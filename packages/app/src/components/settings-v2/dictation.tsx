import { Component, Show, createSignal, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { dictationHint, dictationState, setDictationEnabled, showDictationHint } from "@/utils/dictation-state"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

// Dictation, the microphone in the chat: the user's choice, off until they turn it on. On, the app downloads it in the
// background and the microphone appears in the chat when it is ready; off, the space comes back. Only in the app.
export const DictationSection: Component = () => {
  const language = useLanguage()
  const state = dictationState()
  let section: HTMLDivElement | undefined
  // Opened from the microphone, which says why: the row is in sight, and the sentence goes with the settings.
  onMount(() => {
    if (dictationHint()) section?.scrollIntoView({ block: "center" })
  })
  onCleanup(() => showDictationHint(undefined))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const choose = async (enabled: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      await setDictationEnabled(enabled)
    } catch (cause) {
      setError(mangoDesktopError(cause).message)
    } finally {
      setBusy(false)
    }
  }

  const detail = () => {
    const current = state()
    if (!current) return undefined
    if (current.status === "ready") return language.t("settings.dictation.ready")
    if (current.status === "error") return current.error ?? undefined
    if (current.status === "off") return undefined
    return language.t("settings.dictation.downloading", { done: current.doneMb, size: current.sizeMb })
  }

  return (
    <Show when={state()}>
      {(current) => (
        <div class="settings-v2-section" id="settings-dictation" ref={section}>
          <Show when={current().status !== "ready" && dictationHint()}>{(text) => <p class="settings-v2-prompt-error">{text()}</p>}</Show>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.dictation.row.title")}
              description={language.t("settings.dictation.row.description", { size: current().sizeMb })}
            >
              <div data-action="settings-dictation" class="flex flex-col items-end gap-1">
                <Switch checked={current().enabled} disabled={busy()} onChange={(checked) => void choose(checked)} />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
          <Show when={detail() ?? error()}>
            {(message) => (
              <p
                data-slot="settings-dictation-state"
                class={current().status === "error" || error() ? "settings-v2-prompt-error" : "text-[12px] text-text-weak"}
              >
                {error() ?? message()}
              </p>
            )}
          </Show>
          <Show when={current().status === "error" && current().enabled}>
            <div>
              <ButtonV2 size="normal" variant="neutral" data-action="settings-dictation-retry" disabled={busy()} onClick={() => void choose(true)}>
                {language.t("settings.dictation.retry")}
              </ButtonV2>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
