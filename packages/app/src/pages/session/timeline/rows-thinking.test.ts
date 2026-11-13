import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: () => [],
}))

const { Timeline } = await import("./rows")

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const assistant = { id: "msg_2", role: "assistant", parentID: "msg_1", time: { created: 2 } } as AssistantMessage
const tool = (state: Record<string, unknown>) => ({ type: "tool", tool: "read", state }) as unknown as Part

const thinking = (parts: Part[], status: "idle" | "busy" = "busy") =>
  Timeline.constructMessageRows(user, () => parts, [assistant], 0, status, true, true).flatMap((row) =>
    row._tag === "Thinking" ? [row] : [],
  )

describe("thinking row", () => {
  // Between two quick actions the line comes and goes: if the row came and went with it, the chat would rise and fall
  // by its height at every action.
  test("it keeps its place while a tool is running, with nothing to say", () => {
    const [row] = thinking([tool({ status: "running", time: { start: 5 } })])
    expect(row).toBeDefined()
    expect(row?.since).toBeUndefined()
  })

  test("it says since when between two actions", () => {
    const [row] = thinking([tool({ status: "completed", time: { start: 5, end: 9 } })])
    expect(row?.since).toBe(9)
    expect(row?.afterParts).toBe(true)
  })

  test("it is not there when the turn is not working", () => {
    expect(thinking([tool({ status: "completed", time: { start: 5, end: 9 } })], "idle")).toEqual([])
  })
})
