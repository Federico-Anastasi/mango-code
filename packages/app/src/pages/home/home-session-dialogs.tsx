import { createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTitleGroup,
  DialogV2,
} from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"

/** Asks for the new name of a conversation. */
export function DialogRenameSession(props: { title: string; onRename: (title: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal(props.title)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const next = value().trim()
    dialog.close()
    if (next) props.onRename(next)
  }

  return (
    <DialogV2 fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader hideClose>
          <DialogTitle>{language.t("home.session.rename.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="w-full px-4 pb-1 pt-2">
          <TextInputV2
            autofocus
            appearance="large"
            class="!w-full"
            value={value()}
            aria-label={language.t("home.session.rename.title")}
            onInput={(event) => setValue(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={!value().trim()}>
            {language.t("common.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </DialogV2>
  )
}

/** Confirms the permanent deletion of a conversation. */
export function DialogDeleteSession(props: { title: string; onDelete: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("home.session.delete.title")}
          description={language.t("home.session.delete.confirm", { name: props.title })}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          onClick={() => {
            dialog.close()
            props.onDelete()
          }}
        >
          {language.t("common.delete")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
