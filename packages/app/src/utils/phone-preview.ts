import { createSignal } from "solid-js"
import { showToast } from "@/utils/toast"

/**
 * From a phone the browser panel of the computer is seen through the phone port (`crates/phone`, `site.rs`): `/phone/preview`
 * says which page the panel shows and opens one in it, and a second port serves that page with the same session. The page is
 * shown full screen in a frame whose address is the phone's own with that port.
 */

export type PhonePage = { path: string; title: string; label: string; local: boolean }
type PhonePreviewState = { port: number; page: PhonePage | null }

/** What the phone asks the panel to open: an address of the computer, or an HTML file of a project. */
export type PhoneOpen = { url: string } | { directory: string; path: string }

/**
 * The page shown full screen: the address of the frame and the name over it. A file of the project (`kind`) is shown by
 * itself, from the copy the phone fetched (`src` is its address in memory), not as a page of the computer.
 */
export type PhoneView = { src: string; title: string; kind?: "image" | "pdf" }

const lastPages = new Map<string, PhoneOpen>()
const [available, setAvailable] = createSignal(false)
const [view, setView] = createSignal<PhoneView>()

/** Shows `next`, freeing the file the previous view held. */
function show(next: PhoneView | undefined) {
  const before = view()
  if (before?.kind) URL.revokeObjectURL(before.src)
  setView(next)
}

async function ask(order?: PhoneOpen): Promise<PhonePreviewState | undefined> {
  const response = await fetch(
    "/phone/preview",
    order
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) }
      : { headers: { accept: "application/json" } },
  )
  const answer = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(answer?.error ?? response.statusText)
  return answer
}

/** The frame's address: the phone's own address with the preview port and the page's path. */
export function previewSrc(hostname: string, state: PhonePreviewState) {
  return `http://${hostname}:${state.port}${state.page?.path ?? "/"}`
}

function viewOf(state: PhonePreviewState): PhoneView {
  return { src: previewSrc(location.hostname, state), title: state.page?.title || state.page?.label || "" }
}

/** `http://localhost:<port>` and `http://127.0.0.1:<port>` links: pages of the computer, which the phone cannot reach by itself. */
export function localLink(href: string) {
  if (!URL.canParse(href)) return
  const url = new URL(href)
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") ? url.href : undefined
}

export const phonePreview = {
  /** True when this page comes through the phone port (a plain browser or the desktop app has no such thing). */
  available,
  view,
  async detect() {
    if (window.__MANGO_DESKTOP__) return
    const state = await ask().catch(() => undefined)
    setAvailable(typeof state?.port === "number")
  },
  /**
   * `detect` now and again each time the page comes back (visible, online) while the preview is not available: a drop
   * of the phone's network at the start does not turn it off for the whole visit. Returns the way to stop.
   */
  watch() {
    const check = () => {
      if (!available() && document.visibilityState === "visible") void phonePreview.detect()
    }
    check()
    document.addEventListener("visibilitychange", check)
    window.addEventListener("online", check)
    return () => {
      document.removeEventListener("visibilitychange", check)
      window.removeEventListener("online", check)
    }
  },
  /** The last HTML page a conversation wrote: what the globe opens when the panel has no page. */
  rememberPage(sessionID: string, order: PhoneOpen | undefined) {
    if (order) lastPages.set(sessionID, order)
    else lastPages.delete(sessionID)
  },
  /**
   * Shows the page the panel has now; with none, the last one `sessionID` wrote, if it wrote one. Rejects with the sentence
   * for the user.
   */
  async open(sessionID?: string) {
    let state = await ask()
    const fallback = sessionID && !state?.page ? lastPages.get(sessionID) : undefined
    if (fallback) state = (await ask(fallback)) ?? state
    if (state) show(viewOf(state))
  },
  /** Asks the panel to open a page first, then shows it. Rejects with the sentence for the user. */
  async openPage(order: PhoneOpen) {
    const state = await ask(order)
    if (state) show(viewOf(state))
  },
  /** Shows a picture or a PDF the phone fetched from the computer. */
  showFile(file: Blob, title: string, kind: "image" | "pdf") {
    show({ src: URL.createObjectURL(file), title, kind })
  },
  close: () => show(undefined),
}

/** Links to a page of the computer open in the preview instead of on the phone. Returns the way to stop. */
export function openLocalLinks(onOpen: (url: string) => void) {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null
    const url = link && localLink(link.href)
    if (!url) return
    event.preventDefault()
    onOpen(url)
  }
  document.addEventListener("click", onClick, true)
  return () => document.removeEventListener("click", onClick, true)
}

/** What to do when the preview could not be opened: say it, with the reason the phone port gave. */
export const previewFailed = (title: string) => (cause: unknown) =>
  showToast({ variant: "error", title, description: cause instanceof Error ? cause.message : undefined })
