// mango-code: Settings › Help. The version and the update (with the switch of the automatic check), the website, the
// report of a problem and the logs. "Report a problem" is one click: what the user writes (optional), the files they
// attach, the logs, the PC details and, if the switch stays on, the window go to Mango Code; all anonymized but the
// user's files, which go as they are. A build without the report address (a build of your own) saves a file on the
// Desktop and opens a GitHub issue instead. From the phone the page is the same and the report goes through the app.
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { type Component, createResource, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createAttachments, pasteInto, ReportAttachments } from "@/components/report-attachments"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { updateSentence } from "@/updater"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { mangoVersion } from "@/utils/mango-version"
import { reportTarget } from "@/utils/report"
import { SettingsListV2 } from "../settings-v2/parts/list"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { PaneHeader } from "./header"

const SITE = "https://ciaomango.com/mango-code"

export const SettingsHelp: Component = () => {
  const language = useLanguage()
  return (
    <div class="settings-page-help" data-component="settings-help">
      <PaneHeader title={language.t("settings.section.help")} />
      <Updates />
      <SettingsListV2>
        <Site />
        <Report />
        <Logs />
      </SettingsListV2>
    </div>
  )
}

/** The version with its update, and the switch of the check at each start. Outside the app both are off, with the reason. */
const Updates: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const [ui, setUi] = createStore<{ busy: boolean; error?: string }>({ busy: false })
  const updater = () => platform.updater
  const state = () => updater()?.state() ?? { status: "idle" as const }
  const automatic = () => updater()?.automatic?.() ?? false
  const sentence = () => {
    const at = updater()?.checkedAt?.()
    return updateSentence(
      state(),
      automatic(),
      at === undefined ? undefined : { at, now: Date.now(), locale: language.intl() },
    )
  }

  const setAutomatic = async (next: boolean) => {
    setUi({ busy: true, error: undefined })
    try {
      await updater()?.setAutomatic?.(next)
    } catch (cause) {
      setUi("error", mangoDesktopError(cause).message)
    } finally {
      setUi("busy", false)
    }
  }

  return (
    <SettingsListV2>
      <SettingsRowV2
        title={language.t("settings.help.update.title", { version: mangoVersion })}
        description={updater() ? language.t(sentence().key, sentence().params) : language.t("settings.pcOnly")}
      >
        <Show
          when={state().status === "ready"}
          fallback={
            <ButtonV2
              variant="neutral"
              data-action="settings-check-update"
              data-found-title={language.t("settings.help.update.check")}
              disabled={!updater() || ["checking", "downloading", "installing"].includes(state().status)}
              onClick={() => void updater()?.check()}
            >
              {language.t("settings.help.update.check")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="neutral" data-action="settings-install-update" onClick={() => void updater()?.install()}>
            {language.t("toast.update.action.installRestart")}
          </ButtonV2>
        </Show>
      </SettingsRowV2>
      <SettingsRowV2
        title={language.t("settings.help.automatic.title")}
        description={
          <>
            {language.t(updater()?.setAutomatic ? "settings.help.automatic.description" : "settings.pcOnly")}
            <Show when={ui.error}>
              {(message) => (
                <span class="settings-page-row-line" data-tone="danger">
                  {message()}
                </span>
              )}
            </Show>
          </>
        }
      >
        <div data-action="settings-update-automatic">
          <Switch
            checked={automatic()}
            disabled={!updater()?.setAutomatic || ui.busy}
            onChange={(checked) => void setAutomatic(checked)}
            hideLabel
          >
            {language.t("settings.help.automatic.title")}
          </Switch>
        </div>
      </SettingsRowV2>
    </SettingsListV2>
  )
}

const Site: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  return (
    <SettingsRowV2
      title={language.t("settings.help.site.title")}
      description={language.t("settings.help.site.description")}
    >
      <ButtonV2 variant="neutral" onClick={() => platform.openExternal(SITE)}>
        {language.t("settings.help.site.open")}
      </ButtonV2>
    </SettingsRowV2>
  )
}

/** The row that opens the form. It exists only where a report can go: the app's bridge, or the phone port. */
const Report: Component = () => {
  const language = useLanguage()
  const [target] = createResource(reportTarget)
  const [store, setStore] = createStore({
    open: false,
    note: "",
    screenshot: true,
    state: "idle" as "idle" | "sending" | "sent" | "github",
    file: undefined as string | undefined,
    error: undefined as string | undefined,
  })
  const attachments = createAttachments(() => target()?.info.maxBytes ?? 0)
  const paste = pasteInto(attachments)

  const send = () => {
    const to = target()
    if (!to) return
    setStore({ state: "sending", error: undefined })
    to.send({ note: store.note, screenshot: store.screenshot && to.info.screenshot, files: attachments.files() }).then(
      (done) => {
        setStore({ state: done.sent ? "sent" : "github", file: done.file, note: "" })
        attachments.clear()
      },
      (cause: unknown) => setStore({ state: "idle", error: mangoDesktopError(cause).message }),
    )
  }

  return (
    <Show when={target()}>
      {(to) => (
        <>
          <SettingsRowV2
            title={language.t("settings.help.report.title")}
            description={language.t("settings.help.report.row")}
          >
            <ButtonV2
              variant="neutral"
              data-action="settings-report-open"
              aria-expanded={store.open}
              onClick={() => setStore("open", !store.open)}
            >
              {language.t("settings.help.report.open")}
            </ButtonV2>
          </SettingsRowV2>
          <Show when={store.open}>
            <div class="settings-page-form" data-component="settings-report">
              <p class="settings-page-note">{language.t("settings.help.report.description")}</p>
              <TextareaV2
                class="!w-full"
                rows={3}
                value={store.note}
                placeholder={language.t("settings.help.report.placeholder")}
                onInput={(event) => setStore("note", event.currentTarget.value)}
                onPaste={(event) => to().info.attachments && paste(event)}
              />
              <Show when={to().info.attachments}>
                <ReportAttachments attachments={attachments} />
              </Show>
              <Show when={to().info.screenshot}>
                <SettingsRowV2
                  title={language.t("settings.help.report.screenshot.title")}
                  description={language.t("settings.help.report.screenshot.description")}
                >
                  <Switch checked={store.screenshot} onChange={(checked) => setStore("screenshot", checked)} />
                </SettingsRowV2>
              </Show>
              <div class="settings-page-inline">
                <ButtonV2
                  variant="neutral"
                  data-action="settings-report-problem"
                  disabled={store.state === "sending"}
                  onClick={send}
                >
                  {language.t(
                    store.state === "sending" ? "settings.help.report.sending" : "settings.help.report.button",
                  )}
                </ButtonV2>
                <Show when={store.state === "sent"}>
                  <span class="settings-page-note">{language.t("settings.help.report.sent")}</span>
                </Show>
                <Show when={store.state === "github" && store.file}>
                  {(file) => (
                    <span class="settings-page-note">{language.t("settings.help.report.saved", { file: file() })}</span>
                  )}
                </Show>
              </div>
              <Show when={store.error}>{(message) => <p class="settings-page-error">{message()}</p>}</Show>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}

const Logs: Component = () => {
  const language = useLanguage()
  const [ui, setUi] = createStore<{ error?: string }>({})
  const open = () => {
    setUi("error", undefined)
    window.__MANGO_DESKTOP__?.openLogs().catch((cause: unknown) => setUi("error", mangoDesktopError(cause).message))
  }
  // without the app (the phone, a browser) the row stays, off, with where it is done
  return (
    <SettingsRowV2
      title={language.t("settings.help.logs.title")}
      description={
        <>
          {language.t(window.__MANGO_DESKTOP__ ? "settings.help.logs.description" : "settings.pcOnly")}
          <Show when={ui.error}>
            {(message) => (
              <span class="settings-page-row-line" data-tone="danger">
                {message()}
              </span>
            )}
          </Show>
        </>
      }
    >
      <ButtonV2 variant="neutral" data-action="settings-open-logs" disabled={!window.__MANGO_DESKTOP__} onClick={open}>
        {language.t("settings.help.logs.button")}
      </ButtonV2>
    </SettingsRowV2>
  )
}
