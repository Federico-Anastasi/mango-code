import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { TimelineRow } from "./timeline-row"

/** One place where the searched text appears: the nth time in the text of a row of the conversation. */
export type FindMatch = { key: string; nth: number }

/** Where the search looks in a drawn row: what the user wrote and what the model answered. */
export const FIND_TEXT_SELECTOR = '[data-slot="user-message-text"], [data-slot="text-part-body"]'
// The comments attached to a message are cards of their own, not its text: the count from the data leaves them out too.
const FIND_SKIP_SELECTOR = '[data-slot="user-message-comments"]'

/** The text of a row that the search reads: the user's message or a written part of the answer. */
export function rowText(row: TimelineRow.TimelineRow, getParts: (messageID: string) => Part[]): string | undefined {
  if (row._tag === "UserMessage")
    return getParts(row.userMessageID).find((part): part is TextPart => part.type === "text" && !part.synthetic)?.text
  if (row._tag !== "AssistantPart" || row.group.type !== "part") return
  const ref = row.group.ref
  const part = getParts(ref.messageID).find((item) => item.id === ref.partID)
  if (part?.type === "text") return plainText(part.text)
}

/**
 * The words of an answer as the chat draws them, near enough to count the results of rows that are not drawn: no
 * markers of emphasis, code, headings, quotes, lists and tables, no addresses of links and pictures, no first line of a
 * code block. A drawn row is counted on what is drawn (see `createConversationFind`).
 */
export function plainText(markdown: string) {
  return (
    markdown
      .replace(/^[ \t]{0,3}(`{3,}|~{3,}).*$/gm, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
      .replace(/[ \t]*\|[ \t]*/g, " ")
      .replace(/(\*{1,3}|~~|`+)(?=\S)([^\n]*?\S)\1/g, "$2")
      // `_` marks emphasis only at the edge of a word: `snake_case_name` stays as it is.
      .replace(/(^|\W)(_{1,3})(?=\S)([^\n]*?\S)\2(?!\w)/g, "$1$3")
  )
}

/**
 * The search in the conversation. It reads the loaded messages, so it also counts the rows that are not drawn; a drawn
 * row is counted on what it shows (`counted`). The current result is a place, not a number: older messages loaded
 * above, or a row counted again, do not move it. If it is no longer there the next one takes its place.
 * Enter goes to the next result, Shift+Enter to the previous one, Esc closes.
 */
export function createConversationFind(input: {
  rows: Accessor<TimelineRow.TimelineRow[]>
  text: (row: TimelineRow.TimelineRow) => string | undefined
  onClose?: () => void
}) {
  const [state, setState] = createStore({
    open: false,
    query: "",
    // The current result as a place (row and nth result in it), kept as plain values: undefined key = the first one.
    currentKey: undefined as string | undefined,
    currentNth: 0,
    drawn: {} as Record<string, number>,
  })
  const matches = createMemo(() =>
    state.open ? findMatches(input.rows(), state.query.trim(), input.text, (key) => state.drawn[key]) : [],
  )
  const order = createMemo(() => new Map(input.rows().map((row, index) => [TimelineRow.key(row), index] as const)))
  const index = createMemo(() => {
    const list = matches()
    const key = state.currentKey
    const nth = state.currentNth
    if (key === undefined || list.length === 0) return 0
    const exact = list.findIndex((item) => item.key === key && item.nth === nth)
    if (exact >= 0) return exact
    const row = order().get(key) ?? -1
    const next = list.findIndex((item) => {
      const at = order().get(item.key) ?? -1
      return at > row || (at === row && item.nth > nth)
    })
    return next >= 0 ? next : 0
  })
  const close = () => {
    setState({ open: false, query: "", currentKey: undefined, currentNth: 0, drawn: {} })
    input.onClose?.()
  }
  const move = (step: 1 | -1) => {
    const list = matches()
    if (list.length === 0) return
    const next = list[(index() + step + list.length) % list.length]
    setState({ currentKey: next.key, currentNth: next.nth })
  }
  return {
    opened: () => state.open,
    query: () => state.query,
    index,
    count: () => matches().length,
    current: () => matches()[index()] as FindMatch | undefined,
    open: () => setState("open", true),
    close,
    move,
    setQuery: (value: string) => setState({ query: value, currentKey: undefined, currentNth: 0, drawn: {} }),
    /** How many results a drawn row really shows. */
    counted: (key: string, count: number) => {
      if (state.drawn[key] !== count) setState("drawn", key, count)
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
    },
  }
}

/** Every place of `query` in the rows, in reading order; upper and lower case are the same letter. */
export function findMatches(
  rows: TimelineRow.TimelineRow[],
  query: string,
  text: (row: TimelineRow.TimelineRow) => string | undefined,
  drawn: (key: string) => number | undefined = () => undefined,
): FindMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  return rows.flatMap((row) => {
    const key = TimelineRow.key(row)
    const count = drawn(key) ?? positions((text(row) ?? "").toLowerCase(), needle).length
    return Array.from({ length: count }, (_, nth) => ({ key, nth }))
  })
}

/** The ranges of `query` in the drawn text of `root`, in reading order. */
export function textRanges(root: ParentNode, query: string): Range[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  return Array.from(root.querySelectorAll(FIND_TEXT_SELECTOR)).flatMap((container) => {
    if (!container.textContent?.toLowerCase().includes(needle)) return []
    const nodes: Text[] = []
    const ends: number[] = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(FIND_SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue
      nodes.push(node)
      ends.push((ends.at(-1) ?? 0) + node.data.length)
    }
    // The text node that holds the character at `offset`, and where in it.
    const locate = (offset: number) => {
      let low = 0
      let high = ends.length - 1
      while (low < high) {
        const middle = (low + high) >> 1
        if (ends[middle] > offset) high = middle
        else low = middle + 1
      }
      return { node: nodes[low], offset: offset - (low === 0 ? 0 : ends[low - 1]) }
    }
    const hay = nodes
      .map((node) => node.data)
      .join("")
      .toLowerCase()
    return positions(hay, needle).map((at) => {
      const start = locate(at)
      const end = locate(at + needle.length - 1)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      return range
    })
  })
}

/** The drawn rows of the conversation in `root`, each with the ranges of `query` it shows. */
export function drawnResults(root: ParentNode, query: string) {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-timeline-key]")).flatMap((row) => {
    const key = row.dataset.timelineKey
    return key ? [{ key, ranges: textRanges(row, query) }] : []
  })
}

function positions(hay: string, needle: string) {
  const found: number[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) found.push(at)
  return found
}
