// mango-code: what the settings write about the models, the downloads and the computer, from the state and the catalog
// read by `context/mango.tsx`.
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { cardsText, downloadParts } from "@/components/mango-text"
import type { useLanguage } from "@/context/language"
import type { MangoFit, MangoVariant } from "@/utils/mango-desktop"
import {
  contextLabel,
  diskDrive,
  type Computer,
  type Download,
  type MangoState,
  type Sampling,
} from "@/utils/mango-state"

type Language = Pick<ReturnType<typeof useLanguage>, "t" | "intl">

/**
 * A download in a line: «8,3 di 13,6 GB · circa 4 minuti. Intanto si continua a lavorare.», or what keeps it still;
 * one that brings only the engine the app came with says so first.
 */
export function downloadLine(download: Download, language: Language) {
  const t = language.t
  const parts = downloadParts(download, language)
  if (download.state === "failed") return download.error ?? t("settings.models.download.failed")
  const amount = download.engine_only ? `${t("mango.engine.updating")} · ${parts.amount}` : parts.amount
  if (download.state === "waiting") return `${amount} · ${t("settings.models.download.waiting")}`
  if (download.state === "paused") return `${amount} · ${t("settings.models.download.paused")}`
  const meanwhile = t("settings.models.download.meanwhile")
  return parts.eta ? `${amount} · ${parts.eta}. ${meanwhile}` : `${amount}. ${meanwhile}`
}

/**
 * The downloads as «In arrivo» lists them: one row «Aggiorno il motore», the first download that brings only an engine,
 * however many engines the app came with.
 */
export const arrivingRows = (downloads: Download[]) =>
  downloads.filter((download) => !download.engine_only || download === downloads.find((d) => d.engine_only))

/** «Spazio usato dai modelli: 41 GB su C:»: the drive of the models' folder, or the folder where it has none. */
export function diskLabel(disk: Computer["disk"], t: Language["t"], locale?: string) {
  return t("settings.models.disk", {
    used: formatFileSize(disk.used_bytes, locale),
    drive: diskDrive(disk.path),
  })
}

/**
 * What «Togli» says of a model, on its button and in the window that asks: the space it frees, or, for a model from files
 * the user chose (which stay), that it leaves the list and which files stay where they are, by name: one or two by
 * name, a model in many pieces by its first and how many others.
 */
export function removeLines(model: { label: string; size: string; ownFiles: string[] }, t: Language["t"]) {
  if (!model.ownFiles.length)
    return {
      action: t("settings.models.remove.action", { size: model.size }),
      title: t("settings.models.remove.title", { name: model.label }),
      body: t("settings.models.remove.body", { size: model.size }),
    }
  const names = model.ownFiles.map((file) => file.split(/[\\/]/).at(-1) ?? file)
  return {
    action: t("settings.models.forget"),
    title: t("settings.models.remove.listTitle", { name: model.label }),
    body:
      names.length > 2
        ? t("settings.models.remove.ownFilesMany", { file: names[0], count: names.length - 1 })
        : t(names.length === 1 ? "settings.models.remove.ownFile" : "settings.models.remove.ownFiles", {
            files: names.join(", "),
          }),
  }
}

const CONTEXT_STEP = 4096

/** A context typed as tokens («100000», «100.000») or as K of 1024 tokens («96k»); undefined for anything else. */
export function parseContext(text: string) {
  const match = /^\s*(?:(\d+)\s*k|(\d[\d.,\s]*))\s*$/i.exec(text)
  if (!match) return
  return match[1] ? Number(match[1]) * 1024 : Number(match[2].replace(/[.,\s]/g, ""))
}

/** The plus and the minus of a personal context: to the next multiple of 4096 tokens, within the limits. */
export function stepContext(tokens: number, direction: 1 | -1, min: number, max: number) {
  const next =
    direction > 0
      ? (Math.floor(tokens / CONTEXT_STEP) + 1) * CONTEXT_STEP
      : (Math.ceil(tokens / CONTEXT_STEP) - 1) * CONTEXT_STEP
  return Math.min(max, Math.max(min, next))
}

/** Which limit a context is outside of, if any. */
export function contextIssue(tokens: number, min: number, max: number) {
  if (tokens < min) return "min"
  if (tokens > max) return "max"
}

/** The interval of each sampling value, as the app checks it (`choices.rs`): the label of its sentence, and its limits. */
export const SAMPLING_RANGES = {
  temperature: { range: "settings.models.sampling.range.zeroTo2", min: 0, max: 2 },
  top_p: { range: "settings.models.sampling.range.zeroTo1", min: 0, max: 1 },
  top_k: { range: "settings.models.sampling.range.whole", min: 0, max: 4_294_967_295, whole: true },
  min_p: { range: "settings.models.sampling.range.zeroTo1", min: 0, max: 1 },
  presence_penalty: { range: "settings.models.sampling.range.minus2To2", min: -2, max: 2 },
  repeat_penalty: { range: "settings.models.sampling.range.above0", min: 0, max: Infinity, above: true },
} as const satisfies Record<keyof Sampling, unknown>

/** A sampling value typed with a point or a comma; undefined if it is not a number (or not a whole one for top_k). */
export function parseSamplingValue(name: keyof Sampling, text: string) {
  const range = SAMPLING_RANGES[name]
  const pattern = "whole" in range ? /^\s*\d+\s*$/ : /^\s*-?\d+([.,]\d+)?\s*$/
  if (!pattern.test(text)) return
  return Number(text.replace(",", "."))
}

/** A sampling value as its box shows it: the decimal mark of the language, every digit, no grouping. */
export function samplingText(value: number, locale: string) {
  return value.toLocaleString(locale, { useGrouping: false, maximumFractionDigits: 20 })
}

/** A sampling value outside its interval. */
export function samplingIssue(name: keyof Sampling, value: number) {
  const range = SAMPLING_RANGES[name]
  if ("above" in range) return value <= range.min
  return value < range.min || value > range.max
}

/**
 * The versions of a repo told in thirds of weight, from the lightest: small, medium, large. `undefined` for a single
 * version (a file of the computer): it keeps its name.
 */
export function sizeTiers(bytes: number[]) {
  if (bytes.length < 2) return undefined
  const tiers: ("small" | "medium" | "large")[] = []
  bytes
    .map((value, index) => [value, index] as const)
    .toSorted((a, b) => a[0] - b[0])
    .forEach(([, index], rank) => {
      tiers[index] = (["small", "medium", "large"] as const)[Math.min(2, Math.floor((rank * 3) / bytes.length))]
    })
  return tiers
}

const SPEED_LABELS = {
  very_slow: "settings.models.other.speed.very_slow",
  slow: "settings.models.other.speed.slow",
  fair: "settings.models.other.speed.fair",
  quick: "settings.models.other.speed.quick",
} as const

/** A quantization of «Un altro modello» as chosen: with the image encoder, if asked and the repo has one. */
export const variantFit = (variant: MangoVariant, images: boolean): MangoFit =>
  images && variant.with_images ? variant.with_images : variant

/**
 * A quantization in a line, with or without images as chosen: its name (when the sizes have the title), weight, where it
 * runs and the context it would run with, as the catalog's rows say it: «Q4_K_M · 2,5 GB · 2 schede · 32k».
 */
export function variantLine(
  variant: MangoVariant,
  images: boolean,
  named: boolean,
  language: Language,
  locale?: string,
) {
  const fit = variantFit(variant, images)
  return [
    named && variant.name,
    formatFileSize(fit.bytes, locale),
    fitWhere(fit, language),
    fit.placement && fit.context && contextLabel(fit.context),
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Where a quantization would run: «1 scheda», «2 schede», «Sul processore · lento», «Non ci sta». */
function fitWhere(fit: MangoFit, language: Language) {
  const t = language.t
  if (!fit.placement) return t("settings.models.other.noFit")
  if (fit.placement === "gpu")
    return cardsText({ placement: "gpu", gpus: fit.gpus, context: fit.context ?? 0 }, language)
  return [t("settings.models.other.onCpu"), fit.speed && t(SPEED_LABELS[fit.speed])].filter(Boolean).join(" · ")
}

/** The engine of another PC this one uses, from the state, with its models. */
export function remoteEngine(state: MangoState | undefined) {
  const model = state?.model
  if (model?.phase !== "remote") return undefined
  return { models: model.models }
}
