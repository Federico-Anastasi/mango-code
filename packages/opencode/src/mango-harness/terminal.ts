// The terminals of the harness, started in the project: Git Bash for the commands of a model, PowerShell for what
// only Windows has. Besides running a command it reads it first: a change of folder is answered by the harness, and
// a place outside the project can be seen before anything runs. Reading a command is not a fence: what it does not
// recognise runs.
import { dlopen, FFIType, ptr } from "bun:ffi"
import fs from "node:fs/promises"
import path from "node:path"
import { withoutKeys } from "@/util/mango-secrets"

export type Shell = "bash" | "powershell"

/** A change of folder: alone (`cd`), or in front of another command (`folder`, then `rest`). */
export type Moved = { cd: string } | { folder: string; rest: string }

/** The names that change the folder: PowerShell reads the ones of bash and its own cmdlets. */
const CHANGES = { bash: new Set(["cd"]), powershell: new Set(["cd", "chdir", "set-location"]) }

const unquoted = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2")

const MOVED = {
  bash: /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*(\S[\s\S]*)$/,
  powershell: /^\s*(?:cd|chdir|set-location)\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*(\S[\s\S]*)$/i,
}

/** Whether a command is a change of folder, read as `shell` writes it. */
export function movedBy(command: string, shell: Shell = "powershell"): Moved | undefined {
  const moved = command.match(MOVED[shell])
  if (moved) return { folder: unquoted(moved[1]), rest: moved[2] }
  const plain = command.replace(/\s+2>\s*(\/dev\/null|\$null)\s*$/i, "").trim()
  if (/[|;&<>`\n]|\$\(/.test(plain.replace(/"[^"]*"|'[^']*'/g, ""))) return undefined
  const [first, ...rest] = plain.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  if (!CHANGES[shell].has((first ?? "").toLowerCase()) || rest.length !== 1) return undefined
  // `cd /d`: a switch of the Windows commands, not a path. In bash a word like that is a drive.
  if (rest[0].startsWith("-") || (shell === "powershell" && /^\/[A-Za-z?]{1,2}$/.test(rest[0]))) return undefined
  return { cd: unquoted(rest[0]) }
}

const ELSEWHERE =
  /^(\\\\|~([\\/]|$)|(\$env:|%|\$\{?)(HOME|USERPROFILE|HOMEPATH|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMDATA|SYSTEMROOT|WINDIR|PUBLIC|ONEDRIVE)\b)/i
const LINUX_ROOT =
  /^\/(workspace|workspaces|testbed|project|mnt|cygdrive|home|tmp|root|usr|etc|var|opt|srv|app|data|output|bin|sbin|lib|lib64|dev|proc|sys|boot|run|media|Users)\b/
/** What a command may name under `/dev`: the places of a stream, not of a disk. */
const STREAM = /^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/
/** A drive as bash writes it: `/c`, `/c/`, `/cygdrive/c/Users`. The part after it needs 3 characters or more, so that
 *  the address of a `sed` (`/a/d`) is not one. */
const BASH_DRIVE = /^\/(?:cygdrive\/)?[A-Za-z](?:\/?$|\/[\w.-]{3,})/
// The root of the drive with something after it: `/*.tmp`, `\*`, `/.x`, `\Windows\x`. A switch of cmd (`/q`, `/s`)
// and a regular expression (`\.py`, `\n\t`, `\bword\b`) are not.
const DRIVE_ROOT = /^(?:\/[*.]|\\\*|\\\w[\w .-]+\\(?![bBdDwWsSntrfvAZz](?![\w.*?-]))[\w.*?-])/

/** A word made only of the escapes of printf and echo (`\xff\xfe`, `\377`, `è`, `\t`): bytes, not a place. */
const ESCAPES = /^(?:\\(?:x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|[abefnrtv\\]))+$/

/** A word that names a place whatever the folder the command runs in: the user's folder, another computer. */
export const elsewhere = (word: string) => ELSEWHERE.test(word)

/** The command without the text a here-document (`<< 'EOF'` … `EOF`, also `<<-`) or a here-string of PowerShell
 *  (`@'` … `'@`) gives to a program: data, not words of the shell (`as f:` in Python is no drive). */
const withoutHereText = (command: string) =>
  command
    .replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\t*\3(?=\n|$)/g, "$1")
    .replace(/@(['"])\n[\s\S]*?\n\1@/g, "@$1$1@")

/** The places a command names: a whole path, the root of the disk, a root of Linux, a path that climbs out with
 *  `..`, the user's folders. A switch like `/c` is not one. */
export function pathsIn(given: string, shell: Shell = "powershell"): string[] {
  const bash = shell === "bash"
  // Bash reads a quoted word and the path stuck to it as one word.
  const command = bash ? glued(withoutHereText(given)) : withoutHereText(given)
  const named = (word: string) =>
    !ESCAPES.test(word) &&
    (/^[A-Za-z]:([\\/]|$)/.test(word) ||
      word === "/" ||
      word === "\\" ||
      DRIVE_ROOT.test(word) ||
      elsewhere(word) ||
      (bash && BASH_DRIVE.test(word)) ||
      /(^|[\\/])\.\.([\\/]|$)/.test(word) ||
      (!STREAM.test(word) &&
        (LINUX_ROOT.test(word) || /^\/[\w.-]{2,}\/[\w.-]/.test(word) || /^\/[A-Za-z]\/[\w.-]{3,}/.test(word))))
  const quoted = [...command.matchAll(/"([^"]+)"/g), ...command.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const bare = command.replace(/"[^"]*"|'[^']*'/g, " ").split(/[\s;|&<>=(),]+/)
  // Inside quotes there may be a command for another shell (`bash -c "cd /root/project && …"`): its words count
  // when they are places of Linux or the user's folder. A quoted Windows path with spaces stays whole.
  const inner = quoted
    .flatMap((text) => text.split(/[\s;|&<>=(),'"]+/))
    .filter((word) => (LINUX_ROOT.test(word) && !STREAM.test(word)) || elsewhere(word))
  return [...new Set([...[...quoted, ...bare].filter(named), ...inner])]
}

/** A place that bash writes as a drive (`/c/Users/x`, `/cygdrive/c/x`) as Windows writes it; any other word as it is. */
export const fromBash = (word: string) =>
  word.replace(
    /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?:\/(.*))?$/,
    (_, drive: string, rest = "") => `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`,
  )

// Windows PowerShell 5.1 has no one-line error view and ends with 1 whatever a program it ran ended with. The script
// comes in an environment variable, so it needs no quoting; its errors are written as one line each (the command and
// the message), in English; text is UTF-8 both ways (the cmdlets that read a file take it as UTF-8, which 5.1 does not
// assume); web requests go through the proxy of the environment, which .NET Framework does not read by itself. The
// code it ends with is the last program's, or 1 when a cmdlet reported an error (a program's own lines on stderr are not
// an error of PowerShell).
const SETUP = String.raw`$script = $env:HARNESS_SCRIPT
Remove-Item Env:HARNESS_SCRIPT
[Threading.Thread]::CurrentThread.CurrentUICulture = 'en-US'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$PSDefaultParameterValues = @{ 'Get-Content:Encoding' = 'UTF8'; 'Import-Csv:Encoding' = 'UTF8'; 'Select-String:Encoding' = 'UTF8' }
if ($env:HTTP_PROXY) {
  $proxy = [Net.WebProxy]::new($env:HTTP_PROXY)
  $proxy.BypassList = @($env:NO_PROXY -split ',' | Where-Object { $_ } | ForEach-Object { [regex]::Escape($_) })
  [Net.WebRequest]::DefaultWebProxy = $proxy
}
$global:harnessFailed = $false
$oneLine = { process {
  if ($_ -isnot [Management.Automation.ErrorRecord]) { $_; return }
  $name = $_.InvocationInfo.InvocationName
  $message = $_.Exception.Message -replace '\s*\r?\n\s*', ' '
  if ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { $message; return }
  $global:harnessFailed = $true
  if (-not $name -or $name -eq '&') { $message } else { "$($name): $message" }
} }
try { & ([scriptblock]::Create($script)) 2>&1 | & $oneLine }
catch {
  $e = $_.Exception
  if ($e.InnerException) { $e = $e.InnerException }
  if ($e.Errors) { ($e.Errors | ForEach-Object { $_.Message }) -join ' ' } else { $e.Message -replace '\s*\r?\n\s*', ' ' }
  exit 1
}
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($global:harnessFailed) { exit 1 }`
/**
 * The bash of Git for Windows, by its whole path (`bash` in the PATH of Windows can be the one of WSL): the one the app
 * carries in its resources (`MANGO_HOME`), otherwise the one installed on the PC; undefined when there is none.
 */
export async function gitBash(env: Record<string, string | undefined>) {
  const places = [
    ...(env.MANGO_HOME ? [path.join(env.MANGO_HOME, "git", "bin", "bash.exe")] : []),
    path.join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
  ]
  for (const place of places) {
    if (
      await fs.stat(place).then(
        (stat) => stat.isFile(),
        () => false,
      )
    )
      return place
  }
}
const MOST_LINES = 200
const MOST_CHARS = 20_000
// What is kept of each stream while a command runs: a program that prints without end does not fill the memory.
const KEPT_CHARS = 100_000
// Bash reads a quoted word and the text stuck to it as one word (`"./old files"/*.tmp`); `pathsIn` must too, or the
// second, `/*.tmp`, is the root of the drive. Every quoted string is read whole, so that a quote inside a program
// quoted for another language is never taken for the start of a word.
const GLUED =
  /(?<!\S)(?:"(?:\\.|[^"\\\n])*"|'[^'\n]*')(?:[^\s"'|;&()<>,]+|"(?:\\.|[^"\\\n])*"|'[^'\n]*')*|"(?:\\[\s\S]|[^"\\])*"|'[^']*'/g

/** The command with each quoted word and the path glued right after it joined into one quoted word. */
const glued = (command: string) =>
  command.replace(GLUED, (word) => {
    const parts = word.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^"']+/g) ?? []
    if (!/^[\\/]/.test(parts[1] ?? "") || word.includes('\\"')) return word
    const text = (part: string) =>
      part.startsWith("'")
        ? part.slice(1, -1).replace(/[`$"]/g, "`$&")
        : part.startsWith('"')
          ? part.slice(1, -1)
          : part
    return `"${parts.map(text).join("")}"`
  })

const kernel = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
}).symbols

/** Stops a process and the ones it started, by its id. */
export const stop = (pid: number) =>
  Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    .exited

/** Puts a process just started, and everything it starts, in a job object that kills its members when its handle is
 *  closed: the function returned closes it, so also the programs left running after the process has ended go. If
 *  Windows refuses the job, a process still running at the end is stopped with its tree; one that has ended is left
 *  alone, since its id may already belong to another program. */
function group(pid: number) {
  const job = kernel.CreateJobObjectW(null, null)
  if (!job) return (ended: boolean) => (ended ? undefined : stop(pid))
  const limits = new Uint8Array(144)
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE in JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
  new DataView(limits.buffer).setUint32(16, 0x2000, true)
  const limited = kernel.SetInformationJobObject(job, 9, ptr(limits), limits.length)
  const handle = limited ? kernel.OpenProcess(0x0101, 0, pid) : null
  const assigned = handle ? kernel.AssignProcessToJobObject(job, handle) : 0
  if (handle) kernel.CloseHandle(handle)
  if (!assigned) {
    kernel.CloseHandle(job)
    return (ended: boolean) => (ended ? undefined : stop(pid))
  }
  return (_ended: boolean) => kernel.CloseHandle(job)
}

/** Runs a command in Git Bash or, by default, in PowerShell, and when it is over stops whatever it left running.
 *  `stopped`: it was still going when `seconds` were over. */
export async function run(options: {
  command: string
  cwd: string
  seconds: number
  env?: Record<string, string | undefined>
  shell?: Shell
}) {
  const bash = options.shell === "bash"
  const shell = bash ? await gitBash(options.env ?? process.env) : "powershell.exe"
  if (!shell) throw new Error("Git for Windows is not on this computer")
  const child = Bun.spawn(
    bash ? [shell, "-c", options.command] : [shell, "-NoProfile", "-NonInteractive", "-Command", SETUP],
    {
      cwd: options.cwd,
      env: {
        ...withoutKeys(options.env ?? process.env),
        PYTHONUTF8: "1",
        ...(bash ? {} : { HARNESS_SCRIPT: options.command }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const killAll = group(child.pid)
  const printed = [child.stdout, child.stderr].map((stream) => {
    const got = { tail: "", chars: 0, lines: 0 }
    const decoder = new TextDecoder()
    const done = (async () => {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        got.tail += decoder.decode(chunk, { stream: true })
        if (got.tail.length <= KEPT_CHARS) continue
        const dropped = got.tail.slice(0, got.tail.length - KEPT_CHARS)
        got.chars += dropped.length
        got.lines += dropped.split("\n").length - 1
        got.tail = got.tail.slice(-KEPT_CHARS)
      }
    })()
    return { got, done }
  })
  const text = () => {
    const [out, err] = printed.map((p) => p.got.tail)
    // the errors begin on a line of their own when the output did not end its last line
    const lines = (out && err && !out.endsWith("\n") ? `${out}\n${err}` : out + err)
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\r\n/g, "\n")
      // Bash names itself by the place it lives in: the model knows it as `bash`.
      .replace(/^\/(?:usr\/)?bin\/bash: /gm, "bash: ")
      .trim()
      .split("\n")
    const total = lines.length + printed.reduce((count, p) => count + p.got.lines, 0)
    const last = lines.slice(-MOST_LINES)
    const joined = last.join("\n")
    if (joined.length <= MOST_CHARS)
      return total > last.length ? `(${total} lines, the last ${last.length})\n${joined}` : joined
    // The cut falls inside a line: the part of it that is left is not shown.
    const tail = joined.slice(-MOST_CHARS)
    const kept = tail.slice(tail.indexOf("\n") + 1)
    const chars = joined.length + printed.reduce((count, p) => count + p.got.chars, 0)
    return `(${total} lines, ${chars} characters, the last ${kept.split("\n").length} lines)\n${kept}`
  }
  // A program the command left on can keep the output open after the shell has ended: the wait for it is short.
  const drained = () => Promise.race([Promise.all(printed.map((p) => p.done)), Bun.sleep(2000)])

  const limit = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const ended = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolve) => (limit.timer = setTimeout(() => resolve(false), options.seconds * 1000))),
  ])
  clearTimeout(limit.timer)
  await killAll(ended)
  await drained()
  return { text: text(), code: ended ? (child.exitCode ?? 0) : 0, stopped: !ended }
}

export const inFolder = (folder: string, given: string) => (path.isAbsolute(given) ? given : path.join(folder, given))
