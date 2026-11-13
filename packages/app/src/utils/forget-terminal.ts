// The user's terminal is gone from the app. What it saved in the browser storage goes too, at the start of the
// page: its tabs for each folder and conversation (also in the names of older versions) and its height and whether
// it was open, inside the saved layout.

const TERMINAL_KEY = /(?::workspace:terminal|:session:[^:]+:terminal|\/terminal\.v1|\/terminal\/ses_[^/]+\.v1)$/
const LAYOUT_KEY = /^opencode\.global\.dat:(?:.+:)?layout$/

/** Deletes what the terminal saved and says how many entries changed. */
export function forgetTerminal(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key !== null,
  )
  const removed = keys.filter((key) => TERMINAL_KEY.test(key))
  removed.forEach((key) => storage.removeItem(key))
  const layouts = keys.filter((key) => LAYOUT_KEY.test(key)).filter((key) => dropFromLayout(storage, key))
  return removed.length + layouts.length
}

function dropFromLayout(storage: Pick<Storage, "getItem" | "setItem">, key: string) {
  const layout = parse(storage.getItem(key))
  if (!layout || !("terminal" in layout)) return false
  storage.setItem(
    key,
    JSON.stringify(Object.fromEntries(Object.entries(layout).filter(([name]) => name !== "terminal"))),
  )
  return true
}

// A layout that cannot be read is left to the layout itself, which starts again from its defaults.
function parse(value: string | null) {
  if (!value) return
  const parsed = (() => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  })()
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
}
