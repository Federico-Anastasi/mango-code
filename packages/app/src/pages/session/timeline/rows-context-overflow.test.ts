import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: () => [],
}))

const { Timeline, TimelineRow } = await import("./rows")

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const failed = (name: string, message: string) =>
  ({
    id: "msg_2",
    role: "assistant",
    parentID: "msg_1",
    time: { created: 2, completed: 3 },
    error: { name, data: { message } },
  }) as unknown as AssistantMessage

const rows = (messages: AssistantMessage[], compaction: boolean) =>
  Timeline.constructMessageRows(
    user,
    (id) => (compaction && id === "msg_1" ? ([{ type: "compaction" }] as never) : []),
    messages,
    0,
    "idle",
    true,
    true,
  )

describe("a conversation too long for the model", () => {
  test("the error row asks for a translated text instead of the server's English sentence", () => {
    const row = rows([failed("ContextOverflowError", "Session too large to compact")], true).find(
      (item) => item._tag === "Error",
    )
    expect(row).toMatchObject({ overflow: true })
  })

  test("it does not say the session was compacted when compacting failed", () => {
    const keys = rows([failed("ContextOverflowError", "x")], true).map(TimelineRow.key)
    expect(keys).not.toContain("turn-divider:msg_1:compaction")
  })

  test("a compaction that worked keeps its divider; other errors keep their own text", () => {
    expect(rows([], true).map(TimelineRow.key)).toContain("turn-divider:msg_1:compaction")
    const row = rows([failed("APIError", "boom")], false).find((item) => item._tag === "Error")
    expect(row).toMatchObject({ overflow: false, text: "boom" })
  })
})
