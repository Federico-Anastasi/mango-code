// mango-code: the "Team" page of the settings. The OpenRouter key goes to the Windows Credential Manager
// through the app bridge (never in a file, never back into the page); how many agents and which models are
// choices that apply from the agent restart, which the app does on save.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { mangoDesktopError, type MangoTeamInfo } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsTeamV2: Component = () => {
  const language = useLanguage()
  const team = () => window.__MANGO_DESKTOP__?.team
  const [info, { refetch }] = createResource(async () => await team()?.info())
  const [key, setKey] = createSignal("")
  const [draft, setDraft] = createSignal<{ agents: number; manager: string; agent: string }>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const choices = (current: MangoTeamInfo) => draft() ?? { agents: current.agents, manager: current.manager, agent: current.agent }
  const changed = (current: MangoTeamInfo) => {
    const next = choices(current)
    return next.agents !== current.agents || next.manager !== current.manager || next.agent !== current.agent
  }

  /** A call to the bridge: the app restarts the agent and the window reloads by itself; a rejection is reported. */
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await refetch()
    } catch (cause) {
      const failure = mangoDesktopError(cause)
      setError(
        failure.code === "invalid_key"
          ? language.t("settings.team.error.invalidKey")
          : language.t("settings.team.error.save", { message: failure.message }),
      )
    } finally {
      setBusy(false)
    }
  }

  const saveKey = () =>
    run(async () => {
      await team()?.setKey(key())
      setKey("")
    })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.team.title")}</h2>
      </div>
      <div class="settings-v2-tab-body" data-component="settings-team">
        <p class="settings-v2-prompt-note">{language.t("settings.team.description")}</p>
        <Show when={error()}>{(message) => <p class="settings-v2-prompt-error">{message()}</p>}</Show>
        <Show when={info.error}>
          <p class="settings-v2-prompt-error">
            {language.t("settings.team.error.load", { message: mangoDesktopError(info.error).message })}
          </p>
        </Show>
        <Show when={info()}>
          {(current) => (
            <div class="settings-v2-section">
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.team.key.title")}
                  description={language.t(current().key ? "settings.team.key.saved" : "settings.team.key.missing")}
                >
                  <div class="flex w-full items-center gap-2 sm:w-[320px]" data-action="settings-team-key">
                    <Show
                      when={!current().key}
                      fallback={
                        <ButtonV2 variant="ghost-muted" disabled={busy()} onClick={() => void run(() => team()!.removeKey())}>
                          {language.t("settings.team.key.remove")}
                        </ButtonV2>
                      }
                    >
                      <TextInputV2
                        type="password"
                        appearance="base"
                        value={key()}
                        onInput={(event) => setKey(event.currentTarget.value)}
                        placeholder="sk-or-v1-…"
                        autocomplete="off"
                        spellcheck={false}
                      />
                      <ButtonV2 disabled={busy() || !key().trim()} onClick={() => void saveKey()}>
                        {language.t("settings.team.key.save")}
                      </ButtonV2>
                    </Show>
                  </div>
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.team.agents.title")}
                  description={language.t("settings.team.agents.description", { max: current().max })}
                >
                  <SelectV2
                    appearance="inline"
                    data-action="settings-team-agents"
                    options={Array.from({ length: current().max + 1 }, (_, n) => n)}
                    current={choices(current()).agents}
                    placement="bottom-end"
                    gutter={6}
                    value={(n) => String(n)}
                    label={(n) => String(n)}
                    onSelect={(n) => n != null && setDraft({ ...choices(current()), agents: n })}
                  />
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.team.manager.title")}
                  description={language.t("settings.team.manager.description")}
                >
                  <SelectV2
                    appearance="inline"
                    data-action="settings-team-manager"
                    options={current().models}
                    current={current().models.find((m) => m.key === choices(current()).manager)}
                    placement="bottom-end"
                    gutter={6}
                    value={(m) => m.key}
                    label={(m) => m.label}
                    onSelect={(m) => m && setDraft({ ...choices(current()), manager: m.key })}
                  />
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.team.agent.title")}
                  description={language.t("settings.team.agent.description")}
                >
                  <SelectV2
                    appearance="inline"
                    data-action="settings-team-agent"
                    options={current().models}
                    current={current().models.find((m) => m.key === choices(current()).agent)}
                    placement="bottom-end"
                    gutter={6}
                    value={(m) => m.key}
                    label={(m) => m.label}
                    onSelect={(m) => m && setDraft({ ...choices(current()), agent: m.key })}
                  />
                </SettingsRowV2>
              </SettingsListV2>
              <div class="mt-3 flex items-center justify-end gap-3">
                <span class="settings-v2-prompt-muted">{language.t("settings.team.apply.note")}</span>
                <ButtonV2
                  data-action="settings-team-save"
                  disabled={busy() || !changed(current())}
                  onClick={() => {
                    const next = choices(current())
                    void run(() => team()!.save(next.agents, next.manager, next.agent))
                  }}
                >
                  {language.t("settings.team.apply")}
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}
