// mango-code: a model that is stuck writes the same text again and again until the context is full. The end of what it
// is generating is the same exact text repeated: the answer is cut there. Exact repetition only, and many copies: a
// text that merely resembles itself (code, a table, a list) is never cut.

export type Rule = {
  /** The fewest whole copies of the repeated text. */
  copies: number
  /** The fewest characters the whole copies cover. */
  chars: number
}

/** The answer text and the reasoning. */
export const TEXT: Rule = { copies: 10, chars: 8_000 }
/** The arguments of a tool call (a file being written holds long, alike blocks on purpose). */
export const ARGUMENTS: Rule = { copies: 30, chars: 24_000 }
/** New characters between two looks at the same text. */
export const CHECK_EVERY = 2_000
// The longest tail looked at: a repeated text of a tenth of it, or a thirtieth, is still seen.
const WINDOW = 80_000

/**
 * If the end of `text` is one text repeated `rule.copies` times or more, covering at least `rule.chars` characters
 * (the last copy may be unfinished), how many characters to keep so that the first copy stays and the others go.
 * Runs of blank characters are not a repetition: the blank rule handles them.
 */
export function repeatedAt(text: string, rule: Rule): number | undefined {
  if (text.length < rule.chars) return undefined
  const size = Math.min(text.length, WINDOW)
  // the end read backwards: a repeated end is then a start with a period, which the prefix function finds in one pass
  const tail = Uint16Array.from({ length: size }, (_, index) => text.charCodeAt(text.length - 1 - index))
  const prefix = new Int32Array(size)
  for (let at = 1, border = 0; at < size; at++) {
    while (border > 0 && tail[at] !== tail[border]) border = prefix[border - 1]
    if (tail[at] === tail[border]) border++
    prefix[at] = border
  }
  for (let length = rule.chars; length <= size; length++) {
    const period = length - prefix[length - 1]
    const copies = Math.floor(length / period)
    if (copies < rule.copies || copies * period < rule.chars) continue
    let run = length
    while (run < size && tail[run] === tail[run - period]) run++
    const start = text.length - run
    if (text.slice(start, start + period).trim() === "") return undefined
    // The run may reach back over the end of the text before it (what both end with: a space, a full stop, a line
    // break), and then the first copy ends a few characters after the first `period`: at the end of its sentence or line.
    const stop = /[.!?\n]/
    const ended = (at: number) => stop.test(text[at - 1]) || (/\s/.test(text[at - 1]) && stop.test(text[at - 2]))
    let keep = start + period
    if (!ended(keep)) {
      const end = text.slice(keep, start + 2 * period).search(stop)
      if (end !== -1) keep += end + 1 + text.slice(keep + end + 1, keep + end + 3).search(/[^ \n]|$/)
    }
    const last = text.charCodeAt(keep - 1)
    return last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  }
  return undefined
}
