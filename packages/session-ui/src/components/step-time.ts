import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

type Translate = (key: UiI18nKey, params?: UiI18nParams) => string

/** Milliseconds elapsed: from `start` to `end`, or up to `now` if the step is not finished. */
export function elapsedMs(start: number | undefined, end: number | undefined, now: number) {
  if (typeof start !== "number") return
  return Math.max(0, (typeof end === "number" ? end : now) - start)
}

/** "12s", "1m 4s", "1h 2m": whole seconds, always rounded down. */
export function formatDuration(ms: number, t: Translate) {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total < 60) return t("ui.duration.seconds", { s: total })
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return t("ui.duration.minutes", { m: minutes, s: total % 60 })
  return t("ui.duration.hours", { h: Math.floor(minutes / 60), m: minutes % 60 })
}

function dayIndex(ts: number) {
  const date = new Date(ts)
  return Math.round(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000)
}

/** "today 13:07", "yesterday 18:22", "28 Oct, 13:07" (with the year if it is not the current one). */
export function formatMessageTime(ts: number, now: number, locale: string) {
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(ts)
  const days = dayIndex(now) - dayIndex(ts)
  if (days === 0 || days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day")
    return `${word} ${clock}`
  }
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ts)
}

/** Full date for the tooltip: "Friday, 30 October 2026 at 13:07:42". */
export function formatFullDate(ts: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "medium" }).format(ts)
}

/**
 * Real start of a model step: the end of the reasoning before it, otherwise the creation of the
 * message. A tool call reaches the client all at once at the end of generation, so `state.time.start`
 * and `state.time.end` are a few milliseconds apart: the time the user waited is the time from here on.
 */
export function stepStart(message: Pick<Message, "time"> | undefined, parts: readonly Part[], partID: string) {
  let since = message?.time.created
  for (const part of parts) {
    if (part.id === partID) break
    if (part.type === "reasoning" && typeof part.time.end === "number") since = Math.max(since ?? 0, part.time.end)
  }
  return since
}
