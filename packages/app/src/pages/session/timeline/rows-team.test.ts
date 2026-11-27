import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"

// one group per part, as the other tests of the rows have it: the module is shared by every file of the run
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({ type: "part" as const, key: ref.part.id, ref: { messageID: ref.messageID, partID: ref.part.id } })),
}))

const { Timeline, TimelineRow } = await import("./rows")
const { selectUserMessages } = await import("./model")

const user = (id: string) => ({ id, role: "user", time: { created: 1 } }) as UserMessage
const assistant = (id: string, parentID: string) => ({ id, role: "assistant", parentID, time: { created: 2, completed: 3 } }) as AssistantMessage
const text = (messageID: string, value: string, metadata?: Record<string, unknown>) =>
  ({ id: `prt_${messageID}`, type: "text", messageID, text: value, metadata }) as Part

describe("what the Team puts in the conversation", () => {
  const rows = (parts: Part[]) => Timeline.constructMessageRows(user("msg_1"), () => parts, [], 0, "idle", false, true)

  test("the user did not write it: the turn shows a line of the Team, never the user's message", () => {
    const keys = rows([text("msg_1", "[TEAM] The user stopped the team", { team: { kind: "stopped" } })]).map(TimelineRow.key)
    expect(keys).toEqual(["team-notice:msg_1"])
  })

  test("what the dev and the agents write to the manager is a line of the Team too, with who wrote it", () => {
    const notice = (team: Record<string, unknown>) => rows([text("msg_1", "[DEV] the file is there", { team })])
    const report = notice({ kind: "report" })
    expect(report.map(TimelineRow.key)).toEqual(["team-notice:msg_1"])
    expect(report[0]).toMatchObject({ kind: "report", agent: undefined })
    expect(notice({ kind: "report", agent: 2 })[0]).toMatchObject({ kind: "report", agent: "2" })
    expect(notice({ kind: "automatic" })[0]).toMatchObject({ kind: "automatic", agent: undefined })
    expect(notice({ kind: "automatic", agent: "1" })[0]).toMatchObject({ kind: "automatic", agent: "1" })
  })

  test("the line has the beginning of the message and the whole of it, as written", () => {
    const [row] = rows([text("msg_1", "[AGENT 1]\nThe prices are checked.\nThe cheapest is the second.", { team: { kind: "report", agent: "1" } })])
    expect(row).toMatchObject({ excerpt: "The prices are checked. The cheapest is the second.", text: "The prices are checked.\nThe cheapest is the second." })
  })

  test("a message of the user stays the user's, also when its text starts like a notice", () => {
    const keys = rows([text("msg_1", "[TEAM] I wrote this myself")]).map(TimelineRow.key)
    expect(keys).toEqual(["user-message:msg_1"])
  })

  test("a mark that is not a known one is the user's message", () => {
    expect(rows([text("msg_1", "x", { team: { kind: "somebody" } })]).map(TimelineRow.key)).toEqual(["user-message:msg_1"])
    expect(rows([text("msg_1", "x", { team: "stopped" })]).map(TimelineRow.key)).toEqual(["user-message:msg_1"])
  })

  test("it is not one of the user's messages: not a place to go back to or to fork from", () => {
    const messages: Message[] = [user("msg_a"), assistant("msg_b", "msg_a"), user("msg_c"), assistant("msg_d", "msg_c")]
    const parts = (id: string) => [text(id, "x", id === "msg_c" ? { team: { kind: "stopped" } } : undefined)]
    expect(selectUserMessages(messages, parts).map((message) => message.id)).toEqual(["msg_a"])
    const report = (id: string) => [text(id, "x", id === "msg_c" ? { team: { kind: "report" } } : undefined)]
    expect(selectUserMessages(messages, report).map((message) => message.id)).toEqual(["msg_a"])
  })
})
