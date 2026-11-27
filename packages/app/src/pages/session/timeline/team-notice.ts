import type { Part } from "@opencode-ai/sdk/v2"

/**
 * What the Team put in the conversation: it is not the user's message, so the conversation shows a line instead of it.
 * `stopped`: the Team was stopped; `report`: the dev or an agent wrote to the manager; `automatic`: the same, written
 * by the Team because the turn ended without a message. `agent` is the agent's number (the dev has none). `text` is what
 * was written, without the label the plugin puts on the first line; `excerpt` is its beginning on one line, as plain words. A stopped
 * Team has neither: its line has nothing to open.
 */
export type TeamNoticeKind = "stopped" | "report" | "automatic"

const EXCERPT = 120

/** The words of a Markdown text with none of its marks: code fences, headings, quotes, list bullets, links, emphasis and code. */
const plain = (markdown: string) =>
  markdown
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2")
    .replace(/`+([^`]+)`+/g, "$1")

export function teamNotice(
  parts: Part[],
): { kind: TeamNoticeKind; agent?: string; text: string; excerpt: string } | undefined {
  const first = parts.find((part) => part.type === "text")
  const team = first?.metadata?.team as { kind?: unknown; agent?: unknown } | undefined
  const kind = team?.kind
  if (kind !== "stopped" && kind !== "report" && kind !== "automatic") return
  const agent = typeof team?.agent === "number" || typeof team?.agent === "string" ? String(team.agent) : undefined
  const raw = first?.type === "text" ? first.text : ""
  const text = kind !== "stopped" && raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1).trim() : ""
  const line = plain(text).replace(/\s+/g, " ").trim()
  return { kind, agent, text, excerpt: line.length > EXCERPT ? `${line.slice(0, EXCERPT).trimEnd()}…` : line }
}
