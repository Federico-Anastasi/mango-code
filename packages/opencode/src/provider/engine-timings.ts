// mango-code: the real timings of the local engine (llama-server). The engine writes them in the `timings`
// field of the response chunks; with `timings_per_token` it sends them with every token, so the speed can be
// read live without querying other endpoints, and it is the same figure as in its log (`prompt eval time` /
// `eval time`). The ai-sdk provider does not keep them: this extractor collects them and hands them over as
// end-of-step metadata, which the processor saves on the message.

export type EngineTimings = {
  promptTokens: number
  promptMs: number
  predictedTokens: number
  predictedMs: number
}

export type EngineLive = EngineTimings & { updatedAt: number }

/**
 * Prefill in progress. The tokens are the ones that really have to be read: the part already in the engine's
 * cache (conversation identical to before) does not count, so after an app restart "to read" is the whole
 * conversation and usually a new message.
 */
export type EngineReading = { doneTokens: number; totalTokens: number; ms: number }

// After this much silence a stream is considered closed (cancelled by the user or crashed).
const STALE_MS = 5000

let live: EngineLive | undefined

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** From the engine's `timings` field (llama-server names). */
export function parseTimings(value: unknown): EngineTimings | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const promptTokens = num(raw.prompt_n)
  const predictedTokens = num(raw.predicted_n)
  if (promptTokens === undefined || predictedTokens === undefined) return
  return {
    promptTokens,
    // With the whole prompt in cache the engine does not measure the prefill: 0 ms, not a missing value.
    promptMs: num(raw.prompt_ms) ?? 0,
    predictedTokens,
    predictedMs: num(raw.predicted_ms) ?? 0,
  }
}

/** From the end-of-step metadata, already in the names of EngineTimings. */
export function savedTimings(value: unknown): EngineTimings | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const promptTokens = num(raw.promptTokens)
  const promptMs = num(raw.promptMs)
  const predictedTokens = num(raw.predictedTokens)
  const predictedMs = num(raw.predictedMs)
  if (promptTokens === undefined || promptMs === undefined) return
  if (predictedTokens === undefined || predictedMs === undefined) return
  return { promptTokens, promptMs, predictedTokens, predictedMs }
}

/** Live speed of the stream in progress, or undefined if the engine is not writing. */
export function liveTimings(now = Date.now()): EngineLive | undefined {
  if (!live) return
  if (now - live.updatedAt > STALE_MS) live = undefined
  return live
}

function chunkTimings(chunk: unknown) {
  if (!chunk || typeof chunk !== "object") return
  return parseTimings((chunk as { timings?: unknown }).timings)
}

/** Metadata extractor for @ai-sdk/openai-compatible: `{ [provider]: { timings } }`. */
export function engineTimingsExtractor(providerID: string) {
  return {
    async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
      const timings = chunkTimings(parsedBody)
      return timings ? { [providerID]: { timings } } : undefined
    },
    createStreamExtractor() {
      let last: EngineTimings | undefined
      return {
        processChunk(chunk: unknown) {
          const timings = chunkTimings(chunk)
          if (!timings) return
          last = timings
          live = { ...timings, updatedAt: Date.now() }
        },
        buildMetadata() {
          live = undefined
          return last ? { [providerID]: { timings: last } } : undefined
        },
      }
    },
  }
}

// The engine is the same llama-server as the timings above; its address is the provider's.
let engineOrigin: string | undefined

// The engine may be another PC's: the app then gives the agent its key (`MANGO_ENGINE_KEY`, in the environment only), and every
// call to the engine's own routes carries it. On this PC's engine there is no key and nothing is added.
const engineKey = () => process.env["MANGO_ENGINE_KEY"] || undefined

export const engineIsRemote = () => engineKey() !== undefined

function engineHeaders(): Record<string, string> {
  const key = engineKey()
  return key ? { Authorization: `Bearer ${key}` } : {}
}

export function setEngineOrigin(baseURL: string) {
  engineOrigin = new URL(baseURL).origin
}

/** The engine's address, known after the first request to the local model. */
export const engineOriginUrl = () => engineOrigin

/** From the engine's slot list (`/slots?lite=1`): the prefill in progress, or undefined. */
export function parseReading(slots: unknown): EngineReading | undefined {
  if (!Array.isArray(slots)) return
  for (const slot of slots) {
    if (!slot || typeof slot !== "object") continue
    const raw = slot as Record<string, unknown>
    const total = num(raw.n_prompt_tokens)
    const done = num(raw.n_past_prompt)
    const cached = num(raw.n_prompt_tokens_cache)
    const ms = num(raw.t_prompt_ms)
    // The engine's `state` field stays "idle" while the prompt loads: `is_processing` is what counts.
    // With the prefill finished (done = total) the engine is already decoding.
    if (raw.is_processing !== true) continue
    if (total === undefined || done === undefined || cached === undefined || ms === undefined) continue
    if (done >= total) continue
    return { doneTokens: Math.max(0, done - cached), totalTokens: Math.max(1, total - cached), ms }
  }
}

/**
 * Why the engine is not answering yet: the GPUs are on loan to another app (`who`, since `since`), or the model
 * is loading. It comes from the app's engine manager (`GET /engine`).
 */
export type EngineWait = { kind: "cards"; who?: string; since?: string } | { kind: "loading" }

/** From the engine manager's state: the wait in progress, or undefined if the engine is on. */
export function parseWait(engine: unknown): EngineWait | undefined {
  if (!engine || typeof engine !== "object") return
  const raw = engine as Record<string, unknown>
  if (raw.phase === "starting") return { kind: "loading" }
  if (raw.phase !== "releasing" && raw.phase !== "released") return
  const first = Array.isArray(raw.loans) ? (raw.loans[0] as Record<string, unknown> | undefined) : undefined
  return {
    kind: "cards",
    ...(typeof first?.who === "string" && first.who ? { who: first.who } : {}),
    ...(typeof first?.since === "string" ? { since: first.since } : {}),
  }
}

/** The engine's wait, asked to the manager. It answers at once even when the engine is off. */
export function engineWait(): Promise<EngineWait | undefined> {
  if (!engineOrigin) return Promise.resolve(undefined)
  return fetch(`${engineOrigin}/engine`, { headers: engineHeaders(), signal: AbortSignal.timeout(2000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then(parseWait)
    // An engine without a manager (llama-server alone): no wait to report.
    .catch(() => undefined)
}

let readingRequest: Promise<EngineReading | undefined> | undefined

// The engine answers between one prefill block and the next: with blocks of 2048 tokens that is a few seconds.
const ENGINE_SLOTS_TIMEOUT_MS = 8000

/**
 * Prefill in progress in the engine. One request at a time: the engine answers between one compute block and
 * the next, and several pages asking together must not queue up.
 */
export function readingProgress(): Promise<EngineReading | undefined> {
  if (!engineOrigin) return Promise.resolve(undefined)
  readingRequest ??= fetch(`${engineOrigin}/slots?lite=1`, { headers: engineHeaders(), signal: AbortSignal.timeout(ENGINE_SLOTS_TIMEOUT_MS) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then(parseReading)
    // Engine stopped or without the endpoint: no progress, and the page shows only the time.
    .catch(() => undefined)
    .finally(() => {
      readingRequest = undefined
    })
  return readingRequest
}
