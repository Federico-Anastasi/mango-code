import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { ContextField } from "@/components/settings-page/model-choices"
import type { CatalogEntry } from "@/utils/mango-state"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

const model = (context: number[]) =>
  ({
    key: "big",
    label: "Big",
    limits: { places: [], context, reasoning: [] },
    choices: { place: "auto", gpus: [], context: null, style: "recommended", reasoning: null, sampling: {} },
    verdict: { fits: context.length > 0, where: null, reason: "" },
  }) as unknown as CatalogEntry

function mount(context: number[]) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as Platform}>
        <LanguageProvider>
          <ContextField model={model(context)} disabled={false} choose={() => undefined} />
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )
  return host
}

describe("the context of a model in Models", () => {
  test("a model that fits nowhere with the cards in use offers no context, and the page stays up", () => {
    const host = mount([])
    expect(host.querySelector('[data-action="settings-model-context"]')).toBeNull()
  })

  test("a choice that leaves the open model nowhere to fit takes its steps away, and the page stays up", () => {
    const [entry, setEntry] = createStore(model([32_768, 65_536]))
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () => (
        <PlatformProvider value={{ platform: "web" } as Platform}>
          <LanguageProvider>
            <ContextField model={entry} disabled={false} choose={() => undefined} />
          </LanguageProvider>
        </PlatformProvider>
      ),
      host,
    )
    expect(host.querySelector('[data-action="settings-model-context"]')).not.toBeNull()
    setEntry("limits", "context", [])
    expect(host.querySelector('[data-action="settings-model-context"]')).toBeNull()
  })

  test("a model that fits offers its steps", () => {
    const host = mount([32_768, 65_536])
    expect(host.querySelector('[data-action="settings-model-context"]')).not.toBeNull()
  })
})
