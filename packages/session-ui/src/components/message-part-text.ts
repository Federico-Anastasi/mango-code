export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

// A code block with nothing inside is drawn as an empty dark box: a reply made only of those has nothing to show.
const emptyCodeBlock = /^[ \t]{0,3}(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]{0,3}\1[`~]*[ \t]*$/gm

export function hasContent(text: string | undefined): boolean {
  return !!text?.replace(emptyCodeBlock, "").trim()
}

/** Tools the chat does not draw: a turn that only used these shows nothing of them. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["todowrite"])
