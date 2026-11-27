import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { LanguageProvider } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { RemoveServerDialog } from "@/components/settings-page/remove-server"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

function mount(onRemove: () => Promise<unknown>) {
  const Opener = () => {
    const dialog = useDialog()
    return (
      <button data-slot="open" onClick={() => dialog.show(() => <RemoveServerDialog host="lm.example" key={false} onRemove={onRemove} />)} />
    )
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as Platform}>
        <LanguageProvider>
          <DialogProvider>
            <Opener />
          </DialogProvider>
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )
  host.querySelector<HTMLButtonElement>('[data-slot="open"]')!.click()
}

const confirm = () => document.querySelector<HTMLButtonElement>('[data-action="settings-server-remove-confirm"]')

describe("removing a server", () => {
  test("when the removal cannot be finished the dialog says why and its buttons work again", async () => {
    mount(() => Promise.reject({ code: "io", message: "The key could not be deleted." }))
    await settle()
    confirm()!.click()
    await settle()
    expect(document.body.textContent).toContain("The key could not be deleted.")
    expect(confirm()!.disabled).toBe(false)
  })

  test("when it is done the dialog closes", async () => {
    mount(() => Promise.resolve())
    await settle()
    confirm()!.click()
    await settle()
    expect(confirm()).toBeNull()
  })
})
