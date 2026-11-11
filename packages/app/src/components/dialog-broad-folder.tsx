import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"
import { createSubfolder, folderIsBroad } from "@/utils/project-folder"
import { showToast } from "@/utils/toast"

/** The folder is too broad to be a project: says so and offers to make a subfolder with the name of the project. */
function DialogBroadFolder(props: { folder: string; create: (name: string) => Promise<string>; onCreated: (directory: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const directory = await props.create(name())
      // before closing: closing says "no folder" to whoever waits for the answer
      props.onCreated(directory)
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("project.broad.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex w-full flex-col gap-3 px-4 pt-4 pb-1">
          <div class="text-[13px] leading-5">{language.t("project.broad.message")}</div>
          <Field invalid={!!error()}>
            <Field.Label>{language.t("project.broad.name", { folder: props.folder })}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={name()}
              placeholder={language.t("project.create.placeholder")}
              onInput={(event) => {
                setName(event.currentTarget.value)
                setError(undefined)
              }}
            />
          </Field>
          <Show when={error()}>
            {(text) => (
              <div role="alert" class="text-[13px] leading-5" style={{ color: "var(--v2-state-fg-danger)" }}>
                {text()}
              </div>
            )}
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={busy() || !name().trim()}>
            {language.t("project.broad.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

/**
 * The folders that may become projects, out of the ones chosen: a folder too broad is asked about, and replaced by the
 * subfolder the user creates for it (or dropped if the user closes the dialog). The agent decides what is too broad.
 */
export function useProjectFolders() {
  const dialog = useDialog()
  const language = useLanguage()

  return async (conn: ServerConnection.Any, directories: string[]): Promise<string[]> => {
    if (!("http" in conn)) return directories
    const http = conn.http
    const accepted: string[] = []
    for (const directory of directories) {
      const broad = await folderIsBroad(http, directory).catch((cause: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: cause instanceof Error ? cause.message : String(cause),
        })
        return undefined
      })
      if (broad === undefined) continue
      if (!broad) {
        accepted.push(directory)
        continue
      }
      const made = await new Promise<string | undefined>((resolve) =>
        dialog.show(
          () => (
            <DialogBroadFolder
              folder={directory}
              create={(name) => createSubfolder(http, directory, name)}
              onCreated={resolve}
            />
          ),
          () => resolve(undefined),
        ),
      )
      if (made) accepted.push(made)
    }
    return accepted
  }
}
