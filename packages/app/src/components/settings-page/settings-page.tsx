// mango-code: the settings, a whole page in a tab of the app (the chat goes on in its own tab): six sections and a search
// that finds every setting (`settings-index.ts`). Every way in opens it on its section through `useOpenSettings`; the
// gear opens it on the last section seen. On a phone it is two screens: the sections, then the one chosen.
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createMediaQuery } from "@solid-primitives/media"
import { useNavigate, useSearchParams } from "@solidjs/router"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { settingsHref, useTabs } from "@/context/tabs"
import { mangoVersion } from "@/utils/mango-version"
import { Persist, persisted } from "@/utils/persist"
import { SettingsAgent } from "./agent"
import { useAnswering } from "./answering"
import { SettingsComputer } from "./computer"
import { ControlProvider } from "./control"
import { SettingsGeneral } from "./general"
import { SettingsHelp } from "./help"
import { SettingsLinks } from "./links"
import { SettingsModels } from "./models"
import { useSettingsCommand } from "./open"
import { isSection, searchSettings, SECTIONS, SETTINGS_INDEX, type Found, type SettingsSection } from "./settings-index"
import "../settings-v2/settings-v2.css"
import "./settings-page.css"

const ICONS = {
  models: "models",
  computer: "server",
  agent: "brain",
  links: "link",
  general: "sliders",
  help: "help",
} as const

/** The titles a search result brings into view, and the rows they mark. */
const FOUND_TITLES =
  '[data-slot="settings-v2-row-title"], .settings-v2-section-title, [data-slot="settings-field-title"], [data-found-title]'
const FOUND_ROWS =
  '[data-component="settings-v2-row"], .settings-page-field, .settings-page-row, .settings-page-link-card'
/** How long a row asked for may take to come (a list read from the agent): then the page stops looking. */
const FOUND_WAIT = 10_000

/** The title a row is found by: its own (`data-found-title`, a button whose text says more), or its text. */
function foundTitle(element: HTMLElement) {
  return element.dataset.foundTitle ?? element.textContent?.trim()
}

const TITLES = {
  models: "settings.section.models",
  computer: "settings.section.computer",
  agent: "settings.section.agent",
  links: "settings.section.links",
  general: "settings.section.general",
  help: "settings.section.help",
} as const

export const SettingsPage: Component = () => {
  const language = useLanguage()
  const tabs = useTabs()
  const navigate = useNavigate()
  const [search] = useSearchParams<{ section?: string; focus?: string }>()
  const [memory, setMemory] = persisted(Persist.global("settings.page"), createStore({ section: "models" as string }))
  const phone = createMediaQuery("(max-width: 767px)")
  const [query, setQuery] = createSignal("")
  // on a phone: the list of sections until one is chosen
  const [chosen, setChosen] = createSignal(!!search.section)
  const section = createMemo<SettingsSection>(() => {
    if (isSection(search.section)) return search.section
    return isSection(memory.section) ? memory.section : "models"
  })

  // While a conversation answers with this PC's model the page says what applies when. The answer goes
  // on in its own tab.
  const mango = useMango()
  const answering = useAnswering()
  const answeringLine = createMemo(() => {
    const model = mango.state()?.model
    const tab = answering()
    if (!tab || model?.phase !== "ready") return
    return tab.title
      ? language.t("settings.answering", { title: tab.title, model: model.label })
      : language.t("settings.answering.untitled", { model: model.label })
  })

  // the gear and the menu of the window open the settings from here too
  useSettingsCommand()
  onMount(() => tabs.addSettingsTab())
  createEffect(on(section, (value) => setMemory("section", value)))

  // a result chosen again (the same section and row) looks for its row again
  const [picks, setPicks] = createSignal(0)
  const go = (value: SettingsSection, focus?: string) => {
    setQuery("")
    setChosen(true)
    setPicks((count) => count + 1)
    navigate(settingsHref({ section: value, focus }), { replace: true })
  }

  const found = createMemo(() =>
    searchSettings(
      SETTINGS_INDEX.map((entry) => ({
        section: entry.section,
        title: language.t(entry.title),
        description: entry.description ? language.t(entry.description) : undefined,
        words: entry.words ? language.t(entry.words) : undefined,
      })),
      query(),
    ),
  )

  // A row asked for by its title (a result of the search) comes into view and is marked for a moment, as soon as the
  // section has it: a list read from the agent, or a model's choices, come a moment after the section.
  let main: HTMLElement | undefined
  createEffect(
    on([section, () => search.focus, picks], ([, focus]) => {
      if (!focus || !main) return
      const find = () => {
        const title = [...main!.querySelectorAll<HTMLElement>(FOUND_TITLES)].find(
          (element) => foundTitle(element) === focus,
        )
        if (!title) return false
        const target = title.closest<HTMLElement>(FOUND_ROWS) ?? title
        target.scrollIntoView({ block: "center" })
        target.dataset.found = ""
        setTimeout(() => delete target.dataset.found, 1600)
        return true
      }
      const observer = new MutationObserver(() => find() && observer.disconnect())
      observer.observe(main, { childList: true, subtree: true })
      const giveUp = setTimeout(() => observer.disconnect(), FOUND_WAIT)
      onCleanup(() => {
        observer.disconnect()
        clearTimeout(giveUp)
      })
      requestAnimationFrame(() => find() && observer.disconnect())
    }),
  )

  return (
    // one reading of the models and the computer for every section, kept while the page is open
    <ControlProvider>
      <div class="settings-page" data-component="settings-page" data-phone-page={phone() && chosen() ? "" : undefined}>
        <nav class="settings-page-nav" aria-label={language.t("sidebar.settings")}>
          <div class="settings-page-search" data-action="settings-search">
            <IconV2 name="magnifying-glass" />
            <TextInputV2
              type="search"
              appearance="base"
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                if (event.currentTarget.value) setChosen(true)
              }}
              placeholder={language.t("settings.search.placeholder")}
              aria-label={language.t("settings.search.placeholder")}
              spellcheck={false}
              autocomplete="off"
            />
          </div>
          <div class="settings-page-sections">
            <For each={SECTIONS}>
              {(value) => (
                <button
                  type="button"
                  class="settings-page-section-button"
                  aria-current={!query() && section() === value ? "page" : undefined}
                  data-section={value}
                  onClick={() => go(value)}
                >
                  <Icon name={ICONS[value]} />
                  {language.t(TITLES[value])}
                </button>
              )}
            </For>
          </div>
          <div class="settings-v2-nav-footer">
            <span>{language.t("app.name.desktop")}</span>
            <span>v{mangoVersion}</span>
          </div>
        </nav>

        <main class="settings-page-main" ref={main}>
          <Show when={phone()}>
            <div class="settings-v2-phone-bar">
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                class="!size-11 shrink-0"
                icon={<IconV2 name="chevron-left" />}
                aria-label={language.t("common.goBack")}
                onClick={() => {
                  setQuery("")
                  setChosen(false)
                }}
              />
              <h2>{query() ? language.t("settings.search.results") : language.t(TITLES[section()])}</h2>
            </div>
          </Show>
          <Show when={answeringLine()}>
            {(line) => (
              <p class="settings-page-answering" role="status" data-component="settings-answering">
                {line()}
              </p>
            )}
          </Show>
          <Show when={query()} fallback={<Pane section={section()} focus={search.focus} />}>
            <Results found={found()} onPick={(item) => go(item.section, item.title)} />
          </Show>
        </main>
      </div>
    </ControlProvider>
  )
}

const Results: Component<{ found: Found[]; onPick: (item: Found) => void }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-page-pane" data-slot="settings-search-results">
      <Show when={props.found.length} fallback={<p class="settings-page-note">{language.t("settings.search.none")}</p>}>
        <div class="settings-page-box">
          <For each={props.found}>
            {(item) => (
              <button
                type="button"
                class="settings-page-row settings-page-row--click"
                onClick={() => props.onPick(item)}
                data-search-result={item.section}
              >
                <span class="settings-page-row-copy">
                  <span data-slot="settings-search-title">{item.title}</span>
                  <Show when={item.description}>
                    <span class="settings-page-row-line">{item.description}</span>
                  </Show>
                </span>
                <span class="settings-page-pill">{language.t(TITLES[item.section])}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** One section of the page. */
const Pane: Component<{ section: SettingsSection; focus?: string }> = (props) => {
  const language = useLanguage()
  const header = (
    <div class="settings-page-pane-header">
      <h2 class="settings-page-pane-title">{language.t(TITLES[props.section])}</h2>
    </div>
  )
  return (
    <div class="settings-page-pane settings-v2-panel" data-pane={props.section}>
      <Switch>
        <Match when={props.section === "models"}>
          <SettingsModels focus={props.focus} />
        </Match>
        <Match when={props.section === "computer"}>
          {header}
          <SettingsComputer />
        </Match>
        <Match when={props.section === "agent"}>
          <SettingsAgent focus={props.focus} />
        </Match>
        <Match when={props.section === "links"}>
          {header}
          <SettingsLinks />
        </Match>
        <Match when={props.section === "general"}>
          <SettingsGeneral focus={props.focus} />
        </Match>
        <Match when={props.section === "help"}>
          <SettingsHelp />
        </Match>
      </Switch>
    </div>
  )
}
