// mango-code: the summary that keeps a long conversation within the context, the same for every harness. The request is
// the conversation as the model reads it, with its system prompt and its tools, and one more message at the end with
// the instruction: the engine reads only that. What the model reads afterwards is put together in `compacted.ts`; the
// texts of the instruction and of the lines around the summary are the harness's (`compaction.md`).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { compactionPart, files, isResume, isSummary, isUser, written } from "./compacted"
import { PromptMeasurement } from "./prompt-measurement"
import type { Result } from "./processor"

import { Effect, Layer, Context } from "effect"
import { isOverflow as overflow, reserved, SUMMARY_ROOM, SUMMARY_TOKENS } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]

/** The last messages that stay as they are after a summary, in tokens, at most an eighth of the context; the last one
 *  stays even if it is longer. */
export const TAIL_TOKENS = 8_000
/** The messages of the user that stay word for word after a summary, in tokens, at most a tenth of the context: the
 *  first and as many of the latest as fit. */
export const USERS_TOKENS = 6_000
/** The longest result of a tool in the second try of a request for a summary that the engine found too large. */
export const SHORT_RESULT_CHARS = 2_000
/** A result cut to fit the context keeps at least this many tokens; the note that says so takes about as many. */
const CUT_LEAST_TOKENS = 200
const CUT_NOTE_TOKENS = 80
/** What a picture weighs in the context of a model that sees: the tokenizer does not count it. */
const PICTURE_TOKENS = 360
/** What the messages of the user and the calls of a summary the agent writes without the model may take, in tokens: at
 *  most a tenth of the context. */
const tenth = (window: number) => (window ? Math.min(USERS_TOKENS, Math.floor(window / 10)) : USERS_TOKENS)
/** How much of a call's input, and of what it gave back, a line of that summary keeps. */
const STEP_INPUT_CHARS = 200
const STEP_RESULT_CHARS = 300

const oneLine = (text: string, chars: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > chars ? `${flat.slice(0, chars)}…` : flat
}

/** A call as a line of the summary the agent writes: the tool, its input, and the start of its answer or its error. */
const step = (part: SessionV1.ToolPart) => {
  const call = `- ${part.tool} ${oneLine(JSON.stringify(part.state.input), STEP_INPUT_CHARS)}`
  if (part.state.status === "completed") return `${call}\n  → ${oneLine(part.state.output, STEP_RESULT_CHARS)}`
  if (part.state.status === "error") return `${call}\n  → error: ${oneLine(part.state.error, STEP_RESULT_CHARS)}`
  return call
}

/** The instruction at the end of the request: the first summary, or the update of the one the conversation holds. */
export const instruction = (texts: Record<string, string>, prior: boolean) =>
  [prior ? texts.update : texts.first, texts.template, texts.rule].join("\n\n")

type Message = SessionV1.WithParts

const picture = (mime: string) => mime.startsWith("image/")

/** What a message puts in the context: its words and what the tools were given and answered, and its pictures. */
function material(message: Message) {
  const texts = message.parts.flatMap((part): string[] => {
    if ((part.type === "text" && !part.ignored) || part.type === "reasoning") return [part.text]
    if (part.type !== "tool") return []
    const input = JSON.stringify(part.state.input)
    if (part.state.status === "completed") return [input, part.state.output]
    if (part.state.status === "error") return [input, part.state.error]
    return [input]
  })
  const pictures = message.parts.reduce(
    (sum, part) =>
      sum +
      (part.type === "file" && picture(part.mime) ? 1 : 0) +
      (part.type === "tool" && part.state.status === "completed"
        ? (part.state.attachments ?? []).filter((item) => picture(item.mime)).length
        : 0),
    0,
  )
  return { text: texts.join("\n"), pictures }
}

/** The latest of `items`, from the end, while their sizes fit in `tokens`; with `atLeastOne` the last one stays even if
 *  it does not fit. */
const fitting = <T>(items: T[], tokens: number, size: (item: T) => Effect.Effect<number>, atLeastOne: boolean) =>
  Effect.gen(function* () {
    const kept: T[] = []
    let total = 0
    for (const item of items.toReversed()) {
      total += yield* size(item)
      if (total > tokens && !(atLeastOne && kept.length === 0)) break
      kept.unshift(item)
    }
    return kept
  })

/** The tokens of a text: the engine's tokenizer for a model of Mango Code, four characters a token where the engine
 *  cannot count (another PC's, an external server's) or does not answer. */
const tokens = Effect.fnUntraced(function* (model: Provider.Model, text: string) {
  if (!text) return 0
  if (model.providerID !== "mango") return Token.estimate(text)
  return yield* Effect.tryPromise({ try: () => PromptMeasurement.count(text), catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("compaction: the engine did not count, four characters a token", { error: String(error) }).pipe(
        Effect.as(Token.estimate(text)),
      ),
    ),
  )
})

const weight = (model: Provider.Model) =>
  Effect.fnUntraced(function* (message: Message) {
    const found = material(message)
    return (yield* tokens(model, found.text)) + found.pictures * PICTURE_TOKENS
  })

/** One cap for every size, the largest that keeps them all within `room`: the ones under it stay whole. Undefined when
 *  they fit as they are. */
const capOf = (sizes: number[], room: number) => {
  const ascending = sizes.toSorted((a, b) => a - b)
  let left = Math.max(0, room)
  for (const [at, size] of ascending.entries()) {
    const rest = ascending.length - at
    if (size * rest > left) return Math.floor(left / rest)
    left -= size
  }
  return undefined
}

/** A unit of the tail: a message the model reads, not the ones that ask for a summary or hold it. */
const readable = (message: Message) =>
  !compactionPart(message) && !(message.info.role === "assistant" && message.info.summary) && !written(message)

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  /** The conversation for the request that asks for a summary: the results of the calls of `last`, which no request has
   *  read yet, shortened there (not in the database) as much as the room to reason and write the summary needs. */
  readonly forSummary: (input: {
    messages: Message[]
    last: SessionV1.Assistant
    model: Provider.Model
    instruction: string
  }) => Effect.Effect<Message[]>
  /** The results of the calls of `last` that fit neither in what is left of the context nor in what a summary would
   *  leave are cut short to the second, the longest first, each with the `cut` text of the harness. Whether it cut. */
  readonly fitResults: (input: {
    messages: Message[]
    last: SessionV1.Assistant
    model: Provider.Model
    instruction: string
    texts: Record<string, string>
  }) => Effect.Effect<boolean>
  /** Whether the next request, once the summary is asked for, would no longer leave the model room to write it: the
   *  context of the last answer, plus what came after it (the results of its calls, the messages that followed), plus the
   *  instruction, plus a summary of the longest size. `messages`: the conversation as the model reads it. */
  readonly noRoom: (input: {
    messages: Message[]
    last: SessionV1.Assistant
    model: Provider.Model
    instruction: string
  }) => Effect.Effect<boolean>
  /** The model's answer to the request for a summary is in `message`: it is kept (the tail, the messages of the user, the
   *  files) and the message the model reads after it is written. `stop`: the turn is over (the summary failed, or the
   *  conversation was at its end); `continue`: the work was half way and goes on from the last answer of a tool. */
  readonly complete: (input: {
    sessionID: SessionID
    parentID: MessageID
    message: SessionV1.Assistant
    result: Result
    model: Provider.Model
    /** The texts of the harness (`COMPACTION_TEXTS`). */
    texts: Record<string, string>
    /** The project folder: the files are listed from it. */
    project: string
  }) => Effect.Effect<"continue" | "stop">
  /** Asks for a summary: a message of the user that carries the request, with the settings of the user's last one. */
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }
    auto: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
      })
    })

    const noRoom = Effect.fn("SessionCompaction.noRoom")(function* (input: {
      messages: Message[]
      last: SessionV1.Assistant
      model: Provider.Model
      instruction: string
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.auto === false) return false
      const window = input.model.limit.input || input.model.limit.context
      if (!window) return false
      const keep = reserved(cfg, window)
      const used = input.last.tokens
      const base = used.total || used.input + used.output + used.cache.read + used.cache.write
      // what the measured request did not have: the results of the calls of the last answer, and what followed it
      const added = input.messages
        .filter((message) => readable(message) && message.info.time.created >= input.last.time.created)
        .map((message) =>
          message.info.id === input.last.id
            ? {
                text: message.parts.flatMap((part) => (part.type === "tool" && part.state.status === "completed" ? [part.state.output] : [])).join("\n"),
                pictures: message.parts.reduce(
                  (sum, part) =>
                    sum + (part.type === "tool" && part.state.status === "completed" ? (part.state.attachments ?? []).filter((item) => picture(item.mime)).length : 0),
                  0,
                ),
              }
            : material(message),
        )
      const text = [...added.map((item) => item.text), input.instruction].join("\n")
      const pictures = added.reduce((sum, item) => sum + item.pictures, 0) * PICTURE_TOKENS
      // a token is never less than a character: with room for that many, the engine is not asked
      if (base + text.length + pictures + keep <= window) return false
      return base + (yield* tokens(input.model, text)) + pictures + keep > window
    })

    const forSummary = Effect.fn("SessionCompaction.forSummary")(function* (input: {
      messages: Message[]
      last: SessionV1.Assistant
      model: Provider.Model
      instruction: string
    }) {
      const window = input.model.limit.input || input.model.limit.context
      const answer = input.messages.find((message) => message.info.id === input.last.id)
      if (!window || !answer) return input.messages
      const results = answer.parts.filter(
        (part): part is SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted } =>
          part.type === "tool" && part.state.status === "completed",
      )
      if (results.length === 0) return input.messages
      const used = input.last.tokens
      const base = used.total || used.input + used.output + used.cache.read + used.cache.write
      const room = window - SUMMARY_ROOM - base - (yield* tokens(input.model, input.instruction))
      const sizes = yield* Effect.forEach(results, (part) => tokens(input.model, part.state.output))
      const cap = capOf(sizes, room)
      if (cap === undefined) return input.messages
      const kept = Math.max(CUT_LEAST_TOKENS, cap - CUT_NOTE_TOKENS)
      const shortened = new Map(
        results.flatMap((part, at) => {
          const whole = sizes[at]!
          if (whole <= kept) return []
          const chars = Math.floor((part.state.output.length * kept) / whole)
          const output = `${part.state.output.slice(0, chars)}\n[Tool output truncated for compaction: omitted ${part.state.output.length - chars} chars]`
          return [[part.id, { ...part, state: { ...part.state, output } }] as const]
        }),
      )
      yield* Effect.logInfo("compaction: the newest results shortened in the request for a summary", { room, sizes, kept })
      return input.messages.map((message) =>
        message.info.id === answer.info.id ? { ...message, parts: message.parts.map((part) => shortened.get(part.id) ?? part) } : message,
      )
    })

    const fitResults = Effect.fn("SessionCompaction.fitResults")(function* (input: {
      messages: Message[]
      last: SessionV1.Assistant
      model: Provider.Model
      instruction: string
      texts: Record<string, string>
    }) {
      const window = input.model.limit.input || input.model.limit.context
      const answer = input.messages.find((message) => message.info.id === input.last.id)
      if (!window || !answer) return false
      const results = answer.parts.filter(
        (part): part is SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted } =>
          part.type === "tool" && part.state.status === "completed" && !part.state.metadata?.cut,
      )
      if (results.length === 0) return false
      const used = input.last.tokens
      const base = used.total || used.input + used.output + used.cache.read + used.cache.write
      const keep = reserved(yield* config.get(), window)
      const room = window - keep - base - (yield* tokens(input.model, input.instruction))
      const sizes = yield* Effect.forEach(results, (part) => tokens(input.model, part.state.output))
      const total = sizes.reduce((sum, size) => sum + size, 0)
      if (total <= room) return false
      // What a summary leaves room for: the context less the system prompt and the tools (the smallest request of the
      // whole conversation: after a summary the messages the model reads have only the latest), the longest summary and
      // the messages of the user kept. Results that fit there are left whole: the summary makes the room for them.
      const all = yield* session.messages({ sessionID: input.last.sessionID }).pipe(Effect.orDie)
      const fixed = Math.min(
        base,
        ...all.flatMap((message) =>
          message.info.role === "assistant" && !message.info.summary && message.info.tokens.input > 0
            ? [message.info.tokens.input + message.info.tokens.cache.read + message.info.tokens.cache.write]
            : [],
        ),
      )
      const afterSummary = window - keep - fixed - SUMMARY_TOKENS - tenth(window)
      if (total <= afterSummary) return false
      const cap = capOf(sizes, afterSummary)
      const kept = Math.max(CUT_LEAST_TOKENS, (cap ?? 0) - CUT_NOTE_TOKENS)
      yield* Effect.forEach(results, (part, at) => {
        const whole = sizes[at]!
        if (whole <= kept) return Effect.void
        const note = input.texts.cut.replace("{{whole}}", String(whole)).replace("{{kept}}", String(kept))
        const output = `${part.state.output.slice(0, Math.floor((part.state.output.length * kept) / whole))}\n\n${note}`
        return session.updatePart({ ...part, state: { ...part.state, output, metadata: { ...part.state.metadata, cut: { whole, kept } } } })
      })
      yield* Effect.logInfo("compaction: results cut to fit the context", { room, sizes, kept })
      return true
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user" && !isResume(msg)) turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const complete = Effect.fn("SessionCompaction.complete")(function* (input: {
      sessionID: SessionID
      parentID: MessageID
      message: SessionV1.Assistant
      result: Result
      model: Provider.Model
      texts: Record<string, string>
      project: string
    }) {
      // the user stopped it: the next turn asks for the summary again
      if (SessionV1.AbortedError.isInstance(input.message.error)) return "stop" as const

      const reply = yield* MessageV2.parts(input.message.id).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      const answer = reply
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim()
      // no summary came: the model called a tool, went on repeating itself, was cut short or wrote nothing, the request
      // did not fit even with the results cut short, or the engine refused it (a template that does not take its shape)
      const unwritten =
        !!input.message.error ||
        ["called", "repeat", "compact"].includes(input.result) ||
        input.message.finish === "length" ||
        !answer

      const all = (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).filter(
        (message) => message.info.id !== input.message.id,
      )
      const asked = all.findIndex((message) => message.info.id === input.parentID)
      const request = all[asked]
      const part = request && compactionPart(request)
      if (!request || !part || request.info.role !== "user")
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      const before = all.slice(0, asked)

      const weigh = weight(input.model)
      // on a small context the fixed amounts would fill it again right after the summary: they shrink with it
      const window = input.model.limit.input || input.model.limit.context
      const tailTokens = window ? Math.min(TAIL_TOKENS, Math.floor(window / 8)) : TAIL_TOKENS
      const usersTokens = tenth(window)

      // The tail begins after the last summary: what came before it is in that summary.
      const last = before.findLastIndex(isSummary)
      const since = last < 0 ? 0 : Math.max(last, before.findIndex((message, at) => at > last && written(message))) + 1
      const tail = yield* fitting(before.slice(since).filter(readable), tailTokens, weigh, true)
      const start = tail[0] && before.findIndex((message) => message.info.id === tail[0]!.info.id)

      // Without the model's summary the agent writes one from what it has: the summary before it, then the latest calls
      // the work made since, each with the start of what it gave back, as many as fit.
      const summary = unwritten
        ? yield* Effect.gen(function* () {
            // the summary before, without the sentence it opens with when the agent wrote it too: it is said once
            const prior = last < 0 ? [] : before[last]!.parts.flatMap((item) => (item.type === "text" ? [item.text.trim().replace(input.texts.unwritten, "").trim()] : []))
            const calls = before
              .slice(since, start ?? before.length)
              .filter(readable)
              .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
              .flatMap((item) => (item.type === "tool" ? [step(item)] : []))
            const latest = yield* fitting(calls, tenth(window), (line) => Effect.succeed(Token.estimate(line)), false)
            return [input.texts.unwritten, ...prior, latest.join("\n")].filter(Boolean).join("\n\n")
          })
        : answer
      if (unwritten) {
        yield* Effect.logWarning("compaction: the model wrote no summary, the agent writes it from the calls", {
          result: input.result,
          error: input.message.error?.name,
        })
        input.message.error = undefined
        input.message.finish = "stop"
        yield* session.updateMessage(input.message)
        yield* Effect.forEach(
          reply.filter((item) => item.type === "text"),
          (item) => session.removePart({ sessionID: input.sessionID, messageID: input.message.id, partID: item.id }),
        )
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: input.message.id,
          sessionID: input.sessionID,
          type: "text",
          text: summary,
          time: { start: Date.now(), end: Date.now() },
        })
      }
      // cut for going on with blank lines: the summary was over, and the cut left the answer without its finish
      if (!unwritten && input.result === "blank" && !input.message.finish) {
        input.message.finish = "stop"
        yield* session.updateMessage(input.message)
      }
      const users = before.slice(0, start ?? before.length).filter(isUser)
      const latest = yield* fitting(
        users.slice(1),
        usersTokens - (users[0] ? yield* weigh(users[0]) : 0),
        weigh,
        false,
      )
      const missing = users.length - Math.min(users.length, 1) - latest.length
      const listed = files(before, input.project)
      const lines = (heading: string, found: string[]) =>
        found.length ? [[heading, ...found.map((file) => `- ${file}`)].join("\n")] : []

      const kept = {
        ...part,
        ...(tail[0] ? { tail_start_id: tail[0].info.id } : {}),
        ...(latest[0] ? { users_from_id: latest[0].info.id } : {}),
      }
      if (kept.tail_start_id !== part.tail_start_id || kept.users_from_id !== part.users_from_id)
        yield* session.updatePart(kept)

      const told = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: request.info.agent,
        model: request.info.model,
        tools: request.info.tools,
        system: request.info.system,
        format: request.info.format,
      })
      const write = (text: string, what: "summary" | "missing") =>
        session.updatePart({
          id: PartID.ascending(),
          messageID: told.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          metadata: { resume: "compaction", compaction: what },
          text,
          time: { start: Date.now(), end: Date.now() },
        })
      yield* write(
        [
          input.texts.continued,
          summary,
          ...lines(input.texts["files-read"], listed.read),
          ...lines(input.texts["files-changed"], listed.changed),
        ].join("\n\n"),
        "summary",
      )
      if (missing > 0) yield* write(input.texts.missing.replace("{{missing}}", String(missing)), "missing")
      yield* events.publish(Event.Compacted, { sessionID: input.sessionID })

      // The work was half way when the last answer of the model asked for a tool: the model goes on from its result.
      const end = before.findLast(readable)
      const closed =
        end?.info.role === "assistant" &&
        !end.parts.some((item) => item.type === "tool") &&
        (!!end.info.error || !["tool-calls", "unknown", "length", "context"].includes(end.info.finish ?? "unknown"))
      return closed ? ("stop" as const) : ("continue" as const)
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string }
      auto: boolean
    }) {
      const user = (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).findLast(isUser)?.info
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        ...(user?.role === "user" ? { tools: user.tools, system: user.system, format: user.format } : {}),
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    })

    return Service.of({
      isOverflow,
      noRoom,
      forSummary,
      fitResults,
      prune,
      complete,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Session.node, EventV2Bridge.node, Database.node],
})

export * as SessionCompaction from "./compaction"
