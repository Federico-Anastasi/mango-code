import type { Found, Opened, Web } from "@/mango-harness/contracts"

const MAX_RESULTS = 10

/** Calls a tool of the `web-search` server and gives what it answered: the result of an MCP `tools/call`. */
type CallTool = (name: "search" | "read_url", args: Record<string, unknown>) => Promise<unknown>

type SearchRow = { title?: unknown; url?: unknown; snippet?: unknown }

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

// A tool that failed answers `isError` with its message after "ERROR: ".
const textOf = async (call: Promise<unknown>): Promise<string | Error> => {
  const result = await call.catch(toError)
  if (result instanceof Error) return result
  const { content, isError } = (result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean }
  const text = (content ?? [])
    .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
    .join("\n")
  return isError ? new Error(text.replace(/^ERROR:\s*/, "") || "The web tool failed.") : text
}

// Links read as the harness's pages give them: the text, then the address in brackets. Images and anchors inside the
// page carry no address worth following.
const readable = (markdown: string): string =>
  markdown
    .replace(/\[img: [^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, href: string) =>
      !/^https?:\/\//i.test(href) ? label : label.trim() ? `${label} (${href})` : href,
    )
    .replace(/\n+\[TRUNCATED at \d+ chars[^\]]*\]\s*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

export function openWeb(options: { callTool: CallTool }): Web {
  return {
    async search(query, days) {
      const answer = await textOf(
        options.callTool("search", { query, max_results: MAX_RESULTS, ...(days === undefined ? {} : { days }) }),
      )
      if (answer instanceof Error) {
        // Engines that answered with nothing is an empty result; engines that could not be reached is no web.
        return /^all engines failed/.test(answer.message) && !/FAILED/.test(answer.message) ? [] : answer
      }
      const parsed = (() => {
        try {
          return JSON.parse(answer) as { results?: SearchRow[] }
        } catch {
          return undefined
        }
      })()
      if (!parsed || !Array.isArray(parsed.results)) return new Error("The search answered something unreadable.")
      return parsed.results.flatMap((row): Found[] =>
        typeof row.url === "string" && typeof row.title === "string"
          ? [{ title: row.title, url: row.url, text: typeof row.snippet === "string" ? row.snippet : "" }]
          : [],
      )
    },

    async open(url) {
      const answer = await textOf(options.callTool("read_url", { url }))
      if (answer instanceof Error) return answer
      // `# title`, an optional author line, `source: address`, a blank line, the page. A page that is already text has none.
      const head = /^# (.*)\n(?:(?!source: ).*\n)?source: .*\n\n/.exec(answer)
      const text = readable(head ? answer.slice(head[0].length) : answer)
      if (!text) return new Error(`The page ${url} has no readable text`)
      return { title: head?.[1]?.trim() || url, text } satisfies Opened
    },
  }
}
