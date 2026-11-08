// Title of a conversation from the first words of the user's message (Mango Code).
// Deterministic and instant: no call to the local engine, which is slow and shared.

const MAX_WORDS = 8
const MAX_CHARS = 60

export function titleFromText(text: string): string | undefined {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\/[\w-]+\s*/, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>~|]/g, " ")
    .replace(/^[\s\-+•.:;,!?"'()\[\]{}@]+/, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return undefined

  const words = cleaned.split(" ")
  let title = ""
  let cut = words.length > MAX_WORDS
  for (const word of words.slice(0, MAX_WORDS)) {
    const next = title ? `${title} ${word}` : word
    if (next.length > MAX_CHARS && title) {
      cut = true
      break
    }
    title = next
  }
  if (title.length > MAX_CHARS) {
    title = title.slice(0, MAX_CHARS - 1).trimEnd()
    cut = true
  }
  title = title.replace(/[\s,;:.!?\-–]+$/, "")
  title = title.charAt(0).toUpperCase() + title.slice(1)
  return cut ? `${title}…` : title
}
