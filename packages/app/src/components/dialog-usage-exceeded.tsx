import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { JSX } from "solid-js"

export type DialogGoUpsellProps = {
  title: string
  description: JSX.Element
  link?: string
  actionLabel: string
  onClose?: (dontShowAgain?: boolean) => void
}

export function DialogUsageExceeded(props: DialogGoUpsellProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const runAction = () => {
    if (props.link) platform.openExternal(props.link)
    props.onClose?.()
    dialog.close()
  }

  const dismiss = () => {
    props.onClose?.(true)
    dialog.close()
  }

  return (
    <Dialog title={props.title} description={props.description} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <ButtonV2 variant="ghost" size="large" onClick={dismiss}>
            {language.t("dialog.usageExceeded.dontShowAgain")}
          </ButtonV2>
          <ButtonV2 variant="primary" size="large" onClick={runAction}>
            {props.actionLabel}
          </ButtonV2>
        </div>
      </div>
    </Dialog>
  )
}
