import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { turnOf } from "../../src/session/summary"

const user = (id: string, resume?: string) =>
  ({
    info: { id, role: "user" },
    parts: [{ type: "text", synthetic: !!resume, text: "x", ...(resume ? { metadata: { resume } } : {}) }],
  }) as unknown as SessionV1.WithParts
const assistant = (id: string, parentID: string) =>
  ({ info: { id, role: "assistant", parentID }, parts: [] }) as unknown as SessionV1.WithParts

describe("the turn whose changes a summary counts", () => {
  const all = [
    user("u1"),
    assistant("a1", "u1"),
    user("w1", "length"),
    assistant("a2", "w1"),
    user("u2"),
    assistant("a3", "u2"),
  ]

  test("an answer to the message that took up a cut answer counts for the user's message before it", () => {
    const turn = turnOf(all, "w1")
    expect(String(turn?.target.id)).toBe("u1")
    expect(turn?.messages.map((message) => String(message.info.id))).toEqual(["u1", "a1", "w1", "a2"])
  })

  test("the user's own message counts its answers and the ones after a take-up, not the next turn", () => {
    expect(turnOf(all, "u1")?.messages.map((message) => String(message.info.id))).toEqual(["u1", "a1", "w1", "a2"])
    expect(turnOf(all, "u2")?.messages.map((message) => String(message.info.id))).toEqual(["u2", "a3"])
  })

  test("a message that is not there, or not the user's, has no turn", () => {
    expect(turnOf(all, "nope")).toBeUndefined()
    expect(turnOf(all, "a1")).toBeUndefined()
  })
})
