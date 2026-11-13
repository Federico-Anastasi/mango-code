// mango-code: Settings › Agent. What the model reads with every request (server route `/mango/settings`): the weight
// of the whole in a bar, then a row for tools, MCP servers, skills and instructions that opens on its items. Each item
// has its weight in tokens and one switch; the choice at the top says whether a change applies to all the projects or
// only to the open one. At the end, where the agent browses.
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { type Component, createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { mangoDesktopError } from "@/utils/mango-desktop"
import {
  groupCount,
  itemLabel,
  itemsOf,
  mcpLabel,
  parsePromptSettings,
  PROMPT_GROUPS,
  promptShares,
  promptTotal,
  type PromptGroup,
  type PromptItem,
  type PromptSettings,
} from "@/utils/mango-prompt"
import { authHeaders } from "@/utils/server"
import { SettingsListV2 } from "../settings-v2/parts/list"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { PaneHeader } from "./header"

type Scope = "all" | "folder"

const TEXTS = {
  tools: { title: "settings.agent.tools.title", line: "settings.agent.tools.description" },
  mcp: { title: "settings.agent.mcp.title", line: "settings.agent.mcp.description" },
  skills: { title: "settings.agent.skills.title", line: "settings.agent.skills.description" },
  instructions: { title: "settings.agent.instructions.title", line: "settings.agent.instructions.description" },
} as const satisfies Record<PromptGroup["id"], { title: string; line: string }>

const SHARE_TITLES = {
  base: "settings.prompt.kind.base",
  tools: TEXTS.tools.title,
  mcp: TEXTS.mcp.title,
  skills: TEXTS.skills.title,
  instructions: TEXTS.instructions.title,
} as const

/** `focus`: the title of a row asked for by the search; the row it belongs to opens. */
export const SettingsAgent: Component<{ focus?: string }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [ui, setUi] = createStore<{ scope: Scope; open?: PromptGroup["id"]; error?: string }>({ scope: "all" })

  // The project the settings are about: the one picked in the page, else the one of the tab seen last, else the one
  // selected in the home, else the first project.
  const [picked, setPicked] = createSignal<string>()
  const projects = createMemo(() =>
    layout.projects
      .list()
      .map((project) => ({ worktree: project.worktree, name: project.name || folderName(project.worktree) })),
  )
  const lastTab = () => tabs.store.findLast((tab) => tab.type !== "settings")
  const tabDirectory = () => {
    const tab = lastTab()
    if (tab?.type === "draft") return tab.directory
    if (tab?.type === "session") return serverSync().session.get(tab.sessionId)?.directory
  }
  const directory = createMemo(
    () => picked() ?? tabDirectory() ?? layout.home.selection().directory ?? projects()[0]?.worktree,
  )

  /** A call to the settings route; a server error is reported, not ignored. */
  async function call(folder: string, init?: RequestInit) {
    const sdk = serverSDK()
    const headers = { "Content-Type": "application/json", ...authHeaders(sdk.server.http) }
    const url = new URL("/mango/settings", sdk.url)
    url.searchParams.set("directory", folder)
    const response = await fetch(url, { ...init, headers })
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    if (!response.ok) throw new Error(body?.error ?? `${response.status}`)
    return body
  }

  const [settings, { mutate }] = createResource(directory, async (folder): Promise<PromptSettings | undefined> => {
    setUi("error", undefined)
    try {
      const parsed = parsePromptSettings(await call(folder))
      if (!parsed) throw new Error(language.t("settings.prompt.unexpectedResponse"))
      return parsed
    } catch (cause) {
      setUi("error", language.t("settings.prompt.loadError", { message: reason(cause) }))
    }
  })

  async function toggle(item: PromptItem, enabled: boolean) {
    const folder = directory()
    if (!folder) return
    setUi("error", undefined)
    try {
      const changed = (await call(folder, {
        method: "PUT",
        body: JSON.stringify({ type: item.type, name: item.name, enabled, scope: ui.scope }),
      })) as Pick<PromptItem, "enabled" | "source">
      mutate((current) =>
        current
          ? {
              ...current,
              items: current.items.map((it) =>
                it.type === item.type && it.name === item.name
                  ? { ...it, enabled: changed.enabled, source: changed.source }
                  : it,
              ),
            }
          : current,
      )
    } catch (cause) {
      setUi("error", language.t("settings.prompt.saveError", { message: reason(cause) }))
    }
  }

  // The row asked for by the search opens; the others stay as they are.
  createEffect(
    on(
      () => props.focus,
      (focus) => {
        const group = PROMPT_GROUPS.find((candidate) => language.t(TEXTS[candidate.id].title) === focus)
        if (group) setUi("open", group.id)
      },
    ),
  )

  const tokens = (item: PromptItem) =>
    item.tokens === null
      ? language.t("settings.prompt.notMeasured")
      : language.t("settings.prompt.tokens", { count: item.tokens.toLocaleString(language.locale()) })

  return (
    <div class="settings-page-agent" data-component="settings-prompt">
      <PaneHeader title={language.t("settings.section.agent")} lead={language.t("settings.agent.lead")}>
        <Show when={directory()}>
          {(folder) => (
            <SegmentedControlV2
              class="settings-v2-prompt-scope-control"
              value={ui.scope}
              onChange={(value) => value && setUi("scope", value as Scope)}
              data-action="prompt-scope"
            >
              <SegmentedControlItemV2 value="all">{language.t("settings.agent.scope.all")}</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="folder" title={folder()}>
                {language.t("settings.agent.scope.folder", { folder: folderName(folder()) })}
              </SegmentedControlItemV2>
            </SegmentedControlV2>
          )}
        </Show>
      </PaneHeader>

      <Show when={directory()} fallback={<p class="settings-page-note">{language.t("settings.prompt.noFolder")}</p>}>
        <Show when={projects().length > 1}>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.prompt.project.title")}
              description={language.t("settings.prompt.project.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-prompt-project"
                options={projects()}
                current={projects().find((project) => project.worktree === directory())}
                placement="bottom-end"
                gutter={6}
                value={(project) => project.worktree}
                label={(project) => project.name}
                onSelect={(project) => project && setPicked(project.worktree)}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </Show>
        <Show when={ui.error}>{(message) => <p class="settings-page-error">{message()}</p>}</Show>
        <Show when={settings()}>
          {(current) => (
            <>
              <Weight settings={current()} />
              <div class="settings-page-box" data-slot="prompt-groups">
                <Show when={itemsOf(current(), "base")[0]}>
                  {(base) => (
                    <div class="settings-page-row">
                      <span class="settings-page-row-copy">
                        <span data-slot="settings-v2-row-title">{language.t("settings.prompt.kind.base")}</span>
                        <span class="settings-page-row-line">
                          {language.t("settings.prompt.kind.base.description")}
                        </span>
                      </span>
                      <span class="settings-v2-prompt-weight" data-slot="prompt-weight">
                        {tokens(base())}
                      </span>
                    </div>
                  )}
                </Show>
                <For each={PROMPT_GROUPS}>
                  {(group) => (
                    <Group
                      group={group}
                      settings={current()}
                      open={ui.open === group.id}
                      onToggle={() => setUi("open", ui.open === group.id ? undefined : group.id)}
                      tokens={tokens}
                      onSwitch={(item, enabled) => void toggle(item, enabled)}
                    />
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
        <Show when={settings.loading}>
          <p class="settings-page-note">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </p>
        </Show>
      </Show>

      <BrowserSection />
    </div>
  )
}

/** What a conversation starts with: the total, the bar of its parts and what each part weighs. */
const Weight: Component<{ settings: PromptSettings }> = (props) => {
  const language = useLanguage()
  const total = () => promptTotal(props.settings)
  const shares = () => promptShares(props.settings)
  const number = (value: number) => value.toLocaleString(language.locale())
  return (
    <>
      <h3 class="settings-v2-section-title">{language.t("settings.prompt.title")}</h3>
      <div class="settings-page-box">
        <div class="settings-page-row" data-slot="prompt-total">
          <span class="settings-page-row-copy">
            <span data-slot="settings-v2-row-title">
              {language.t("settings.agent.total", { count: number(total().tokens) })}
              <Show when={total().unmeasured > 0}>
                <span class="settings-v2-prompt-muted">
                  {" "}
                  {language.t("settings.prompt.total.unmeasured", { count: total().unmeasured })}
                </span>
              </Show>
            </span>
            <div class="settings-page-stack">
              <For each={shares()}>
                {(share) => <u data-kind={share.id} style={{ width: `${(share.tokens / total().tokens) * 100}%` }} />}
              </For>
            </div>
            <div class="settings-page-legend">
              <For each={shares()}>
                {(share) => (
                  <span>
                    <i data-kind={share.id} />
                    {language.t(SHARE_TITLES[share.id])} {number(share.tokens)}
                  </span>
                )}
              </For>
            </div>
          </span>
        </div>
      </div>
      <p class="settings-page-note">{language.t("settings.prompt.description")}</p>
    </>
  )
}

/** How a row tells its items: «12 accesi su 14», «3 collegati», «4 accese», «2 file». */
const GroupCount: Component<{ group: PromptGroup["id"]; on: number; all: number }> = (props) => {
  const language = useLanguage()
  return (
    <Show
      when={props.group !== "mcp"}
      fallback={
        <span class="settings-page-pill" data-tone={props.on > 0 ? "ok" : undefined}>
          {language.plural("settings.agent.count.mcp", props.on)}
        </span>
      }
    >
      <span>
        {props.group === "tools"
          ? language.plural("settings.agent.count.tools", props.on, { all: props.all })
          : language.plural(
              props.group === "skills" ? "settings.agent.count.skills" : "settings.agent.count.files",
              props.on,
            )}
      </span>
    </Show>
  )
}

/** A row of the box (tools, MCP servers, skills, instructions): how many are on, and, open, one line and one switch for each. */
const Group: Component<{
  group: PromptGroup
  settings: PromptSettings
  open: boolean
  onToggle: () => void
  tokens: (item: PromptItem) => string
  onSwitch: (item: PromptItem, enabled: boolean) => void
}> = (props) => {
  const language = useLanguage()
  const count = () => groupCount(props.settings, props.group)
  const servers = () => props.settings.items.filter((item) => item.type === "mcp").map((item) => item.name)
  const label = (item: PromptItem) =>
    item.type === "mcp"
      ? mcpLabel(item.name, servers(), (own) => language.t(`mango.mcp.${own}`))
      : itemLabel(item.type, item.name)
  return (
    <div class="settings-page-model" data-kind={props.group.id} data-open={props.open ? "" : undefined}>
      <button
        type="button"
        class="settings-page-row settings-page-row--click"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span class="settings-page-row-copy">
          <span data-slot="settings-v2-row-title">{language.t(TEXTS[props.group.id].title)}</span>
          <span class="settings-page-row-line">{language.t(TEXTS[props.group.id].line)}</span>
        </span>
        <span class="settings-page-row-meta">
          <GroupCount group={props.group.id} on={count().on} all={count().all} />
          <IconV2 name="chevron-down" class={props.open ? "rotate-180" : ""} />
        </span>
      </button>
      <Show when={props.open}>
        <div class="settings-page-items">
          <Show when={count().all === 0}>
            <p class="settings-page-note">{language.t("settings.agent.empty")}</p>
          </Show>
          <For each={props.group.kinds}>
            {(kind) => (
              <Show when={itemsOf(props.settings, kind).length > 0}>
                <Show when={props.group.kinds.length > 1}>
                  <h4 class="settings-page-items-title">
                    {language.t(
                      kind === "plugins" ? "settings.prompt.kind.plugins" : "settings.prompt.kind.instructions",
                    )}
                  </h4>
                </Show>
                <SettingsListV2>
                  <For each={itemsOf(props.settings, kind)}>
                    {(item) => (
                      <SettingsRowV2
                        title={<span title={item.type === "mcp" ? undefined : item.name}>{label(item)}</span>}
                        description={
                          <Show when={item.source === "folder"}>{language.t("settings.prompt.fromFolder")}</Show>
                        }
                      >
                        <span
                          class="settings-v2-prompt-weight"
                          data-slot="prompt-weight"
                          data-measured={item.tokens !== null ? "" : undefined}
                        >
                          {props.tokens(item)}
                        </span>
                        <div data-action="prompt-switch" data-name={item.name}>
                          <Switch
                            checked={item.enabled}
                            onChange={(checked) => props.onSwitch(item, checked)}
                            hideLabel
                          >
                            {label(item)}
                          </Switch>
                        </div>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// «Sul web»: where the agent browses. Only in the Preview panel, or also in the user's Chrome, as a new tab, when a page
// needs their logins. Shown when Chrome is on the computer; without the app it stays, off, with where it is done. Turning
// Chrome on requires its remote debugging, which Chrome makes you enable by hand and remembers only for that launch.
const BrowserSection: Component = () => {
  const language = useLanguage()
  const chrome = () => window.__MANGO_DESKTOP__?.chrome
  // without an answer about Chrome the section is not shown, and the log says why
  const [info, { refetch }] = createResource(
    async () =>
      (await chrome()
        ?.info()
        .catch((cause: unknown) => console.error("Chrome not read", mangoDesktopError(cause).message))) ?? undefined,
  )
  const [state, setState] = createStore<{ busy: boolean; error?: string }>({ busy: false })

  const choose = async (next: boolean) => {
    const api = chrome()
    if (!api) return
    setState({ busy: true, error: undefined })
    try {
      await api.setEnabled(next)
      await refetch()
    } catch (cause) {
      const failure = mangoDesktopError(cause)
      setState(
        "error",
        language.t(
          failure.code === "chrome_missing"
            ? "settings.general.row.useChrome.missing"
            : "settings.general.row.useChrome.debugOff",
        ),
      )
    } finally {
      setState("busy", false)
    }
  }

  return (
    <Show when={!chrome() || info()?.installed}>
      <h3 class="settings-v2-section-title">{language.t("settings.agent.web")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.agent.web.where.title")}
          description={
            <>
              {language.t(chrome() ? "settings.agent.web.where.description" : "settings.pcOnly")}
              <Show when={state.error}>
                {(message) => (
                  <span class="settings-page-row-line" data-tone="danger">
                    {message()}
                  </span>
                )}
              </Show>
            </>
          }
        >
          <SegmentedControlV2
            value={info()?.enabled ? "chrome" : "panel"}
            disabled={!chrome() || state.busy}
            onChange={(value) => value && void choose(value === "chrome")}
            data-action="settings-use-my-chrome"
            aria-label={language.t("settings.agent.web.where.title")}
          >
            <SegmentedControlItemV2 value="panel">{language.t("settings.agent.web.panel")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="chrome">{language.t("settings.agent.web.chrome")}</SegmentedControlItemV2>
          </SegmentedControlV2>
        </SettingsRowV2>
      </SettingsListV2>
    </Show>
  )
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function reason(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
