import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt-state"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  let target = input.target
  let cleared: Prompt | undefined

  return {
    prompt: input.prompt,
    context: input.context,
    target: () => target,
    /** Empties the box; `kept` are the parts that were not sent and stay in it. */
    clear(kept: Prompt = []) {
      if (initial !== target) initial.reset()
      target.reset()
      if (kept.length > 0) target.set([...DEFAULT_PROMPT, ...kept], 0)
      cleared = target.current()
    },
    retarget(next: PromptTarget) {
      input.context.forEach(next.context.add)
      target = next
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (cleared !== undefined && target.current() !== cleared) return
      return { target, prompt: input.prompt, context: input.context }
    },
  }
}
