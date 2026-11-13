import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline, TimelineRow } from "./rows"

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const assistant = (extra: Partial<AssistantMessage> = {}) =>
  ({
    id: "msg_2",
    role: "assistant",
    parentID: "msg_1",
    time: { created: 2, completed: 3 },
    ...extra,
  }) as AssistantMessage
const text = (value: string) => ({ id: "prt_1", type: "text", messageID: "msg_2", text: value }) as Part
const tool = (name: string) =>
  ({
    id: `prt_${name}`,
    type: "tool",
    tool: name,
    callID: "call_1",
    messageID: "msg_2",
    state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 2, end: 3 } },
  }) as Part
const reasoning = {
  id: "prt_r",
  type: "reasoning",
  messageID: "msg_2",
  text: "Ci penso un attimo.",
  time: { start: 2, end: 3 },
} as Part
const step = { id: "prt_3", type: "step-finish", messageID: "msg_2" } as Part

const keys = (input: { messages?: AssistantMessage[]; parts?: Part[]; status?: "idle" | "busy"; active?: boolean }) =>
  Timeline.constructMessageRows(
    user,
    (id) => (id === "msg_2" ? (input.parts ?? []) : []),
    input.messages ?? [assistant()],
    0,
    input.status ?? "idle",
    input.active ?? true,
    true,
  ).map(TimelineRow.key)

describe("an answer without text", () => {
  test("a finished answer with nothing written and nothing drawn says so", () => {
    expect(keys({ parts: [step] })).toContain("empty-answer:msg_1")
    expect(keys({ parts: [text("  \n\n")] })).toContain("empty-answer:msg_1")
    expect(keys({ parts: [text("```\n```")] })).toContain("empty-answer:msg_1")
    expect(keys({ parts: [reasoning, step] })).toContain("empty-answer:msg_1")
    expect(keys({ parts: [tool("todowrite"), step] })).toContain("empty-answer:msg_1")
    expect(keys({ parts: [step], status: "busy", active: false })).toContain("empty-answer:msg_1")
  })

  test("the sentence does not appear for an answer with words, actions, an error or still working", () => {
    expect(keys({ parts: [text("Fatto.")] })).not.toContain("empty-answer:msg_1")
    expect(keys({ parts: [tool("read")] })).not.toContain("empty-answer:msg_1")
    expect(keys({ parts: [step], status: "busy" })).not.toContain("empty-answer:msg_1")
    expect(keys({ messages: [assistant({ time: { created: 2 } })], parts: [] })).not.toContain("empty-answer:msg_1")
    expect(keys({ messages: [] })).not.toContain("empty-answer:msg_1")
    const failed = assistant({ error: { name: "APIError", data: { message: "down", isRetryable: false } } })
    expect(keys({ messages: [failed], parts: [step] })).not.toContain("empty-answer:msg_1")
    const stopped = assistant({ error: { name: "MessageAbortedError", data: { message: "" } } })
    expect(keys({ messages: [stopped], parts: [step] })).not.toContain("empty-answer:msg_1")
  })
})
