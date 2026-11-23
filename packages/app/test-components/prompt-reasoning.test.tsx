import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { PromptReasoning } from "@/components/prompt-reasoning"

const labels: Record<string, string> = {
  low: "Basso",
  medium: "Medio",
  high: "Alto",
  off: "Spento",
  on: "Acceso",
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(levels: string[], value: string) {
  const chosen: string[] = []
  const closed: number[] = []
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PromptReasoning
        levels={levels}
        value={value}
        label="Ragionamento"
        text={(level) => labels[level]}
        onChange={(level) => chosen.push(level)}
        onClose={() => closed.push(1)}
      />
    ),
    host,
  )
  const pill = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-reasoning"]')
  // happy-dom reports no animation name, so Kobalte keeps a closed content mounted: closed is marked, not removed
  const control = () =>
    document.querySelector<HTMLElement>('[data-component="prompt-reasoning-control"]:not([data-closed]) [data-slot="segmented-control-v2"]')
  const segments = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="segmented-control-v2-item"]')].map((item) => ({
      text: item.textContent,
      pressed: item.hasAttribute("data-pressed"),
      click: () => item.click(),
    }))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
  return { chosen, closed, pill, control, segments, tick }
}

describe("the reasoning pill", () => {
  test("closed, it is the gauge and the value alone, with Reasoning as its name", () => {
    const view = mount(["low", "medium", "high"], "medium")
    const pill = view.pill()
    expect(pill?.textContent).toBe("Medio")
    expect(pill?.querySelector("svg")).not.toBeNull()
    expect(pill?.getAttribute("aria-label")).toBe("Ragionamento")
    expect(view.control()).toBeNull()
  })

  test("clicked, it opens the three levels with the current one pressed", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.click()
    await view.tick()
    expect(view.segments()).toEqual([
      { text: "Basso", pressed: false, click: expect.any(Function) },
      { text: "Medio", pressed: true, click: expect.any(Function) },
      { text: "Alto", pressed: false, click: expect.any(Function) },
    ])
  })

  test("with two levels it opens the two", async () => {
    const view = mount(["off", "on"], "on")
    view.pill()?.click()
    await view.tick()
    expect(view.segments().map((item) => item.text)).toEqual(["Spento", "Acceso"])
  })

  test("a choice is given and the control closes", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.click()
    await view.tick()
    view.segments()[0].click()
    await view.tick()
    expect(view.chosen).toEqual(["low"])
    expect(view.control()).toBeNull()
  })

  test("the level already chosen is no new choice", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.click()
    await view.tick()
    view.segments()[1].click()
    await view.tick()
    expect(view.chosen).toEqual([])
    expect(view.control()).toBeNull()
  })

  test("Escape closes it without a choice", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.click()
    await view.tick()
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await view.tick()
    expect(view.control()).toBeNull()
    expect(view.chosen).toEqual([])
  })

  test("a click outside closes it without a choice", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.click()
    await view.tick()
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    document.body.click()
    await view.tick()
    expect(view.control()).toBeNull()
    expect(view.chosen).toEqual([])
  })

  test("opened with the pointer, focus stays out of the levels, so no ring is drawn on one", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    view.pill()?.click()
    await view.tick()
    expect(document.activeElement?.closest('[data-slot="segmented-control-v2-item"]')).toBeNull()
    expect(document.activeElement?.getAttribute("data-component")).toBe("prompt-reasoning-control")
  })

  test("opened with the keyboard, focus goes in to the levels", async () => {
    const view = mount(["low", "medium", "high"], "medium")
    view.pill()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    view.pill()?.click()
    await view.tick()
    expect(document.activeElement?.getAttribute("data-slot")).toBe("segmented-control-v2-item")
  })
})
