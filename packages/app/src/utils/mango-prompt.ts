// mango-code: the prompt settings page (see the server's `/mango/settings` and session/settings.ts).
// Each item has its weight in tokens, measured by the engine with the first request of a conversation: where it
// is missing it is `null` and the page writes "not measured", never an estimate.

export const PROMPT_KINDS = ["tools", "mcp", "skills", "instructions", "plugins"] as const
export type PromptKind = (typeof PROMPT_KINDS)[number]

/** The rows of the Agent section: what each lists. Instructions and plugins are one row, both are text added to the prompt. */
export const PROMPT_GROUPS = [
  { id: "tools", kinds: ["tools"] },
  { id: "mcp", kinds: ["mcp"] },
  { id: "skills", kinds: ["skills"] },
  { id: "instructions", kinds: ["instructions", "plugins"] },
] as const satisfies readonly { id: string; kinds: readonly PromptKind[] }[]
export type PromptGroup = (typeof PROMPT_GROUPS)[number]

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

/** Mango Code's own MCP servers (launcher/opencode-home/opencode.template.json), by what they are for. */
const OWN_MCP: Record<string, OwnMcp> = {
  "chrome-devtools": "browser",
  documents: "documents",
  "web-search": "search",
}
export type OwnMcp = "browser" | "documents" | "search"

/**
 * How an MCP server is named on screen, among `servers`: Mango Code's own ones by the name the user knows (`label`),
 * the user's by theirs. If one of the user's servers already goes by that name, ours keeps its own: two rows with the
 * same name could not be told apart.
 */
export function mcpLabel(name: string, servers: readonly string[], label: (own: OwnMcp) => string) {
  if (!Object.hasOwn(OWN_MCP, name)) return name
  const known = label(OWN_MCP[name])
  return servers.some((other) => other !== name && other.toLowerCase() === known.toLowerCase()) ? name : known
}

/** The items a row of the Agent section lists, and how many of them are on. */
export function groupCount(settings: PromptSettings, group: PromptGroup) {
  const listed = group.kinds.flatMap((kind) => itemsOf(settings, kind))
  return { on: listed.filter((item) => item.enabled).length, all: listed.length }
}

/** The parts of the first request, for the bar: the base and each row's enabled items that were measured, those that weigh. */
export function promptShares(settings: PromptSettings) {
  const measured = (kinds: readonly (PromptKind | "base")[]) =>
    settings.items
      .filter((item) => item.enabled && (kinds as readonly string[]).includes(item.type))
      .reduce((sum, item) => sum + (item.tokens ?? 0), 0)
  return [
    { id: "base" as const, tokens: measured(["base"]) },
    ...PROMPT_GROUPS.map((group) => ({ id: group.id, tokens: measured(group.kinds) })),
  ].filter((share) => share.tokens > 0)
}
