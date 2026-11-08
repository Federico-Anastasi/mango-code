import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import {
  Toast,
  showToast as showLegacyToast,
  toaster as legacyToaster,
  type ToastOptions,
  type ToastVariant,
} from "@opencode-ai/ui/toast"
import { ToastV2, showToastV2, toasterV2 } from "@opencode-ai/ui/v2/toast-v2"
import { missingDirectoryIn, reportMissingDirectory } from "./missing-directory"

let v2 = false

export function setV2Toast(value: boolean) {
  v2 = value
}

export function ToastRegion(props: { v2: boolean }) {
  if (props.v2) return <ToastV2.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  // project folder gone from the disk: no technical toast in English, whoever removes the project takes care of it
  const missing =
    typeof options === "string"
      ? missingDirectoryIn(options)
      : missingDirectoryIn(
          typeof options.description === "string" ? options.description : undefined,
          typeof options.title === "string" ? options.title : undefined,
        )
  if (missing) {
    reportMissingDirectory(missing)
    return 0
  }
  if (!v2) return showLegacyToast(options)
  if (typeof options === "string") return showToastV2(options)

  return showToastV2({
    ...options,
    icon: resolveIcon(options.icon, options.variant),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

// v1 and v2 ids come from separate registries, so dismissal has to use the same
// implementation that issued the id.
export function dismissToast(toastId: number) {
  if (!v2) return legacyToaster.dismiss(toastId)
  return toasterV2.dismiss(toastId)
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined) {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  return <Icon name={name} />
}
