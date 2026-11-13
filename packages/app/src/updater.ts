import type { Accessor } from "solid-js"

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  /** Whether the check at each start is on; only where the choice is the user's (the Mango Code app). */
  automatic?: Accessor<boolean>
  setAutomatic?(automatic: boolean): Promise<void>
  /** When the last check that got an answer ended (milliseconds since 1970); only where the app says it. */
  checkedAt?: Accessor<number | undefined>
  check(): Promise<UpdaterState>
  install(): Promise<void>
}

type UpdateSentence = {
  key:
    | "settings.help.update.checking"
    | "settings.help.update.downloading"
    | "settings.help.update.ready"
    | "settings.help.update.installing"
    | "settings.help.update.upToDate"
    | "settings.help.update.checkedToday"
    | "settings.help.update.checkedOn"
    | "settings.help.update.error"
    | "settings.help.update.description"
    | "settings.help.update.manual"
  params?: Record<string, string | number>
}

/**
 * What the update row says: the key of the sentence and what goes into it. With the automatic check off, the idle row
 * says so. The latest version, with the time of the check when it is known: «today at 9:12», or the day before it.
 */
export function updateSentence(
  state: UpdaterState,
  automatic: boolean,
  checked?: { at: number; now: number; locale: string },
): UpdateSentence {
  switch (state.status) {
    case "checking":
      return { key: "settings.help.update.checking" }
    case "downloading":
      return {
        key: "settings.help.update.downloading",
        params: { version: state.version, percent: state.percent ?? 0 },
      }
    case "ready":
      return { key: "settings.help.update.ready", params: { version: state.version } }
    case "installing":
      return { key: "settings.help.update.installing", params: { version: state.version } }
    case "up-to-date": {
      if (!checked) return { key: "settings.help.update.upToDate" }
      const at = new Date(checked.at)
      const time = at.toLocaleTimeString(checked.locale, { hour: "2-digit", minute: "2-digit" })
      if (at.toDateString() === new Date(checked.now).toDateString())
        return { key: "settings.help.update.checkedToday", params: { time } }
      const date = at.toLocaleDateString(checked.locale, { day: "numeric", month: "long" })
      return { key: "settings.help.update.checkedOn", params: { date, time } }
    }
    case "error":
      return { key: "settings.help.update.error", params: { message: state.message } }
    default:
      return { key: automatic ? "settings.help.update.description" : "settings.help.update.manual" }
  }
}
