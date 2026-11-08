// mango-code: the "Help" page of the settings. "Report a problem" is one click: what the user writes (optional),
// the logs, the PC details and, if the switch stays on, the window go to Mango Code, anonymized. A build without the
// report address (a build of your own) saves a file on the Desktop and opens a GitHub issue instead.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { type Component, Match, Show, Switch as Choose } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { mangoVersion } from "@/utils/mango-version"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsHelpV2: Component = () => {
  const language = useLanguage()
  const updater = usePlatform().updater
  // What the update row says, from the state of the app's updater.
  const updateText = () => {
    const state = updater?.state() ?? { status: "idle" as const }
    if (state.status === "checking") return language.t("settings.help.update.checking")
    if (state.status === "downloading")
      return language.t("settings.help.update.downloading", { version: state.version, percent: state.percent ?? 0 })
    if (state.status === "ready") return language.t("settings.help.update.ready", { version: state.version })
    if (state.status === "installing") return language.t("settings.help.update.installing", { version: state.version })
    if (state.status === "up-to-date") return language.t("settings.help.update.upToDate")
    if (state.status === "error") return language.t("settings.help.update.error", { message: state.message })
    return language.t("settings.help.update.description")
  }
  const updateBusy = () => ["checking", "downloading", "installing"].includes(updater?.state().status ?? "")
  const [store, setStore] = createStore({
    note: "",
    screenshot: true,
    state: "idle" as "idle" | "sending" | "sent" | "github",
    file: undefined as string | undefined,
    error: undefined as string | undefined,
  })

  const report = () => {
    const bridge = window.__MANGO_DESKTOP__
    if (!bridge) return
    setStore({ state: "sending", error: undefined })
    bridge
      .reportProblem({ note: store.note, screenshot: store.screenshot })
      .then(
        (done) => setStore({ state: done.sent ? "sent" : "github", file: done.file, note: "" }),
        (cause: unknown) => setStore({ state: "idle", error: mangoDesktopError(cause).message }),
      )
  }

  const logs = () => {
    setStore("error", undefined)
    window.__MANGO_DESKTOP__?.openLogs().catch((cause: unknown) => setStore("error", mangoDesktopError(cause).message))
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.help.title")}</h2>
      </div>
      <div class="settings-v2-tab-body" data-component="settings-help">
        <Show when={updater}>
          {(updates) => (
            <div class="settings-v2-section">
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.help.update.title", { version: mangoVersion })}
                  description={updateText()}
                >
                  <Show
                    when={updates().state().status === "ready"}
                    fallback={
                      <ButtonV2
                        variant="neutral"
                        data-action="settings-check-update"
                        disabled={updateBusy()}
                        onClick={() => void updates().check()}
                      >
                        {language.t("settings.help.update.check")}
                      </ButtonV2>
                    }
                  >
                    <ButtonV2 variant="neutral" data-action="settings-install-update" onClick={() => void updates().install()}>
                      {language.t("toast.update.action.installRestart")}
                    </ButtonV2>
                  </Show>
                </SettingsRowV2>
              </SettingsListV2>
            </div>
          )}
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.help.report.title")}</h3>
          <p class="settings-v2-prompt-note">{language.t("settings.help.report.description")}</p>
          <TextareaV2
            class="!w-full"
            rows={3}
            value={store.note}
            placeholder={language.t("settings.help.report.placeholder")}
            onInput={(event) => setStore("note", event.currentTarget.value)}
          />
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.help.report.screenshot.title")}
              description={language.t("settings.help.report.screenshot.description")}
            >
              <Switch checked={store.screenshot} onChange={(checked) => setStore("screenshot", checked)} />
            </SettingsRowV2>
          </SettingsListV2>
          <div class="flex items-center gap-3">
            <ButtonV2
              variant="neutral"
              data-action="settings-report-problem"
              disabled={store.state === "sending"}
              onClick={report}
            >
              {language.t(store.state === "sending" ? "settings.help.report.sending" : "settings.help.report.button")}
            </ButtonV2>
            <Choose>
              <Match when={store.state === "sent"}>
                <span class="settings-v2-prompt-note">{language.t("settings.help.report.sent")}</span>
              </Match>
              <Match when={store.state === "github" && store.file}>
                {(file) => <span class="settings-v2-prompt-note">{language.t("settings.help.report.saved", { file: file() })}</span>}
              </Match>
            </Choose>
          </div>
          <Show when={store.error}>{(message) => <p class="settings-v2-prompt-error">{message()}</p>}</Show>
        </div>

        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.help.logs.title")}
              description={language.t("settings.help.logs.description")}
            >
              <ButtonV2 variant="neutral" data-action="settings-open-logs" onClick={logs}>
                {language.t("settings.help.logs.button")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
