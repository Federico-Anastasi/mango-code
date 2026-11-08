import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { lazy } from "solid-js"
import { DialogSelectDirectory } from "./dialog-select-directory"
import { directoryPickerKind } from "./directory-picker-policy"

const DialogSelectDirectoryV2 = lazy(() =>
  import("./dialog-select-directory-v2").then((module) => ({ default: module.DialogSelectDirectoryV2 })),
)

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

export function useDirectoryPicker() {
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()

  return (input: DirectoryPickerInput) => {
    if (directoryPickerKind(platform.platform, input.server, !!platform.pickNativeDirectories) === "native") {
      const opts = { title: input.title, multiple: input.multiple }
      const picked =
        platform.platform === "desktop" ? platform.openDirectoryPickerDialog(opts) : platform.pickNativeDirectories?.(opts)
      void picked?.then(input.onSelect, (cause: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: mangoDesktopError(cause).message,
        })
        input.onSelect(null)
      })
      return
    }

    let selected = false
    const onSelect = (result: string | string[] | null) => {
      selected = result !== null
      input.onSelect(result)
    }
    const cancel = () => {
      if (!selected) input.onSelect(null)
    }
    if (platform.platform === "desktop" && settings.general.newLayoutDesigns()) {
      dialog.show(() => <DialogSelectDirectoryV2 {...input} onSelect={onSelect} />, cancel)
      return
    }
    dialog.show(() => <DialogSelectDirectory {...input} onSelect={onSelect} />, cancel)
  }
}
