import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { TabHint } from "@/components/titlebar-tab-hint"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(project: string | undefined, title: string | undefined) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <TabHint project={project} title={title} />, host)
  return host
}

describe("the hint of a conversation's tab", () => {
  test("it is the project and the whole title, the project quieter", () => {
    const host = mount("invoice-tool", "Fix the failing test")
    expect(host.textContent).toBe("invoice-tool·Fix the failing test")
    expect(host.querySelector('[data-slot="project"]')?.textContent).toBe("invoice-tool")
    expect(host.querySelector('[data-slot="title"]')?.textContent).toBe("Fix the failing test")
  })

  test("a conversation with no project has only the title", () => {
    const host = mount(undefined, "A lighthouse on a cliff")
    expect(host.textContent).toBe("A lighthouse on a cliff")
    expect(host.querySelector('[data-slot="project"]')).toBeNull()
  })
})
