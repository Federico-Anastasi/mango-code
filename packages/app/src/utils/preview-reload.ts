// What a server on this PC serves cannot be told from its address: any file of these kinds may be part of the page.
const WEB_FILE = /\.(html?|css|m?js|jsx|tsx?|json|svg|png|jpe?g|gif|webp|ico|vue|svelte)$/i

const comparable = (file: string) => file.replaceAll("\\", "/").toLowerCase()

/** Whether a file the model has just written or changed can be part of the page the preview shows. */
export function pageChangedBy(page: string, file: string): boolean {
  const url = URL.canParse(page) ? new URL(page) : undefined
  if (!url) return false
  if (url.protocol === "file:") {
    const shown = comparable(decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, "$1"))
    const folder = shown.slice(0, shown.lastIndexOf("/") + 1)
    return comparable(file).startsWith(folder)
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const local = host === "localhost" || host === "::1" || /^127\./.test(host)
  return (url.protocol === "http:" || url.protocol === "https:") && local && WEB_FILE.test(file)
}
