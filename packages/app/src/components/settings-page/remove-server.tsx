// mango-code: «Remove» on a server asks first, in a window of the app, like removing a model from the computer: the server's
// models leave the menus and its saved key is deleted.
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { mangoDesktopError } from "@/utils/mango-desktop"

/** `onRemove` removes the server the dialog names; a refusal is told in the card, the dialog just closes. A failure of
 *  the removal itself is told here, and the buttons work again. */
export function RemoveServerDialog(props: { host: string; key: boolean; onRemove: () => Promise<unknown> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const remove = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      await props.onRemove()
      dialog.close()
    } catch (cause) {
      setFailure(mangoDesktopError(cause).message)
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("settings.links.servers.remove.title", { host: props.host })}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-2 px-4 pt-4 pb-1">
        <div class="text-[13px] leading-5" data-slot="settings-server-remove-what">
          {language.t(props.key ? "settings.links.servers.remove.bodyKey" : "settings.links.servers.remove.body")}
        </div>
        <Show when={failure()}>
          {(message) => (
            <div class="settings-v2-prompt-error" data-slot="settings-server-remove-failed">
              {message()}
            </div>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant="danger"
          disabled={busy()}
          onClick={() => void remove()}
          data-action="settings-server-remove-confirm"
        >
          {language.t("settings.links.servers.remove")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
