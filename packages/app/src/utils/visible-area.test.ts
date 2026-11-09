import { describe, expect, test } from "bun:test"
import { keyboardArea } from "./visible-area"

describe("keyboardArea", () => {
  test("with the keyboard open the app takes what the user sees: above the keyboard, where the browser has scrolled to", () => {
    expect(keyboardArea({ height: 388.4, offsetTop: 0, scale: 1 }, 724, true)).toEqual({ top: 0, height: 388 })
    expect(keyboardArea({ height: 380, offsetTop: 126.6, scale: 1 }, 724, true)).toEqual({ top: 127, height: 380 })
  })

  test("not typing there is no keyboard: nothing is kept, even if the visible area is still short", () => {
    expect(keyboardArea({ height: 388, offsetTop: 0, scale: 1 }, 724, false)).toBeUndefined()
  })

  test("when the visible area is as tall as the page there is nothing to follow", () => {
    expect(keyboardArea({ height: 724, offsetTop: 0, scale: 1 }, 724, true)).toBeUndefined()
    expect(keyboardArea({ height: 723.5, offsetTop: 0, scale: 1 }, 724, true)).toBeUndefined()
  })

  test("pinch-zoomed the visible area is only a piece of the page: the app stays as it is", () => {
    expect(keyboardArea({ height: 300, offsetTop: 40, scale: 2 }, 724, true)).toBeUndefined()
  })
})
