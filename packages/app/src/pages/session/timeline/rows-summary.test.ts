import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

// one group per part, as the other tests of the rows have it: the module is shared by every file of the run
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({ type: "part" as const, key: ref.part.id, ref: { messageID: ref.messageID, partID: ref.part.id } })),
}))

const { Timeline, TimelineRow } = await import("./rows")

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const assistant = (id: string, extra: Partial<AssistantMessage> = {}) =>
  ({ id, role: "assistant", parentID: "msg_1", time: { created: 2, completed: 3 }, ...extra }) as AssistantMessage
const text = (messageID: string, value: string) => ({ id: `prt_${messageID}`, type: "text", messageID, text: value }) as Part

describe("a summary in the middle of the work", () => {
  test("its text is for the model: the user sees where it happened, and the work before and after it", () => {
    const messages = [assistant("msg_2"), assistant("msg_3", { summary: true, mode: "compaction" }), assistant("msg_4")]
    const parts: Record<string, Part[]> = {
      msg_2: [text("msg_2", "Reading the files.")],
      msg_3: [text("msg_3", "This summary was put together from the work itself, not written by you")],
      msg_4: [text("msg_4", "Here are the six files.")],
    }
    const rows = Timeline.constructMessageRows(user, (id) => parts[id] ?? [], messages, 0, "idle", false, true)
    const keys = rows.map(TimelineRow.key)
    expect(keys).toContain("summarized:msg_1:msg_3")
    const shown = rows.flatMap((row) =>
      row._tag !== "AssistantPart" ? [] : row.group.type === "part" ? [row.group.ref.messageID] : row.group.refs.map((ref) => ref.messageID),
    )
    expect(shown).toEqual(["msg_2", "msg_4"])
    // in its place in the turn: after the work before it, before the work after it
    const at = (key: string) => keys.findIndex((k) => k.startsWith(key))
    expect(at("assistant-part:msg_1")).toBeLessThan(at("summarized:"))
    expect(keys.findLastIndex((k) => k.startsWith("assistant-part:msg_1"))).toBeGreaterThan(at("summarized:"))
  })
})
