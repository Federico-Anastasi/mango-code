// mango-code: the Dictation row of Settings › General: the microphone in the chat, the user's choice, off until they turn
// it on. On, the app downloads it in the background and the microphone appears in the chat when it is ready; off, the
// space comes back. Only in the app: elsewhere the row stays, off, with where it is done. When the microphone leads here
// because it is not ready, the row says why.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { type Component, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { dictationHint, dictationState, setDictationEnabled, showDictationHint } from "@/utils/dictation-state"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { SettingsRowV2 } from "../settings-v2/parts/row"
// the Home of the first start shows this row before the settings were ever opened
import "./settings-page.css"

export const DictationRow: Component = () => {
  const language = useLanguage()
  const state = dictationState()
  const [ui, setUi] = createStore<{ busy: boolean; error?: string }>({ busy: false })
  onCleanup(() => showDictationHint(undefined))

  const choose = async (enabled: boolean) => {
    setUi({ busy: true, error: undefined })
    try {
      await setDictationEnabled(enabled)
    } catch (cause) {
      setUi("error", mangoDesktopError(cause).message)
    } finally {
      setUi("busy", false)
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
    <Show
      when={window.__MANGO_DESKTOP__?.dictation}
      fallback={
        <SettingsRowV2 title={language.t("settings.dictation.row.title")} description={language.t("settings.pcOnly")}>
          <div data-action="settings-dictation">
            <Switch checked={false} disabled hideLabel>
              {language.t("settings.dictation.row.title")}
            </Switch>
          </div>
        </SettingsRowV2>
      }
    >
      <Show when={state()}>
        {(current) => (
          <SettingsRowV2
            title={language.t("settings.dictation.row.title")}
            description={
              <>
                {language.t("settings.dictation.row.description", { size: current().sizeMb })}
                <Show when={current().status !== "ready" && dictationHint()}>
                  {(text) => (
                    <span class="settings-page-row-line" data-tone="danger">
                      {text()}
                    </span>
                  )}
                </Show>
                <Show when={ui.error ?? detail()}>
                  {(message) => (
                    <span
                      class="settings-page-row-line"
                      data-slot="settings-dictation-state"
                      data-tone={current().status === "error" || ui.error ? "danger" : undefined}
                    >
                      {message()}
                    </span>
                  )}
                </Show>
              </>
            }
          >
            <div data-action="settings-dictation" class="settings-page-inline">
              <Show when={current().status === "error" && current().enabled}>
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  data-action="settings-dictation-retry"
                  disabled={ui.busy}
                  onClick={() => void choose(true)}
                >
                  {language.t("settings.dictation.retry")}
                </ButtonV2>
              </Show>
              <Switch checked={current().enabled} disabled={ui.busy} onChange={(checked) => void choose(checked)} />
            </div>
          </SettingsRowV2>
        )}
      </Show>
    </Show>
  )
}
