import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { waitingState } from "./waiting"

const user = { time: { created: 1_000 } }
const assistant = (id: string, created: number, completed?: number) => ({ id, time: { created, completed } })
const reasoning = (time: { start: number; end?: number }, text = "thinking") =>
  ({ type: "reasoning", text, time }) as unknown as Part
const text = (time: { start: number; end?: number }, body = "hello") =>
  ({ type: "text", text: body, time }) as unknown as Part
const tool = (state: Record<string, unknown>) => ({ type: "tool", tool: "write", state }) as unknown as Part
const parts = (map: Record<string, Part[]>) => (id: string) => map[id] ?? []

describe("waitingState", () => {
  test("before any part it waits since the request was sent", () => {
    expect(waitingState(user, [], parts({}))).toEqual({ since: 1_000, afterParts: false })
  })

  test("with the model message created it counts from there", () => {
    expect(waitingState(user, [assistant("a", 1_200)], parts({}))).toEqual({ since: 1_200, afterParts: false })
  })

  test("a reasoning in progress already has its timer", () => {
    expect(waitingState(user, [assistant("a", 1_200)], parts({ a: [reasoning({ start: 1_500 })] }))).toBeUndefined()
  })

  test("a reasoning without text is not visible yet: it waits", () => {
    const result = waitingState(user, [assistant("a", 1_200)], parts({ a: [reasoning({ start: 1_500 }, "")] }))
    expect(result?.since).toBe(1_200)
  })

  test("a flowing answer and a tool in progress have their own sign of life", () => {
    expect(waitingState(user, [assistant("a", 1_200)], parts({ a: [text({ start: 1_300 })] }))).toBeUndefined()
    expect(
      waitingState(user, [assistant("a", 1_200)], parts({ a: [tool({ status: "running", time: { start: 1_400 } })] })),
    ).toBeUndefined()
    expect(waitingState(user, [assistant("a", 1_200)], parts({ a: [tool({ status: "pending" })] }))).toBeUndefined()
  })

  test("when everything is done, it counts from the last real end", () => {
    const done = [
      reasoning({ start: 1_300, end: 5_000 }),
      tool({ status: "completed", time: { start: 6_000, end: 6_020 } }),
    ]
    expect(waitingState(user, [assistant("a", 1_200, 6_100)], parts({ a: done }))).toEqual({
      since: 6_020,
      afterParts: true,
    })
  })

  test("a step not closed but already concluded by the server does not block the wait", () => {
    const stale = [reasoning({ start: 1_300 })]
    expect(waitingState(user, [assistant("a", 1_200, 2_000)], parts({ a: stale }))?.afterParts).toBe(true)
  })

  test("the next message is the one that counts", () => {
    const first = [reasoning({ start: 1_300, end: 2_000 })]
    const result = waitingState(user, [assistant("a", 1_200, 3_000), assistant("b", 3_100)], parts({ a: first }))
    expect(result).toEqual({ since: 3_100, afterParts: true })
  })
})
