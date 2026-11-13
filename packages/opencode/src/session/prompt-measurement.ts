// mango-code: how many tokens each prompt item weighs (a tool, an MCP server, a skill, an instructions file, a plugin).
// The engine counts them with the running model's own tokenizer (`POST /tokenize`, through the engine manager), so the
// numbers are never estimates; an item without a measurement shows as "not measured" on the settings page.
//
// Weights depend on the model (each has its own tokenizer) and on the folder (instructions, skills and servers differ
// between projects), so they are kept per folder, for the model that measured last. They are saved in the agent's state
// folder so that they survive a restart of the app. Each weight carries a fingerprint of the text it was measured on: if
// the text has changed since (an edited CLAUDE.md, a rewritten skill, a server with other tools, a new base prompt after
// an update), the weight is no longer shown.

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { engineIsRemote, engineOriginUrl } from "@/provider/engine-timings"
import { tr } from "@/util/mango-language"

/** An item with the text it adds to the prompt; without text (a server that is not connected) it cannot be measured. */
export type Item = { kind: string; name: string; text?: string }

/** Per folder: the model of its last measurement and, by kind and name, each item's tokens and text fingerprint. */
const Saved = Schema.Record(
  Schema.String,
  Schema.Struct({
    model: Schema.String,
    items: Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Struct({ tokens: Schema.Number, print: Schema.String })),
    ),
  }),
)
type Saved = typeof Saved.Type

/** How many folders the file keeps: the ones measured most recently. */
const FOLDERS = 50

const file = () => path.join(Global.Path.state, "prompt-weights.json")
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Saved))
const folderKey = (directory: string) => path.resolve(directory).toLowerCase()
// The base prompt carries today's date (session/system.ts): a new day does not make its weight an old one.
const print = (text: string) => Hash.fast(text.replace(/Today's date: .*/, ""))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let loaded: Saved | undefined
let problem: string | undefined

/** What went wrong reading the file, once, for the agent's log; the weights then count as none. */
export function takeProblem() {
  const taken = problem
  problem = undefined
  return taken
}

/**
 * The weights of every folder, read from the file the first time. A file that is not valid counts as empty and the
 * next measurement writes it again; one that cannot be read now (held by another program) is tried again next time,
 * and until then there are no weights and nothing is written over it.
 */
function weights(): Saved | undefined {
  if (loaded) return loaded
  const read = readFile()
  if ("error" in read) {
    problem = read.error
    return undefined
  }
  if (Option.isNone(read.weights)) problem = `${file()} is not valid: the next measurement writes it again`
  loaded = Option.getOrElse(read.weights, () => ({}))
  return loaded
}

function readFile(): { weights: Option.Option<Saved> } | { error: string } {
  try {
    return { weights: decode(fs.readFileSync(file(), "utf8")) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { weights: Option.some({}) }
    return { error: `${file()}: ${message(e)}` }
  }
}

/** Writes the whole file, or says why it could not; the weights stay in memory either way. */
function save(next: Saved): string | undefined {
  const temporary = `${file()}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n")
    fs.renameSync(temporary, file())
  } catch (e) {
    // a temporary file left behind is harmless: this process's next write replaces it
    void fs.promises.rm(temporary, { force: true }).catch(() => undefined)
    return `${file()}: ${message(e)}`
  }
}

/** The model of the last measurement in this folder: the one that ran its latest conversation. */
export function measuredModel(directory: string): string | undefined {
  return weights()?.[folderKey(directory)]?.model
}

/**
 * The tokens of an item for this folder and model, or `undefined` if it has not been measured or its text has changed
 * since. An item whose text is not known right now (a server not connected, a plugin's reminder, seen only during a
 * conversation) keeps its weight: nothing says it is old.
 */
export function tokens(directory: string, model: string, item: Item): number | undefined {
  const known = weights()?.[folderKey(directory)]
  const ofKind = known?.model === model ? known.items[item.kind] : undefined
  // an item's name is free text (a server called "constructor"): only the file's own keys count
  const weight = ofKind && Object.hasOwn(ofKind, item.name) ? ofKind[item.name] : undefined
  if (!weight || (item.text !== undefined && weight.print !== print(item.text))) return undefined
  return weight.tokens
}

async function count(text: string): Promise<number> {
  // The network door of another PC's engine does not count tokens: the item stays "not measured", without a refused request each.
  if (engineIsRemote()) throw new Error(tr("il motore di un altro PC non conta i token", "the engine of another PC does not count tokens"))
  const origin = engineOriginUrl()
  if (!origin) throw new Error("the engine address is not known: no request to the local model yet")
  const response = await fetch(`${origin}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`/tokenize answered ${response.status}`)
  const body = (await response.json()) as { tokens?: unknown }
  if (!Array.isArray(body.tokens)) throw new Error("/tokenize did not answer with a list of tokens")
  return body.tokens.length
}

const PARALLEL = 8

/**
 * Measures the items and remembers them per folder and model. With the same model the measured items are added to the
 * ones already known (a disabled plugin brings no text, but its earlier weight is still valid); with another model it
 * starts again, but only if something was measured: an engine that counted nothing leaves the weights as they were.
 * An item that cannot be measured stays unmeasured and the reason goes in `errors`; `unsaved` says why the weights
 * could not be kept.
 */
export async function measure(directory: string, model: string, items: Item[]) {
  const results: { kind: string; name: string; tokens: number; print: string }[] = []
  const errors: string[] = []
  const queue = items.filter((item): item is Item & { text: string } => item.text !== undefined)
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let item = queue.pop(); item; item = queue.pop()) {
        try {
          results.push({ kind: item.kind, name: item.name, tokens: await count(item.text), print: print(item.text) })
        } catch (e) {
          errors.push(`${item.kind} ${item.name}: ${message(e)}`)
        }
      }
    }),
  )
  if (results.length === 0) return { errors }
  const all = weights()
  if (!all) return { errors, unsaved: takeProblem() }
  const key = folderKey(directory)
  const existing = all[key]
  const known: Record<string, Record<string, { tokens: number; print: string }>> = existing?.model === model
    ? { ...existing.items }
    : {}
  for (const result of results)
    known[result.kind] = { ...known[result.kind], [result.name]: { tokens: result.tokens, print: result.print } }
  // the folder just measured goes last, and the oldest ones beyond FOLDERS are dropped
  loaded = Object.fromEntries([
    ...Object.entries(all)
      .filter(([folder]) => folder !== key)
      .slice(-(FOLDERS - 1)),
    [key, { model, items: known }],
  ])
  return { errors, unsaved: save(loaded) }
}

// What a plugin adds to the conversation messages (the reminder) exists only while the plugin runs: it is collected
// there and measured with the first request. Once a conversation is measured nothing more is collected.
const additions = new Map<string, Map<string, string>>()
const measured = new Set<string>()

/** A plugin that runs without adding anything weighs zero; one message after another does not erase the text already seen. */
export function recordPlugin(sessionID: string | undefined, plugin: string, texts: string[]) {
  if (!sessionID || measured.has(sessionID)) return
  const session = additions.get(sessionID) ?? new Map<string, string>()
  if (texts.length > 0 || !session.has(plugin)) session.set(plugin, texts.join("\n"))
  additions.set(sessionID, session)
}

/** What the plugins added to the messages of a conversation; from here on nothing more is collected. */
export function takePlugins(sessionID: string): Map<string, string> | undefined {
  measured.add(sessionID)
  const session = additions.get(sessionID)
  additions.delete(sessionID)
  return session
}

export * as PromptMeasurement from "./prompt-measurement"
