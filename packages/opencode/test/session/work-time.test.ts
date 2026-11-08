import { describe, expect, test } from "bun:test"
import { partActivity, workSteps } from "@/session/work-time"

const message = (id: string, role: string, created: number, completed?: number) => ({
  id,
  data: { role, time: { created, ...(completed === undefined ? {} : { completed }) } },
})

describe("work time", () => {
  test("counts only the assistant steps, from creation to the end", () => {
    const steps = workSteps(
      [message("u1", "user", 0, 100), message("a1", "assistant", 1000, 4000), message("a2", "assistant", 5000, 5500)],
      () => [],
    )
    expect(steps).toEqual([
      { id: "a1", ms: 3000 },
      { id: "a2", ms: 500 },
    ])
  })

  test("a step without an end counts up to the last activity of its parts, and without any it is left out", () => {
    const parts: Record<string, unknown[]> = {
      cut: [
        { type: "reasoning", time: { start: 1100, end: 2000 } },
        { type: "tool", state: { status: "running", time: { start: 2500 } } },
      ],
    }
    const steps = workSteps(
      [message("cut", "assistant", 1000), message("empty", "assistant", 9000)],
      (id) => parts[id] ?? [],
    )
    expect(steps).toEqual([{ id: "cut", ms: 1500 }])
  })

  test("parts without times give no activity", () => {
    expect(partActivity({ type: "text", text: "x" })).toBeUndefined()
    expect(partActivity({ type: "tool", state: { status: "pending" } })).toBeUndefined()
    expect(partActivity("x")).toBeUndefined()
  })
})
