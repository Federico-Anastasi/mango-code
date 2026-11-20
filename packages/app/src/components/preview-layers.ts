export type Box = { left: number; top: number; right: number; bottom: number }

/**
 * What the page opens above the native panel: a menu, a list or a popover (their positioner), the topmost layer of the
 * library (a dialog's content) and the dimmed backdrop of a dialog, which covers the whole window. A tooltip is left out:
 * it comes with a hover, and stepping aside for it would freeze the live page at every pass of the mouse.
 */
export const LAYERS = "[data-popper-positioner], [data-kb-top-layer], [data-component='dialog-overlay']"

const crosses = (a: Box, b: Box) => b.right - b.left > 0 && b.bottom - b.top > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top

/** Whether a layer of the page covers part of `panel`, wherever the library leaves the pointer: only where it is drawn counts. */
export function layerOver(panel: Box, root: ParentNode, own?: Element) {
  return [...root.querySelectorAll(LAYERS)].some((layer) => {
    if (own?.contains(layer) || layer.querySelector("[role='tooltip']")) return false
    return crosses(panel, layer.getBoundingClientRect())
  })
}
