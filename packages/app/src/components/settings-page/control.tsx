// mango-code: the settings page's view of the state, the catalog and the computer that `context/mango.tsx` reads for the
// whole interface: Models, Computer and Connections show the same view, read again at once after a command.
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useMango } from "@/context/mango"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { applyView, type ControlView } from "./view"

export const { use: useControl, provider: ControlProvider } = createSimpleContext({
  name: "SettingsControl",
  gate: false,
  init: () => {
    const mango = useMango()
    const [view, setView] = createStore<ControlView>({ failed: false })
    createEffect(() =>
      applyView(setView, {
        state: mango.state(),
        catalog: mango.catalog(),
        computer: mango.computer(),
        failed: mango.failed(),
        computerFailed: mango.computerFailed(),
        catalogFailed: mango.catalogFailed(),
      }),
    )
    return { view, now: mango.refresh }
  },
})

/**
 * The bridge commands of a section, by row (a model's key, a card): busy while one runs, its refusal kept under its row,
 * and `after` (the view read again) done before the controls come back, so a second choice starts from the new state.
 */
export function createCommands(after?: () => Promise<unknown>) {
  const [ui, setUi] = createStore<{ busy: Record<string, boolean>; errors: Record<string, string | undefined> }>({
    busy: {},
    errors: {},
  })
  async function run<T>(row: string, command: () => Promise<T> | undefined): Promise<T | undefined> {
    setUi("busy", row, true)
    setUi("errors", row, undefined)
    try {
      return await command()
    } catch (cause) {
      setUi("errors", row, mangoDesktopError(cause).message)
    } finally {
      await after?.()
      setUi("busy", row, false)
    }
  }
  return {
    run,
    busy: (row: string) => !!ui.busy[row],
    anyBusy: () => Object.values(ui.busy).some(Boolean),
    error: (row: string) => ui.errors[row],
    /** The refusals are about the state they were given in: a new state clears them. */
    clearErrors: () => setUi("errors", reconcile({})),
  }
}
