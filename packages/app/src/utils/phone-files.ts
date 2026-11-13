import { PREVIEW_MAX_BYTES, previewKind } from "@opencode-ai/session-ui/project-file"
import type { ProjectFiles } from "@opencode-ai/session-ui/context"
import { phonePreview } from "@/utils/phone-preview"

/**
 * The files of a project from a phone: the phone port hands them over only if they are inside the project of the conversation
 * (`/phone/file`). A web page opens in the preview of the computer; a picture and, where the browser can show one, a PDF open
 * inside the app; the other documents are taken as a download. There is no folder to show.
 */
export function phoneProjectFiles(directory: string): ProjectFiles | undefined {
  if (!phonePreview.available()) return
  const address = (path: string, more = "") =>
    `/phone/file?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}${more}`
  const files: ProjectFiles = {
    async info(path) {
      const response = await fetch(address(path, "&info=1"))
      if (response.ok) return response.json()
      throw { code: response.status === 404 ? "not_found" : "io", message: response.statusText }
    },
    async open(path) {
      const kind = previewKind(path)
      if (kind === "web") return phonePreview.openPage({ directory, path })
      if (kind && (kind === "image" || navigator.pdfViewerEnabled)) return showFile(files, address(path), path, kind)
      const link = document.createElement("a")
      link.href = address(path)
      link.download = ""
      link.click()
    },
  }
  return files
}

/**
 * The file is fetched and shown from memory with the type it must have: a picture is drawn as a picture (an SVG never
 * runs as a page) and a PDF as a PDF, whatever the computer says it is. A file over the limit is not fetched.
 */
async function showFile(files: ProjectFiles, url: string, path: string, kind: "image" | "pdf") {
  if ((await files.info(path)).size > PREVIEW_MAX_BYTES) throw { code: "too_large", message: path }
  const response = await fetch(url)
  if (!response.ok) throw { code: response.status === 404 ? "not_found" : "io", message: response.statusText }
  const sent = response.headers.get("content-type") ?? ""
  const type = kind === "pdf" ? "application/pdf" : sent.startsWith("image/") ? sent : ""
  const name = path.split(/[\\/]/).at(-1) ?? path
  phonePreview.showFile(new Blob([await response.arrayBuffer()], { type }), name, kind)
}
