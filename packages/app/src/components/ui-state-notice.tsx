import { onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { dismissToast, showToast, whenToastsReady } from "@/utils/toast"
import { watchUiStateNotices } from "@/utils/ui-state"

/**
 * What the app tells about the interface's state (`utils/ui-state.ts`): a change that cannot be written stays on screen until
 * a retry succeeds, and a state read from its backup copy is told once. It lives next to the toast region of the layout.
 */
export function UiStateNotice() {
  const language = useLanguage()
  const shown = new Map<string, number>()
  onMount(() => {
    let stop: (() => void) | undefined
    let gone = false
    whenToastsReady(() => {
      if (gone) return
      stop = watchUiStateNotices((notice, on) => {
        const toast = shown.get(notice)
        if (!on) {
          if (toast !== undefined) dismissToast(toast)
          shown.delete(notice)
          return
        }
        if (toast !== undefined) return
        shown.set(
          notice,
          notice === "unsaved"
            ? showToast({
                variant: "error",
                persistent: true,
                title: language.t("app.uiState.unsaved.title"),
                description: language.t("app.uiState.unsaved.description"),
              })
            : showToast({ variant: "default", description: language.t("app.uiState.restored") }),
        )
      })
    })
    onCleanup(() => {
      gone = true
      stop?.()
      shown.forEach((toast) => dismissToast(toast))
      shown.clear()
    })
  })
  return null
}
