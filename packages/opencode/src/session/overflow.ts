import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"

/** How long a summary is, at the most, in what the model reads after it. */
export const SUMMARY_TOKENS = 4_096
/** The room the model needs to reason about the conversation and write its summary, at the least. */
export const SUMMARY_ROOM = 8_192

/** The part of the context kept free: the summary starts when the rest is used, at 90% of the context, or earlier when
 *  a tenth is less than the room to reason and write a summary; the configuration may set it. */
export function reserved(cfg: ConfigV1.Info, window: number) {
  return cfg.compaction?.reserved ?? Math.max(SUMMARY_ROOM, Math.ceil(window / 10))
}

/**
 * Whether the conversation, as the last step measured it, has reached the part of the context (or of the input the
 * model accepts) kept free for the summary. An answer itself has no limit of its own. `noRoom` (compaction) measures
 * the next request exactly before it is made.
 */
export function isOverflow(input: { cfg: ConfigV1.Info; tokens: SessionV1.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const window = input.model.limit.input || input.model.limit.context
  return count >= Math.max(0, window - reserved(input.cfg, window))
}
