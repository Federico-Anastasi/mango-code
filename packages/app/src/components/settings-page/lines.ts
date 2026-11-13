// mango-code: what the settings write about the models, the downloads and the computer, from the state and the catalog
// read by `context/mango.tsx`.
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { cardsText, downloadParts } from "@/components/mango-text"
import type { useLanguage } from "@/context/language"
import type { MangoFit, MangoModelChoices, MangoVariant } from "@/utils/mango-desktop"
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

/** The temperature a style gives, from the catalog's: «precise» never warmer than the catalog (`choices.rs`). */
export function styleTemperature(style: MangoModelChoices["style"], sampling: Sampling | null) {
  const own = sampling?.temperature
  if (style === "precise") return own === undefined ? 0.3 : Math.min(own, 0.3)
  if (style === "creative") return 1.1
  return own
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
