// What a command takes away from the files the project had when the conversation began: a file deleted, or written
// over so that some of its lines are gone. The harness keeps the project as it was given, and before a command that
// may lose something keeps it as it is; when the command lost lines of the user's own, it puts the project back.
// The folders of a repository and of packages are not walked, and a file over 1 MB is not kept: what happens to it
// is not seen, and it is never put back nor taken away.
import fs from "node:fs/promises"
import path from "node:path"
import { SKIPPED } from "./files"

const LARGEST = 1 << 20

/** The files of a project by their path from it in lower case (Windows does not tell `A.txt` from `a.txt`), with
 *  the path as it is written and the bytes; its folders, the same way; the files too large to keep. */
export type Kept = {
  files: Map<string, { shown: string; bytes: Buffer }>
  folders: Map<string, string>
  large: Set<string>
}
export type Lost = { shown: string; removed: boolean; lines: string[] }

export async function keep(project: string): Promise<Kept> {
  const kept: Kept = { files: new Map(), folders: new Map(), large: new Set() }
  // A program the model left running may make and take away files while they are read: one gone is not there.
  const gone = () => undefined
  const walk = async (folder: string): Promise<void> => {
    const entries = (await fs.readdir(path.join(project, folder), { withFileTypes: true }).catch(gone)) ?? []
    await Promise.all(
      entries.map(async (entry) => {
        const shown = folder ? `${folder}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (SKIPPED.has(entry.name)) return
          kept.folders.set(shown.toLowerCase(), shown)
          return walk(shown)
        }
        if (!entry.isFile()) return
        const whole = path.join(project, shown)
        const size = (await fs.stat(whole).catch(gone))?.size
        if (size === undefined) return
        if (size > LARGEST) return void kept.large.add(shown.toLowerCase())
        const bytes = await fs.readFile(whole).catch(gone)
        if (bytes) kept.files.set(shown.toLowerCase(), { shown, bytes })
      }),
    )
  }
  await walk("")
  return kept
}

const linesOf = (bytes: Buffer) =>
  bytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** The lines of the user's own that a file would lose if it became `after` (undefined: removed): those of the file as
 *  given, when it still held them before. A file the model already changed is its own work, and lines kept anywhere
 *  in the new text are not lost. */
export function lostIn(
  given: Kept,
  before: Buffer | undefined,
  key: string,
  after: Buffer | undefined,
): Lost | undefined {
  const original = given.files.get(key)
  if (!original || !before || !before.equals(original.bytes)) return undefined
  const lines = linesOf(original.bytes)
  const kept = new Set(after ? linesOf(after) : [])
  if (!lines.length || lines.every((line) => kept.has(line))) return undefined
  return { shown: original.shown, removed: after === undefined, lines }
}

/** What the command lost. A file that is gone from its place but whose bytes are in another (moved, renamed) is not. */
export function lostBetween(given: Kept, before: Kept, after: Kept): Lost[] {
  const bodies = [...after.files.values()].map((file) => file.bytes)
  // In the order of their paths: the files are read at once, and a map keeps the order they came in.
  return [...before.files]
    .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
    .map(([key, file]) => {
      const now = after.files.get(key)?.bytes
      if (!now && bodies.some((body) => body.equals(file.bytes))) return undefined
      return lostIn(given, file.bytes, key, now)
    })
    .filter((one) => one !== undefined)
}

/** Puts the project back as `before`: the files and folders it had, with their bytes and names; none of those made
 *  since. */
export async function restore(project: string, before: Kept, after: Kept) {
  const made = [...after.files.keys()].filter((key) => !before.files.has(key) && !before.large.has(key))
  await Promise.all(made.map((key) => fs.rm(path.join(project, after.files.get(key)?.shown ?? key), { force: true })))
  const folders = [...after.folders]
    .filter(([key]) => !before.folders.has(key))
    .sort(([one], [other]) => other.length - one.length)
  for (const [, shown] of folders) await fs.rm(path.join(project, shown), { recursive: true, force: true })
  // Shallow first, so a folder is made with the name it had before what it holds is written in it.
  const had = [...before.folders.values()].sort((one, other) => one.length - other.length)
  for (const shown of had) await fs.mkdir(path.join(project, shown), { recursive: true })
  for (const file of before.files.values()) {
    const now = after.files.get(file.shown.toLowerCase())
    if (now?.bytes.equals(file.bytes)) continue
    await fs.writeFile(path.join(project, file.shown), file.bytes)
  }
}

/** What is lost, as the model reads it: each file with what it held, the first few. */
export function described(lost: Lost[]) {
  const shown = lost.slice(0, 8).map((one) => {
    const first = one.lines.slice(0, 2).map((line) => `«${line.length > 80 ? `${line.slice(0, 80)}…` : line}»`)
    return `- \`${one.shown}\`, ${one.removed ? "deleted" : "written over"}: ${one.lines.length} lines, ${first.join(" ")}${one.lines.length > 2 ? " …" : ""}`
  })
  return [...shown, ...(lost.length > 8 ? [`- and ${lost.length - 8} files more`] : [])].join("\n")
}
