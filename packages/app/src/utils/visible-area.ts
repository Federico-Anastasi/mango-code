type Viewport = { height: number; offsetTop: number; scale: number }

/**
 * Where the app sits while the keyboard is open. iPhone browsers keep the page as tall as the screen minus their bars and
 * show the keyboard on top of it: the part the user sees is shorter (and may be scrolled) and the app has to follow it.
 * Without a keyboard nothing is computed: the app fills the page, whatever the browser's bars do. `undefined`: no keyboard,
 * or pinch-zoomed (the visible area is then only a piece of the page: the app stays as it is).
 */
export function keyboardArea(viewport: Viewport, pageHeight: number, typing: boolean) {
  if (!typing || Math.abs(viewport.scale - 1) > 0.01) return undefined
  if (viewport.height >= pageHeight - 1) return undefined
  return { top: Math.round(viewport.offsetTop), height: Math.round(viewport.height) }
}

const NOT_TEXT = ["button", "checkbox", "radio", "range", "file", "submit", "reset", "image", "color"]

function typing() {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !NOT_TEXT.includes(el.type)
}

/**
 * Keeps `--keyboard-top` and `--keyboard-height` on `root` (see `#root` in index.css) and `data-keyboard` while the keyboard is
 * open. The state is read from the focus and the visual viewport every time one of them changes and, while typing, every
 * quarter of a second: a browser that does not tell when the keyboard goes away leaves nothing stale behind.
 */
export function followKeyboard(root: HTMLElement) {
  const viewport = window.visualViewport
  if (!viewport) return
  const apply = () => {
    const area = keyboardArea(viewport, document.documentElement.clientHeight, typing())
    if (area) {
      root.style.setProperty("--keyboard-top", `${area.top}px`)
      root.style.setProperty("--keyboard-height", `${area.height}px`)
      root.dataset.keyboard = ""
      return
    }
    if (!("keyboard" in root.dataset)) return
    root.style.removeProperty("--keyboard-top")
    root.style.removeProperty("--keyboard-height")
    delete root.dataset.keyboard
    // the browser may leave the page scrolled after the keyboard goes away
    window.scrollTo(0, 0)
  }
  viewport.addEventListener("resize", apply)
  viewport.addEventListener("scroll", apply)
  window.addEventListener("resize", apply)
  // after a focus change `activeElement` is the new one only in the next task
  const soon = () => setTimeout(apply, 0)
  document.addEventListener("focusin", soon)
  document.addEventListener("focusout", soon)
  setInterval(() => {
    if (typing() || "keyboard" in root.dataset) apply()
  }, 250)
  apply()
}
