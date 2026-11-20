import { afterEach, describe, expect, test } from "bun:test"
import { layerOver, type Box } from "./preview-layers"

const panel: Box = { left: 500, top: 40, right: 900, bottom: 700 }

function add(attributes: Record<string, string>, box: Box, parent: Element = document.body) {
  const el = document.createElement("div")
  Object.entries(attributes).forEach(([name, value]) => el.setAttribute(name, value))
  el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => ({}) })
  parent.append(el)
  return el
}

const menu = (box: Box) => add({ "data-popper-positioner": "" }, box)
const window_: Box = { left: 0, top: 0, right: 900, bottom: 760 }

afterEach(() => {
  document.body.replaceChildren()
  document.body.removeAttribute("style")
})

describe("layerOver", () => {
  test("nothing open: the panel is not covered", () => {
    expect(layerOver(panel, document)).toBe(false)
  })

  test("a menu that does not reach the panel leaves it alone, also while the library blocks the pointer of the page", () => {
    document.body.style.pointerEvents = "none"
    menu({ left: 300, top: 40, right: 480, bottom: 200 })
    expect(layerOver(panel, document)).toBe(false)
  })

  test("a tooltip over the panel does not cover it: a hover must not freeze the live page", () => {
    const tip = menu({ left: 600, top: 60, right: 700, bottom: 90 })
    const content = document.createElement("div")
    content.setAttribute("role", "tooltip")
    tip.append(content)
    expect(layerOver(panel, document)).toBe(false)
  })

  test("a menu that reaches the panel covers it", () => {
    menu({ left: 400, top: 40, right: 640, bottom: 300 })
    expect(layerOver(panel, document)).toBe(true)
  })

  test("a layer that only touches the panel's edge does not cover it", () => {
    menu({ left: 300, top: 40, right: 500, bottom: 200 })
    menu({ left: 600, top: 700, right: 800, bottom: 760 })
    expect(layerOver(panel, document)).toBe(false)
  })

  test("a layer with no size, or one the library has not placed, covers nothing", () => {
    menu({ left: 600, top: 100, right: 600, bottom: 300 })
    menu({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(layerOver(panel, document)).toBe(false)
  })

  test("a dialog covers the panel with its backdrop, even when its own box is far from it", () => {
    add({ "data-kb-top-layer": "" }, { left: 100, top: 100, right: 300, bottom: 300 })
    expect(layerOver(panel, document)).toBe(false)
    add({ "data-component": "dialog-overlay" }, window_)
    expect(layerOver(panel, document)).toBe(true)
  })

  test("the topmost layer of the library covers the panel where it is drawn", () => {
    add({ "data-kb-top-layer": "" }, { left: 700, top: 600, right: 880, bottom: 690 })
    expect(layerOver(panel, document)).toBe(true)
  })

  test("what the panel itself holds is not a layer over it", () => {
    const aside = document.createElement("aside")
    document.body.append(aside)
    add({ "data-kb-top-layer": "" }, { left: 600, top: 40, right: 800, bottom: 100 }, aside)
    expect(layerOver(panel, document, aside)).toBe(false)
    expect(layerOver(panel, document)).toBe(true)
  })
})
