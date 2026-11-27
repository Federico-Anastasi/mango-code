import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

const held = (metadata: Record<string, unknown> | undefined) =>
  (metadata?.harness as { held?: boolean } | undefined)?.held === true
const wrote = (metadata: Record<string, unknown> | undefined) => !!metadata?.resume || held(metadata)

/** An answer of the model that the harness held back: the user does not see it. */
export const heldAnswer = (part: Part) => part.type === "text" && !part.synthetic && held(part.metadata)

/** A part the agent cut because it kept writing the same text: the answer ends there. */
export const repeatedPart = (part: Part) =>
  (part.type === "text" || part.type === "reasoning" || part.type === "tool") &&
  (part.metadata?.harness as { repeated?: boolean } | undefined)?.repeated === true

/**
 * When an answer is cut for its length the agent takes it up once with a message of its own (a text marked `resume`),
 * and when the harness holds an answer back it asks the model again the same way (marked `harness.held`).
 * That message is not a turn: it is dropped and the answers to it go to the user's message before it, so that the
 * conversation shows one turn. `resumes` has the ids of the dropped messages. Without any, `messages` is the same list.
 */
export function foldResumes(messages: Message[], parts: (messageID: string) => Part[]) {
  const resumes = new Map<string, string>()
  let turn: string | undefined
  messages.forEach((message) => {
    if (message.role !== "user") return
    if (turn && parts(message.id).some((part) => part.type === "text" && part.synthetic && wrote(part.metadata))) {
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
