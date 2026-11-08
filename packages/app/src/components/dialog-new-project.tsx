import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createSignal, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { mangoDesktopError } from "@/utils/mango-desktop"

/**
 * "New project": asks for a name and creates the folder in the chosen location (by default Documents\Mango Code;
 * the Windows picker chooses another one, even a new one). Only with the desktop bridge.
 */
export function DialogNewProject(props: {
  create: (name: string, parent: string) => Promise<string>
  defaultFolder: () => Promise<string>
  chooseFolder: () => Promise<string | null>
  onCreated: (directory: string) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [folder, setFolder] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  onMount(() => props.defaultFolder().then(setFolder, (cause: unknown) => setError(message(cause))))

  const change = () =>
    props.chooseFolder().then(
      (picked) => picked && setFolder(picked),
      (cause: unknown) => setError(message(cause)),
    )

  const message = (cause: unknown) => {
    const failure = mangoDesktopError(cause)
    if (failure.code === "exists") return language.t("project.create.error.exists")
    if (failure.code === "invalid") return language.t("project.create.error.invalid")
    return language.t("project.create.error.generic", { message: failure.message })
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const parent = folder()
    if (busy() || !parent) return
    setBusy(true)
    setError(undefined)
    try {
      const directory = await props.create(name(), parent)
      dialog.close()
      props.onCreated(directory)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("project.create.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex w-full flex-col gap-3 px-4 pt-4 pb-1">
          <Field invalid={!!error()}>
            <Field.Label>{language.t("project.create.name")}</Field.Label>
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
          <div class="flex flex-col gap-1.5">
            <div class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("project.create.where")}</div>
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1 truncate text-[13px] leading-5" title={folder()}>
                {folder()}
              </div>
              <ButtonV2 type="button" variant="neutral" disabled={busy() || !folder()} onClick={change}>
                {language.t("project.create.change")}
              </ButtonV2>
            </div>
          </div>
          <Show
            when={error()}
            fallback={<div class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("project.create.hint")}</div>}
          >
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
          <ButtonV2 type="submit" variant="contrast" disabled={busy() || !name().trim() || !folder()}>
            {language.t("project.create.submit")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

/** Opens the "New project" dialog; `undefined` when the desktop bridge is missing (normal browser). */
export function useNewProject() {
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const { createProjectFolder, projectsFolder, pickNativeDirectories } = platform
  if (!createProjectFolder || !projectsFolder || !pickNativeDirectories) return undefined
  return (onCreated: (directory: string) => void) =>
    dialog.show(() => (
      <DialogNewProject
        create={createProjectFolder}
        defaultFolder={projectsFolder}
        chooseFolder={() => pickNativeDirectories({ title: language.t("project.create.change") }) as Promise<string | null>}
        onCreated={onCreated}
      />
    ))
}
