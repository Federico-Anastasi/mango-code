import { dlopen, FFIType } from "bun:ffi"
import { lazy } from "@/util/lazy"

// mango-code: the programs a command of the shell tool leaves running (a dev server, a program started in the
// background), for each conversation. The user sees them in the conversation's side panel and stops them there; the
// app's "Quit" stops them anyway.
//
// A process is the command's when it was created while the command ran (from its start to its shell's exit, a second
// either way) and either carries the command's own variable (MARK) or is a direct child of the command's shell. The
// variable is inherited by everything the command starts, however it is started and even when what started it has
// ended: Git Bash's `bin\bash.exe` starts the real bash and leaves within milliseconds when the command ends with `&`,
// and `cmd /c start` or `Start-Process` leave too. A program that starts without it (`Start-Process
// -UseNewEnvironment`, `env -i`) is still found as a child of the shell. The time matters because Windows reuses PIDs,
// and the variable is read from the process the table describes (same creation time) and not from a new one that took
// its number.
//
// A program with a window of its own (a browser, an editor, a console opened with `start`) is not listed and never
// stopped, nor is what it started: the user closes it from its window. The list is for the programs in the background.
//
// Every process is stopped through a handle opened on it after checking its creation time, never by its number: a
// shell that waited for the stopped program ends by itself, and its number may already belong to a program of the user.
//
// Windows only: the shell tool records nothing elsewhere and the list is empty.

/** The variable each command of the shell tool carries, with a value of its own. */
export const MARK = "MANGO_SHELL_RUN"

/**
 * A command of the shell tool, once it has ended: `pid` is its shell and `end` the time that shell exited;
 * `sessionID` is the conversation the user sees (the root one).
 */
type Run = { sessionID: string; mark: string; pid: number; start: number; end: number; command: string }

/**
 * A process of the computer: `started` in milliseconds since 1970; `mark` the value of MARK it carries, if any;
 * `unread` when it could be one of a command's but its environment could not be read (an antivirus, a 32-bit program);
 * `window` when it shows a window of its own.
 */
type Proc = {
  pid: number
  parent: number
  started: number
  name: string
  command: string
  mark?: string
  unread?: boolean
  window?: boolean
}

// `since`: the table must have been read after this time, so that it holds what the runs ended before it left.
type Read = (since: number) => Promise<Proc[]>

// The process table and the clock of the agent are the same, but a command's shell starts after the command and the
// programs it leaves may start a moment after it exits: a second either way.
const SLACK = 1000
// Past this many runs, a new one makes the runs that left nothing go, in every conversation.
const MAX_RUNS = 500
// The list asked again within this time (two windows, the panel and a change of the conversation) reads the table once.
const FRESH_MS = 2500
// PowerShell that does not answer is stopped.
const READ_TIMEOUT_MS = 8000

const runs: Run[] = []

/** Remembers a command that has ended. */
export async function record(run: Run, read: Read = table) {
  runs.push(run)
  if (runs.length <= MAX_RUNS) return
  const all = runs.slice()
  forgetEmpty(all, await current(read, latest(all)))
}

/** The programs the conversation's commands left running; the runs that left nothing are forgotten. */
export async function list(sessionID: string, read: Read = table) {
  const mine = runs.filter((run) => run.sessionID === sessionID)
  if (mine.length === 0) return []
  return forgetEmpty(mine, await current(read, latest(mine))).flatMap((item) =>
    item.left.map((proc) => ({
      pid: proc.pid,
      started: proc.started,
      name: proc.name,
      command: proc.command,
      asked: item.run.command,
    })),
  )
}

/**
 * Stops a program of the list with everything it started. It must still be the same process (same PID and same
 * creation time) and one the conversation left running: a PID taken by another program is never touched. The table
 * is read once, just before, and what is stopped is the tree found in it, deepest first.
 */
export async function stop(
  input: { sessionID: string; pid: number; started: number },
  read: Read = () => readTable(),
  kill: (procs: Proc[]) => boolean | Promise<boolean> = killAll,
): Promise<"stopped" | "gone" | "failed"> {
  const mine = runs.filter((run) => run.sessionID === input.sessionID)
  if (mine.length === 0) return "gone"
  const procs = await current(read, latest(mine))
  const found = forgetEmpty(mine, procs)
    .flatMap((item) => item.left.map((proc) => ({ run: item.run, proc })))
    .find((item) => item.proc.pid === input.pid && item.proc.started === input.started)
  if (!found) return "gone"
  const stopped = await kill([...tree(procs, found.proc), ...waiting(procs, found.run, found.proc)])
  // The list read next must not come from a table older than this.
  cache.procs = undefined
  return stopped ? "stopped" : "failed"
}

/**
 * What the run left running in the background: the topmost of its processes. A shell that waits for a program it
 * started (the copy of bash that holds `server &`) gives its place to that program; a program with a window, and what
 * it started, is left out.
 */
export function survivors(procs: Proc[], run: Run) {
  const mine = owned(procs, run)
  const shown = mine
    .filter((proc) => !shell(proc) || !mine.some((child) => childOf(child, proc)))
    .filter((proc) => ![proc, ...above(procs, run, proc)].some((item) => item.window))
  return shown.filter((proc) => !above(procs, run, proc).some((item) => shown.includes(item)))
}

/**
 * The process and what it started, deepest first: a child created after its parent with that parent's PID. A program
 * with a window (a browser a server opened) is the user's, and stays with what it started.
 */
export function tree(procs: Proc[], root: Proc): Proc[] {
  const below = procs.filter((proc) => childOf(proc, root) && !proc.window)
  return [...below.flatMap((child) => tree(procs, child)), root]
}

/**
 * The shells above a program that wait for it and nothing else, nearest first: they go when it is stopped, or cmd
 * running `/c "server & other"` would start the next one. Only a shell of the run (its mark, created while it ran),
 * without a window, whose only living child is that program (its console host aside).
 */
function waiting(procs: Proc[], run: Run, proc: Proc): Proc[] {
  const parent = procs.find((item) => childOf(proc, item))
  if (!parent || !shell(parent) || parent.window || parent.mark !== run.mark || !during(parent, run)) return []
  if (procs.some((item) => item !== proc && childOf(item, parent) && !host(item))) return []
  return [parent, ...waiting(procs, run, parent)]
}

const SHELLS = new Set(["bash.exe", "sh.exe", "dash.exe", "zsh.exe", "cmd.exe", "powershell.exe", "pwsh.exe"])

/** The run's processes: created while it ran, with its mark or started by its shell; console hosts aside. */
function owned(procs: Proc[], run: Run) {
  return procs.filter((proc) => during(proc, run) && !host(proc) && (proc.mark === run.mark || proc.parent === run.pid))
}

function during(proc: Proc, run: Run) {
  return proc.started >= run.start - SLACK && proc.started <= run.end + SLACK
}

function shell(proc: Proc) {
  return SHELLS.has(proc.name.toLowerCase())
}

function host(proc: Proc) {
  return proc.name.toLowerCase() === "conhost.exe"
}

function childOf(child: Proc, parent: Proc) {
  return child.parent === parent.pid && child.started >= parent.started && child.pid !== parent.pid
}

/**
 * The ancestors of a process, nearest first, whether they belong to the run or not, up to those older than the run
 * (the agent, the app).
 */
function above(procs: Proc[], run: Run, proc: Proc): Proc[] {
  const parent = procs.find((item) => childOf(proc, item) && item.started >= run.start - SLACK)
  return parent ? [parent, ...above(procs, run, parent)] : []
}

/**
 * What each run left running; the runs that left nothing leave the memory (each one once, by identity). A run stays
 * while a process of its time could not be read: it may be one of its own.
 */
function forgetEmpty(mine: Run[], procs: Proc[]) {
  const found = mine.map((run) => ({ run, left: survivors(procs, run) }))
  found
    .filter((item) => item.left.length === 0 && !procs.some((proc) => proc.unread && during(proc, item.run)))
    .forEach((item) => {
      // Another reading may have forgotten it meanwhile.
      const index = runs.indexOf(item.run)
      if (index >= 0) runs.splice(index, 1)
    })
  return found
}

/** A reading of the table that can be trusted: an empty one failed (PowerShell itself is in any true one). */
async function current(read: Read, since: number) {
  const procs = await read(since)
  if (procs.length === 0) throw new Error("the process table came back empty")
  return procs
}

function latest(mine: Run[]) {
  return Math.max(...mine.map((run) => run.end))
}

// Every process is tried, even after one that did not stop.
function killAll(procs: Proc[]) {
  return procs.map(terminate).every(Boolean)
}

/**
 * Stops the process the table describes, through a handle that holds it: true once it is not running. A process whose
 * number now belongs to another one (a different creation time) has ended, and that other one is never touched.
 */
export function terminate(proc: Pick<Proc, "pid" | "started">) {
  const api = native().kernel
  const handle = api.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_TERMINATE, 0, proc.pid)
  if (!handle) return !alive(proc)
  try {
    const created = createdAt(handle)
    if (Number.isNaN(created)) return false
    if (created !== proc.started) return true
    return !!api.TerminateProcess(handle, 1) || !running(handle)
  } finally {
    api.CloseHandle(handle)
  }
}

const cache: { at: number; procs: Promise<Proc[]> | undefined } = { at: 0, procs: undefined }

/** The processes of the computer, read once for the readings asked close together after `since`. */
export function table(since = 0) {
  if (cache.procs && cache.at >= since && Date.now() - cache.at < FRESH_MS) return cache.procs
  const procs = readTable()
  cache.at = Date.now()
  cache.procs = procs
  // A failed reading is not kept: the next one tries again.
  procs.catch(() => {
    if (cache.procs === procs) cache.procs = undefined
  })
  return procs
}

// Windows PowerShell 5.1 is on every Windows; CIM gives the parent, the creation time and the command line.
const WINDOWS_TABLE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; " +
    "t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); n = $_.Name; c = [string]$_.CommandLine } }) " +
    "| ConvertTo-Json -Compress",
].join(";")

/**
 * The processes of the computer. The environment is read only from those created after `from`, by default the start
 * of the oldest run remembered: an older process cannot carry a run's mark, and the processes of the system are not
 * opened every time the list is asked.
 */
export async function readTable(from = Math.min(...runs.map((run) => run.start))): Promise<Proc[]> {
  const shell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const child = Bun.spawn([shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE], {
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
    timeout: READ_TIMEOUT_MS,
  })
  const text = await new Response(child.stdout).text()
  const code = await child.exited
  if (code !== 0) throw new Error(`the process table could not be read (PowerShell: ${child.signalCode ?? code})`)
  const shown = windowed()
  return parseTable(text).map((proc) => ({
    ...proc,
    ...(proc.started >= from - SLACK ? environmentOf(proc) : {}),
    window: shown.has(proc.pid),
  }))
}

const PROCESS_TERMINATE = 0x0001
const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const STILL_ACTIVE = 259
// FILETIME counts 100 ns from 1601.
const EPOCH_1601_MS = 11_644_473_600_000

const native = lazy(() => ({
  kernel: dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetProcessTimes: {
      args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    ReadProcessMemory: {
      args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols,
  ntdll: dlopen("ntdll.dll", {
    NtQueryInformationProcess: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols,
  user32: dlopen("user32.dll", {
    FindWindowExW: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  }).symbols,
}))

/**
 * The value of MARK in the environment of the process the table describes. A process that is not the one of the table
 * any more (its PID taken by a new one), or that has ended, has none; one that is there but cannot be read is `unread`.
 */
function environmentOf(proc: Proc): Pick<Proc, "mark" | "unread"> {
  const api = native().kernel
  const handle = api.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, proc.pid)
  if (!handle) return alive(proc) ? { unread: true } : {}
  try {
    if (createdAt(handle) !== proc.started) return {}
    const entries = environment(handle)
    if (!entries) return { unread: true }
    return { mark: entries.find((item) => item.startsWith(MARK + "="))?.slice(MARK.length + 1) }
  } finally {
    api.CloseHandle(handle)
  }
}

/** The process of the table is still running: one that cannot even be asked this is not one to count on. */
function alive(proc: Pick<Proc, "pid" | "started">) {
  const api = native().kernel
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, proc.pid)
  if (!handle) return false
  try {
    return createdAt(handle) === proc.started && running(handle)
  } finally {
    api.CloseHandle(handle)
  }
}

function running(handle: bigint) {
  const code = new Uint32Array(1)
  return !!native().kernel.GetExitCodeProcess(handle, code) && code[0] === STILL_ACTIVE
}

// The same instant CIM gives: measured, to the millisecond on every process.
function createdAt(handle: bigint) {
  const times = Array.from({ length: 4 }, () => new BigUint64Array(1))
  if (!native().kernel.GetProcessTimes(handle, times[0], times[1], times[2], times[3])) return Number.NaN
  return Number(times[0][0] / 10_000n) - EPOCH_1601_MS
}

// The PEB points to the process parameters, which hold the address and size of the environment block (offsets of
// 64-bit Windows, as the app's own reading at quit).
function environment(handle: bigint) {
  const info = new BigUint64Array(6)
  if (native().ntdll.NtQueryInformationProcess(handle, 0, info, info.byteLength, null) !== 0) return
  const parameters = word(handle, info[1] + 0x20n)
  const address = parameters && word(handle, parameters + 0x80n)
  const size = parameters && word(handle, parameters + 0x3f0n)
  if (!address || !size) return
  const block = Buffer.alloc(Math.min(Number(size), 1 << 20))
  if (!native().kernel.ReadProcessMemory(handle, address, block, block.length, null)) return
  return block.toString("utf16le").split("\0")
}

function word(handle: bigint, address: bigint) {
  const value = new BigUint64Array(1)
  if (!native().kernel.ReadProcessMemory(handle, address, value, 8, null)) return
  return value[0]
}

/** The processes that show a window: the visible top-level windows of the desktop, by the process that owns them. */
function windowed() {
  const api = native().user32
  const owner = new Uint32Array(1)
  const pids = new Set<number>()
  for (let window = api.FindWindowExW(0n, 0n, null, null); window; window = api.FindWindowExW(0n, window, null, null))
    if (api.IsWindowVisible(window) && api.GetWindowThreadProcessId(window, owner)) pids.add(owner[0])
  return pids
}

function parseTable(text: string): Proc[] {
  const rows: unknown = JSON.parse(text.trim() || "[]")
  if (!Array.isArray(rows)) return []
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    if (typeof row.p !== "number" || typeof row.q !== "number" || typeof row.t !== "number") return []
    return [{ pid: row.p, parent: row.q, started: row.t, name: String(row.n ?? ""), command: String(row.c ?? "") }]
  })
}

export * as LeftRunning from "./left-running"
