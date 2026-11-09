import { projectFileKind } from "@opencode-ai/session-ui/project-file"
import type { ProjectFiles } from "@opencode-ai/session-ui/context"
import { phonePreview } from "@/utils/phone-preview"

/**
 * The files of a project from a phone: the phone port hands them over only if they are inside the project of the conversation
 * (`/phone/file`). A web page opens in the preview, the other documents are taken as a download. There is no folder to show.
 */
export function phoneProjectFiles(directory: string): ProjectFiles | undefined {
  if (!phonePreview.available()) return
  const address = (path: string, more = "") =>
    `/phone/file?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}${more}`
  return {
    async info(path) {
      const response = await fetch(address(path, "&info=1"))
      if (response.ok) return response.json()
      throw { code: response.status === 404 ? "not_found" : "io", message: response.statusText }
    },
    async open(path) {
      if (projectFileKind(path) === "web") return phonePreview.openPage({ directory, path })
      const link = document.createElement("a")
      link.href = address(path)
      link.download = ""
      link.click()
    },
  }
}
