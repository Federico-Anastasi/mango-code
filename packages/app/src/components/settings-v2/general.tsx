import { Component, type JSX, Show, createMemo, createResource, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useUpdaterAction } from "../updater-action"
import { useSettings } from "@/context/settings"
import { inMangoDesktop, mangoDesktopError } from "@/utils/mango-desktop"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DictationSection } from "./dictation"
import { PhoneSection } from "./phone"
import { LayoutRetirementNotice, LayoutTransitionToggle } from "./interface-transition"
import {
  createAppearanceSettingsController,
  createSoundSettingsController,
  soundOptions,
  type AppearanceSettingsController,
  type SoundSettingsController,
} from "./general-controllers"
import "./settings-v2.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]
const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
} as const
const soundSettings = {
  agent: {
    action: "settings-sounds-agent",
    title: "settings.general.sounds.agent.title",
    description: "settings.general.sounds.agent.description",
  },
  permissions: {
    action: "settings-sounds-permissions",
    title: "settings.general.sounds.permissions.title",
    description: "settings.general.sounds.permissions.description",
  },
  errors: {
    action: "settings-sounds-errors",
    title: "settings.general.sounds.errors.title",
    description: "settings.general.sounds.errors.description",
  },
} as const

// "Use my Chrome": the agent drives the user's Chrome (their profile, their logins) instead of the
// Preview panel. The item shows only if Chrome is there; turning it on requires remote debugging, which
// Chrome makes you enable by hand and remembers only for that launch.
const BrowserRow: Component = () => {
  const language = useLanguage()
  const chrome = () => window.__MANGO_DESKTOP__?.chrome
  const [info, { refetch }] = createResource(async () => (await chrome()?.info()) ?? undefined)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const toggle = async (next: boolean) => {
    const api = chrome()
    if (!api) return
    setBusy(true)
    setError(undefined)
    try {
      await api.setEnabled(next)
      await refetch()
    } catch (cause) {
      const failure = mangoDesktopError(cause)
      setError(
        language.t(
          failure.code === "chrome_missing"
            ? "settings.general.row.useChrome.missing"
            : "settings.general.row.useChrome.debugOff",
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={info()?.installed}>
      <SettingsRowV2
        title={language.t("settings.general.row.useChrome.title")}
        description={language.t("settings.general.row.useChrome.description")}
      >
        <div data-action="settings-use-my-chrome" class="flex flex-col items-end gap-1">
          <Switch checked={info()?.enabled ?? false} disabled={busy()} onChange={(checked) => void toggle(checked)} />
          <Show when={error()}>
            {(message) => <span class="max-w-64 text-end text-[11px] text-text-danger">{message()}</span>}
          </Show>
        </div>
      </SettingsRowV2>
    </Show>
  )
}

const AppearanceSection: Component<{ controller: AppearanceSettingsController; fonts: boolean }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.appearance")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={schemeOptions}
            current={schemeOptions.find((option) => option === props.controller.scheme.current())}
            placement="bottom-end"
            gutter={6}
            label={(option) => {
              if (option === "system") return language.t("theme.scheme.system")
              if (option === "light") return language.t("theme.scheme.light")
              return language.t("theme.scheme.dark")
            }}
            onSelect={(option) => option && props.controller.scheme.select(option)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={<>{language.t("settings.general.row.theme.description")}</>}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={props.controller.theme.options()}
            current={props.controller.theme.current()}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.name}
            onSelect={props.controller.theme.select}
          />
        </SettingsRowV2>

        <Show when={props.fonts}>
          <FontSettings fonts={props.controller.fonts} />
        </Show>
      </SettingsListV2>
    </div>
  )
}

const FontSettings: Component<{ fonts: AppearanceSettingsController["fonts"] }> = (props) => (
  <>
    <FontSetting kind="ui" fonts={props.fonts} />
    <FontSetting kind="code" fonts={props.fonts} />
  </>
)

/** Section closed by default: the items for those who know what they are. */
const CollapsedSection: Component<{ title: string; children: JSX.Element }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="settings-v2-section">
      <button
        type="button"
        data-action="settings-advanced-toggle"
        aria-expanded={open()}
        class="settings-v2-section-title flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        {props.title}
        <IconV2 name="chevron-down" class={open() ? "" : "-rotate-90"} />
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}

const FontSetting: Component<{
  kind: "ui" | "code"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInputV2
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRowV2>
  )
}

const SoundsSection: Component<{ controller: SoundSettingsController }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>
      <SettingsListV2>
        <SoundSetting kind="agent" channel={props.controller.agent} />
        <SoundSetting kind="permissions" channel={props.controller.permissions} />
        <SoundSetting kind="errors" channel={props.controller.errors} />
      </SettingsListV2>
    </div>
  )
}

const SoundSetting: Component<{
  kind: "agent" | "permissions" | "errors"
  channel: SoundSettingsController["agent"]
}> = (props) => {
  const language = useLanguage()
  const config = () => soundSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <SelectV2
        appearance="inline"
        data-action={config().action}
        options={soundOptions}
        current={props.channel.current()}
        value={(option) => option.id}
        label={(option) => language.t(option.label)}
        onHighlight={props.channel.highlight}
        onSelect={props.channel.select}
        placement="bottom-end"
        gutter={6}
      />
    </SettingsRowV2>
  )
}

const LanguageSetting = () => {
  const language = useLanguage()
  const options = createMemo(() =>
    language.choices.map((choice) => ({
      value: choice,
      label: language.label(choice),
    })),
  )
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.language.title")}
      description={language.t("settings.general.row.language.description")}
    >
      <SelectV2
        appearance="inline"
        data-action="settings-language"
        options={options()}
        placement="bottom-end"
        gutter={6}
        current={options().find((option) => option.value === language.choice())}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && language.setChoice(option.value)}
      />
    </SettingsRowV2>
  )
}

export const SettingsGeneralV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")
  const updater = useUpdaterAction()
  const appearance = createAppearanceSettingsController()
  const sounds = createSoundSettingsController()
  const desktop = createMemo(() => platform.platform === "desktop")
  const mango = inMangoDesktop()

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => desktop() && "getPinchZoomEnabled" in platform,
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const InterfaceSection = () => (
    <LayoutTransitionToggle
      title={language.t("settings.general.row.newInterface.title")}
      badge={language.t("settings.general.row.newInterface.badge")}
      description={language.t("settings.general.row.newInterface.description")}
      checked={settings.general.newLayoutDesigns()}
      onChange={(checked) => settings.general.setNewLayoutDesigns(checked)}
    />
  )

  const InterfaceNoticeSection = () => (
    <LayoutRetirementNotice
      title={language.t("settings.general.row.newInterfaceNotice.title")}
      description={language.t("settings.general.row.newInterfaceNotice.description")}
      dismiss={language.t("settings.general.row.newInterfaceNotice.dismiss")}
      onDismiss={() => settings.general.dismissNewInterfaceNotice()}
    />
  )

  const ToolPartsRows = () => (
    <>
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
    </>
  )

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        <LanguageSetting />

        <SettingsRowV2
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRowV2>

        <Show when={!mango}>
          <ToolPartsRows />
        </Show>

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
    </div>
  )

  // inside the Mango Code app the technical items are in "Advanced", closed
  const AdvancedSection = () => (
    <Show when={mango}>
      <CollapsedSection title={language.t("settings.general.section.advanced")}>
        <SettingsListV2>
          <BrowserRow />
          <ToolPartsRows />
          <FontSettings fonts={appearance.fonts} />
        </SettingsListV2>
      </CollapsedSection>
    </Show>
  )

  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={() => updater.run()}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  // We can probably remove this, right?
  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
    </Show>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <Show when={!mango && settings.general.layoutTransitionAvailable()}>
          <InterfaceSection />
        </Show>

        <Show when={!mango && settings.general.newInterfaceNoticeVisible()}>
          <InterfaceNoticeSection />
        </Show>

        <GeneralSection />

        <DictationSection />

        <PhoneSection />

        <AppearanceSection controller={appearance} fonts={!mango} />

        <NotificationsSection />

        <SoundsSection controller={sounds} />

        <Show when={desktop()}>
          <UpdatesSection />
        </Show>

        <DisplaySection />

        <AdvancedSection />
      </div>
    </>
  )
}
