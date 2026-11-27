// mango-code: the conversation of a model whose harness is `commands` (session/harness.ts). The harness of
// `mango-harness/` gives the system prompt, the tools, what each tool answers, how the user's message reaches the model
// and whether a final answer is held back. One is opened for each conversation, when its first request needs it.

import type { JSONSchema7 } from "@ai-sdk/provider"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Skill, User } from "@/mango-harness/contracts"
import { openHarness } from "@/mango-harness/harness"
import type { openWeb } from "@/mango-harness/world/web"
import { versionOf } from "@/mango-harness/version"
import type { Harness } from "./harness"
import { PartID, type MessageID, type SessionID } from "./schema"

type Opened = ReturnType<typeof openHarness>
type Version = ReturnType<typeof versionOf>

export type Options = {
  project: string
  version: Version
  user: User
  skills: Skill[]
  /** The user's own tools, by name: the harness only needs to know them. */
  tools: { name: string; description: string; answers: string }[]
  /** Calls a tool of the web search server of the app. */
  callTool: Parameters<typeof openWeb>[0]["callTool"]
}
export type Opener = (options: Options) => Promise<Opened>

// The world modules are read when the first conversation of this kind starts: the browser is not loaded for the others.
const open: Opener = async (options) => {
  const [{ openWeb }, { openPanelBrowser }] = await Promise.all([
    import("@/mango-harness/world/web"),
    import("@/mango-harness/world/browser"),
  ])
  return openHarness({
    project: options.project,
    version: options.version,
    web: openWeb({ callTool: options.callTool }),
    browser: openPanelBrowser({ project: options.project }),
    user: options.user,
    skills: options.skills,
    tools: options.tools,
  })
}
let opener = open

/** Only for tests: the function that makes a harness; without an argument, the real one. */
export function opening(next?: Opener) {
  opener = next ?? open
}

/** The tool call that is being run: the chat shows the harness's question to the user under it. */
export type Running = { current?: { messageID: MessageID; callID: string } }

export type Entry = {
  /** The definition it was made from: a conversation whose model changes harness gets a new one. */
  id: string
  /** Whether its model sees pictures: a conversation that moves to a model that sees, or no more, gets a new one. */
  vision: boolean
  /** That definition with the switches of the settings page over it. */
  definition: Harness.Definition
  harness: Opened
  version: Version
  /** The user's messages of the conversation and the calls since the last one: they time the discipline. */
  turn: { messages: number; calls: number }
  running: Running
  /** The system prompt, read once: the engine keeps its cache of it for the whole conversation. */
  system: string
  /** How many bytes of the prompt are the same for every folder and day. */
  stable: number
  /** The times a call the engine could not read is asked again. */
  retries: number
  /** What each user message of the conversation was turned into: a message is given to the harness once. */
  said: Map<string, string>
  /** The last call of the conversation: the next one waits for it. */
  queue: Promise<unknown>
}

/** Runs the calls of a conversation one after the other, as the harness counts and answers them: the SDK starts every
 *  call of a message as soon as it reads it. One still waiting when the user stops the turn does not run. */
function inTurn<T>(entry: Entry, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const go = () => (signal?.aborted ? Promise.reject(new Error("The user stopped the turn before this call ran.")) : run())
  const next = entry.queue.then(go, go)
  entry.queue = next.catch(() => undefined)
  return next
}

const entries = new Map<string, Promise<Entry>>()

/** The bytes of the prompt up to the first value that changes (the project, the date): the template says where. */
export function stableLength(template: string, system: string) {
  const cut = template.indexOf("{{")
  const prefix = cut < 0 ? template : template.slice(0, cut)
  if (!system.startsWith(prefix)) throw new Error("the prompt of the harness does not begin with its template")
  return Buffer.byteLength(prefix)
}

export async function entryFor(
  sessionID: string,
  definition: Harness.Definition,
  make: (running: Running) => Promise<Omit<Options, "version">>,
  /** What the settings page switched off when the conversation started. */
  off: NonNullable<Parameters<typeof versionOf>[1]>["off"] = {},
  /** The model sees pictures. */
  vision = false,
): Promise<Entry> {
  const known = entries.get(sessionID)
  if (known) {
    const entry = await known
    if (entry.id === definition.id && entry.vision === vision) return entry
    forget(sessionID)
  }
  const made = (async (): Promise<Entry> => {
    const running: Running = {}
    const version = versionOf(definition, { off, vision })
    const harness = await opener({ ...(await make(running)), version })
    const system = harness.system()[0]
    return {
      id: definition.id,
      vision,
      definition,
      harness,
      version,
      turn: { messages: 0, calls: 0 },
      running,
      system,
      stable: stableLength(definition.prompt!.trim(), system),
      retries: version.meta.retries ?? 0,
      said: new Map<string, string>(),
      queue: Promise.resolve(),
    }
  })()
  entries.set(sessionID, made)
  made.catch(() => entries.delete(sessionID))
  return made
}

/** The conversation is gone: what its harness left running stops. */
export function forget(sessionID: string) {
  const entry = entries.get(sessionID)
  entries.delete(sessionID)
  void entry
    ?.then((made) => made.harness.close())
    .catch((error: unknown) => console.warn(`the harness of ${sessionID} did not close: ${String(error)}`))
}

/** The messages as the model reads them: the user's text goes through the harness (once for each message), and what
 *  plugins or the loop added to a user's message is left out. A message the loop wrote itself stays as it is. */
export function messages(entry: Entry, all: SessionV1.WithParts[]): SessionV1.WithParts[] {
  return all.map((message) => {
    if (message.info.role !== "user") return message
    const texts = message.parts.filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
    const held = texts.find((part) => part.metadata?.harness?.held === true)
    const written = texts.filter((part) => !part.synthetic)
    const first = held ?? written[0]
    if (!first) return message
    const text = held?.text ?? entry.said.get(message.info.id) ?? said(entry, written.map((part) => part.text).join("\n"))
    if (!held) entry.said.set(message.info.id, text)
    return { ...message, parts: [{ ...first, text }, ...message.parts.filter((part) => part.type !== "text")] }
  })
}

/** A new message of the user's as the model reads it: through the harness, and with the discipline when it is due. */
function said(entry: Entry, given: string) {
  entry.turn.messages++
  entry.turn.calls = 0
  const text = entry.harness.message(given)
  const hook = entry.definition.hooks["discipline-messages"]
  const due = hook?.on && hook.every && (entry.turn.messages - 1) % hook.every === 0
  return due ? `${text}\n\n${entry.definition.texts["discipline-messages"]}` : text
}

/** What the model reads of a call: the harness's answer, and the discipline every so many calls of the turn. */
function answered(entry: Entry, text: string) {
  entry.turn.calls++
  const hook = entry.definition.hooks["discipline-calls"]
  const due = hook?.on && hook.every && entry.turn.calls % hook.every === 0
  return due ? `${text}\n\n${entry.definition.texts["discipline-calls"]}` : text
}

/** The tools of a request: the harness's, in its order, then the user's own; and `invalid`, which is never sent.
 *  `enabled`: what the settings page leaves on. */
export function tools(
  entry: Entry,
  input: {
    sessionID: SessionID
    messageID: MessageID
    own: Record<string, AITool>
    /** Stores the result of a call that finished after the user stopped the turn. */
    settle: (callID: string, name: string, output: string) => Promise<void>
    enabled?: (name: string) => boolean
  },
): Record<string, AITool> {
  const declared = entry.version
    .declarations(entry.version.startingTools())
    .filter(({ function: item }) => input.enabled?.(item.name) ?? true)
  const harnessTools = Object.fromEntries(
    declared.map(({ function: item }) => [
      item.name,
      tool({
        description: item.description,
        inputSchema: jsonSchema(item.parameters as JSONSchema7),
        execute: (args, options) =>
          inTurn(entry, options.abortSignal, async () => {
            entry.running.current = { messageID: input.messageID, callID: options.toolCallId }
            const answer = await entry.harness.call(item.name, args as Record<string, unknown>)
            const text = answered(entry, answer.text)
            if (answer.failed) throw new Error(text)
            if (options.abortSignal?.aborted) await input.settle(options.toolCallId, item.name, text)
            // The pictures of `page_look` and `read` go with the words, in the same answer.
            const attachments = (answer.images ?? []).map((picture) => ({
              id: PartID.ascending(),
              sessionID: input.sessionID,
              messageID: input.messageID,
              type: "file" as const,
              mime: picture.mime,
              url: `data:${picture.mime};base64,${picture.base64}`,
            }))
            return { title: item.name, metadata: {}, output: text, ...(attachments.length ? { attachments } : {}) }
          }),
      }),
    ]),
  )
  const own = Object.fromEntries(
    Object.entries(input.own).map(([name, item]) => [
      name,
      {
        ...item,
        // The harness counts the call and knows the user's tools were used; what the model reads is the tool's own answer.
        execute: (args: unknown, options: Parameters<NonNullable<AITool["execute"]>>[1]) =>
          inTurn(entry, options.abortSignal, async () => {
            await entry.harness.call(name, args as Record<string, unknown>)
            return item.execute!(args, options)
          }),
      } as AITool,
    ]),
  )
  const invalid = tool({
    description: "Do not use",
    inputSchema: jsonSchema<{ tool: string; error: string }>({
      type: "object",
      properties: { tool: { type: "string" }, error: { type: "string" } },
    }),
    execute: (args: { tool: string; error: string }, options) =>
      inTurn(entry, options.abortSignal, async () => {
        const known = declared.some(({ function: item }) => item.name === args.tool) || Object.hasOwn(own, args.tool)
        const output = known ? args.error : (await entry.harness.call(args.tool, {})).text
        return { title: "invalid", metadata: {}, output }
      }),
  })
  return { ...harnessTools, ...own, invalid }
}

export * as CommandsHarness from "./commands-harness"
