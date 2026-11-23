import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { MangoNotice } from "@/components/mango-notice"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(text: string) {
  const closed: number[] = []
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <MangoNotice text={text} closeLabel="Close" onClose={() => closed.push(1)} />, host)
  return { host, closed, line: () => host.querySelector<HTMLElement>('[data-component="mango-notice"]') }
}

describe("the engine's notice above the box", () => {
  test("it says its line as a notice, not as an error", () => {
    const view = mount("I can't read the memory of the cards: the model starts anyway.")
    expect(view.line()?.textContent).toContain("I can't read the memory of the cards: the model starts anyway.")
    expect(view.line()?.getAttribute("role")).toBe("status")
    expect(view.line()?.getAttribute("data-kind")).toBe("notice")
  })

  test("the user can close it", () => {
    const view = mount("One line.")
    view.host.querySelector<HTMLButtonElement>('[data-action="mango-notice-dismiss"]')?.click()
    expect(view.closed).toEqual([1])
  })
})
