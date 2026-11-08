import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  engineTurn,
  formatRate,
  lastActivity,
  lastMeasured,
  olderWorkMs,
  ownsEngineNumbers,
  parseEngineQueue,
  parseLive,
  parseReading,
  parseWait,
  parseWorkSteps,
  readingRate,
  responseMs,
  sessionWorkMs,
  summarizeWork,
  tokensPerSecond,
  type Timings,
} from "./engine-speed"

const timings = (promptTokens: number, promptMs: number, predictedTokens: number, predictedMs: number): Timings => ({
  promptTokens,
  promptMs,
  predictedTokens,
  predictedMs,
})
const step = (created: number, completed: number | undefined, t?: Timings) => ({
  time: { created, completed },
  timings: t,
})

describe("engine speed", () => {
  test("the speed is tokens over time and disappears on measurements that are too small", () => {
    expect(tokensPerSecond(1000, 2000, 32)).toBe(500)
    expect(tokensPerSecond(21, 857.86, 32)).toBeUndefined()
    expect(tokensPerSecond(100, 0, 32)).toBeUndefined()
  })

  test("format: one decimal under 100, integer above", () => {
    expect(formatRate(793.654, "it")).toBe("794")
    expect(formatRate(33.8176, "it")).toBe("33,8")
    expect(formatRate(20.49, "en")).toBe("20.5")
  })

  test("answer with several steps: weighted speed, tiny steps do not dirty it", () => {
    const work = summarizeWork(
      [
        step(0, 10_000, timings(6500, 10_000, 100, 5000)),
        step(10_000, 12_000, timings(21, 857.86, 94, 4588.31)),
        step(12_000, 13_000, timings(29, 1293.35, 43, 2051.86)),
      ],
      20_000,
    )!
    expect(work.steps).toBe(3)
    expect(work.readTokens).toBe(6550)
    expect(work.writeTokens).toBe(237)
    // reading uses only the 6500-token step: 650 tokens/s, not the average with the two small ones
    expect(work.readRate).toBeCloseTo(650, 5)
    expect(work.writeRate).toBeCloseTo((237 * 1000) / (5000 + 4588.31 + 2051.86), 5)
    expect(work.modelMs).toBeCloseTo(10_000 + 5000 + 857.86 + 4588.31 + 1293.35 + 2051.86, 5)
    expect(work.wallMs).toBe(13_000)
  })

  test("without engine timings nothing is invented", () => {
    expect(summarizeWork([step(0, 1000)], 5000)).toBeUndefined()
    expect(summarizeWork([], 5000)).toBeUndefined()
  })

  test("answer duration: from the first step to the end of the last one", () => {
    expect(responseMs([step(1000, 4000), step(4000, 9000)])).toBe(8000)
    expect(responseMs([])).toBeUndefined()
    expect(responseMs([step(1000, undefined)])).toBeUndefined()
  })

  test("working time of the conversation: an open step counts only if the model is working", () => {
    const messages = [step(0, 5000), step(6000, 9000), step(10_000, undefined)]
    expect(sessionWorkMs(messages, false, 30_000)).toBe(8000)
    expect(sessionWorkMs(messages, true, 30_000)).toBe(28_000)
    expect(sessionWorkMs([step(0, undefined), step(1000, 2000)], true, 30_000)).toBe(1000)
  })

  test("a step cut by a restart counts up to its last activity", () => {
    const messages = [step(0, undefined), step(1000, 2000)]
    expect(sessionWorkMs(messages, false, 30_000, (m) => (m === messages[0] ? 4000 : undefined))).toBe(5000)
    expect(sessionWorkMs(messages, false, 30_000, () => undefined)).toBe(1000)
    // Activity recorded before the start of the step: inconsistent data, not counted.
    expect(sessionWorkMs([step(5000, undefined)], false, 30_000, () => 1000)).toBe(0)
  })

  test("the steps the page has not loaded are summed from the server, the others are not", () => {
    const steps = parseWorkSteps({ steps: [{ id: "a", ms: 5000 }, { id: "b", ms: 2000 }, { id: "c", ms: 0 }, { ms: 1 }] })
    expect(steps).toEqual([
      { id: "a", ms: 5000 },
      { id: "b", ms: 2000 },
    ])
    expect(olderWorkMs(steps, ["b"])).toBe(5000)
    expect(olderWorkMs(steps, [])).toBe(7000)
    expect(parseWorkSteps(undefined)).toEqual([])
  })

  test("last activity of a step: latest end or start among the parts", () => {
    const parts = [
      { type: "reasoning", time: { start: 100, end: 400 } },
      { type: "text", time: { start: 400 } },
      { type: "tool", state: { status: "running", time: { start: 700 } } },
      { type: "tool", state: { status: "pending", input: {}, raw: "" } },
    ] as unknown as Part[]
    expect(lastActivity(parts)).toBe(700)
    expect(lastActivity([])).toBeUndefined()
    expect(lastActivity(undefined)).toBeUndefined()
  })

  test("last measured speed: read and write are looked up separately", () => {
    const measured = lastMeasured([
      step(0, 1, timings(6500, 10_000, 100, 5000)),
      step(1, 2, timings(21, 857.86, 94, 4588.31)),
      step(2, 3),
    ])
    expect(measured.read?.rate).toBeCloseTo(650, 5)
    expect(measured.write?.rate).toBeCloseTo((94 * 1000) / 4588.31, 5)
    expect(lastMeasured([step(0, 1)])).toEqual({ read: undefined, write: undefined })
  })

  test("the route's live numbers are read only if complete", () => {
    const live = { promptTokens: 100, promptMs: 200, predictedTokens: 5, predictedMs: 90, updatedAt: 1 }
    expect(parseLive({ live })).toEqual(live)
    expect(parseLive({ live: null })).toBeUndefined()
    expect(parseLive({ live: { promptTokens: 1 } })).toBeUndefined()
    expect(parseLive("x")).toBeUndefined()
  })

  test("the reading in progress is read only if complete and the speed is tokens over time", () => {
    const reading = { doneTokens: 31_000, totalTokens: 72_000, ms: 50_000 }
    expect(parseReading({ live: null, reading })).toEqual(reading)
    expect(parseReading({ reading: null })).toBeUndefined()
    expect(parseReading({ reading: { doneTokens: 1 } })).toBeUndefined()
    expect(readingRate(reading)).toBe(620)
    expect(readingRate({ doneTokens: 10, totalTokens: 72_000, ms: 20 })).toBeUndefined()
  })

  test("the engine wait is read only if it is of a known kind", () => {
    expect(parseWait({ wait: { kind: "cards", who: "Video Editor", since: "2026-11-05T12:11:00+01:00" } })).toEqual({
      kind: "cards",
      who: "Video Editor",
      since: "2026-11-05T12:11:00+01:00",
    })
    expect(parseWait({ wait: { kind: "loading" } })).toEqual({ kind: "loading" })
    expect(parseWait({ wait: { kind: "unknown" } })).toBeUndefined()
    expect(parseWait({ wait: null })).toBeUndefined()
    expect(parseWait({})).toBeUndefined()
  })
})

describe("who uses the engine", () => {
  const body = {
    live: null,
    reading: { doneTokens: 37_018, totalTokens: 74_477, ms: 25_000 },
    active: { sessionID: "calc", requestSessionID: "calc", title: "Calculator in index.html", directory: "/p", since: 1 },
    waiting: [
      { sessionID: "hello", requestSessionID: "hello", since: 2 },
      { sessionID: "third", requestSessionID: "third-child", title: "  ", since: 3 },
      { invalid: true },
    ],
  }
  const queue = parseEngineQueue(body)

  test("reads who is active and who waits, discarding incomplete entries and empty titles", () => {
    expect(queue.active).toEqual({
      sessionID: "calc",
      requestSessionID: "calc",
      title: "Calculator in index.html",
      directory: "/p",
    })
    expect(queue.waiting.map((item) => item.sessionID)).toEqual(["hello", "third"])
    expect(queue.waiting[1]?.title).toBeUndefined()
    expect(parseEngineQueue(undefined)).toEqual({ active: undefined, waiting: [] })
    expect(parseEngineQueue({ active: null, waiting: "x" })).toEqual({ active: undefined, waiting: [] })
  })

  test("the active conversation has the engine numbers", () => {
    const turn = engineTurn(queue, "calc")
    expect(turn).toEqual({ kind: "active" })
    expect(ownsEngineNumbers(turn)).toBe(true)
  })

  test("the queued one waits behind the active one, with the position, and has no numbers", () => {
    const first = engineTurn(queue, "hello")
    expect(first).toMatchObject({ kind: "waiting", position: 1, queued: 2, behind: { sessionID: "calc" } })
    expect(ownsEngineNumbers(first)).toBe(false)
    expect(engineTurn(queue, "third")).toMatchObject({ kind: "waiting", position: 2, queued: 2 })
  })

  test("the request of a sub-agent counts for the conversation it started from and for itself", () => {
    expect(engineTurn(queue, "third-child")).toMatchObject({ kind: "waiting", position: 2 })
    expect(engineTurn(parseEngineQueue({ active: { sessionID: "parent", requestSessionID: "child" } }), "child")).toEqual({
      kind: "active",
    })
  })

  test("a conversation without requests while the engine is busy has no numbers", () => {
    const turn = engineTurn(queue, "another")
    expect(turn).toMatchObject({ kind: "other", behind: { sessionID: "calc" } })
    expect(ownsEngineNumbers(turn)).toBe(false)
    expect(engineTurn(queue, undefined).kind).toBe("other")
  })

  test("if the server reports no request in progress nothing is taken from anyone", () => {
    const turn = engineTurn(parseEngineQueue({ live: null, reading: null }), "hello")
    expect(turn).toEqual({ kind: "free" })
    expect(ownsEngineNumbers(turn)).toBe(true)
  })
})
