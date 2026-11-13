import { Component, Show, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import type { MangoPhoneAccess } from "@/utils/mango-desktop"

// "From your phone": the link of one place (home Wi-Fi, or outside with Tailscale) with its QR and the button that copies it.
// The card of Settings › Connections shows one for each place.
export const PhoneAccess: Component<{ label: string; access: MangoPhoneAccess | null; missing: string }> = (props) => {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  const copy = (link: string) =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  return (
    <div class="flex w-[220px] flex-col gap-2" data-slot="settings-phone-access">
      <div class="text-[13px] font-medium text-text-strong">{props.label}</div>
      <Show when={props.access} fallback={<p class="text-[12px] text-text-weak">{props.missing}</p>}>
        {(access) => (
          <>
            {/* The QR is an SVG made by the app: as an image, not as markup in the page. */}
            <img
              class="size-[180px] rounded-md bg-white"
              alt={props.label}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(access().qr)}`}
            />
            <div class="text-[12px] text-text-weak select-text break-all">{access().address}</div>
            <Show when={access().public}>
              <p data-slot="settings-phone-public" class="settings-v2-prompt-error">
                {language.t("settings.phone.public")}
              </p>
            </Show>
            <div>
              <ButtonV2 size="normal" variant="neutral" onClick={() => void copy(access().link)}>
                {language.t(copied() ? "settings.phone.copied" : "settings.phone.copy")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
