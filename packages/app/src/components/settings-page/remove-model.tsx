// mango-code: «Togli dal computer» asks first, in a window of the app: the model's name, the space it frees at most (the
// files it shares with another model stay) and whether it stops. A model from a file the user chose is only taken off
// the list: the window says so, and names the file that stays where it is.
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { removeLines } from "./lines"

/**
 * `inUse`: the model answers or is loading now; `ownFiles`: the files the user chose, which stay where they are.
 * `onRemove` removes the model the dialog names; a refusal is told under the model's row, the dialog just closes.
 */
export function RemoveModelDialog(props: {
  label: string
  size: string
  inUse: boolean
  ownFiles: string[]
  onRemove: () => Promise<unknown>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const lines = () => removeLines(props, language.t)

  const remove = async () => {
    setBusy(true)
    await props.onRemove()
    dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{lines().title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-2 px-4 pt-4 pb-1">
        <div class="text-[13px] leading-5" data-slot="settings-remove-what">
          {lines().body}
        </div>
        <Show when={props.inUse}>
          <div class="text-[13px] leading-5" data-slot="settings-remove-in-use">
            {language.t("settings.models.remove.inUse")}
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant="danger"
          disabled={busy()}
          onClick={() => void remove()}
          data-action="settings-model-remove-confirm"
        >
          {language.t("settings.models.remove.yes")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
