// mango-code: the messages sent before the model is ready. They wait in the interface, one
// list per conversation in the order they were sent; when the model is ready they leave together as one message. The
// list is saved: a message of an earlier start of the app is not sent by itself, it goes back into its box as a draft.
import type { Prompt } from "@/context/prompt"
import type { FollowupDraft } from "@/components/prompt-input/submit"

export type PendingItem = { id: string; run: string; draft: FollowupDraft }

/** This start of the app: a waiting message of another start goes back into its box. */
export const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const SEPARATOR = "\n\n"

/** Prompts one after the other, a blank line between them, with the places of the mentions moved along. */
export function joinPrompts(prompts: Prompt[]): Prompt {
  let offset = 0
  return prompts.flatMap((prompt, index) => {
    const parts = prompt.map((part) =>
      "content" in part ? { ...part, start: part.start + offset, end: part.end + offset } : part,
    )
    offset += prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
    if (index === prompts.length - 1) return parts
    const separator = { type: "text" as const, content: SEPARATOR, start: offset, end: offset + SEPARATOR.length }
    offset += SEPARATOR.length
    return [...parts, separator]
  })
}

/**
 * The waiting messages of a conversation as the one message that leaves: their prompts in order and their context
 * together. It goes to `model` (the one now ready) when it was meant for the local engine; agent and variant are the last
 * message's.
 */
export function combine(
  items: PendingItem[],
  model?: { providerID: string; modelID: string },
): FollowupDraft | undefined {
  const last = items.at(-1)?.draft
  if (!last) return
  const context = items.flatMap((item) => item.draft.context)
  return {
    ...last,
    prompt: joinPrompts(items.map((item) => item.draft.prompt)),
    context: context.filter((item, index) => context.findIndex((other) => other.key === item.key) === index),
    model: model && last.model.providerID === model.providerID ? model : last.model,
  }
}

/**
 * The messages as they leave, in order: those written one after the other go as one message, and a «/» command goes by
 * itself, since it is run and not read.
 */
export function batches(items: PendingItem[]) {
  return items.reduce<PendingItem[][]>((groups, item) => {
    const last = groups.at(-1)
    if (!last || isCommand(item.draft) || isCommand(last[0].draft)) return [...groups, [item]]
    return [...groups.slice(0, -1), [...last, item]]
  }, [])
}

const isCommand = (draft: FollowupDraft) => pendingText(draft).startsWith("/")

/** The text a waiting message shows. */
export const pendingText = (draft: FollowupDraft) =>
  draft.prompt
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()

/** Of a conversation's list, the messages of this start (they wait) and those of an earlier one (back to the box). */
export function split(items: PendingItem[] | undefined, run: string) {
  const list = items ?? []
  return { waiting: list.filter((item) => item.run === run), earlier: list.filter((item) => item.run !== run) }
}

/** `promise`, or a failure after `ms`: a send that never answers does not keep its messages «being sent» for ever. */
export function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
