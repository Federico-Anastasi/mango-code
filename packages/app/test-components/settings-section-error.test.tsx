import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { SectionBoundary } from "@/components/settings-page/settings-page"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

describe("an error in a section of the settings", () => {
  test("stays in its section, says why, and «Retry» shows the section again", () => {
    const [broken, setBroken] = createSignal(true)
    const Section = () => {
      if (broken()) throw new Error("the context is missing")
      return <p data-slot="section">ok</p>
    }
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () => (
        <PlatformProvider value={{ platform: "web" } as Platform}>
          <LanguageProvider>
            <p data-slot="outside">outside</p>
            <SectionBoundary>
              <Section />
            </SectionBoundary>
          </LanguageProvider>
        </PlatformProvider>
      ),
      host,
    )
    expect(host.querySelector('[data-slot="outside"]')).not.toBeNull()
    const failed = host.querySelector('[data-slot="settings-section-failed"]')
    expect(failed?.textContent).toContain("the context is missing")
    setBroken(false)
    host.querySelector<HTMLButtonElement>('[data-action="settings-section-retry"]')!.click()
    expect(host.querySelector('[data-slot="section"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="settings-section-failed"]')).toBeNull()
  })
})
