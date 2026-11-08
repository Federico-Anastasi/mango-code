// Office documents -> text, for a model that reads only text (Mango Code).
// Word, Excel, PowerPoint and PDF are recognized from the content of the file, not from the extension alone.
import ExcelJS from "exceljs"
import JSZip from "jszip"
import mammoth from "mammoth"
import TurndownService from "turndown"
import { extractText, getDocumentProxy } from "unpdf"

export type DocumentKind = "docx" | "xlsx" | "pptx" | "pdf"

const MIME: Record<DocumentKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
}

/** Cap on the text of a document put in a message: ~10k tokens on an 80-128k context. */
export const MAX_DOCUMENT_CHARS = 40_000

const MAX_SHEET_ROWS = 1000
const MAX_SHEET_COLUMNS = 40

export function documentKind(filename: string | undefined, mime: string | undefined): DocumentKind | undefined {
  const byMime = (Object.keys(MIME) as DocumentKind[]).find((kind) => MIME[kind] === mime)
  if (byMime) return byMime
  const ext = filename?.split(".").pop()?.toLowerCase()
  return ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf" ? ext : undefined
}

/** The text of the document as Markdown: headings, lists and tables stay recognizable. */
export async function documentToText(kind: DocumentKind, bytes: Uint8Array): Promise<string> {
  const text = await (kind === "docx" ? docx(bytes) : kind === "xlsx" ? xlsx(bytes) : kind === "pptx" ? pptx(bytes) : pdf(bytes))
  return text.replace(/\n{3,}/g, "\n\n").trim()
}

async function docx(bytes: Uint8Array) {
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    // embedded images would be megabytes of base64: a text-only model has no use for them
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  )
  const md = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
  md.addRule("image", { filter: "img", replacement: () => "[image]" })
  md.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).rows).map((row) =>
        Array.from(row.cells).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
      )
      if (!rows.length) return ""
      const width = Math.max(...rows.map((row) => row.length))
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`
      return `\n\n${[line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`
    },
  })
  return md.turndown(value)
}

function cellText(cell: ExcelJS.Cell) {
  const v = cell.value
  if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, "")
  // a formula with no saved result (file made by a library, never opened in Excel) is shown as it is
  if (v && typeof v === "object" && "formula" in v && v.result === undefined) return `=${v.formula}`
  return cell.text
}

async function xlsx(bytes: Uint8Array) {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const sheets = book.worksheets.map((sheet) => {
    const rows: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (rows.length >= MAX_SHEET_ROWS) return
      const cells: string[] = []
      const last = Math.min(row.cellCount, MAX_SHEET_COLUMNS)
      for (let c = 1; c <= last; c++) cells.push(cellText(row.getCell(c)).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|"))
      rows.push([String(number), ...cells])
    })
    const width = Math.max(1, ...rows.map((row) => row.length - 1))
    const line = (cells: string[]) => `| ${[cells[0], ...Array.from({ length: width }, (_, i) => cells[i + 1] ?? "")].join(" | ")} |`
    const header = `| row | ${Array.from({ length: width }, (_, i) => columnLetter(i + 1)).join(" | ")} |`
    const cut = sheet.rowCount > MAX_SHEET_ROWS ? `\n\n(the sheet has ${sheet.rowCount} rows: here the first ${MAX_SHEET_ROWS})` : ""
    return `## Sheet «${sheet.name}»\n\n${[header, `|${" --- |".repeat(width + 1)}`, ...rows.map(line)].join("\n")}${cut}`
  })
  return sheets.join("\n\n")
}

function columnLetter(n: number) {
  let out = ""
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out
  return out
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function xmlText(xml: string) {
  const unescape = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENTITIES[e.toLowerCase()],
    )
  return [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)]
    // the slide number is an automatic field, not text by the author
    .filter((p) => !p[0].includes('type="slidenum"'))
    .map((p) => unescape([...p[0].matchAll(/<a:t(?: [^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("")).trim())
    .filter(Boolean)
}

async function pptx(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const number = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1])
  const named = (dir: string) =>
    Object.keys(zip.files)
      .filter((name) => new RegExp(`^ppt/${dir}/[^/]+\\.xml$`).test(name))
      .sort((a, b) => number(a) - number(b))
  const notes = new Map<number, string[]>()
  for (const name of named("notesSlides")) {
    const lines = xmlText(await zip.files[name].async("string"))
    if (lines.length) notes.set(number(name), lines)
  }
  const slides = await Promise.all(
    named("slides").map(async (name, index) => {
      const lines = xmlText(await zip.files[name].async("string"))
      const note = notes.get(number(name))
      return [`## Slide ${index + 1}`, ...lines.map((line) => `- ${line}`), ...(note ? ["", "Speaker notes:", ...note] : [])].join("\n")
    }),
  )
  return slides.join("\n\n")
}

async function pdf(bytes: Uint8Array) {
  const doc = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(doc, { mergePages: false })
  const pages = text.map((page, i) => ({ n: i + 1, page: page.trim() })).filter(({ page }) => page)
  if (!pages.length) throw new Error("the PDF has no selectable text (maybe it is a scan)")
  return pages.map(({ n, page }) => `## Page ${n}\n\n${page}`).join("\n\n")
}
