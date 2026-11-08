// mango-code: speed and timings of the local engine, computed from the real numbers llama-server
// writes on the message (`timings`). Pure functions: the UI uses them for the composer bar, the session
// header and the line under each answer.
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

export type Timings = NonNullable<AssistantMessage["timings"]>

// Below these thresholds the speed says nothing about the engine: a 20-token request is read in under a
// second and the time is mostly a fixed cost per request (in the engine log: 21 tokens at 24 t/s). The
// number is still true, but shown as a "speed" it worries people for no reason, so for those requests
// we show the tokens and not the speed.
export const MIN_READ_TOKENS = 32
export const MIN_WRITE_TOKENS = 8

/** Tokens per second; undefined if the measurement is too small to be a speed. */
export function tokensPerSecond(tokens: number, ms: number, minTokens: number) {
  if (tokens < minTokens || !(ms > 0)) return
  return (tokens * 1000) / ms
}

export const readRate = (t: Timings) => tokensPerSecond(t.promptTokens, t.promptMs, MIN_READ_TOKENS)
export const writeRate = (t: Timings) => tokensPerSecond(t.predictedTokens, t.predictedMs, MIN_WRITE_TOKENS)

/** From 794 to "794", from 33.82 to "33.8": under 100 one decimal helps, above it is noise. */
export function formatRate(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 100 ? 0 : 1 }).format(value)
}

export const formatTokens = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)

type Step = Pick<AssistantMessage, "time" | "timings">

/**
 * Everything the engine did for an answer (one or more steps: each tool call opens a new one). The speeds
 * are token-weighted averages, computed only on the steps big enough to be a measurement.
 */
export type Work = {
  /** Steps with engine timings. */
  steps: number
  readTokens: number
  writeTokens: number
  readMs: number
  writeMs: number
  readRate?: number
  writeRate?: number
  /** Time the engine spent reading and writing. */
  modelMs: number
  /** Duration of the measured steps only, tools and waits included. */
  wallMs: number
}

export function summarizeWork(messages: readonly Step[], now: number): Work | undefined {
  const measured = messages.filter((m): m is Step & { timings: Timings } => !!m.timings)
  if (measured.length === 0) return
  const sum = (pick: (t: Timings) => number) => measured.reduce((total, m) => total + pick(m.timings), 0)
  const rate = (tokens: (t: Timings) => number, ms: (t: Timings) => number, min: number) => {
    const big = measured.filter((m) => tokens(m.timings) >= min)
    const tokenSum = big.reduce((total, m) => total + tokens(m.timings), 0)
    const msSum = big.reduce((total, m) => total + ms(m.timings), 0)
    return tokensPerSecond(tokenSum, msSum, min)
  }
  const readMs = sum((t) => t.promptMs)
  const writeMs = sum((t) => t.predictedMs)
  return {
    steps: measured.length,
    readTokens: sum((t) => t.promptTokens),
    writeTokens: sum((t) => t.predictedTokens),
    readMs,
    writeMs,
    readRate: rate((t) => t.promptTokens, (t) => t.promptMs, MIN_READ_TOKENS),
    writeRate: rate((t) => t.predictedTokens, (t) => t.predictedMs, MIN_WRITE_TOKENS),
    modelMs: readMs + writeMs,
    wallMs: measured.reduce((total, m) => total + stepMs(m, now), 0),
  }
}

/** Duration of a step; a step still open counts up to `now`. */
export function stepMs(message: Pick<AssistantMessage, "time">, now: number) {
  return Math.max(0, (message.time.completed ?? now) - message.time.created)
}

/** Duration of the whole answer, from the first step to the end of the last one (tools included). */
export function responseMs(messages: readonly Pick<AssistantMessage, "time">[]) {
  if (messages.length === 0) return
  const first = Math.min(...messages.map((m) => m.time.created))
  const last = Math.max(...messages.map((m) => m.time.completed ?? 0))
  return last > first ? last - first : undefined
}

/** Last instant recorded in a step: the latest end or start among its parts. */
export function lastActivity(parts: readonly Part[] | undefined) {
  let latest: number | undefined
  for (const part of parts ?? []) {
    const time: { start?: number; end?: number } | undefined =
      part.type === "tool" ? ("time" in part.state ? part.state.time : undefined) : "time" in part ? (part.time as { start?: number; end?: number }) : undefined
    const moment = typeof time?.end === "number" ? time.end : time?.start
    if (typeof moment === "number" && (latest === undefined || moment > latest)) latest = moment
  }
  return latest
}

/**
 * The model's working time in a conversation: the sum of the duration of every step. A step with no end
 * counts only if it is the last one and the model is working: one left open (app closed or restarted
 * halfway through an answer) must not keep the counter running forever, so it counts up to the last
 * activity it left (`lastActivity`), if it left any.
 */
export function sessionWorkMs<M extends Pick<AssistantMessage, "time">>(
  messages: readonly M[],
  working: boolean,
  now: number,
  activityOf?: (message: M) => number | undefined,
) {
  const last = messages.length - 1
  return messages.reduce((total, message, index) => {
    if (message.time.completed === undefined && !(working && index === last)) {
      const end = activityOf?.(message)
      return end !== undefined && end > message.time.created ? total + end - message.time.created : total
    }
    return total + stepMs(message, now)
  }, 0)
}

/** Last speed measured in the conversation, for read and write separately. */
export function lastMeasured(messages: readonly Pick<AssistantMessage, "timings">[]) {
  let read: { rate: number; tokens: number } | undefined
  let write: { rate: number; tokens: number } | undefined
  for (let i = messages.length - 1; i >= 0 && !(read && write); i--) {
    const timings = messages[i]?.timings
    if (!timings) continue
    const r = readRate(timings)
    if (!read && r !== undefined) read = { rate: r, tokens: timings.promptTokens }
    const w = writeRate(timings)
    if (!write && w !== undefined) write = { rate: w, tokens: timings.predictedTokens }
  }
  return { read, write }
}

/** Duration of a model step, as the server sends it for the answers the page has not loaded. */
export type WorkStep = { id: string; ms: number }

export function parseWorkSteps(body: unknown): WorkStep[] {
  const steps = body && typeof body === "object" ? (body as { steps?: unknown }).steps : undefined
  if (!Array.isArray(steps)) return []
  return steps.filter(
    (step): step is WorkStep =>
      !!step && typeof step.id === "string" && typeof step.ms === "number" && Number.isFinite(step.ms) && step.ms > 0,
  )
}

/** Time of the steps the page has not loaded: the others it counts itself, live. */
export function olderWorkMs(steps: readonly WorkStep[], loadedIDs: readonly string[]) {
  const loaded = new Set(loadedIDs)
  return steps.reduce((total, step) => (loaded.has(step.id) ? total : total + step.ms), 0)
}

/** Live numbers of the stream in progress, as the server route sends them. */
export type LiveTimings = Timings & { updatedAt: number }

/** Reading of the context in progress, as the server route sends it: only the tokens that really need reading. */
export type Reading = { doneTokens: number; totalTokens: number; ms: number }

export function parseReading(body: unknown): Reading | undefined {
  if (!body || typeof body !== "object") return
  const reading = (body as { reading?: unknown }).reading
  if (!reading || typeof reading !== "object") return
  const raw = reading as Record<string, unknown>
  const keys = ["doneTokens", "totalTokens", "ms"] as const
  if (!keys.every((key) => typeof raw[key] === "number" && Number.isFinite(raw[key]))) return
  return raw as Reading
}

/** Live read speed: tokens done over the elapsed time, or undefined if it is too early. */
export function readingRate(reading: Reading) {
  return tokensPerSecond(reading.doneTokens, reading.ms, MIN_READ_TOKENS)
}

/** Why the engine does not answer yet, as the route sends it: gpus on loan or model loading. */
export type EngineWait = { kind: "cards"; who?: string; since?: string } | { kind: "loading" }

export function parseWait(body: unknown): EngineWait | undefined {
  if (!body || typeof body !== "object") return
  const wait = (body as { wait?: unknown }).wait
  if (!wait || typeof wait !== "object") return
  const raw = wait as Record<string, unknown>
  if (raw.kind === "loading") return { kind: "loading" }
  if (raw.kind !== "cards") return
  return {
    kind: "cards",
    ...(typeof raw.who === "string" && raw.who ? { who: raw.who } : {}),
    ...(typeof raw.since === "string" && raw.since ? { since: raw.since } : {}),
  }
}

export function parseLive(body: unknown): LiveTimings | undefined {
  if (!body || typeof body !== "object") return
  const live = (body as { live?: unknown }).live
  if (!live || typeof live !== "object") return
  const raw = live as Record<string, unknown>
  const keys = ["promptTokens", "promptMs", "predictedTokens", "predictedMs", "updatedAt"] as const
  if (!keys.every((key) => typeof raw[key] === "number" && Number.isFinite(raw[key]))) return
  return raw as LiveTimings
}

/** A conversation that has a request to the engine, as the server route sends it. */
export type EngineSession = {
  sessionID: string
  /** The session that really made the request (different from `sessionID` only for sub-agents). */
  requestSessionID: string
  /** Absent if the conversation does not have a real name yet. */
  title?: string
  directory?: string
}

export type EngineQueue = { active?: EngineSession; waiting: EngineSession[] }

function parseEngineSession(value: unknown): EngineSession | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionID !== "string" || !raw.sessionID) return
  return {
    sessionID: raw.sessionID,
    requestSessionID: typeof raw.requestSessionID === "string" ? raw.requestSessionID : raw.sessionID,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : undefined,
    directory: typeof raw.directory === "string" ? raw.directory : undefined,
  }
}

/** Who has the request in progress and who waits, as the route sends them; empty if the server does not say. */
export function parseEngineQueue(body: unknown): EngineQueue {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  return {
    active: parseEngineSession(raw.active),
    waiting: Array.isArray(raw.waiting)
      ? raw.waiting.flatMap((item) => {
          const session = parseEngineSession(item)
          return session ? [session] : []
        })
      : [],
  }
}

const isSession = (item: EngineSession, sessionID: string) =>
  item.sessionID === sessionID || item.requestSessionID === sessionID

/**
 * The role of a conversation with respect to the engine, that is, whose the route's numbers are:
 *  - `active`: the engine works for it, the numbers are its own;
 *  - `waiting`: the engine works for another one and it waits for its turn (`position` is 1 for the first
 *    in the queue, `queued` how many wait in total);
 *  - `other`: the engine works for another one and it has no request yet (for example a tool running
 *    between two steps): the numbers are not its own;
 *  - `free`: the server reports no request in progress, so nothing is attributed to anyone and the
 *    numbers, if there are any, stay as they were.
 */
export type EngineTurn =
  | { kind: "active" }
  | { kind: "free" }
  | { kind: "other"; behind: EngineSession }
  | { kind: "waiting"; behind: EngineSession; position: number; queued: number }

export function engineTurn(queue: EngineQueue, sessionID: string | undefined): EngineTurn {
  const { active } = queue
  if (!active) return { kind: "free" }
  if (sessionID && isSession(active, sessionID)) return { kind: "active" }
  const index = sessionID ? queue.waiting.findIndex((item) => isSession(item, sessionID)) : -1
  if (index < 0) return { kind: "other", behind: active }
  return { kind: "waiting", behind: active, position: index + 1, queued: queue.waiting.length }
}

/** The route's live numbers belong to this conversation (or to no other). */
export const ownsEngineNumbers = (turn: EngineTurn) => turn.kind === "active" || turn.kind === "free"
