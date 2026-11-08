import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

export type Waiting = {
  /** Since when the model gives no visible signs: the last real end of a step, or the send. */
  since: number
  /** At least one step has already appeared: the model is working, it is not still reading the request. */
  afterParts: boolean
}

function liveText(part: Part & { type: "reasoning" | "text" }) {
  return !!part.text?.trim() && typeof part.time?.end !== "number"
}

function live(part: Part) {
  if (part.type === "reasoning" || part.type === "text") return liveText(part)
  if (part.type !== "tool") return false
  return part.state.status === "pending" || part.state.status === "running"
}

function end(part: Part) {
  if (part.type === "reasoning" || part.type === "text") return part.time?.end
  if (part.type === "tool" && "time" in part.state && "end" in part.state.time) return part.state.time.end
}

/**
 * If nothing is moving in the turn (reasoning, answer or tool in progress) the model
 * is reading or preparing: it returns since when. Otherwise `undefined`: the live part already shows
 * its own timer.
 */
export function waitingState(
  user: Pick<UserMessage, "time">,
  assistants: Pick<AssistantMessage, "id" | "time">[],
  getParts: (messageID: string) => Part[],
): Waiting | undefined {
  const parts = assistants.flatMap((message) => getParts(message.id))
  const current = assistants.at(-1)
  if (current && typeof current.time.completed !== "number" && getParts(current.id).some(live)) return
  const moments = [user.time.created, ...assistants.map((message) => message.time.created)]
  parts.forEach((part) => {
    const value = end(part)
    if (typeof value === "number") moments.push(value)
  })
  return {
    since: Math.max(...moments),
    afterParts: parts.some((part) => part.type === "reasoning" || part.type === "text" || part.type === "tool"),
  }
}
