import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { SessionProject } from "@/pages/session/timeline/session-project"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(name: string | undefined) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <SessionProject name={name} none="No project" />, host)
  return host.querySelector<HTMLElement>('[data-slot="session-project"]')
}

describe("the project in the header of a conversation", () => {
  test("with a project it is the folder and the name, where the title was", () => {
    const header = mount("invoice-tool")
    expect(header?.textContent).toBe("invoice-tool")
    expect(header?.querySelector("svg")).not.toBeNull()
    expect(header?.getAttribute("data-empty")).toBeNull()
  })

  test("a long name is cut with dots and shown whole under the pointer", () => {
    const name = "a-very-long-project-name-that-does-not-fit-in-the-header-of-the-conversation"
    const header = mount(name)
    const label = header?.querySelector<HTMLElement>('[data-slot="session-project-name"]')
    expect(label?.className).toContain("truncate")
    expect(header?.getAttribute("title")).toBe(name)
  })

  test("with no project it says so, in a secondary tone and without the folder", () => {
    const header = mount(undefined)
    expect(header?.textContent).toBe("No project")
    expect(header?.querySelector("svg")).toBeNull()
    expect(header?.getAttribute("data-empty")).toBe("")
  })
})
