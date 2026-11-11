import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  engineIsRemote,
  engineTimingsExtractor,
  engineWait,
  liveTimings,
  parseReading,
  parseTimings,
  parseWait,
  readingProgress,
  savedTimings,
  setEngineOrigin,
} from "@/provider/engine-timings"

// Final chunk as llama-server sends it (same numbers as its `eval time` log).
const final = {
  timings: { prompt_n: 21, prompt_ms: 857.86, predicted_n: 94, predicted_ms: 4588.31, predicted_per_second: 20.49 },
}

describe("engine timings", () => {
  test("reads the engine fields and discards incomplete data", () => {
    expect(parseTimings(final.timings)).toEqual({
      promptTokens: 21,
      promptMs: 857.86,
      predictedTokens: 94,
      predictedMs: 4588.31,
    })
    expect(parseTimings({ prompt_n: 21 })).toBeUndefined()
    expect(parseTimings({ prompt_n: null, predicted_n: 3 })).toBeUndefined()
    expect(parseTimings(undefined)).toBeUndefined()
  })

  test("whole prompt in cache: prefill at zero, not a missing value", () => {
    expect(parseTimings({ prompt_n: 0, prompt_ms: 0, prompt_per_second: null, predicted_n: 5, predicted_ms: 100 })).toEqual({
      promptTokens: 0,
      promptMs: 0,
      predictedTokens: 5,
      predictedMs: 100,
    })
  })

  test("the stream exposes the numbers live and hands them over as metadata at the end of the step", () => {
    const extractor = engineTimingsExtractor("mango").createStreamExtractor()
    expect(liveTimings()).toBeUndefined()
    extractor.processChunk({ choices: [] })
    expect(liveTimings()).toBeUndefined()
    extractor.processChunk({ timings: { prompt_n: 21, prompt_ms: 857.86, predicted_n: 3, predicted_ms: 140 } })
    expect(liveTimings()?.predictedTokens).toBe(3)
    extractor.processChunk(final)
    expect(liveTimings()?.predictedTokens).toBe(94)
    expect(extractor.buildMetadata()).toEqual({
      mango: { timings: { promptTokens: 21, promptMs: 857.86, predictedTokens: 94, predictedMs: 4588.31 } },
    })
    expect(liveTimings()).toBeUndefined()
  })

  test("the end-of-step metadata reads back unchanged (it is what the processor saves)", () => {
    const extractor = engineTimingsExtractor("mango").createStreamExtractor()
    extractor.processChunk(final)
    const metadata = extractor.buildMetadata()
    expect(savedTimings(metadata?.mango?.timings)).toEqual(parseTimings(final.timings))
    expect(savedTimings({ promptTokens: 1 })).toBeUndefined()
    expect(savedTimings(undefined)).toBeUndefined()
  })

  test("a stream without timings leaves no metadata", () => {
    const extractor = engineTimingsExtractor("mango").createStreamExtractor()
    extractor.processChunk({ choices: [{ delta: { content: "hello" } }] })
    expect(extractor.buildMetadata()).toBeUndefined()
  })

  test("a stream that has been silent too long is no longer live", () => {
    const extractor = engineTimingsExtractor("mango").createStreamExtractor()
    extractor.processChunk(final)
    expect(liveTimings(Date.now() + 10_000)).toBeUndefined()
  })

  test("non-streaming response", async () => {
    expect(await engineTimingsExtractor("mango").extractMetadata({ parsedBody: final })).toEqual({
      mango: { timings: { promptTokens: 21, promptMs: 857.86, predictedTokens: 94, predictedMs: 4588.31 } },
    })
    expect(await engineTimingsExtractor("mango").extractMetadata({ parsedBody: {} })).toBeUndefined()
  })
})

describe("prompt prefill", () => {
  const slot = (extra: Record<string, unknown>) => ({
    id: 0,
    state: 0,
    is_processing: true,
    n_prompt_tokens: 72000,
    n_past_prompt: 31000,
    n_prompt_tokens_cache: 0,
    t_prompt_ms: 50000,
    ...extra,
  })

  test("reads the tokens done and to do, not counting the part already in cache", () => {
    expect(parseReading([slot({})])).toEqual({ doneTokens: 31000, totalTokens: 72000, ms: 50000 })
    expect(parseReading([slot({ n_prompt_tokens_cache: 70000, n_past_prompt: 70400, n_prompt_tokens: 70600 })])).toEqual({
      doneTokens: 400,
      totalTokens: 600,
      ms: 50000,
    })
  })

  test("no prefill if the slot is idle, if it has finished reading or if data is missing", () => {
    expect(parseReading([slot({ is_processing: false })])).toBeUndefined()
    expect(parseReading([slot({ n_past_prompt: 72000 })])).toBeUndefined()
    expect(parseReading([{ id: 0, state: 1 }])).toBeUndefined()
    expect(parseReading({ error: "x" })).toBeUndefined()
    expect(parseReading([])).toBeUndefined()
  })
})

describe("engine wait", () => {
  const engine = (extra: Record<string, unknown>) => ({ phase: "running", name: "Qwen3.6-35B-A3B", loans: [], ...extra })

  test("GPUs on loan: who has them and since when", () => {
    const loan = { gpus: null, pid: 4242, who: "Video Editor", since: "2026-11-05T12:11:00+01:00" }
    expect(parseWait(engine({ phase: "released", loans: [loan] }))).toEqual({
      kind: "cards",
      who: "Video Editor",
      since: "2026-11-05T12:11:00+01:00",
    })
    expect(parseWait(engine({ phase: "releasing", loans: [loan] }))?.kind).toBe("cards")
    // a loan without the name of who asked for it, or no loans (the model does not fit on the remaining GPUs)
    expect(parseWait(engine({ phase: "released", loans: [{ ...loan, who: "" }] }))).toEqual({
      kind: "cards",
      since: "2026-11-05T12:11:00+01:00",
    })
    expect(parseWait(engine({ phase: "released" }))).toEqual({ kind: "cards" })
  })

  test("model loading", () => {
    expect(parseWait(engine({ phase: "starting", name: null, model: "3.6" }))).toEqual({ kind: "loading" })
  })

  test("engine on, or a response that is not the manager's: no wait", () => {
    expect(parseWait(engine({}))).toBeUndefined()
    expect(parseWait({ error: "x" })).toBeUndefined()
    expect(parseWait(undefined)).toBeUndefined()
  })
})

describe("the engine of another PC", () => {
  const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef"
  const seen: Record<string, string | null> = {}
  let manager: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    manager = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        seen[path] = req.headers.get("authorization")
        if (path === "/engine") return Response.json({ phase: "starting" })
        return Response.json([{ is_processing: true, n_prompt_tokens: 100, n_past_prompt: 40, n_prompt_tokens_cache: 0, t_prompt_ms: 900 }])
      },
    })
    setEngineOrigin(`http://127.0.0.1:${manager.port}/v1`)
  })

  afterAll(() => {
    delete process.env.MANGO_ENGINE_KEY
    manager.stop(true)
  })

  test("the two reads of the manager carry the key when the engine is another PC's, and nothing on this PC", async () => {
    delete process.env.MANGO_ENGINE_KEY
    expect(engineIsRemote()).toBe(false)
    expect(await engineWait()).toEqual({ kind: "loading" })
    expect(await readingProgress()).toBeDefined()
    expect(seen).toEqual({ "/engine": null, "/slots": null })

    process.env.MANGO_ENGINE_KEY = KEY
    expect(engineIsRemote()).toBe(true)
    expect(await engineWait()).toEqual({ kind: "loading" })
    expect(await readingProgress()).toEqual({ doneTokens: 40, totalTokens: 100, ms: 900 })
    expect(seen).toEqual({ "/engine": `Bearer ${KEY}`, "/slots": `Bearer ${KEY}` })
  })
})
