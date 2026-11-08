import { For } from "solid-js"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ImagePreview } from "@opencode-ai/ui/image-preview"

/**
 * Images a tool produced (the browser screenshot): preview in the chat, click to enlarge.
 * A text-only model gets just a note; the user sees the image.
 */
export function ToolImages(props: { attachments?: FilePart[] }) {
  const dialog = useDialog()
  const i18n = useI18n()
  const images = () => (props.attachments ?? []).filter((file) => file.mime.startsWith("image/"))

  return (
    <For each={images()}>
      {(file, index) => {
        const alt = () => i18n.t("ui.tool.image.alt", { n: index() + 1 })
        return (
          <button
            type="button"
            data-component="tool-image"
            aria-label={i18n.t("ui.tool.image.open")}
            onClick={() => dialog.show(() => <ImagePreview src={file.url} alt={alt()} />)}
          >
            <img src={file.url} alt={alt()} />
          </button>
        )
      }}
    </For>
  )
}
