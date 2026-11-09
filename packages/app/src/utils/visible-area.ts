type Viewport = { height: number; offsetTop: number; scale: number }

/**
 * The part of the screen the user sees, where the app has to sit: not under the browser's bars, above the keyboard.
 * `dvh` does not give it on every phone browser, and with the keyboard open the page itself scrolls up. Pinch-zoomed
 * the visible area is only a piece of the page: the app stays as it is.
 */
export function visibleArea(viewport: Viewport) {
  if (Math.abs(viewport.scale - 1) > 0.01) return undefined
  return { top: Math.round(viewport.offsetTop), height: Math.round(viewport.height) }
}

/** Keeps `--visible-top` and `--visible-height` of the element (see `#root` in index.css) on the visible area. */
export function followVisibleArea(root: HTMLElement) {
  const viewport = window.visualViewport
  if (!viewport) return
  const apply = () => {
    const area = visibleArea(viewport)
    if (!area) {
      root.style.removeProperty("--visible-top")
      root.style.removeProperty("--visible-height")
      return
    }
    root.style.setProperty("--visible-top", `${area.top}px`)
    root.style.setProperty("--visible-height", `${area.height}px`)
  }
  viewport.addEventListener("resize", apply)
  viewport.addEventListener("scroll", apply)
  apply()
}
