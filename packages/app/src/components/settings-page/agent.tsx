// mango-code: Settings › Agent. The harnesses first (session/harness.ts): Mango Code's two and the user's own, each with
// the models that use it; the one picked shows what the model reads with every request (server route `/mango/settings`):
// the weight of the whole in a bar, then a row for the base prompt, tools, MCP servers, skills, instructions and hooks
// that opens on its items. Each item has its weight in tokens and one switch; the choice at the top says whether a
// switch applies to all the projects or only to the open one. In a harness of the user's the base prompt, the words of a
// tool, the texts and numbers of a hook and the texts of the summary of a long conversation can be changed. At the end, where the agent browses.
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { StepperV2 } from "@opencode-ai/ui/v2/stepper-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { type Component, createEffect, createMemo, createResource, createSignal, For, type JSX, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
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
import { SettingsListV2 } from "../settings-v2/parts/list"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { useSettingsProject } from "./directory"
import { folderKey } from "@/utils/path-key"
import { PaneHeader } from "./header"
import { createHarnessList, type HarnessHook, type HarnessShown, parseHarness, useAgentCall } from "./harnesses"

type Scope = "all" | "folder"

const TEXTS = {
  tools: { title: "settings.agent.tools.title", line: "settings.agent.tools.description" },
  mcp: { title: "settings.agent.mcp.title", line: "settings.agent.mcp.description" },
  skills: { title: "settings.agent.skills.title", line: "settings.agent.skills.description" },
  instructions: { title: "settings.agent.instructions.title", line: "settings.agent.instructions.description" },
  hooks: { title: "settings.agent.hooks.title", line: "settings.agent.hooks.description" },
} as const satisfies Record<PromptGroup["id"], { title: string; line: string }>

const SHARE_TITLES = {
  base: "settings.prompt.kind.base",
  tools: TEXTS.tools.title,
  mcp: TEXTS.mcp.title,
  skills: TEXTS.skills.title,
  instructions: TEXTS.instructions.title,
} as const

/** What each hook does to the model's work, and the number it takes with its unit. */
const HOOKS = {
  "discipline-messages": { kind: "adds", number: { key: "every", unit: "messages" } },
  "discipline-calls": { kind: "adds", number: { key: "every", unit: "calls" } },
  "after-failed-call": { kind: "adds" },
  "same-call-again": { kind: "refuses" },
  "outside-project": { kind: "refuses" },
  "path-taken-from-project": { kind: "adds" },
  "after-page-written": { kind: "adds" },
  "every-calls": { kind: "adds", number: { key: "every", unit: "calls" } },
  "plan-open-every-calls": { kind: "adds", number: { key: "every", unit: "calls" } },
  "cd-in-terminal": { kind: "refuses" },
  "file-named-otherwise": { kind: "adds" },
  "answer-without-opening": { kind: "holds" },
  "would-lose": { kind: "asks" },
  "web-in-terminal": { kind: "refuses" },
  "web-before-own-tools": { kind: "refuses" },
  "page-not-found": { kind: "refuses" },
  "rules-in-messages": { kind: "adds" },
  "unreadable-call": { kind: "retries", number: { key: "times", unit: "times" } },
} as const satisfies Record<
  string,
  {
    kind: "adds" | "refuses" | "holds" | "asks" | "retries"
    number?: { key: "every" | "times"; unit: "calls" | "messages" | "times" }
  }
>
type HookName = keyof typeof HOOKS

/** The texts of the summary of a long conversation, in the order the page shows them (`COMPACTION_TEXTS` of the agent). */
const COMPACTION = ["first", "update", "template", "rule", "continued", "files-read", "files-changed", "missing", "unwritten", "cut"] as const
const isHook = (name: string): name is HookName => Object.hasOwn(HOOKS, name)

/** The values a hook's text can carry (`{{calls}}`, `{{path}}`): the harness fills them in. */
const valuesOf = (text: string) => [...new Set([...text.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]))]

/** `focus`: the title of a row asked for by the search, whose row opens; or a harness, which is shown. */
export const SettingsAgent: Component<{ focus?: string }> = (props) => {
  const language = useLanguage()
  const mango = useMango()
  const call = useAgentCall()
  const [ui, setUi] = createStore<{ scope: Scope; open?: string; error?: string; busy: boolean }>({
    scope: "all",
    busy: false,
  })

  // The project the settings are about: the one picked in the page, else the default one (`directory.ts`).
  const [picked, setPicked] = createSignal<string>()
  const project = useSettingsProject()
  const projects = createMemo(() =>
    project
      .projects()
      .map((project) => ({ worktree: project.worktree, name: project.name || folderName(project.worktree) })),
  )
  const directory = createMemo(() => picked() ?? project.directory())

  const [list, { refetch: refetchList, failed: listFailed }] = createHarnessList()
  const [chosen, setChosen] = createSignal<string>()
  const harness = createMemo(() => chosen() ?? list()?.default)
  // a harness that cannot be read (its harness.json broken, the agent restarting) says why above the page; a rejected
  // resource would throw where it is read and take the page down
  const [detail, { refetch: refetchDetail }] = createResource(harness, async (id) => {
    try {
      const shown = parseHarness(await call("/mango/harness", { id }))
      if (!shown) throw new Error(language.t("settings.prompt.unexpectedResponse"))
      return shown
    } catch (cause) {
      setUi("error", language.t("settings.prompt.loadError", { message: reason(cause) }))
    }
  })

  const [settings, { mutate, refetch: refetchSettings }] = createResource(
    () => {
      const folder = directory()
      const id = harness()
      return folder && id ? { folder, id } : undefined
    },
    async ({ folder, id }): Promise<PromptSettings | undefined> => {
      setUi("error", undefined)
      try {
        const parsed = parsePromptSettings(await call("/mango/settings", { directory: folder, harness: id }))
        if (!parsed) throw new Error(language.t("settings.prompt.unexpectedResponse"))
        return parsed
      } catch (cause) {
        setUi("error", language.t("settings.prompt.loadError", { message: reason(cause) }))
      }
    },
  )

  async function toggle(item: PromptItem, enabled: boolean) {
    const folder = directory()
    const id = harness()
    if (!folder || !id) return
    setUi("error", undefined)
    try {
      const changed = (await call(
        "/mango/settings",
        { directory: folder, harness: id },
        { method: "PUT", body: JSON.stringify({ type: item.type, name: item.name, enabled, scope: ui.scope }) },
      )) as Pick<PromptItem, "enabled" | "source">
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

  /** A command on the harnesses: one at a time, its refusal shown, the list and the harness read again after it. */
  async function act(run: () => Promise<unknown>) {
    setUi({ busy: true, error: undefined })
    try {
      await run()
    } catch (cause) {
      setUi("error", reason(cause))
    } finally {
      setUi("busy", false)
    }
  }

  const duplicate = (from: string, name: string) =>
    act(async () => {
      const made = (await call(
        "/mango/harness",
        {},
        { method: "POST", body: JSON.stringify({ from, name: language.t("settings.harness.copyName", { name }) }) },
      )) as { id: string }
      await refetchList()
      setChosen(made.id)
    })

  const change = (body: Record<string, unknown>) =>
    act(async () => {
      const id = harness()
      if (!id) return
      await call("/mango/harness", { id }, { method: "PUT", body: JSON.stringify(body) })
      await Promise.all([refetchList(), refetchDetail(), refetchSettings()])
    })

  // A model that is not on the computer cannot be given another harness from Models: its choice of this one goes with
  // it, and the model starts again with the default one. For a model on the computer the agent refuses and names it.
  const remove = (id: string) =>
    act(async () => {
      const bridge = window.__MANGO_DESKTOP__?.models
      for (const model of (mango.catalog() ?? []).filter((item) => !item.present && item.choices.harness === id))
        await bridge?.setChoices(model.key, { ...model.choices, harness: null })
      await call("/mango/harness", { id }, { method: "DELETE" })
      await refetchList()
      setChosen(undefined)
    })

  // The row asked for by the search opens; a harness asked for (by a model's «Open in Agent») is shown.
  createEffect(
    on([() => props.focus, list], ([focus, current]) => {
      if (!focus) return
      if (current?.harnesses.some((item) => item.id === focus)) return setChosen(focus)
      const group = PROMPT_GROUPS.find((candidate) => language.t(TEXTS[candidate.id].title) === focus)
      if (group) setUi("open", group.id)
    }),
  )

  // The models on the computer that use each harness: a model without a choice uses the default one.
  const usedBy = (id: string) =>
    (mango.catalog() ?? [])
      .filter((model) => model.present && (model.choices.harness ?? list()?.default) === id)
      .map((model) => model.label)

  const tokens = (item: PromptItem) =>
    item.tokens === null
      ? language.t("settings.prompt.notMeasured")
      : language.t("settings.prompt.tokens", { count: item.tokens.toLocaleString(language.locale()) })

  const nameOf = () => list()?.harnesses.find((item) => item.id === harness())?.name ?? ""

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

      <Show when={listFailed()}>
        {(message) => <p class="settings-page-note">{language.t("settings.harness.listFailed", { message: message() })}</p>}
      </Show>
      <Show when={list()} keyed>
        {(current) => (
          <>
            <h3 class="settings-v2-section-title">{language.t("settings.harness.title")}</h3>
            <div class="settings-page-box" data-slot="harness-list">
              <For each={current.harnesses}>
                {(item) => {
                  const selected = () => item.id === harness()
                  const used = () => usedBy(item.id)
                  return (
                    <div class="settings-page-row settings-page-harness" aria-current={selected() ? "true" : undefined} data-harness={item.id}>
                      <span class="settings-page-row-copy">
                        <Show
                          when={selected() && !item.fixed && !item.error}
                          fallback={
                            <button type="button" class="settings-page-harness-pick" onClick={() => setChosen(item.id)} data-found-title={item.name}>
                              <span data-slot="settings-v2-row-title">{item.name}</span>
                              <Show when={item.id === current.default}>
                                <Tag variant="neutral">{language.t("settings.models.default.pill")}</Tag>
                              </Show>
                            </button>
                          }
                        >
                          <TextInputV2
                            appearance="base"
                            value={item.name}
                            aria-label={language.t("settings.harness.name")}
                            data-action="settings-harness-name"
                            disabled={ui.busy}
                            onBlur={(event) => {
                              const name = event.currentTarget.value.trim()
                              if (name && name !== item.name) void change({ name })
                            }}
                            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                          />
                        </Show>
                        <span class="settings-page-row-line" data-tone={item.error ? "danger" : undefined}>
                          {item.error
                            ? language.t("settings.harness.broken", { message: item.error })
                            : [
                                used().length ? used().join(", ") : language.t("settings.harness.models.none"),
                                ...(item.from
                                  ? [language.t("settings.harness.from", { name: current.harnesses.find((h) => h.id === item.from)?.name ?? item.from })]
                                  : []),
                              ].join(" ")}
                        </span>
                      </span>
                      <span class="settings-page-row-meta">
                        <Show when={!item.error}>
                          <ButtonV2
                            variant="neutral"
                            disabled={ui.busy}
                            onClick={() => void duplicate(item.id, item.name)}
                            data-action="settings-harness-duplicate"
                          >
                            {language.t("settings.harness.duplicate")}
                          </ButtonV2>
                        </Show>
                        <Show when={!item.fixed && (selected() || item.error)}>
                          <ButtonV2
                            variant="danger"
                            disabled={ui.busy}
                            onClick={() => void remove(item.id)}
                            data-action="settings-harness-remove"
                          >
                            {language.t("settings.harness.remove")}
                          </ButtonV2>
                        </Show>
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          </>
        )}
      </Show>

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
                current={projects().find((project) => folderKey(project.worktree) === folderKey(directory()))}
                placement="bottom-end"
                gutter={6}
                value={(project) => project.worktree}
                label={(project) => project.name}
                onSelect={(project) => project && setPicked(project.worktree)}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </Show>
        <Show when={ui.error}>{(message) => <p class="settings-page-error" role="alert">{message()}</p>}</Show>
        <Show when={settings()}>
          {(current) => (
            <>
              <Weight
                settings={current()}
                title={language.t("settings.harness.reads", { name: nameOf() })}
                commands={detail()?.kind === "commands"}
              />
              <div class="settings-page-box" data-slot="prompt-groups">
                <Show when={itemsOf(current(), "base")[0]}>
                  {(base) => (
                    <BaseRow
                      base={base()}
                      detail={detail()}
                      open={ui.open === "base"}
                      onToggle={() => setUi("open", ui.open === "base" ? undefined : "base")}
                      tokens={tokens}
                      busy={ui.busy}
                      onSave={(prompt) => change({ prompt })}
                    />
                  )}
                </Show>
                <Show when={detail()}>
                  {(shown) => (
                    <CompactionRow
                      detail={shown()}
                      open={ui.open === "compaction"}
                      onToggle={() => setUi("open", ui.open === "compaction" ? undefined : "compaction")}
                      busy={ui.busy}
                      onSave={(name, text) => change({ compaction: { [name]: text } })}
                    />
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
                      row={
                        group.id === "hooks"
                          ? (item) => (
                              <HookRow
                                item={item}
                                detail={detail()}
                                busy={ui.busy}
                                onSwitch={(enabled) => void toggle(item, enabled)}
                                onSave={(name, hook, text) => change({ ...(hook ? { hooks: { [name]: hook } } : {}), texts: { [name]: text } })}
                              />
                            )
                          : group.id === "tools" && detail() && !detail()!.fixed
                            ? (item) => (
                                <ToolRow
                                  item={item}
                                  tokens={tokens(item)}
                                  busy={ui.busy}
                                  onSwitch={(enabled) => void toggle(item, enabled)}
                                  onSave={(description) => change({ tools: { [item.name]: description } })}
                                />
                              )
                            : undefined
                      }
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

/** What a conversation starts with: the total, the bar of its parts and what each part weighs. `commands`: a harness
 *  that reads its items when a conversation starts, not at every message. */
const Weight: Component<{ settings: PromptSettings; title: string; commands: boolean }> = (props) => {
  const language = useLanguage()
  const total = () => promptTotal(props.settings)
  const shares = () => promptShares(props.settings)
  const number = (value: number) => value.toLocaleString(language.locale())
  return (
    <>
      <h3 class="settings-v2-section-title">{props.title}</h3>
      <div class="settings-page-box">
        <div class="settings-page-row" data-slot="prompt-total">
          <span class="settings-page-row-copy">
            {/* nothing measured yet: no number, which would read as an empty start */}
            <Show
              when={total().tokens > 0 || total().unmeasured === 0}
              fallback={<span data-slot="settings-v2-row-title">{language.t("settings.agent.total.unmeasured")}</span>}
            >
              <span data-slot="settings-v2-row-title">
                {language.t("settings.agent.total", { count: number(total().tokens) })}
                <Show when={total().unmeasured > 0}>
                  <span class="settings-v2-prompt-muted">
                    {" "}
                    {language.t("settings.prompt.total.unmeasured", { count: total().unmeasured })}
                  </span>
                </Show>
              </span>
            </Show>
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
      <p class="settings-page-note">
        {language.t(props.commands ? "settings.prompt.description.commands" : "settings.prompt.description")}
      </p>
    </>
  )
}

/** A text the model reads, as it is (a harness of Mango Code), or to be changed and saved (one of the user's). */
const TextEdit: Component<{
  text: string
  fixed: boolean
  busy: boolean
  rows?: number
  label: string
  hint?: string
  onSave: (text: string) => void
  extra?: JSX.Element
  /** Whether something besides the text was changed (a number): saving is possible with the text as it is. */
  changed?: boolean
}> = (props) => {
  const language = useLanguage()
  const [draft, setDraft] = createSignal(props.text)
  createEffect(on(() => props.text, (text) => setDraft(text)))
  return (
    <div class="settings-page-edit">
      {props.extra}
      <Show
        when={!props.fixed}
        fallback={
          <>
            <pre class="settings-page-text">{props.text}</pre>
            <small class="settings-page-row-line">{language.t("settings.harness.fixed")}</small>
          </>
        }
      >
        <TextareaV2
          value={draft()}
          rows={props.rows ?? 6}
          spellcheck={false}
          aria-label={props.label}
          disabled={props.busy}
          onInput={(event) => setDraft(event.currentTarget.value)}
          data-action="settings-harness-text"
        />
        <Show when={props.hint}>{(hint) => <small class="settings-page-row-line">{hint()}</small>}</Show>
        <span class="settings-page-edit-actions">
          <ButtonV2
            variant="ghost"
            disabled={props.busy || (draft() === props.text && !props.changed)}
            onClick={() => setDraft(props.text)}
          >
            {language.t("settings.harness.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="neutral"
            disabled={props.busy || (draft() === props.text && !props.changed)}
            onClick={() => props.onSave(draft())}
            data-action="settings-harness-save"
          >
            {language.t("settings.harness.save")}
          </ButtonV2>
        </span>
      </Show>
    </div>
  )
}

/** The base prompt: its weight, and the text, which a harness of the user's can change. */
const BaseRow: Component<{
  base: PromptItem
  detail?: HarnessShown
  open: boolean
  onToggle: () => void
  tokens: (item: PromptItem) => string
  busy: boolean
  onSave: (prompt: string) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-page-model" data-kind="base" data-open={props.open ? "" : undefined}>
      <button type="button" class="settings-page-row settings-page-row--click" aria-expanded={props.open} onClick={props.onToggle}>
        <span class="settings-page-row-copy">
          <span data-slot="settings-v2-row-title">{language.t("settings.prompt.kind.base")}</span>
          <span class="settings-page-row-line">{language.t("settings.harness.prompt.description")}</span>
        </span>
        <span class="settings-page-row-meta">
          <span class="settings-v2-prompt-weight" data-slot="prompt-weight">
            {props.tokens(props.base)}
          </span>
          <IconV2 name="chevron-down" class={props.open ? "rotate-180" : ""} />
        </span>
      </button>
      <Show when={props.open && props.detail}>
        {(detail) => (
          <div class="settings-page-items">
            <TextEdit
              text={detail().prompt}
              fixed={detail().fixed}
              busy={props.busy}
              rows={14}
              label={language.t("settings.prompt.kind.base")}
              onSave={props.onSave}
            />
          </div>
        )}
      </Show>
    </div>
  )
}

/** The summary of a long conversation: the texts the model reads when it is asked for it, and the lines Mango Code writes
 *  around it. A harness of the user's can change each one. */
const CompactionRow: Component<{
  detail: HarnessShown
  open: boolean
  onToggle: () => void
  busy: boolean
  onSave: (name: string, text: string) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-page-model" data-kind="compaction" data-open={props.open ? "" : undefined}>
      <button type="button" class="settings-page-row settings-page-row--click" aria-expanded={props.open} onClick={props.onToggle}>
        <span class="settings-page-row-copy">
          <span data-slot="settings-v2-row-title">{language.t("settings.harness.compaction.title")}</span>
          <span class="settings-page-row-line">{language.t("settings.harness.compaction.description")}</span>
        </span>
        <span class="settings-page-row-meta">
          <IconV2 name="chevron-down" class={props.open ? "rotate-180" : ""} />
        </span>
      </button>
      <Show when={props.open}>
        <div class="settings-page-items">
          <For each={COMPACTION}>
            {(name) => (
              <div data-compaction={name}>
                <h4 class="settings-page-items-title">{language.t(`settings.harness.compaction.${name}`)}</h4>
                <TextEdit
                  text={props.detail.compaction[name] ?? ""}
                  fixed={props.detail.fixed}
                  busy={props.busy}
                  rows={name === "template" || name === "update" ? 12 : 3}
                  label={language.t(`settings.harness.compaction.${name}`)}
                  hint={valuesOf(props.detail.compaction[name] ?? "").length
                    ? language.t("settings.harness.hook.values", { values: valuesOf(props.detail.compaction[name] ?? "").join(", ") })
                    : undefined}
                  onSave={(text) => props.onSave(name, text)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** A tool of a harness of the user's: its switch, and the words the model knows it by, to be changed. */
const ToolRow: Component<{
  item: PromptItem
  tokens: string
  busy: boolean
  onSwitch: (enabled: boolean) => void
  onSave: (description: string) => void
}> = (props) => {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  return (
    <div class="settings-page-hook" data-open={open() ? "" : undefined} data-tool={props.item.name}>
      <div class="settings-page-row">
        <button type="button" class="settings-page-row-copy settings-page-hook-open" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span data-slot="settings-v2-row-title">{props.item.name}</span>
        </button>
        <span class="settings-page-row-meta">
          <span class="settings-v2-prompt-weight" data-slot="prompt-weight">
            {props.tokens}
          </span>
          <div data-action="prompt-switch" data-name={props.item.name}>
            <Switch checked={props.item.enabled} onChange={props.onSwitch} hideLabel>
              {props.item.name}
            </Switch>
          </div>
        </span>
      </div>
      <Show when={open()}>
        <TextEdit
          text={props.item.description ?? ""}
          fixed={false}
          busy={props.busy}
          label={props.item.name}
          hint={language.t("settings.harness.tool.description")}
          onSave={props.onSave}
        />
      </Show>
    </div>
  )
}

/** A hook: what it does, its switch; open, its number and the text the model reads, which a harness of the user's can
 *  change. */
const HookRow: Component<{
  item: PromptItem
  detail?: HarnessShown
  busy: boolean
  onSwitch: (enabled: boolean) => void
  onSave: (name: string, hook: Partial<HarnessHook> | undefined, text: string) => void
}> = (props) => {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const name = () => props.item.name
  const known = () => {
    const hook = name()
    return isHook(hook) ? HOOKS[hook] : undefined
  }
  const number = (): { key: "every" | "times"; unit: "calls" | "messages" | "times" } | undefined => {
    const spec = known()
    return spec && "number" in spec ? spec.number : undefined
  }
  const saved = () => props.detail?.hooks[name()]
  const [value, setValue] = createSignal<number>()
  createEffect(on(saved, (hook) => setValue(number() && hook ? hook[number()!.key] : undefined)))
  const title = () => (isHook(name()) ? language.t(`settings.hook.${name() as HookName}.title`) : name())
  const line = () => (isHook(name()) ? language.t(`settings.hook.${name() as HookName}.description`) : "")
  const text = () => props.detail?.texts[name()] ?? ""
  const fixed = () => props.detail?.fixed ?? true
  return (
    <div class="settings-page-hook" data-open={open() ? "" : undefined} data-hook={name()}>
      <div class="settings-page-row">
        <button type="button" class="settings-page-row-copy settings-page-hook-open" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span data-slot="settings-v2-row-title">{title()}</span>
          <span class="settings-page-row-line">{line()}</span>
        </button>
        <span class="settings-page-row-meta">
          <Show when={known()}>{(spec) => <Tag variant="neutral">{language.t(`settings.hook.kind.${spec().kind}`)}</Tag>}</Show>
          <div data-action="prompt-switch" data-name={name()}>
            <Switch checked={props.item.enabled} onChange={props.onSwitch} hideLabel>
              {title()}
            </Switch>
          </div>
        </span>
      </div>
      <Show when={open() && props.detail}>
        <TextEdit
          text={text()}
          fixed={fixed()}
          busy={props.busy}
          label={title()}
          hint={
            valuesOf(text()).length
              ? language.t("settings.harness.hook.values", { values: valuesOf(text()).join(", ") })
              : language.t("settings.harness.hook.text")
          }
          changed={number() !== undefined && value() !== saved()?.[number()!.key]}
          onSave={(next) =>
            props.onSave(name(), number() && value() !== saved()?.[number()!.key] ? { [number()!.key]: value() } : undefined, next)
          }
          extra={
            <Show when={number()}>
              {(spec) => (
                <span class="settings-page-number" data-slot="hook-number">
                  <span>{language.t(spec().key === "every" ? "settings.hook.every" : "settings.hook.upTo")}</span>
                  <Show when={!fixed()} fallback={<b>{value()}</b>}>
                    <StepperV2
                      label={title()}
                      value={String(value() ?? "")}
                      decreaseLabel={language.t("settings.hook.less")}
                      increaseLabel={language.t("settings.hook.more")}
                      canDecrease={!props.busy && (value() ?? 1) > 1}
                      canIncrease={!props.busy}
                      onDecrease={() => setValue((value() ?? 1) - 1)}
                      onIncrease={() => setValue((value() ?? 0) + 1)}
                    />
                  </Show>
                  <span>{language.t(`settings.hook.unit.${spec().unit}`)}</span>
                </span>
              )}
            </Show>
          }
        />
      </Show>
    </div>
  )
}

/** How a row tells its items: «12 of 14 on», «3 connected», «4 on», «2 files», «14 of 17 on». */
const GroupCount: Component<{ group: PromptGroup["id"]; on: number; all: number }> = (props) => {
  const language = useLanguage()
  return (
    <Show
      when={props.group !== "mcp"}
      fallback={
        <Tag variant={props.on > 0 ? "ready" : "neutral"}>{language.plural("settings.agent.count.mcp", props.on)}</Tag>
      }
    >
      <span>
        {props.group === "tools" || props.group === "hooks"
          ? language.plural(`settings.agent.count.${props.group}`, props.on, { all: props.all })
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
  /** How an item is shown when the row has its own (a hook, a tool that can be described anew); else a switch. */
  row?: (item: PromptItem) => JSX.Element
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
                      <Show when={props.row} keyed fallback={
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
                      }>
                        {(row) => row(item)}
                      </Show>
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

// «On the web»: where the agent browses. Only in the Preview panel, or also in the user's Chrome, as a new tab, when a page
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
