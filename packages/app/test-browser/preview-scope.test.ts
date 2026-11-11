import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { rememberPerKey } from "@/utils/preview-scope"

test("the preview panel is closed in a conversation that did not open it, and found as it was left on return", () => {
  const [opened, setOpened] = createSignal(false)
  const [key, setKey] = createSignal("pizzeria")
  const dispose = createRoot((dispose) => {
    rememberPerKey(opened, setOpened, key)
    return dispose
  })

  setOpened(true)
  setKey("word")
  expect(opened()).toBe(false)

  setKey("pizzeria")
  expect(opened()).toBe(true)

  setOpened(false)
  setKey("word")
  setKey("pizzeria")
  expect(opened()).toBe(false)
  dispose()
})
