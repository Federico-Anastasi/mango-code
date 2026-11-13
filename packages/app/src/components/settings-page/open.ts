// mango-code: every way into the settings opens the page in its tab (`settings-page.tsx`): the gear and «Impostazioni»
// on the last section seen, the other doors on their section and row.
import { makeEventListener } from "@solid-primitives/event-listener"
import { onMount } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useTabs } from "@/context/tabs"
import { isSection, type SettingsSection } from "./settings-index"

/** `focus`: the title of a row, or a model's key in Models. */
export function useOpenSettings() {
  const tabs = useTabs()
  return (section?: SettingsSection, focus?: string) => tabs.openSettings({ section, focus })
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const open = useOpenSettings()
  const show = () => open()

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      onSelect: show,
    },
  ])

  return show
}

/**
 * The settings the app asks for: «Settings…» of the Windows icon sends `mango-settings` with its section and keeps the
 * request until it is read (`pendingSettings()`), so an interface still loading finds it at its start. The event opens
 * its section and empties the request: one request opens the settings once.
 */
export function useSettingsFromApp() {
  const open = useOpenSettings()
  const section = (asked: unknown) => {
    const value = (asked as { section?: unknown } | null | undefined)?.section
    return typeof value === "string" && isSection(value) ? value : undefined
  }
  const take = () =>
    window.__MANGO_DESKTOP__?.pendingSettings().catch((cause: unknown) => {
      console.error(`the settings asked by the app could not be read: ${String(cause)}`)
      return null
    })
  onMount(() => {
    void take()?.then((asked) => asked && open(section(asked)))
    makeEventListener(window, "mango-settings", (event) => {
      open(section((event as CustomEvent<unknown>).detail))
      void take()
    })
  })
}
