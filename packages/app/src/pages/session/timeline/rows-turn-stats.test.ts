import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: () => [],
}))

const { Timeline, TimelineRow } = await import("./rows")

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const timings = { promptTokens: 21, promptMs: 857.86, predictedTokens: 94, predictedMs: 4588.31 }
const assistant = (withTimings: boolean) =>
  ({
    id: "msg_2",
    role: "assistant",
    parentID: "msg_1",
    time: { created: 2, completed: 3 },
    ...(withTimings ? { timings } : {}),
  }) as AssistantMessage

const keys = (messages: AssistantMessage[], status: "idle" | "busy", isActive: boolean) =>
  Timeline.constructMessageRows(user, () => [], messages, 0, status, isActive, true).map(TimelineRow.key)

describe("turn stats row", () => {
  test("it appears under the finished answer that has the engine timings", () => {
    expect(keys([assistant(true)], "idle", true)).toContain("turn-stats:msg_1")
    expect(keys([assistant(true)], "busy", false)).toContain("turn-stats:msg_1")
  })

  test("it does not appear while the turn works nor without measurements", () => {
    expect(keys([assistant(true)], "busy", true)).not.toContain("turn-stats:msg_1")
    expect(keys([assistant(false)], "idle", true)).not.toContain("turn-stats:msg_1")
    expect(keys([], "idle", true)).not.toContain("turn-stats:msg_1")
  })
})
