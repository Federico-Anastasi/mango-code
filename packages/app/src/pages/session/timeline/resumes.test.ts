import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { foldResumes } from "./resumes"

const user = (id: string) => ({ id, role: "user", time: { created: 1 } }) as UserMessage
const assistant = (id: string, parentID: string) =>
  ({ id, role: "assistant", parentID, time: { created: 2, completed: 3 } }) as AssistantMessage
const words = (messageID: string) => ({ id: `p_${messageID}`, type: "text", messageID, text: "Ciao." }) as Part
const resume = (messageID: string) =>
  ({ id: `p_${messageID}`, type: "text", sessionID: "ses_1", messageID, synthetic: true, text: "Go on.", metadata: { resume: "length" } }) as Part
const note = (messageID: string) =>
  ({ id: `p_${messageID}`, type: "text", sessionID: "ses_1", messageID, synthetic: true, text: "Look at this." }) as Part

const partsOf = (parts: Part[]) => (id: string) => parts.filter((part) => part.messageID === id)

describe("a turn the agent took up again by itself", () => {
  test("belongs to the turn before it: the message that asked is left out and its answers go to the user's message", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2"), user("u3")]
    const folded = foldResumes(messages, partsOf([words("u1"), resume("u2"), words("u3")]))
    expect(folded.messages.map((message) => message.id)).toEqual(["u1", "a1", "a2", "u3"])
    expect(folded.messages.find((message) => message.id === "a2")).toMatchObject({ parentID: "u1" })
    expect(folded.resumes.has("u2")).toBe(true)
    expect(folded.resumes.has("u3")).toBe(false)
    // the originals are not touched
    expect((messages[3] as AssistantMessage).parentID).toBe("u2")
  })

  test("a second one in the same turn goes to the same user's message", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2"), user("u3"), assistant("a3", "u3")]
    const folded = foldResumes(messages, partsOf([words("u1"), resume("u2"), resume("u3")]))
    expect(folded.messages.map((message) => (message.role === "assistant" ? message.parentID : message.id))).toEqual(["u1", "u1", "u1", "u1"])
  })

  test("other synthetic messages (a comment on a file) stay turns of their own, and with nothing to fold the list is the same one", () => {
    const messages: Message[] = [user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2")]
    const folded = foldResumes(messages, partsOf([words("u1"), note("u2")]))
    expect(folded.messages).toBe(messages)
    expect(folded.resumes.size).toBe(0)
  })

  test("without a message of the user's before it, it is a turn of its own", () => {
    const messages: Message[] = [user("u2"), assistant("a2", "u2")]
    expect(foldResumes(messages, partsOf([resume("u2")])).messages).toBe(messages)
  })
})
