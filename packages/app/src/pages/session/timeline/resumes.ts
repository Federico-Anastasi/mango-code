import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

/**
 * When an answer is cut for its length the agent takes it up once with a message of its own (a text marked `resume`).
 * That message is not a turn: it is dropped and the answers to it go to the user's message before it, so that the
 * conversation shows one turn. `resumes` has the ids of the dropped messages. Without any, `messages` is the same list.
 */
export function foldResumes(messages: Message[], parts: (messageID: string) => Part[]) {
  const resumes = new Map<string, string>()
  let turn: string | undefined
  messages.forEach((message) => {
    if (message.role !== "user") return
    if (turn && parts(message.id).some((part) => part.type === "text" && part.synthetic && part.metadata?.resume)) {
      resumes.set(message.id, turn)
      return
    }
    turn = message.id
  })
  if (resumes.size === 0) return { messages, resumes }
  return {
    messages: messages
      .filter((message) => !resumes.has(message.id))
      .map((message) =>
        message.role === "assistant" && resumes.has(message.parentID)
          ? ({ ...message, parentID: resumes.get(message.parentID)! } satisfies AssistantMessage)
          : message,
      ),
    resumes,
  }
}
