// The commands that work on the files of the project: read, write, edit, search. Every path is taken from the
// project folder and shown from it; what a command answers holds nothing that the model could take for a line of
// the file.
import { isUtf8 } from "node:buffer"
import fs from "node:fs/promises"
import path from "node:path"
import { getDocumentProxy } from "unpdf"
import { fromLinux } from "../../../../launcher/mango-linux-path.mjs"
import type { Commands } from "./version"
import type { Answer } from "./contracts"
import { fitted } from "./look"
import { pageSights } from "./pdfpage"

export const ok = (text: string): Answer => ({ text, failed: false })
export const no = (text: string): Answer => ({ text, failed: true })

export type Files = {
  project: string
  commands: Commands
  outside(given: string): Promise<Answer>
  /** Whether the model is given pictures: an image file, a PDF page that has no text. */
  vision: boolean
  /** Whether a place outside the project may be read, or written. */
  reach(whole: string, how: "read" | "write"): boolean
}

const UNREAD = /\.(docx|xlsx|pptx)$/i
const PDF = /\.pdf$/i
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const NO_TEXT = "(no text on this page)"
const MOST_PICTURES = 4
/** The folders of a repository and of packages: `search` does not go into them, nor does the record of the files. */
export const SKIPPED = new Set([".git", "node_modules"])
const LONGEST_LINE = 1000
const MOST_CHARS = 20_000
// Control characters that no text has, in a file that is not UTF-8: a binary file read as latin1 is full of them.
const CONTROLS = /[\x00-\x08\x0e-\x1a\x1c-\x1f]/
const MOST_ENTRIES = 200

export const within = (child: string, parent: string) =>
  child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + path.sep)

/** Where a path is, by its letters alone. */
export function place(project: string, given: string) {
  const whole = path.resolve(project, given)
  return {
    whole,
    inside: within(whole, project),
    shown: within(whole, project) ? path.relative(project, whole).split(path.sep).join("/") || "." : whole,
  }
}

const real = (whole: string): Promise<string> =>
  fs.realpath(whole).catch(async () => {
    const parent = path.dirname(whole)
    return parent === whole ? whole : path.join(await real(parent), path.basename(whole))
  })

/** Where a path is, links followed: a link inside the project that leads out of it is outside. */
export async function located(project: string, given: string) {
  const at = place(project, given)
  return at.inside ? { ...at, inside: within(await real(at.whole), await real(project)) } : at
}

const kind = (whole: string) =>
  fs.stat(whole).then(
    (s) => (s.isDirectory() ? "folder" : "file"),
    () => "none",
  )
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/))
const cut = (line: string, most: number) =>
  line.length > most ? `${line.slice(0, most)} … (${line.length - most} more characters)` : line
const shown = (lines: string[]) => lines.map((line) => cut(line, LONGEST_LINE)).join("\n")

type Row = { y: number; height: number; pieces: { x: number; width: number; text: string }[] }

/** The lines of one PDF page. pdf.js gives pieces of text with a position, not lines: the pieces at the same height
 *  (less than half a character apart) make a line, left to right; a wide gap (a table column) becomes two spaces; a
 *  line far under the one before leaves a blank line. */
function pdfLines(items: { str: string; transform: number[]; width: number; height: number }[]) {
  const rows: Row[] = []
  items
    .filter((item) => item.str.trim())
    .forEach((item) => {
      const y = item.transform[5]
      const height = item.height || Math.abs(item.transform[3]) || 10
      const row = rows.find((one) => Math.abs(one.y - y) < height / 2) ?? { y, height, pieces: [] }
      if (row.pieces.length === 0) rows.push(row)
      row.pieces.push({ x: item.transform[4], width: item.width, text: item.str })
    })
  return rows
    .sort((a, b) => b.y - a.y)
    .flatMap((row, i) => {
      const line = row.pieces
        .sort((a, b) => a.x - b.x)
        .reduce(
          (made, piece, k) => {
            const gap = piece.x - made.end
            const space =
              k === 0
                ? ""
                : gap > row.height * 1.2
                  ? "  "
                  : gap > row.height * 0.12 && !made.text.endsWith(" ") && !piece.text.startsWith(" ")
                    ? " "
                    : ""
            return { text: made.text + space + piece.text, end: piece.x + piece.width }
          },
          { text: "", end: 0 },
        )
        .text.trimEnd()
      return i > 0 && rows[i - 1].y - row.y > row.height * 1.9 ? ["", line] : [line]
    })
}

/** The text of a PDF, page by page. `blank` has, for each page with no text, the number of the line that says so and the
 *  page. An Error says why the file cannot be read. */
async function pdfText(whole: string, shown: string) {
  const unreadable = (why: unknown) => {
    const error = why instanceof Error ? why : new Error(String(why))
    return new Error(
      error.name === "PasswordException" || /password/i.test(error.message)
        ? `${shown} is protected by a password: it cannot be read.`
        : `${shown} is not a readable PDF (${error.message.split("\n")[0]}).`,
    )
  }
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(whole)), { verbosity: 0 }).catch(unreadable)
  if (pdf instanceof Error) return pdf
  try {
    const pages = await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, i) => {
        const content = await (await pdf.getPage(i + 1)).getTextContent()
        const lines = pdfLines(content.items.flatMap((item) => ("str" in item ? [item] : [])))
        return [`--- page ${i + 1} ---`, ...(lines.length ? lines : [NO_TEXT]), ...(i + 1 < pdf.numPages ? [""] : [])]
      }),
    )
    const blank = new Map(
      pages.flatMap((page, i) => {
        const before = pages.slice(0, i).reduce((count, one) => count + one.length, 0)
        return page[1] === NO_TEXT ? [[before + 2, i + 1] as const] : []
      }),
    )
    return { pages: pdf.numPages, lines: pages.flat(), blank }
  } catch (e) {
    return unreadable(e)
  } finally {
    await pdf.loadingTask.destroy()
  }
}

/** The text of a file in the encoding it has, and how to write it back in the same one. `binary`: it is not text. */
async function load(whole: string) {
  const bytes = await fs.readFile(whole)
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : isUtf8(bytes) ? "utf8" : "latin1"
  const raw = bytes.toString(encoding)
  const mark = raw.startsWith("﻿") ? "﻿" : ""
  return {
    binary:
      encoding !== "utf16le" &&
      (bytes.subarray(0, 8000).includes(0) || (encoding === "latin1" && CONTROLS.test(raw.slice(0, 8000)))),
    text: raw.slice(mark.length),
    save: (next: string) => fs.writeFile(whole, Buffer.from(mark + next, encoding)),
  }
}

export async function listing(folder: string) {
  const entries = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((e) => e.name !== ".git")
    .map((e) => e.name + (e.isDirectory() ? "/" : ""))
    .sort()
  if (entries.length === 0) return "(empty folder)"
  return entries.length > MOST_ENTRIES
    ? `${entries.length} entries, the first ${MOST_ENTRIES}:\n${entries.slice(0, MOST_ENTRIES).join("\n")}`
    : entries.join("\n")
}

/** A file that is not there, with what the nearest folder that exists holds. */
export async function missing(project: string, whole: string): Promise<Answer> {
  // Outside the project the model is told what its project holds, not what is on the user's disk.
  if (!within(whole, project)) return no(`No file ${whole}. The project holds:\n${await listing(project)}`)
  const parts = path.relative(project, path.dirname(whole)).split(path.sep).filter(Boolean)
  const parents = parts.map((_, i) => path.join(project, ...parts.slice(0, parts.length - i)))
  const kinds = await Promise.all(parents.map(kind))
  const folder = parents.find((_, i) => kinds[i] === "folder") ?? project
  return no(
    `No file ${place(project, whole).shown}. The folder ${place(project, folder).shown} holds:\n${await listing(folder)}`,
  )
}

/** A path written for another computer (`/home/user/site/index.html`, `/workspace/app.js`) as a path from the
 *  project folder (`launcher/mango-linux-path.mjs`). Undefined for a path of this computer, a drive written as a folder
 *  (`/c/Users`, `/mnt/c/Users`) included. */
export async function fromProject(project: string, written: string) {
  const first = written.split(/[\\/]+/).filter(Boolean)[0]
  const has = first !== undefined && (await kind(path.join(project, first))) !== "none"
  const at = fromLinux(project, written, () => has)
  if (!at?.moved) return undefined
  return path.relative(project, at.path).split(path.sep).join("/") || "."
}

export async function read(
  files: Files,
  a: { path: string; from?: number; lines?: number; last?: number },
): Promise<Answer> {
  const at = await located(files.project, a.path)
  if (!at.inside && !files.reach(at.whole, "read")) return files.outside(a.path)
  const what = await kind(at.whole)
  if (what === "none") return missing(files.project, at.whole)
  if (what === "folder") return ok(await listing(at.whole))
  if (UNREAD.test(at.whole)) return no("`read` does not read Word, Excel and PowerPoint files.")
  if (IMAGE.test(at.whole)) {
    if (!files.vision) return no(`${at.shown} is a picture, and pictures cannot be seen in this setup.`)
    const picture = await fitted(await fs.readFile(at.whole))
    return picture instanceof Error
      ? no(`${at.shown} is ${picture.message}.`)
      : { ...ok(`The picture of ${at.shown} follows.`), images: [picture] }
  }
  const pdf = PDF.test(at.whole) ? await pdfText(at.whole, at.shown) : undefined
  if (pdf instanceof Error) return no(pdf.message)
  const file = pdf ? undefined : await load(at.whole)
  if (file?.binary) return no(`${at.shown} is a binary file, not text: it cannot be read.`)
  const lines = pdf ? pdf.lines : linesOf(file?.text ?? "")
  const title = pdf ? `${at.shown}, PDF of ${pdf.pages} ${pdf.pages === 1 ? "page" : "pages"}` : at.shown
  const from = a.last ? Math.max(1, lines.length - a.last + 1) : Math.max(1, a.from ?? 1)
  const wanted = lines.slice(from - 1, from - 1 + (a.lines ?? 200))
  // An answer is at most MOST_CHARS long: the lines that do not fit are left out, with the line to read on from.
  const sizes = wanted.map((line) => Math.min(line.length, LONGEST_LINE) + 1)
  const total = { chars: 0 }
  const over = sizes.findIndex((size) => (total.chars += size) > MOST_CHARS)
  const some = wanted.slice(0, over < 0 ? wanted.length : Math.max(1, over))
  const to = from - 1 + some.length
  const left = wanted.length - some.length
  const leftOut =
    left > 0
      ? `\n… ${left} more lines (${sizes.slice(some.length).reduce((total, size) => total + size, 0)} characters) left out to keep the answer short: read on from line ${to + 1}`
      : ""
  if (lines.length === 0) return ok(`${at.shown}, an empty file`)
  if (from > lines.length) return no(`${at.shown} has ${lines.length} lines.`)
  // The pages with no text among the lines shown are given as pictures, the first few; the others say where to read on.
  const blank = pdf && files.vision ? [...pdf.blank].filter(([line]) => line >= from && line <= to) : []
  const drawn = blank.length
    ? await pageSights(
        at.whole,
        blank.slice(0, MOST_PICTURES).map(([, page]) => page),
      )
    : []
  const notes = new Map(
    blank.map(([line], i): [number, string] => [
      line,
      drawn instanceof Error
        ? `(no text on this page, and its picture could not be made: ${drawn.message})`
        : i < MOST_PICTURES
          ? `(no text on this page: picture ${i + 1} below)`
          : `(no text on this page: its picture is left out, as ${MOST_PICTURES} come in one read; read on from line ${line - 1})`,
    ]),
  )
  const body = shown(some.map((line, i) => notes.get(from + i) ?? line))
  const answer = ok(`${title}, lines ${from}-${to} of ${lines.length}\n${body}${leftOut}`)
  return Array.isArray(drawn) && drawn.length ? { ...answer, images: drawn } : answer
}

export async function write(
  files: Files,
  a: { path: string; content: string },
): Promise<Answer & { written?: { whole: string; shown: string; lines: number } }> {
  const at = await located(files.project, a.path)
  if (!at.inside && !files.reach(at.whole, "write")) return files.outside(a.path)
  if (UNREAD.test(at.whole) || PDF.test(at.whole))
    return no("`write` does not make Word, Excel, PowerPoint or PDF files.")
  const what = await kind(at.whole)
  if (what === "folder") return no(`${at.shown} is a folder.`)
  await fs.mkdir(path.dirname(at.whole), { recursive: true })
  await fs.writeFile(at.whole, a.content)
  const lines = linesOf(a.content).length
  return { ...ok(`Written ${at.shown} (${lines} lines)`), written: { whole: at.whole, shown: at.shown, lines } }
}

export const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

export async function edit(
  files: Files,
  a: { path: string; old?: string; new: string; all?: boolean },
): Promise<Answer> {
  const at = await located(files.project, a.path)
  if (!at.inside && !files.reach(at.whole, "write")) return files.outside(a.path)
  const what = await kind(at.whole)
  if (what === "folder") return no(`${at.shown} is a folder.`)
  if (what === "none") return missing(files.project, at.whole)
  const file = await load(at.whole)
  if (file.binary) return no(`${at.shown} is a binary file, not text: it cannot be edited.`)
  const before = linesOf(file.text)
  const eol = file.text.includes("\r\n") ? "\r\n" : "\n"
  const fresh = a.new.replace(/\r?\n/g, eol)

  if (!a.old) return no("`edit` needs `old`: the text that is in the file now.")

  const old = a.old.split(/\r?\n/)
  const exact = [...file.text.matchAll(new RegExp(old.map(escaped).join("\\r?\\n"), "g"))]
  // A model does not see the spaces at the end of a line: a harness may find the text without them.
  const found =
    exact.length || !files.commands.spaces
      ? exact
      : [
          ...file.text.matchAll(
            new RegExp(old.map((line) => escaped(line.trimEnd())).join("[ \\t]*\\r?\\n") + "[ \\t]*$", "gm"),
          ),
        ]
  if (found.length === 0) {
    if (before.length === 0) return no(`${at.shown} is empty.`)
    const wanted = new Set(wordsOf(old.find((line) => line.trim()) ?? ""))
    const scores = before.map((line) => wordsOf(line).filter((word) => wanted.has(word)).length)
    const best = scores.indexOf(Math.max(...scores))
    const first = Math.max(0, best - 2)
    return no(
      `The old text is not in ${at.shown}. The closest lines:\n${shown(before.slice(first, best + 3))}`,
    )
  }
  const lineOf = (index: number) => file.text.slice(0, index).split("\n").length
  if (found.length > 1 && !a.all)
    return no(
      `The old text is in ${found.length} places of ${at.shown}, at lines ${found.map((m) => lineOf(m.index)).join(", ")}. Give more of the text around the one you mean, or \`all\`.`,
    )
  const next = found.reduceRight(
    (whole, m) => whole.slice(0, m.index) + fresh + whole.slice(m.index + m[0].length),
    file.text,
  )
  if (next === file.text) return no("Nothing changed: the new text is the same as the old.")
  await file.save(next)
  const after = linesOf(next)
  const start = lineOf(found[0].index)
  const from = Math.max(1, start - 2)
  return ok(
    `Changed ${at.shown}${found.length > 1 ? ` in ${found.length} places` : ""}. Around the change:\n${shown(after.slice(from - 1, start + fresh.split(eol).length + 1))}`,
  )
}

export async function search(
  files: Files,
  a: { name?: string; text?: string; folder?: string; file?: string },
): Promise<Answer> {
  if (!a.name && !a.text && !a.file) return no("Give `name`, `text`, or both.")
  if (a.name && (/(^|[\\/])\.\.([\\/]|$)/.test(a.name) || /^([\\/]|[A-Za-z]:)/.test(a.name)))
    return no("`name` is a pattern for names inside the project, like `*.csv` or `src/**/*.ts`.")
  const at = await located(files.project, a.folder ?? ".")
  if (!at.inside && !files.reach(at.whole, "read")) return files.outside(a.folder ?? ".")
  if ((await kind(at.whole)) !== "folder")
    return no(`No folder ${at.shown}. The project holds:\n${await listing(files.project)}`)
  // Names are matched without minding the case, as Windows does.
  const pattern = new Bun.Glob((!a.name ? "**/*" : a.name.includes("/") ? a.name : `**/${a.name}`).toLowerCase())
  const only = a.file === undefined ? undefined : await located(files.project, a.file)
  if (only && !only.inside && !files.reach(only.whole, "read")) return files.outside(a.file ?? "")
  if (only && (await kind(only.whole)) !== "file") return missing(files.project, only.whole)
  const paths = only
    ? [only.shown]
    : (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: at.whole, dot: true })))
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => !file.split("/").some((part) => SKIPPED.has(part)) && pattern.match(file.toLowerCase()))
        .map((file) => place(files.project, path.join(at.whole, file)).shown)
        .sort()
  const wanted = a.text?.toLowerCase()
  const found =
    wanted === undefined
      ? paths
      : (
          await Promise.all(
            paths.map(async (file) => {
              const loaded = await load(path.resolve(files.project, file))
              return loaded.binary
                ? []
                : linesOf(loaded.text).flatMap((line, i) =>
                    line.toLowerCase().includes(wanted) ? [`${file}:${i + 1}: ${cut(line, 300)}`] : [],
                  )
            }),
          )
        ).flat()
  if (found.length === 0) return ok(`Nothing found. The project holds:\n${await listing(files.project)}`)
  return ok(
    found.length > 100 ? `${found.length} found, the first 100:\n${found.slice(0, 100).join("\n")}` : found.join("\n"),
  )
}
