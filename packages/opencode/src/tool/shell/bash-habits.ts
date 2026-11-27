// A model writes bash out of habit even when the tool says the shell is PowerShell: `cd dir && cmd`, `head`, a
// heredoc. What can be made to work is rewritten before it runs; for the rest the result says what to use instead,
// so that the model does not have to guess from an error message in the language of the computer.

import path from "path"
import { ProjectPath } from "../project-path"

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

/** Where each command of a line begins: at its start and after every operator. */
const begins = (found: Mark[]) => [0, ...found.filter((mark) => mark.text !== "#" && mark.text !== "<<").map((mark) => mark.at + mark.text.length)]

// Bash commands that PowerShell has under the same name with other options, or under another name: what runs here.
const SAME_JOB: [RegExp, string][] = [
  [/^(\s*)ls\s+-[1AFahlrt]+(?=\s|$)/, "$1Get-ChildItem -Force"],
  [/^(\s*)ps\s+(?:-?aux|-ef|-e|-A)(?=\s|$)/, "$1Get-Process"],
  [/^(\s*)rm\s+-(?:rf|fr|r|R|Rf|fR)(?=\s)/, "$1Remove-Item -Recurse -Force"],
  [/^(\s*)rm\s+-f(?=\s)/, "$1Remove-Item -Force"],
  [/^(\s*)kill\s+-(?:9|KILL|SIGKILL)\s+(\d+)(?=\s|$)/, "$1Stop-Process -Force -Id $2"],
  [/^(\s*)mkdir\s+-p\s+(\S+)(?=\s*$|\s*[;|&\n])/, "$1New-Item -ItemType Directory -Force -Path $2 | Out-Null"],
]

// `ls -la a b c`: PowerShell takes several names separated by commas.
const NAME = /"[^"]*"|'[^']*'|[^\s|;&<>'"]+/g
const LIST_SEVERAL = new RegExp(String.raw`^(\s*)ls\s+-[1AFahlrt]+((?:\s+(?:${NAME.source})){2,})(?=\s*$|\s*[;|&\n])`)

// Where a filter's own words end: at the end of the command or before the next operator.
const END = String.raw`(?=\s*(?:$|[;|&\n)]))`
const GREP = new RegExp(String.raw`^(\s*)grep((?:\s+-[A-Za-z]+)*)\s+("[^"]*"|'[^']*'|[^\s|;&'"-][^\s|;&]*)` + END)
const HEAD = new RegExp(String.raw`^(\s*)(head|tail)(?:\s+(?:-n\s*)?-?(\d+))?` + END)
const COUNT = new RegExp(String.raw`^(\s*)wc\s+-l` + END)

/**
 * The filter a bash pipeline ends with (`| grep -i word`, `| head -20`, `| tail -5`, `| wc -l`) as PowerShell has it.
 * Only a program that is not on this computer, and only a form that has a counterpart: the rest is left as written.
 */
function filter(piped: string, missing: (name: string) => boolean) {
  const name = /^\s*([a-z]+)/.exec(piped)?.[1] ?? ""
  if (!["grep", "head", "tail", "wc"].includes(name) || !missing(name)) return piped
  return piped
    .replace(GREP, (whole, lead: string, flags: string, pattern: string) => {
      const letters = flags.replace(/[\s-]/g, "")
      if (/[^iEPFvn]/.test(letters)) return whole
      const words = [
        "Select-String",
        ...(letters.includes("v") ? ["-NotMatch"] : []),
        ...(letters.includes("F") ? ["-SimpleMatch"] : []),
        ...(letters.includes("i") ? [] : ["-CaseSensitive"]),
        // in a plain grep pattern `\|` separates the alternatives
        `-Pattern ${/[EPF]/.test(letters) ? pattern : pattern.replaceAll("\\|", "|")}`,
      ]
      return lead + words.join(" ")
    })
    .replace(HEAD, (_, lead: string, which: string, count?: string) => `${lead}Select-Object -${which === "head" ? "First" : "Last"} ${count ?? 10}`)
    .replace(COUNT, "$1Measure-Object -Line | ForEach-Object Lines")
}

const BACKGROUND =
  "A command that ends with `&` starts a PowerShell job that stops when this call ends: the program is not running. To leave a program running: `Start-Process -WindowStyle Hidden <program> -ArgumentList '<arguments>'`."

/** `program arguments &` as PowerShell leaves a program running, or undefined when the statement is more than that. */
function detached(statement: string) {
  const body = /^([\s\S]*?[^&\s])\s*&\s*$/.exec(statement)?.[1]
  if (!body) return
  const steps = body
    .replace(/\s*(?:\d|\*)?>\s*(?:\$null|NUL)\b/g, "")
    .replace(/\s*2>&1/g, "")
    .split("&&")
    .map((step) => step.trim())
  const run = steps.pop() ?? ""
  const folder = steps.length === 1 ? /^cd\s+("[^"]+"|'[^']+'|[^\s'"]+)$/.exec(steps[0])?.[1] : undefined
  if (steps.length > (folder ? 1 : 0) || !run || /[|;&<>'"`$(){}]/.test(run)) return
  const [program, ...rest] = run.split(/\s+/)
  return [
    `Start-Process -WindowStyle Hidden ${program}`,
    ...(rest.length > 0 ? [`-ArgumentList '${rest.join(" ")}'`] : []),
    ...(folder ? [`-WorkingDirectory ${folder}`] : []),
  ].join(" ")
}

// Where a Unix path in a command starts when it names a folder of a disk. A command also carries the paths of a site
// (`fetch('/api/items')` in a script): those are left alone, so only these beginnings and the project's name count.
const UNIX_FOLDERS = new Set(["home", "tmp", "root", "workspace", "mnt", "var", "usr", "etc", "opt"])

/**
 * The command as PowerShell can run it: what bash writes by habit and has an exact counterpart here is rewritten (the
 * null device, `ls -la`, `python3`, a program left running with `&`, a Unix path, which becomes the project folder).
 * `notes` says what the model has to know about it.
 */
export function adapt(input: { command: string; directory: string; missing: (name: string) => boolean }) {
  const moved: string[] = []
  const project = path.win32.basename(input.directory).toLowerCase()
  const pathed = input.command
    .replace(/(\d|&)?>\s*\/dev\/null\b/g, (_, stream?: string) => `${stream === "&" ? "*" : (stream ?? "")}>$null`)
    .replace(/(?<![\w.:/\\-])\/dev\/null\b/g, "NUL")
    .replace(/(?<=^|[\s'"(])\/(?=[A-Za-z]:[\\/])/g, "")
    .replace(/(?<=^|[\s'"(])\/[\w.-]+(?:\/[\w.@%+-]*)*/g, (token) => {
      // Git Bash writes a drive as a folder: /c/Users/name
      const drive = /^\/([A-Za-z])\/((?:[^/]+\/)+[^/]*)$/.exec(token)
      if (drive) return `${drive[1].toUpperCase()}:/${drive[2]}`
      const parts = token.toLowerCase().split("/").filter(Boolean)
      const folder = UNIX_FOLDERS.has(parts[0]) && (parts.length > 1 || parts[0] === "tmp")
      if (!folder && !parts.includes(project)) return token
      const located = ProjectPath.locate(token, input.directory, "win32")
      if (!located.note) return token
      moved.push(token)
      return located.path.replaceAll("\\", "/")
    })

  const found = marks(pathed)
  if (!found) return { command: pathed, notes: [] }
  const python = /\bpython3\b/.test(pathed) && input.missing("python3") && !input.missing("python")
  const piped = new Set(found.filter((mark) => mark.text === "|").map((mark) => mark.at + 1))
  const renamed = begins(found)
    .toReversed()
    .reduce((command, start) => {
      if (piped.has(start)) return command.slice(0, start) + filter(command.slice(start), input.missing)
      const rest = command.slice(start).replace(LIST_SEVERAL, (_, lead: string, names: string) => `${lead}Get-ChildItem -Force ${[...names.matchAll(NAME)].map(([name]) => name).join(",")}`)
      const [pattern, instead] = SAME_JOB.find(([pattern]) => pattern.test(rest)) ?? []
      const next = pattern && instead ? rest.replace(pattern, instead) : python ? rest.replace(/^(\s*)python3(?=\s|$)/, "$1python") : rest
      return command.slice(0, start) + next
    }, pathed)

  const cuts = (marks(renamed) ?? []).filter((mark) => mark.depth === 0 && (mark.text === ";" || mark.text === "\n"))
  const edges = [0, ...cuts.flatMap((cut) => [cut.at, cut.at + cut.text.length]), renamed.length]
  const pieces = edges.slice(1).map((end, index) => renamed.slice(edges[index], end))
  const left = pieces.map((piece) => (/[^&]&\s*$/.test(piece) ? (detached(piece) ?? piece) : piece))
  const command = left.join("")
  const jobs = left.some((piece) => /[^&]&\s*$/.test(piece))

  return {
    command,
    notes: [
      moved.length > 0 &&
        `This computer runs Windows: ${[...new Set(moved)].map((item) => `\`${item}\``).join(", ")} ${new Set(moved).size === 1 ? "is not a path" : "are not paths"} here. The project folder (${input.directory}) was used instead.`,
      jobs && BACKGROUND,
    ].filter((note): note is string => Boolean(note)),
  }
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
  wc: "count the lines of a file with `(Get-Content file).Count`",
  pgrep: "list the running programs with `Get-Process name`",
  pkill: "stop a program with `Stop-Process -Id <id>`, its id from `Get-Process name`",
  lsof: "see what listens on a port with `Get-NetTCPConnection -LocalPort <port>`",
  nohup: "leave a program running with `Start-Process -WindowStyle Hidden <program>`",
  chmod: "Windows needs no permission to run a file, leave it out",
  stat: "see the size and the date of a file with `Get-Item file`",
}

/**
 * What to tell the model about a command that PowerShell could not run as written. `missing` says whether a program
 * is absent from this computer: Git for Windows, for one, brings `head` and `grep` along.
 */
export function notes(input: { command: string; shell: string; missing: (name: string) => boolean }) {
  const found = marks(input.command)
  if (!found) return []
  const shell = input.shell === "powershell" ? "Windows PowerShell (5.1)" : "PowerShell"
  const names = begins(found).map((start) => /^\s*([A-Za-z]+)(?=\s|$)/.exec(input.command.slice(start))?.[1] ?? "")
  const absent = [...new Set(names.filter((name) => INSTEAD[name] && input.missing(name)))]
  return [
    found.some((mark) => mark.text === "<<") &&
      `This shell is ${shell}, not bash: it has no heredoc (\`<< EOF\`), so the command was not run. To create a file use the Write tool.`,
    input.shell === "powershell" &&
      found.some((mark) => mark.text === "&&" || mark.text === "||") &&
      `This shell is ${shell}, not bash: it has no \`&&\` and no \`||\`, so the command was not run. Write \`cmd1; if ($?) { cmd2 }\`.`,
    absent.length > 0 &&
      `This shell is ${shell}, not bash: ${absent.map((name) => `\`${name}\``).join(", ")} ${absent.length === 1 ? "does" : "do"} not exist on this computer. Instead: ${[...new Set(absent.map((name) => INSTEAD[name]))].join("; ")}.`,
    names.includes("find") &&
      / -(?:name|type|maxdepth|iname)\b/.test(input.command) &&
      `This shell is ${shell}, not bash: \`find\` here is a Windows program that searches text inside files. To find files by name use the Glob tool.`,
  ].filter((note): note is string => Boolean(note))
}

export * as BashHabits from "./bash-habits"

