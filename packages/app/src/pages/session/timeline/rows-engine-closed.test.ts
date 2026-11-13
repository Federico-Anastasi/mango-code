import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: () => [],
}))

const { Timeline } = await import("./rows")

const user = { id: "msg_1", role: "user", time: { created: 1 } } as UserMessage
const failed = (data: object) =>
  ({
    id: "msg_2",
    role: "assistant",
    parentID: "msg_1",
    time: { created: 2, completed: 3 },
    error: { name: "APIError", data: { isRetryable: true, ...data } },
  }) as unknown as AssistantMessage

const errorRow = (message: AssistantMessage) =>
  Timeline.constructMessageRows(user, () => [], [message], 0, "idle", true, true).find((row) => row._tag === "Error")

describe("this PC's model closed in the middle of the answer", () => {
  test("the error row says the agent's sentence and offers to send the message again", () => {
    const row = errorRow(
      failed({
        message: "Il modello si è chiuso a metà risposta.",
        metadata: { code: "ECONNRESET", engine: "closed" },
      }),
    )
    expect(row).toMatchObject({
      retry: true,
      text: "Il modello si è chiuso a metà risposta.",
    })
  })

  test("any other error keeps its text with nothing to press", () => {
    expect(errorRow(failed({ message: "boom", metadata: { code: "ECONNRESET" } }))).toMatchObject({ retry: false })
    expect(errorRow(failed({ message: "boom" }))).toMatchObject({ retry: false })
  })

  test("an error that arrives without its data still makes a row, with nothing to press", () => {
    const bare = { ...failed({}), error: { name: "APIError" } } as unknown as AssistantMessage
    expect(errorRow(bare)).toMatchObject({ retry: false, text: "" })
  })
})
