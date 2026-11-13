import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createFileFind } from "@opencode-ai/session-ui/pierre/file-find"

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

// The find in a file goes to the next and previous result with Enter and Shift+Enter in its field; Ctrl+G is gone.
test("Ctrl+G does not move the find in a file, Enter and Shift+Enter do", async () => {
  const wrapper = document.createElement("div")
  const overlay = document.createElement("div")
  const host = document.createElement("div")
  document.body.append(wrapper, overlay, host)
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<div data-content><div data-line>gatto</div><div data-line>gatto</div><div data-line>gatto</div></div>`

  await createRoot(async (dispose) => {
    const find = createFileFind({ wrapper: () => wrapper, overlay: () => overlay, getRoot: () => root })
    await frame()
    find.focus()
    find.setQuery("gatto")
    await frame()
    expect(find.count()).toBe(3)
    expect(find.index()).toBe(0)

    const ctrlG = new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ctrlG)
    expect(ctrlG.defaultPrevented).toBe(false)
    expect(find.index()).toBe(0)

    find.onInputKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))
    expect(find.index()).toBe(1)
    find.onInputKeyDown(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true }))
    expect(find.index()).toBe(0)
    dispose()
  })
  wrapper.remove()
  overlay.remove()
  host.remove()
})

// Ctrl+F belongs to a file only when the user is in it, even with its find open; in the find's own bar it stays there.
test("Ctrl+F opens the find of a file only with the focus inside it or in its bar", async () => {
  const wrapper = document.createElement("div")
  wrapper.tabIndex = 0
  const overlay = document.createElement("div")
  const host = document.createElement("div")
  const bar = document.createElement("div")
  bar.dataset.component = "file-search-bar"
  const input = document.createElement("input")
  bar.append(input)
  const outside = document.createElement("button")
  document.body.append(wrapper, overlay, host, bar, outside)
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = `<div data-content><div data-line>gatto</div></div>`
  const ctrlF = (target: Element) => {
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  try {
    await createRoot(async (dispose) => {
      const find = createFileFind({ wrapper: () => wrapper, overlay: () => overlay, getRoot: () => root })
      await frame()
      find.focus()
      expect(find.open()).toBe(true)

      outside.focus()
      expect(ctrlF(outside)).toBe(false)
      input.focus()
      expect(ctrlF(input)).toBe(true)
      wrapper.focus()
      expect(ctrlF(wrapper)).toBe(true)
      dispose()
    })
  } finally {
    wrapper.remove()
    overlay.remove()
    host.remove()
    bar.remove()
    outside.remove()
  }
})
