import type { UiI18nKey } from "@opencode-ai/ui/context/i18n"

export type ProjectFileKind = "word" | "excel" | "powerpoint" | "pdf" | "image" | "web" | "text" | "archive" | "file"

const KINDS: Record<string, ProjectFileKind> = {
  docx: "word",
  doc: "word",
  odt: "word",
  rtf: "word",
  xlsx: "excel",
  xls: "excel",
  ods: "excel",
  pptx: "powerpoint",
  ppt: "powerpoint",
  odp: "powerpoint",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  html: "web",
  htm: "web",
  txt: "text",
  md: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  log: "text",
  zip: "archive",
  "7z": "archive",
  rar: "archive",
}

/** Types with no line-by-line diff to show: in the chat they are a card to open. */
const CARD_KINDS = new Set<ProjectFileKind>(["word", "excel", "powerpoint", "pdf", "image", "archive"])

export function projectFileKind(name: string): ProjectFileKind {
  const base = name.split(/[\\/]/).at(-1) ?? name
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "file"
  return KINDS[base.slice(dot + 1).toLowerCase()] ?? "file"
}

/** A document (or an image) rather than a text file with changes to read. */
export function isProjectFileCard(name: string) {
  return CARD_KINDS.has(projectFileKind(name))
}

/**
 * What the preview shows of a file: a PDF, a picture (an SVG too, drawn as a picture and never run as a page) or a web
 * page (it runs, like the pages the agent opens).
 */
export function previewKind(name: string): "pdf" | "image" | "web" | undefined {
  const kind = projectFileKind(name)
  return kind === "pdf" || kind === "image" || kind === "web" ? kind : undefined
}

/** The most the preview opens (desktop panel and phone), in bytes: a bigger file says so and is opened from the folder. */
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024

export function projectFileKindKey(kind: ProjectFileKind) {
  return `ui.file.kind.${kind}` as UiI18nKey
}

/** Absolute path of a project file (inside the project, files are relative, with the `/` separator). */
export function projectFilePath(directory: string, file: string) {
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") || file.startsWith("/")) return file
  const sep = directory.includes("\\") ? "\\" : "/"
  const root = directory.replace(/[\\/]+$/, "")
  return `${root}${sep}${file.replace(/[\\/]/g, sep)}`
}

/** "12 KB", "1,3 MB": a readable size, with the decimal comma or point of the language. */
export function formatFileSize(bytes: number, locale?: string) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const text = value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })
  return `${text} ${units[unit]}`
}

/** The app bridge rejects with `{ code }`: the code chooses the text to show. */
export function projectFileProblem(cause: unknown): "missing" | "blocked" | "large" | "unreadable" | "failed" {
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code: unknown }).code : undefined
  if (code === "not_found") return "missing"
  if (code === "blocked_type") return "blocked"
  if (code === "too_large") return "large"
  if (code === "unreadable") return "unreadable"
  return "failed"
}

/**
 * File a tool wrote, read from the tool part: `write` and `edit` (path in the parameters) and
 * `documents_create` (path in the confirmation message). It serves folders without git, where the
 * session's changes are not recorded.
 */
export function producedFilePath(tool: string, input: Record<string, unknown> | undefined, output: unknown) {
  if ((tool === "write" || tool === "edit") && typeof input?.filePath === "string") return input.filePath
  if (tool === "documents_create" && typeof output === "string") return output.match(/^File created: (.+) \(\d+ KB\)/m)?.[1]
}

/** Same form to compare two paths: same slashes, case ignored (Windows). */
export function samePathKey(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** The path relative to the project folder, if it is inside it; otherwise the path as it is. */
export function projectRelativePath(directory: string, path: string) {
  const root = samePathKey(directory) + "/"
  const whole = path.replace(/\\/g, "/")
  return samePathKey(path).startsWith(root) ? whole.slice(root.length) : whole
}
