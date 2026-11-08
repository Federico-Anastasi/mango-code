// mango-code: the "Models" page of the settings. The conversation's model is chosen from its name, under the text
// field; downloading or removing models and changing the engine happen in the app page that the tray icon also
// opens ("Models and engine"): this page leads there with a click.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { type Component, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsLocalModelsV2: Component = () => {
  const language = useLanguage()
  const [error, setError] = createSignal<string>()

  const open = () => {
    setError(undefined)
    window.__MANGO_DESKTOP__
      ?.openModels()
      .catch((cause: unknown) => setError(mangoDesktopError(cause).message))
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.localModels.title")}</h2>
      </div>
      <div class="settings-v2-tab-body" data-component="settings-local-models">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.localModels.change.title")}
              description={language.t("settings.localModels.change.description")}
            >
              {null}
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.localModels.manage.title")}
              description={language.t("settings.localModels.manage.description")}
            >
              <ButtonV2 variant="neutral" data-action="settings-open-models" onClick={open}>
                {language.t("settings.localModels.manage.button")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
          <Show when={error()}>{(message) => <p class="settings-v2-prompt-error">{message()}</p>}</Show>
        </div>
      </div>
    </>
  )
}
