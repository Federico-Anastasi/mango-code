// mango-code: the reasoning control under the box. Where the app's catalog entry is read for the levels a model offers
// and the one chosen, and where a choice is put back into the model's choices: nothing else reads or writes them.
import type { MangoModelChoices } from "@/utils/mango-desktop"
import { MANGO_PROVIDER } from "@/utils/model-info"

const REASONING_LEVELS = ["off", "on", "low", "medium", "high"] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/** The Team's manager runs on OpenRouter: its levels are the variants of the model. */
const TEAM_PROVIDER = "openrouter"
const TEAM_LEVELS = ["low", "medium", "high"] as const

const level = (value: unknown): value is ReasoningLevel => REASONING_LEVELS.some((item) => item === value)

/** `limits.reasoning` is the list of levels (empty: the model does not reason); `choices.reasoning` one of them, or absent. */
export function reasoningOf(entry: { limits: { reasoning: unknown }; choices: { reasoning?: unknown } }) {
  const { reasoning: levels } = entry.limits
  const { reasoning: chosen } = entry.choices
  return {
    levels: Array.isArray(levels) ? levels.filter(level) : [],
    chosen: level(chosen) ? chosen : undefined,
  }
}

/** The choices of a model with the reasoning level chosen. */
export const withReasoning = (choices: MangoModelChoices, value: ReasoningLevel): MangoModelChoices => ({ ...choices, reasoning: value })

/** What a model does when nothing was chosen: its last level, as the app reads it. */
const initial = (levels: readonly ReasoningLevel[]) => levels[levels.length - 1]

export type ReasoningControl =
  | { source: "local"; key: string; levels: ReasoningLevel[]; value: ReasoningLevel; choices: MangoModelChoices }
  | { source: "team"; levels: ReasoningLevel[]; value: ReasoningLevel }

/** The control the box shows for the model in use, or nothing when the model has no levels to choose from. */
export function reasoningControl(input: {
  model?: { id: string; provider?: { id: string } }
  catalog?: readonly { key: string; limits: { reasoning: unknown }; choices: MangoModelChoices }[]
  /** The other PC's engine is in use: its models are not this catalog's. */
  remote?: boolean
  variants: { list: () => string[]; current: () => string | undefined }
}): ReasoningControl | undefined {
  const { model } = input
  if (!model) return
  if (model.provider?.id === TEAM_PROVIDER) {
    const offered = input.variants.list()
    const levels = TEAM_LEVELS.filter((item) => offered.includes(item))
    if (levels.length < 2) return
    const current = input.variants.current()
    // no variant chosen: no effort is sent, and the control shows the middle level
    return { source: "team", levels, value: levels.find((item) => item === current) ?? "medium" }
  }
  if (model.provider?.id !== MANGO_PROVIDER || input.remote) return
  const entry = input.catalog?.find((item) => item.key === model.id)
  if (!entry) return
  const { levels, chosen } = reasoningOf(entry)
  if (levels.length < 2) return
  return {
    source: "local",
    key: entry.key,
    levels,
    value: chosen && levels.includes(chosen) ? chosen : initial(levels),
    choices: entry.choices,
  }
}
