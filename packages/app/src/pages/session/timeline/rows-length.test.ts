import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline, TimelineRow } from "./rows"

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const assistant = (id: string, extra: Partial<AssistantMessage> = {}) =>
  ({ id, role: "assistant", parentID: "msg_1", time: { created: 2, completed: 3 }, ...extra }) as AssistantMessage
const tool = (messageID: string) =>
  ({
    id: `prt_tool_${messageID}`,
    type: "tool",
    tool: "read",
    callID: "call_1",
    messageID,
    state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 2, end: 3 } },
  }) as Part
const reasoning = (messageID: string) =>
  ({ id: `prt_r_${messageID}`, type: "reasoning", messageID, text: "Ci penso.", time: { start: 2, end: 3 } }) as Part
const text = (messageID: string) => ({ id: `prt_t_${messageID}`, type: "text", messageID, text: "Fatto." }) as Part

const keys = (input: { messages: AssistantMessage[]; parts: Part[]; status?: "idle" | "busy"; active?: boolean }) =>
  Timeline.constructMessageRows(
    user,
    (id) => input.parts.filter((part) => part.messageID === id),
    input.messages,
    0,
    input.status ?? "idle",
    input.active ?? true,
    true,
  ).map(TimelineRow.key)

const cut = (id: string, extra: Partial<AssistantMessage> = {}) => assistant(id, { finish: "length", ...extra })

describe("a turn stopped for its length", () => {
  test("says so, with the way to go on, when the last answer was cut: also after tools, and also with a thought and nothing more", () => {
    expect(keys({ messages: [cut("msg_2")], parts: [tool("msg_2"), reasoning("msg_2")] })).toContain("length-stop:msg_1")
    expect(keys({ messages: [cut("msg_2")], parts: [reasoning("msg_2")] })).toContain("length-stop:msg_1")
    expect(keys({ messages: [cut("msg_2")], parts: [text("msg_2")] })).toContain("length-stop:msg_1")
    // the sentence about an answer without words is not added to it
    expect(keys({ messages: [cut("msg_2")], parts: [reasoning("msg_2")] })).not.toContain("empty-answer:msg_1")
  })

  test("tells a second cut from the first: the sentence of the row says «again» once the turn took up the answer", () => {
    const rows = (messages: AssistantMessage[]) =>
      Timeline.constructMessageRows(user, () => [], messages, 0, "idle", true, true).filter((row) => row._tag === "LengthStop")
    expect(rows([cut("msg_2")]).map((row) => row.again)).toEqual([false])
    expect(rows([cut("msg_2"), cut("msg_3")]).map((row) => row.again)).toEqual([true])
  })

  test("a turn taken up again has a line after the answer that was cut, and no sentence if the second one finished", () => {
    const result = keys({
      messages: [cut("msg_2"), assistant("msg_3", { finish: "stop" })],
      parts: [tool("msg_2"), reasoning("msg_2"), text("msg_3")],
    })
    expect(result).toContain("resumed:msg_1:msg_2")
    expect(result).not.toContain("length-stop:msg_1")
  })

  test("a turn cut twice has the line and then the sentence", () => {
    const result = keys({ messages: [cut("msg_2"), cut("msg_3")], parts: [reasoning("msg_2"), reasoning("msg_3")] })
    expect(result).toContain("resumed:msg_1:msg_2")
    expect(result).toContain("length-stop:msg_1")
    expect(result.indexOf("resumed:msg_1:msg_2")).toBeLessThan(result.indexOf("length-stop:msg_1"))
    expect(result.filter((key) => key.startsWith("resumed:"))).toHaveLength(1)
  })

  test("nothing while the turn goes on, or for an answer that ended in another way or with an error", () => {
    expect(keys({ messages: [cut("msg_2")], parts: [text("msg_2")], status: "busy" })).not.toContain("length-stop:msg_1")
    expect(keys({ messages: [assistant("msg_2", { finish: "stop" })], parts: [text("msg_2")] })).not.toContain("length-stop:msg_1")
    expect(keys({ messages: [assistant("msg_2", { finish: "tool-calls" })], parts: [tool("msg_2")] })).not.toContain("length-stop:msg_1")
    const failed = cut("msg_2", { error: { name: "APIError", data: { message: "down", isRetryable: false } } })
    expect(keys({ messages: [failed], parts: [text("msg_2")] })).not.toContain("length-stop:msg_1")
    const stopped = cut("msg_2", { error: { name: "MessageAbortedError", data: { message: "" } } })
    expect(keys({ messages: [stopped], parts: [text("msg_2")] })).not.toContain("length-stop:msg_1")
    expect(keys({ messages: [cut("msg_2", { time: { created: 2 } })], parts: [] })).not.toContain("length-stop:msg_1")
  })
})
