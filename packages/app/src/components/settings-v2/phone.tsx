import { Component, For, Show, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { mangoDesktopError, type MangoPhoneAccess, type MangoPhoneState } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

// "From your phone": the web UI on the phone, from the home Wi-Fi or from outside with Tailscale. Off by default; on, the app
// opens its own port and here are the links with the key and their QRs. Only in the app: the phone does not see the bridge.
export const PhoneSection: Component = () => {
  const language = useLanguage()
  const phone = () => window.__MANGO_DESKTOP__?.phone
  const [state, { mutate }] = createResource(async () => (await phone()?.state()) ?? undefined)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const run = async (action: (api: NonNullable<ReturnType<typeof phone>>) => Promise<MangoPhoneState>) => {
    const api = phone()
    if (!api) return
    setBusy(true)
    setError(undefined)
    try {
      mutate(await action(api))
    } catch (cause) {
      setError(mangoDesktopError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const places = () => {
    const current = state()
    if (!current?.enabled) return []
    return [
      { label: language.t("settings.phone.home"), access: current.home, missing: language.t("settings.phone.home.missing") },
      { label: language.t("settings.phone.away"), access: current.away, missing: language.t("settings.phone.away.missing") },
    ]
  }

  return (
    <Show when={phone()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.phone.title")}</h3>
        <SettingsListV2>
          <SettingsRowV2 title={language.t("settings.phone.row.title")} description={language.t("settings.phone.row.description")}>
            <div data-action="settings-phone" class="flex flex-col items-end gap-1">
              <Switch
                checked={state()?.enabled ?? false}
                disabled={busy() || !state()}
                onChange={(checked) => void run((api) => api.setEnabled(checked))}
              />
              <Show when={error()}>
                {(message) => <span class="max-w-64 text-end text-[11px] text-text-danger">{message()}</span>}
              </Show>
            </div>
          </SettingsRowV2>
        </SettingsListV2>

        <Show when={state()?.enabled}>
          <Show when={state()?.error}>
            {(message) => <p class="text-[12px] text-text-danger">{message()}</p>}
          </Show>
          <div class="flex flex-wrap gap-6">
            <For each={places()}>
              {(place) => <PhoneAccess label={place.label} access={place.access} missing={place.missing} />}
            </For>
          </div>
          <p class="text-[12px] text-text-weak">{language.t("settings.phone.firewall")}</p>
          <div>
            <ButtonV2
              size="normal"
              variant="neutral"
              data-action="settings-phone-new-key"
              disabled={busy()}
              onClick={() => void run((api) => api.newKey())}
            >
              {language.t("settings.phone.newKey")}
            </ButtonV2>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const PhoneAccess: Component<{ label: string; access: MangoPhoneAccess | null; missing: string }> = (props) => {
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
