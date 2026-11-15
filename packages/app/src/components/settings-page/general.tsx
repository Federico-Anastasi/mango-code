// mango-code: Settings › General. The four rows every Mango app has, in this order: language, theme (system, light, dark),
// size and dictation. Then what only Mango Code has: what the chat shows, the alerts (a notification and a sound for each
// of the three events) and, closed, the technical items: the tool parts of the chat.
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { StepperV2 } from "@opencode-ai/ui/v2/stepper-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { type Component, createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { type LanguageChoice, useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { mangoDesktopError, nextZoom } from "@/utils/mango-desktop"
import { SettingsListV2 } from "../settings-v2/parts/list"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { DictationRow } from "./dictation"
import { PaneHeader } from "./header"

const SCHEMES = [
  { value: "system", label: "theme.scheme.system" },
  { value: "light", label: "theme.scheme.light" },
  { value: "dark", label: "theme.scheme.dark" },
] as const satisfies readonly { value: ColorScheme; label: string }[]

/** `focus`: the title of a row asked for by the search; the closed part opens if the row is in it. */
export const SettingsGeneral: Component<{ focus?: string }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const mobile = createMediaQuery("(max-width: 767px)")
  // the system's language first, as the theme has it
  const languages = createMemo(() =>
    language.choices
      .toSorted((a, b) => Number(b === "system") - Number(a === "system"))
      .map((value) => ({ value, label: language.label(value) })),
  )

  const alerts = [
    {
      id: "agent",
      title: "settings.general.alerts.agent",
      notify: settings.notifications.agent,
      setNotify: settings.notifications.setAgent,
      sound: settings.sounds.agentEnabled,
      setSound: settings.sounds.setAgentEnabled,
    },
    {
      id: "permissions",
      title: "settings.general.alerts.permissions",
      notify: settings.notifications.permissions,
      setNotify: settings.notifications.setPermissions,
      sound: settings.sounds.permissionsEnabled,
      setSound: settings.sounds.setPermissionsEnabled,
    },
    {
      id: "errors",
      title: "settings.general.alerts.errors",
      notify: settings.notifications.errors,
      setNotify: settings.notifications.setErrors,
      sound: settings.sounds.errorsEnabled,
      setSound: settings.sounds.setErrorsEnabled,
    },
  ] as const

  return (
    <div class="settings-page-general" data-component="settings-general">
      <PaneHeader title={language.t("settings.section.general")} />

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <SegmentedControlV2
            value={language.choice()}
            onChange={(value) => value && language.setChoice(value as LanguageChoice)}
            data-action="settings-language"
            aria-label={language.t("settings.general.row.language.title")}
          >
            <For each={languages()}>
              {(option) => <SegmentedControlItemV2 value={option.value}>{option.label}</SegmentedControlItemV2>}
            </For>
          </SegmentedControlV2>
        </SettingsRowV2>

        <SettingsRowV2 title={language.t("settings.general.theme.title")} description="">
          <SegmentedControlV2
            value={theme.colorScheme()}
            onChange={(value) => value && theme.setColorScheme(value as ColorScheme)}
            data-action="settings-color-scheme"
            aria-label={language.t("settings.general.theme.title")}
          >
            <For each={SCHEMES}>
              {(scheme) => (
                <SegmentedControlItemV2 value={scheme.value}>{language.t(scheme.label)}</SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
        </SettingsRowV2>

        <ZoomRow />

        <DictationRow />
      </SettingsListV2>

      <h3 class="settings-v2-section-title">{language.t("settings.general.section.own")}</h3>
      <SettingsListV2>
        <SettingsRowV2 title={language.t("settings.general.reasoning.title")} description="">
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRowV2>

        <Show when={mobile() && import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"}>
          <SettingsRowV2
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>

      <h3 class="settings-v2-section-title">{language.t("settings.general.alerts.title")}</h3>
      <SettingsListV2>
        <For each={alerts}>
          {(alert) => (
            <SettingsRowV2 title={language.t(alert.title)} description="">
              <div class="settings-page-inline" data-action={`settings-alert-${alert.id}`}>
                <span>{language.t("settings.general.alerts.notify")}</span>
                <Switch checked={alert.notify()} onChange={(checked) => alert.setNotify(checked)} hideLabel>
                  {language.t("settings.general.alerts.notify")}
                </Switch>
                <span>{language.t("settings.general.alerts.sound")}</span>
                <Switch checked={alert.sound()} onChange={(checked) => alert.setSound(checked)} hideLabel>
                  {language.t("settings.general.alerts.sound")}
                </Switch>
              </div>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>

      <Advanced focus={props.focus} />
    </div>
  )
}

/** «Grandezza − 100% +»: the zoom of the window, the same as Ctrl+ and Ctrl-, which it follows. */
const ZoomRow: Component = () => {
  const language = useLanguage()
  const zoom = () => window.__MANGO_DESKTOP__?.zoom
  const [value, setValue] = createSignal<number>()
  const [error, setError] = createSignal<string>()
  onMount(
    () =>
      void zoom()
        ?.get()
        .then(setValue, (cause) => setError(mangoDesktopError(cause).message)),
  )
  makeEventListener(window, "mango-zoom", (event) => setValue((event as CustomEvent<number>).detail))
  const step = (direction: 1 | -1) => {
    const current = value()
    if (current === undefined) return
    setError(undefined)
    zoom()
      ?.set(nextZoom(current, direction))
      .then(setValue, (cause) => setError(mangoDesktopError(cause).message))
  }
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.zoom.title")}
      description={error() ?? (zoom() ? "" : language.t("settings.pcOnly"))}
    >
      <div data-action="settings-zoom">
        <StepperV2
          label={language.t("settings.general.row.zoom.title")}
          value={value() === undefined ? "—" : `${Math.round(value()! * 100)}%`}
          decreaseLabel={language.t("desktop.menu.zoomOut")}
          increaseLabel={language.t("desktop.menu.zoomIn")}
          canDecrease={value() !== undefined && value()! > nextZoom(value()!, -1)}
          canIncrease={value() !== undefined && value()! < nextZoom(value()!, 1)}
          onDecrease={() => step(-1)}
          onIncrease={() => step(1)}
        />
      </div>
    </SettingsRowV2>
  )
}

/** The titles of the rows of the closed part: a search that leads to one of them opens it. */
const ADVANCED_TITLES = [
  "settings.general.row.shellToolPartsExpanded.title",
  "settings.general.row.editToolPartsExpanded.title",
] as const

/** Closed: what is for those who know what they are. */
const Advanced: Component<{ focus?: string }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const [open, setOpen] = createSignal(false)
  createEffect(
    on(
      () => props.focus,
      (focus) => {
        if (ADVANCED_TITLES.some((title) => language.t(title) === focus)) setOpen(true)
      },
    ),
  )
  return (
    <div class="settings-v2-section">
      <button
        type="button"
        data-action="settings-advanced-toggle"
        aria-expanded={open()}
        class="settings-v2-section-title flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        {language.t("settings.general.section.advanced")}
        <IconV2 name="chevron-down" class={open() ? "" : "-rotate-90"} />
      </button>
      <Show when={open()}>
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.shellToolPartsExpanded.title")}
            description={language.t("settings.general.row.shellToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-shell-tool-parts-expanded">
              <Switch
                checked={settings.general.shellToolPartsExpanded()}
                onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.general.row.editToolPartsExpanded.title")}
            description={language.t("settings.general.row.editToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-edit-tool-parts-expanded">
              <Switch
                checked={settings.general.editToolPartsExpanded()}
                onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRowV2>
        </SettingsListV2>
      </Show>
    </div>
  )
}
