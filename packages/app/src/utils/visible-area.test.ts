import { describe, expect, test } from "bun:test"
import { visibleArea } from "./visible-area"

describe("visibleArea", () => {
  test("the app takes exactly what the user sees: under the browser bars and above the keyboard", () => {
    expect(visibleArea({ height: 641.4, offsetTop: 0, scale: 1 })).toEqual({ top: 0, height: 641 })
    // the browser scrolled the page up to show the field that has the keyboard: the app follows the visible area
    expect(visibleArea({ height: 380, offsetTop: 126.6, scale: 1 })).toEqual({ top: 127, height: 380 })
  })

  test("pinch-zoomed there is no area to follow: the page stays at its normal size", () => {
    expect(visibleArea({ height: 300, offsetTop: 40, scale: 2 })).toBeUndefined()
  })
})
