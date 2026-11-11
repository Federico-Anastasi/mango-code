// mango-code: the prompt settings page (see the server's `/mango/settings` and session/settings.ts).
// Each item has its weight in tokens, measured by the engine with the first request of a conversation: where it
// is missing it is `null` and the page writes "not measured", never an estimate.

export const PROMPT_KINDS = ["tools", "mcp", "skills", "instructions", "plugins"] as const
export type PromptKind = (typeof PROMPT_KINDS)[number]

export type PromptItem = {
  /** One of PROMPT_KINDS, or `base` (the base prompt: fixed, it cannot be turned off). */
  type: string
  name: string
  tokens: number | null
  enabled: boolean
  /** Which file the on/off comes from: `folder` if the folder changes it, `default` for all folders. */
  source: "default" | "folder" | null
}

export type PromptSettings = { directory: string; items: PromptItem[] }

function parseItem(value: unknown): PromptItem | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  if (typeof raw.type !== "string" || typeof raw.name !== "string" || typeof raw.enabled !== "boolean") return
  if (raw.tokens !== null && typeof raw.tokens !== "number") return
  if (raw.source !== null && raw.source !== "default" && raw.source !== "folder") return
  return { type: raw.type, name: raw.name, tokens: raw.tokens, enabled: raw.enabled, source: raw.source }
}

/** From the response of `GET /mango/settings`; `undefined` if it is not the expected one. */
export function parsePromptSettings(body: unknown): PromptSettings | undefined {
  if (!body || typeof body !== "object") return
  const raw = body as Record<string, unknown>
  if (typeof raw.directory !== "string" || !Array.isArray(raw.items)) return
  const items = raw.items.map(parseItem)
  if (items.some((item) => !item)) return
  return { directory: raw.directory, items: items as PromptItem[] }
}

/**
 * The items of a section: from the heaviest, the unmeasured ones last by name. An item that weighs nothing is left out
 * while it is on (a plugin that only works behind the scenes); once it is off it is listed, to turn it back on.
 */
export function itemsOf(settings: PromptSettings, kind: PromptKind | "base"): PromptItem[] {
  return settings.items
    .filter((item) => item.type === kind && (item.tokens !== 0 || !item.enabled))
    .toSorted((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name))
}

/** What the first request weighs: the base and the measured enabled items; the unmeasured enabled ones are counted apart. */
export function promptTotal(settings: PromptSettings): { tokens: number; unmeasured: number } {
  let tokens = 0
  let unmeasured = 0
  for (const item of settings.items) {
    if (!item.enabled) continue
    if (item.tokens === null) unmeasured++
    else tokens += item.tokens
  }
  return { tokens, unmeasured }
}

/** How an item is written: an instructions file of another folder (full path or address) with just its name. */
export function itemLabel(kind: string, name: string): string {
  if (kind !== "instructions") return name
  if (/^[A-Za-z]:\//.test(name) || /^https?:\/\//.test(name)) return name.split("/").pop() || name
  return name
}
