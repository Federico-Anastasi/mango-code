import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { I18nProvider, type UiI18n } from "@opencode-ai/ui/context/i18n"
import { dict as it } from "@opencode-ai/ui/i18n/it"
import { DataProvider } from "@opencode-ai/session-ui/context/data"
import { PictureTool } from "@opencode-ai/session-ui/picture-tool"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

const italian: UiI18n = {
  locale: () => "it",
  t: (key, params) =>
    (it[key] ?? key).replace(/{{\s*([^}]+?)\s*}}/g, (_, name: string) => String(params?.[name.trim()] ?? "")),
  plural: (key) => key,
}

function mount(metadata: Record<string, unknown>, start: number) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <I18nProvider value={italian}>
        <DialogProvider>
          <DataProvider data={{} as never} directory="/project">
            <PictureTool
              tool="image_generate"
              status="running"
              input={{ prompt: "a red cat", name: "red-cat" }}
              metadata={{ width: 768, height: 768, file: "/project/images/red-cat.png", ...metadata }}
              time={{ start }}
              label={{ title: "Immagine" }}
            />
          </DataProvider>
        </DialogProvider>
      </I18nProvider>
    ),
    host,
  )
  return host.querySelector('[data-slot="basic-tool-tool-time"]')?.textContent
}

describe("a picture of a conversation that asks for several at once", () => {
  test("one waiting for the engine says «In coda» and counts no time, though its call began a minute ago", () => {
    expect(mount({ stage: "waiting", step: 0, steps: 0 }, Date.now() - 60_000)).toBe("In coda")
  })

  test("it counts from the moment its own turn came, not from the call", () => {
    const label = mount({ stage: "drawing", step: 3, steps: 8, began: Date.now() - 20_000 }, Date.now() - 60_000)
    expect(label).toBe("Passo 3 di 8 · 20 s")
  })
})
