import { makeEventListener } from "@solid-primitives/event-listener"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { useLanguage } from "@/context/language"

/**
 * The first X that hides the window: the app sends `mango-close-notice` and waits a second for the answer
 * (app/src-tauri/src/close_notice.rs). The notice does not take the place of another open dialog, and a second X while
 * it is up closes it: in both cases the window goes. Only "OK" counts as read, and the window goes with it, without a
 * second X; closed with Esc or its X, the window stays and the notice comes back at the next X.
 */
export function CloseNotice() {
  const dialog = useDialog()
  const notice = { up: false }
  makeEventListener(window, "mango-close-notice", () => {
    const answer = (shown: boolean) => void window.__MANGO_DESKTOP__?.closeNoticeAnswer?.(shown)
    if (notice.up) {
      dialog.close()
      return answer(false)
    }
    if (dialog.active) return answer(false)
    notice.up = true
    dialog.show(
      () => <DialogCloseNotice />,
      () => {
        notice.up = false
      },
    )
    answer(true)
  })
  return null
}

function DialogCloseNotice() {
  const dialog = useDialog()
  const language = useLanguage()
  const understood = () => {
    dialog.close()
    void window.__MANGO_DESKTOP__?.closeNoticeSeen?.()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("app.closeNotice.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-col gap-3 px-4 pt-4 pb-1">
        <p class="text-[13px] leading-5">{language.t("app.closeNotice.tray")}</p>
        <p class="text-[13px] leading-5">{language.t("app.closeNotice.programs")}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="contrast" autofocus data-action="close-notice-ok" onClick={understood}>
          {language.t("app.closeNotice.ok")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
