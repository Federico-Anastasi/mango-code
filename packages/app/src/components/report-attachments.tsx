// mango-code: the files a user attaches to a problem report. They are chosen with the button or pasted (an image) and
// they go as they are: the text under the button says it. What is too large is refused with the reason, never dropped.
import { For, Show, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { addAttachments, formatSize } from "@/utils/report"
import "./settings-v2/settings-v2.css"

/** The files chosen so far, within `maxBytes` for the whole. */
export function createAttachments(maxBytes: () => number) {
  const [files, setFiles] = createSignal<File[]>([])
  const [refused, setRefused] = createSignal<ReturnType<typeof addAttachments>["refused"]>()
  return {
    files,
    refused,
    maxBytes,
    add(incoming: File[]) {
      const result = addAttachments(files(), incoming, maxBytes())
      setFiles(result.files)
      setRefused(result.refused)
    },
    remove(file: File) {
      setFiles(files().filter((item) => item !== file))
      setRefused(undefined)
    },
    clear() {
      setFiles([])
      setRefused(undefined)
    },
  }
}

export type Attachments = ReturnType<typeof createAttachments>

/** For the `onPaste` of the field where the user writes: an image in the clipboard becomes an attachment. */
export function pasteInto(attachments: Attachments) {
  const named = (blob: Blob, index: number) => {
    const extension = blob.type === "image/jpeg" ? "jpg" : (blob.type.split("/")[1] ?? "png")
    return new File([blob], `pasted-image-${Date.now()}-${index}.${extension}`, { type: blob.type || "image/png" })
  }
  return (event: ClipboardEvent) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"))
    if (images.length > 0) {
      event.preventDefault()
      attachments.add(images.map(named))
      return
    }
    // In the app the window's clipboard does not always hand the page an image (a bitmap, a file copied in Explorer):
    // the app reads it. Only when there is no text to paste.
    const bridge = window.__MANGO_DESKTOP__
    if (!bridge || event.clipboardData?.getData("text")) return
    void bridge
      .readClipboardImage()
      .then((png) => png && attachments.add([named(new Blob([png], { type: "image/png" }), 0)]))
      .catch(() => undefined)
  }
}

export function ReportAttachments(props: { attachments: Attachments }) {
  const language = useLanguage()
  let input!: HTMLInputElement
  const refusal = () => {
    const refused = props.attachments.refused()
    if (!refused) return undefined
    const values = { name: refused.name, size: formatSize(refused.size), max: formatSize(props.attachments.maxBytes()) }
    return language.t(
      refused.kind === "file" ? "settings.help.report.files.tooLarge" : "settings.help.report.files.total",
      values,
    )
  }
  return (
    <div class="flex flex-col gap-2" data-component="report-attachments">
      <div class="flex flex-col items-start gap-2">
        <ButtonV2 variant="neutral" class="shrink-0 whitespace-nowrap" data-action="report-attach" onClick={() => input.click()}>
          {language.t("settings.help.report.files.add")}
        </ButtonV2>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            props.attachments.add([...(event.currentTarget.files ?? [])])
            event.currentTarget.value = ""
          }}
        />
        <span class="settings-v2-prompt-note">{language.t("settings.help.report.files.hint")}</span>
      </div>
      <For each={props.attachments.files()}>
        {(file) => (
          <div class="flex items-center gap-2 text-13-regular text-text-strong" data-component="report-attachment">
            <span class="min-w-0 flex-1 truncate">{file.name}</span>
            <span class="settings-v2-prompt-note shrink-0">{formatSize(file.size)}</span>
            <IconButtonV2
              size="small"
              variant="ghost-muted"
              icon={<Icon name="xmark-small" />}
              aria-label={language.t("settings.help.report.files.remove", { name: file.name })}
              onClick={() => props.attachments.remove(file)}
            />
          </div>
        )}
      </For>
      <Show when={refusal()}>{(message) => <p class="settings-v2-prompt-error">{message()}</p>}</Show>
    </div>
  )
}
