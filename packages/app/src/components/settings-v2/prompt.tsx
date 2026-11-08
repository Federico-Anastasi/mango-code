// mango-code: what goes into the prompt (server settings, route `/mango/settings`). Each item with its weight in
// tokens, a switch, and the choice of whether the change applies to all folders or only to the open one.
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { type Accessor, type Component, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import {
  itemLabel,
  itemsOf,
  PROMPT_KINDS,
  parsePromptSettings,
  promptTotal,
  type PromptItem,
  type PromptKind,
  type PromptSettings,
} from "@/utils/mango-prompt"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Scope = "all" | "folder"

export const SettingsPromptV2: Component<{
  directory: Accessor<string | undefined>
  projects: Accessor<{ worktree: string; name: string }[]>
  onPick: (directory: string) => void
}> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [scope, setScope] = createSignal<Scope>("all")
  const [error, setError] = createSignal<string>()

  /** A call to the settings route; a server error is reported, not ignored. */
  async function call(directory: string, init?: RequestInit) {
    const sdk = serverSDK()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (sdk.server.http.password)
      headers.authorization = `Basic ${authTokenFromCredentials({ username: sdk.server.http.username, password: sdk.server.http.password })}`
    const url = new URL("/mango/settings", sdk.url)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, { ...init, headers })
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    if (!response.ok) throw new Error(body?.error ?? `${response.status}`)
    return body
  }

  const [settings, { mutate }] = createResource(
    () => props.directory(),
    async (directory): Promise<PromptSettings | undefined> => {
      setError(undefined)
      try {
        const parsed = parsePromptSettings(await call(directory))
        if (!parsed) throw new Error(language.t("settings.prompt.unexpectedResponse"))
        return parsed
      } catch (cause) {
        setError(language.t("settings.prompt.loadError", { message: cause instanceof Error ? cause.message : String(cause) }))
      }
    },
  )

  async function toggle(item: PromptItem, enabled: boolean) {
    const directory = props.directory()
    if (!directory) return
    setError(undefined)
    try {
      const changed = (await call(directory, {
        method: "PUT",
        body: JSON.stringify({ type: item.type, name: item.name, enabled, scope: scope() }),
      })) as Pick<PromptItem, "enabled" | "source">
      mutate((current) =>
        current
          ? {
              ...current,
              items: current.items.map((it) =>
                it.type === item.type && it.name === item.name ? { ...it, enabled: changed.enabled, source: changed.source } : it,
              ),
            }
          : current,
      )
    } catch (cause) {
      setError(language.t("settings.prompt.saveError", { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  const folderName = () => props.directory()?.split(/[\\/]/).filter(Boolean).pop() ?? ""
  const tokens = (item: PromptItem) =>
    item.tokens === null
      ? language.t("settings.prompt.notMeasured")
      : language.t("settings.prompt.tokens", { count: item.tokens.toLocaleString(language.locale()) })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.prompt.title")}</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-prompt" data-component="settings-prompt">
        <Show
          when={props.directory()}
          fallback={<p class="settings-v2-prompt-note">{language.t("settings.prompt.noFolder")}</p>}
        >
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.prompt.project.title")}
              description={language.t("settings.prompt.project.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-prompt-project"
                options={props.projects()}
                current={props.projects().find((project) => project.worktree === props.directory())}
                placement="bottom-end"
                gutter={6}
                value={(project) => project.worktree}
                label={(project) => project.name}
                onSelect={(project) => project && props.onPick(project.worktree)}
              />
            </SettingsRowV2>
          </SettingsListV2>
          <p class="settings-v2-prompt-note">{language.t("settings.prompt.description")}</p>
          <Show when={error()}>{(message) => <p class="settings-v2-prompt-error">{message()}</p>}</Show>
          <Show when={settings()}>
            {(current) => (
              <>
                <div class="settings-v2-prompt-bar">
                  <div class="settings-v2-prompt-total" data-slot="prompt-total">
                    {language.t("settings.prompt.total", { count: promptTotal(current()).tokens.toLocaleString(language.locale()) })}
                    <Show when={promptTotal(current()).unmeasured > 0}>
                      <span class="settings-v2-prompt-muted">
                        {language.t("settings.prompt.total.unmeasured", { count: promptTotal(current()).unmeasured })}
                      </span>
                    </Show>
                  </div>
                  <div class="settings-v2-prompt-scope">
                    <span class="settings-v2-prompt-muted">{language.t("settings.prompt.scope.label")}</span>
                    <SegmentedControlV2
                      class="settings-v2-prompt-scope-control"
                      value={scope()}
                      onChange={(value) => value && setScope(value as Scope)}
                      data-action="prompt-scope"
                    >
                      <SegmentedControlItemV2 value="all">{language.t("settings.prompt.scope.all")}</SegmentedControlItemV2>
                      <SegmentedControlItemV2 value="folder" title={props.directory()}>
                        {language.t("settings.prompt.scope.folder", { folder: folderName() })}
                      </SegmentedControlItemV2>
                    </SegmentedControlV2>
                  </div>
                </div>

                <Show when={itemsOf(current(), "base")[0]}>
                  {(base) => (
                    <div class="settings-v2-section">
                      <SettingsListV2>
                        <SettingsRowV2
                          title={language.t("settings.prompt.kind.base")}
                          description={language.t("settings.prompt.kind.base.description")}
                        >
                          <span class="settings-v2-prompt-weight" data-slot="prompt-weight">
                            {tokens(base())}
                          </span>
                        </SettingsRowV2>
                      </SettingsListV2>
                    </div>
                  )}
                </Show>

                <For each={PROMPT_KINDS}>
                  {(kind: PromptKind) => (
                    <Show when={itemsOf(current(), kind).length > 0}>
                      <div class="settings-v2-section" data-kind={kind}>
                        <h3 class="settings-v2-section-title">{language.t(`settings.prompt.kind.${kind}`)}</h3>
                        <p class="settings-v2-prompt-note">{language.t(`settings.prompt.kind.${kind}.description`)}</p>
                        <SettingsListV2>
                          <For each={itemsOf(current(), kind)}>
                            {(item) => (
                              <SettingsRowV2
                                title={<span title={item.name}>{itemLabel(item.type, item.name)}</span>}
                                description={
                                  <Show when={item.source === "folder"}>
                                    {language.t("settings.prompt.fromFolder")}
                                  </Show>
                                }
                              >
                                <span class="settings-v2-prompt-weight" data-slot="prompt-weight" data-measured={item.tokens !== null ? "" : undefined}>
                                  {tokens(item)}
                                </span>
                                <div data-action="prompt-switch" data-name={item.name}>
                                  <Switch checked={item.enabled} onChange={(checked) => void toggle(item, checked)} hideLabel>
                                    {item.name}
                                  </Switch>
                                </div>
                              </SettingsRowV2>
                            )}
                          </For>
                        </SettingsListV2>
                      </div>
                    </Show>
                  )}
                </For>
              </>
            )}
          </Show>
          <Show when={settings.loading}>
            <p class="settings-v2-prompt-note">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </p>
          </Show>
        </Show>
      </div>
    </>
  )
}
