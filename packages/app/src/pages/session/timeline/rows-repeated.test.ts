import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline, TimelineRow } from "./rows"

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const assistant = (id: string, extra: Partial<AssistantMessage> = {}) =>
  ({ id, role: "assistant", parentID: "msg_1", time: { created: 2, completed: 3 }, ...extra }) as AssistantMessage
const text = (messageID: string, extra: Record<string, unknown> = {}) =>
  ({ id: `prt_t_${messageID}`, type: "text", messageID, text: "Fatto.", ...extra }) as Part
const cutText = (messageID: string) => text(messageID, { metadata: { harness: { repeated: true } } })
const reasoning = (messageID: string, extra: Record<string, unknown> = {}) =>
  ({ id: `prt_r_${messageID}`, type: "reasoning", messageID, text: "Ci penso.", time: { start: 2, end: 3 }, ...extra }) as Part

const keys = (input: { messages: AssistantMessage[]; parts: Part[]; status?: "idle" | "busy" }) =>
  Timeline.constructMessageRows(
    user,
    (id) => input.parts.filter((part) => part.messageID === id),
    input.messages,
    0,
    input.status ?? "idle",
    true,
    true,
  ).map(TimelineRow.key)

describe("an answer cut because it kept writing the same text", () => {
  test("has one line, where the turn ends", () => {
    const result = keys({ messages: [assistant("msg_2")], parts: [cutText("msg_2")] })
    expect(result.filter((key) => key.startsWith("repeated:"))).toEqual(["repeated:msg_1:msg_2"])
  })

  test("has the line for the answer that was cut, and none for the one the turn took up after it", () => {
    const result = keys({
      messages: [assistant("msg_2"), assistant("msg_3", { finish: "stop" })],
      parts: [cutText("msg_2"), text("msg_3")],
    })
    expect(result.filter((key) => key.startsWith("repeated:"))).toEqual(["repeated:msg_1:msg_2"])
  })

  test("is also there when the cut part is a thought, and then the turn is not called empty", () => {
    const result = keys({
      messages: [assistant("msg_2")],
      parts: [reasoning("msg_2", { metadata: { harness: { repeated: true } } })],
    })
    expect(result).toContain("repeated:msg_1:msg_2")
    expect(result).not.toContain("empty-answer:msg_1")
  })

  test("is not there for an answer that was not cut so, or that failed", () => {
    expect(keys({ messages: [assistant("msg_2")], parts: [text("msg_2")] }).some((key) => key.startsWith("repeated:"))).toBe(false)
    const failed = assistant("msg_2", { error: { name: "APIError", data: { message: "down", isRetryable: false } } })
    expect(keys({ messages: [failed], parts: [cutText("msg_2")] }).some((key) => key.startsWith("repeated:"))).toBe(false)
  })
})
