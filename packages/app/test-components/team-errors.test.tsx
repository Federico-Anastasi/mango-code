import { afterEach, describe, expect, test } from "bun:test"
import { ErrorBoundary, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { TeamSwitch } from "@/components/team-switch"
import { SettingsTeamV2 } from "@/components/settings-v2/team"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  delete (window as { __MANGO_DESKTOP__?: unknown }).__MANGO_DESKTOP__
})

// what the bridge answers when the Credential Manager cannot be read or the Team's file is damaged
const unreadable = () => {
  ;(window as { __MANGO_DESKTOP__?: unknown }).__MANGO_DESKTOP__ = {
    team: { info: () => Promise.reject({ code: "io", message: "The Team's choices are damaged." }) },
  }
}

function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as Platform}>
        <LanguageProvider>
          <ErrorBoundary fallback={() => <p data-slot="fell">fell</p>}>{view()}</ErrorBoundary>
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )
  return host
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("the Team when its state cannot be read", () => {
  test("the switch beside the model is not there, and the conversation stays up", async () => {
    unreadable()
    const host = mount(() => (
      <TeamSwitch agents={{ options: [], current: "build", select: () => undefined } as never} stop={async () => undefined} />
    ))
    await settle()
    expect(host.querySelector('[data-slot="fell"]')).toBeNull()
    expect(host.querySelector('[data-action="prompt-team"]')).toBeNull()
  })

  test("the settings page says why, and stays up", async () => {
    unreadable()
    const host = mount(() => <SettingsTeamV2 />)
    await settle()
    expect(host.querySelector('[data-slot="fell"]')).toBeNull()
    expect(host.textContent).toContain("The Team's choices are damaged.")
  })
})
