// mango-code: the sentences the bar, the Home and the status line share about the model and the downloads.
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import type { useLanguage } from "@/context/language"
import type { Reading } from "@/utils/engine-speed"
import {
  contextLabel,
  contextWords,
  etaParts,
  etaSeconds,
  mainDownload,
  whereCards,
  type Download,
  type MangoState,
  type Proposal,
  type Where,
} from "@/utils/mango-state"

type Language = Pick<ReturnType<typeof useLanguage>, "t" | "intl">

/** «2 schede», «1 scheda», «Processore». */
export function cardsText(where: Where, language: Language) {
  if (where.placement === "cpu" || where.gpus.length === 0) return language.t("mango.where.cpu")
  return where.gpus.length === 1
    ? language.t("mango.where.cards.one")
    : language.t("mango.where.cards.other", { count: where.gpus.length })
}

/** The line under a model in the menus: «2 schede · 128k». */
export function whereLine(where: Where | null, language: Language) {
  if (!where) return
  return `${cardsText(where, language)} · ${contextLabel(where.context)}`
}

/** Where a model loads, as a sentence goes on: «sulla RTX 3060 Ti», «sulle schede RTX 3060 Ti + GTX 1080», «sul processore». */
export function onWhere(where: Where, language: Language) {
  const cards = whereCards(where)
  if (!cards || where.gpus.length === 0) return language.t("mango.on.cpu")
  return where.gpus.length === 1
    ? language.t("mango.on.card", { card: cards })
    : language.t("mango.on.cards", { cards })
}

/** The model proposed after a failed start: «Ci sta sulla sola RTX 3060 Ti.» */
export function fitsText(where: Where, language: Language) {
  const cards = whereCards(where)
  if (!cards || where.gpus.length === 0) return language.t("mango.fits.cpu")
  return where.gpus.length === 1
    ? language.t("mango.fits.card", { card: cards })
    : language.t("mango.fits.cards", { cards })
}

/** «meno di un minuto», «circa 12 minuti», «circa 2 h», «circa 2 h e 5 min». */
export function etaText(seconds: number, language: Language) {
  const eta = etaParts(seconds)
  if (eta.kind === "lessThanMinute") return language.t("mango.eta.lessThanMinute")
  if (eta.kind === "minutes")
    return eta.count === 1 ? language.t("mango.eta.minute") : language.t("mango.eta.minutes", { count: eta.count })
  if (eta.kind === "hours") return language.t("mango.eta.hours", { hours: eta.hours })
  return language.t("mango.eta.hoursMinutes", { hours: eta.hours, minutes: eta.minutes })
}

/** «0,5 di 18,2 GB», «24 MB al secondo», «circa 12 minuti»: what has arrived, how fast, how long still, when known. */
export function downloadParts(download: Download, language: Language) {
  const locale = language.intl()
  const eta = etaSeconds(download)
  return {
    amount: language.t("mango.status.amount", {
      done: formatFileSize(download.done, locale),
      total: formatFileSize(download.total, locale),
    }),
    speed:
      download.bytes_per_second > 0
        ? language.t("mango.status.speed", { speed: formatFileSize(download.bytes_per_second, locale) })
        : undefined,
    eta: eta === undefined ? undefined : etaText(eta, language),
  }
}

/** How far a download is, from 0 to 100. */
export const downloadPercent = (download: Pick<Download, "done" | "total">) =>
  download.total > 0 ? Math.min(100, Math.floor((download.done / download.total) * 100)) : 0

/** A download that did not succeed, with its sentence when it has one. */
export function downloadFailedText(download: Download, language: Language) {
  if (download.engine_only)
    return download.error
      ? language.t("mango.engine.failed", { error: download.error })
      : language.t("mango.engine.failed.bare")
  return download.error
    ? language.t("mango.status.downloadFailed", { model: download.label, error: download.error })
    : language.t("mango.status.downloadFailed.bare", { model: download.label })
}

/** What a download does, as the Home and the status line say it: «Scarico Qwen3.6», «Aggiorno il motore». */
export const downloadTitle = (download: Download, language: Language) =>
  download.engine_only
    ? language.t("mango.engine.updating")
    : language.t("mango.status.download", { model: download.label })

/**
 * The models chosen together that wait for this download to end, said under it: «Dopo arriva Qwen3.5-4B.», «Dopo
 * arrivano altri 2 modelli.». Nothing for the engine the app came with, or when none waits.
 */
export function queueText(state: MangoState, current: Download, language: Language) {
  if (current.engine_only) return
  const waiting = state.downloads.filter((d) => d.model !== current.model && d.state === "waiting" && !d.engine_only)
  if (waiting.length === 0) return
  return waiting.length === 1
    ? language.t("mango.home.queue.one", { model: waiting[0].label })
    : language.t("mango.home.queue.other", { count: waiting.length })
}

/** A download in pause: «Lo scaricamento di Qwen3.6 è in pausa», «L'aggiornamento del motore è in pausa». */
export const downloadPausedText = (download: Download, language: Language) =>
  download.engine_only
    ? language.t("mango.engine.paused")
    : language.t("mango.status.downloadPaused", { model: download.label })

/**
 * The engine works on the conversation before it answers: «Preparo la conversazione · 12 s», the same words whether it
 * reads it again or takes it back from the saved memory, in the status line and in the conversation.
 */
export const readingText = (read: Reading, language: Language) =>
  language.t("mango.status.reading", { seconds: Math.max(1, Math.round(read.ms / 1000)) })

export type StatusLine =
  | { kind: "failed"; text: string; proposal: Proposal | null }
  | { kind: "text"; text: string; progress?: number }
  | { kind: "ready"; text: string }
  /** No model on the computer and none coming: the line leads to Models, and the composer does not send. */
  | { kind: "empty"; text: string }

/**
 * The line above the composer, from the most urgent: a start that failed (with the proposed model), a load with its
 * seconds («Scaricato.» if the model has just arrived), the cards lent, the other PC's engine that does not answer, the
 * first model's download or the engine the app came with, no model on the computer (`empty`: with a download that
 * stopped, its sentence), the engine preparing the conversation, a model just ready. Nothing when all is quiet.
 */
export function statusLine(
  input: { state: MangoState; downloaded: ReadonlySet<string>; justReady: boolean; reading?: Reading; empty?: boolean },
  language: Language,
): StatusLine | undefined {
  const model = input.state.model
  if (model.phase === "failed") {
    const reason = model.taken ?? model.reason
    return {
      kind: "failed",
      text: reason
        ? language.t("mango.status.failed", { model: model.label, reason })
        : language.t("mango.status.failed.bare", { model: model.label }),
      proposal: model.proposal,
    }
  }
  if (model.phase === "loading") {
    const where = model.where
    const parts = [
      language.t("mango.status.loading", { model: model.label }),
      where && (whereCards(where) ?? language.t("mango.where.cpu")),
      where && contextLabel(where.context),
      language.t("mango.status.seconds", { seconds: model.seconds }),
    ].filter(Boolean)
    const prefix = input.downloaded.has(model.model) ? `${language.t("mango.status.downloaded")} ` : ""
    return { kind: "text", text: prefix + parts.join(" · ") }
  }
  if (model.phase === "lent") return { kind: "text", text: language.t("mango.status.lent", { model: model.label }) }
  if (model.phase === "remote" && !model.reachable)
    return { kind: "text", text: language.t("mango.status.remoteDown") }
  if (model.phase === "none") {
    const download = mainDownload(input.state)
    const stopped = input.empty ? ("empty" as const) : ("text" as const)
    if (!download) return input.empty ? { kind: "empty", text: language.t("mango.status.empty") } : undefined
    if (download.state === "failed") return { kind: stopped, text: downloadFailedText(download, language) }
    if (download.state === "paused") return { kind: stopped, text: downloadPausedText(download, language) }
    const parts = downloadParts(download, language)
    return {
      kind: "text",
      text: [downloadTitle(download, language), parts.amount, parts.eta]
        .filter(Boolean)
        .join(" · "),
      progress: downloadPercent(download),
    }
  }
  const read = input.reading
  if (read && read.totalTokens > 0) return { kind: "text", text: readingText(read, language) }
  if (model.phase !== "ready" || !input.justReady) return
  const words = contextWords(model.where.context)
  if (model.where.placement === "cpu" || model.where.gpus.length === 0)
    return { kind: "ready", text: language.t("mango.status.ready.cpu", { model: model.label, words }) }
  return {
    kind: "ready",
    text: language.t("mango.status.ready.gpu", { model: model.label, cards: cardsText(model.where, language), words }),
  }
}
