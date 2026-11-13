// A model writes bash out of habit even when the tool says the shell is PowerShell: `cd dir && cmd`, `head`, a
// heredoc. What can be made to work is rewritten before it runs; for the rest the result says what to use instead,
// so that the model does not have to guess from an error message in the language of the computer.

type Mark = {
  text: "&&" | "||" | "<<" | "|" | ";" | "\n" | "#"
  at: number
  depth: number
}

// The parts of a PowerShell command that are not code: here-strings, strings, a block comment, an escaped character.
const OPAQUE = [/@'[^\n]*\n[\s\S]*?\n'@/y, /@"[^\n]*\n[\s\S]*?\n"@/y, /'(?:[^']|'')*'/y, /"(?:[^"`]|`[\s\S]|"")*"/y, /<#[\s\S]*?#>/y, /`[\s\S]/y]
const COMMENT = /(?<=^|[\s;({])#[^\n]*/y
const OPERATORS = ["&&", "||", "<<", "|", ";", "\n"] as const

/** The operators of a command and where they are. Undefined when a string is left open: then nothing can be said. */
function marks(command: string) {
  const out: Mark[] = []
  let depth = 0
  let at = 0
  while (at < command.length) {
    const opaque = OPAQUE.map((pattern) => {
      pattern.lastIndex = at
      return pattern.exec(command)?.[0]
    }).find(Boolean)
    if (opaque) {
      at += opaque.length
      continue
    }
    const char = command[at]
    if (char === "'" || char === '"') return
    COMMENT.lastIndex = at
    const comment = COMMENT.exec(command)?.[0]
    if (comment) {
      out.push({ text: "#", at, depth })
      at += comment.length
      continue
    }
    if ("([{".includes(char)) depth++
    if (")]}".includes(char)) depth = Math.max(0, depth - 1)
    const operator = OPERATORS.find((item) => command.startsWith(item, at))
    if (operator) out.push({ text: operator, at, depth })
    at += operator?.length ?? 1
  }
  return out
}

/**
 * Windows PowerShell 5.1 has no `&&`: `a && b` becomes `a; if ($?) { b }`, which runs `b` only when `a` succeeded
 * and keeps the failure as the result. Only plain chains are rewritten; anything else is returned as it is.
 */
export function chain(command: string) {
  const found = marks(command)
  if (!found?.some((mark) => mark.text === "&&")) return command
  if (found.some((mark) => (mark.text === "&&" && mark.depth > 0) || ["||", "<<", "#"].includes(mark.text))) return command
  const cuts = [...found.filter((mark) => mark.depth === 0 && mark.text !== "|"), { text: ";" as const, at: command.length, depth: 0 }]
  const out: string[] = []
  let start = 0
  let open = 0
  for (const cut of cuts) {
    const piece = command.slice(start, cut.at)
    start = cut.at + cut.text.length
    if (cut.text === "&&") {
      if (!piece.trim()) return command
      out.push(`${piece.trim()}; if ($?) { `)
      open++
      continue
    }
    if (open && !piece.trim()) return command
    out.push(open ? piece.trim() + " }".repeat(open) : piece, cut.at < command.length ? cut.text : "")
    open = 0
  }
  return out.join("")
}

// Commands of bash that Windows does not have, and what does the same job here.
const INSTEAD: Record<string, string> = {
  head: "to read part of a file use the Read tool with `offset` and `limit`",
  tail: "to read part of a file use the Read tool with `offset` and `limit`",
  grep: "to search in files use the Grep tool",
  sed: "to change a file use the Edit tool",
  awk: "to change a file use the Edit tool",
  touch: "to create a file use the Write tool",
  export: 'set a variable with `$env:NAME = "value"`',
  which: "find a program with `Get-Command name`",
}

/**
 * What to tell the model about a command that PowerShell could not run as written. `missing` says whether a program
 * is absent from this computer: Git for Windows, for one, brings `head` and `grep` along.
 */
export function notes(input: { command: string; shell: string; missing: (name: string) => boolean }) {
  const found = marks(input.command)
  if (!found) return []
  const shell = input.shell === "powershell" ? "Windows PowerShell (5.1)" : "PowerShell"
  const starts = [0, ...found.filter((mark) => mark.text !== "#" && mark.text !== "<<").map((mark) => mark.at + mark.text.length)]
  const absent = [
    ...new Set(
      starts
        .map((start) => /^\s*([A-Za-z]+)(?=\s|$)/.exec(input.command.slice(start))?.[1] ?? "")
        .filter((name) => INSTEAD[name] && input.missing(name)),
    ),
  ]
  return [
    found.some((mark) => mark.text === "<<") &&
      `This shell is ${shell}, not bash: it has no heredoc (\`<< EOF\`), so the command was not run. To create a file use the Write tool.`,
    input.shell === "powershell" &&
      found.some((mark) => mark.text === "&&" || mark.text === "||") &&
      `This shell is ${shell}, not bash: it has no \`&&\` and no \`||\`, so the command was not run. Write \`cmd1; if ($?) { cmd2 }\`.`,
    absent.length > 0 &&
      `This shell is ${shell}, not bash: ${absent.map((name) => `\`${name}\``).join(", ")} ${absent.length === 1 ? "does" : "do"} not exist on this computer. Instead: ${[...new Set(absent.map((name) => INSTEAD[name]))].join("; ")}.`,
  ].filter((note): note is string => Boolean(note))
}

export * as BashHabits from "./bash-habits"
