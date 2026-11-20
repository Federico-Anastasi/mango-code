import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { beforeRevert, isTimelineReady, loadOlderTimeline, selectUserMessages } from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_z"), assistant("msg_a"), user("msg_b"), user("msg_c")]
    const users = selectUserMessages(messages, () => [])

    expect(users.map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_c"])
    expect(beforeRevert(users, "msg_b").map((message) => message.id)).toEqual(["msg_z"])
    expect(beforeRevert(users)).toBe(users)
  })

  test("the message the agent writes to take up a cut answer is not one of the user's", () => {
    const messages: Message[] = [user("msg_a"), assistant("msg_b"), user("msg_c"), assistant("msg_d"), user("msg_e")]
    const parts = (id: string) =>
      id === "msg_c"
        ? ([{ id: "prt_c", type: "text", sessionID: "ses_1", messageID: id, synthetic: true, text: "Go on.", metadata: { resume: "length" } }] as Part[])
        : ([{ id: `prt_${id}`, type: "text", sessionID: "ses_1", messageID: id, text: "Ciao." }] as Part[])
    expect(selectUserMessages(messages, parts).map((message) => message.id)).toEqual(["msg_a", "msg_e"])
  })

  test("a resume message and its answer stay in the conversation shown; only the revert point cuts it", () => {
    const messages: Message[] = [user("msg_a"), assistant("msg_b"), user("msg_c"), assistant("msg_d"), user("msg_e"), assistant("msg_f")]
    expect(beforeRevert(messages)).toBe(messages)
    expect(beforeRevert(messages, "msg_e").map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_d"])
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})
