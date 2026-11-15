// mango-code: what the row of a picture says and how its frame is shaped. The picture is made in the order the
// agent writes in the part's metadata (`stage`), by the user's request in the conversation or by the model by itself:
// one row shows both.
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

/** The longest side of the picture in the conversation, in pixels. */
export const PICTURE_LONG_SIDE = 320

export type PictureStage = "rewriting" | "waiting" | "preparing" | "drawing" | "finishing"

const STAGES: ReadonlySet<string> = new Set<PictureStage>(["rewriting", "waiting", "preparing", "drawing", "finishing"])

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** The stage the part says it is at; without it (the turn has just begun) none. */
export function pictureStage(metadata: Record<string, unknown>): PictureStage | undefined {
  return typeof metadata.stage === "string" && STAGES.has(metadata.stage) ? (metadata.stage as PictureStage) : undefined
}

/** What it is doing, in words: the key of the text and its parameters. */
export function pictureWords(metadata: Record<string, unknown>): { key: UiI18nKey; params?: UiI18nParams } {
  const stage = pictureStage(metadata)
  if (stage === "drawing") {
    const step = count(metadata.step)
    const steps = count(metadata.steps)
    if (step && steps) return { key: "ui.picture.stage.drawing", params: { step, steps } }
    return { key: "ui.picture.stage.preparing" }
  }
  return { key: `ui.picture.stage.${stage ?? "starting"}` as UiI18nKey }
}

/** How far the drawing is, from 0 to 100; none before the first step. */
export function pictureProgress(metadata: Record<string, unknown>) {
  if (pictureStage(metadata) === "finishing") return 100
  if (pictureStage(metadata) !== "drawing") return undefined
  const step = typeof metadata.step === "number" ? metadata.step : undefined
  const steps = count(metadata.steps)
  if (step === undefined || !steps) return undefined
  return Math.min(100, Math.max(0, (step / steps) * 100))
}

/** The final proportions of the picture, as the part tells them; a square when it does not. */
export function pictureSides(metadata: Record<string, unknown>) {
  return { width: count(metadata.width) ?? 1, height: count(metadata.height) ?? 1 }
}

/** The width of the frame in the conversation: the picture's long side is `PICTURE_LONG_SIDE`, its proportions the real ones. */
export function pictureFrameWidth(sides: { width: number; height: number }) {
  return Math.round(PICTURE_LONG_SIDE * Math.min(1, sides.width / sides.height))
}

/** The seconds the picture took, from the part's own times; none while it goes on or when they are not there. */
export function pictureSeconds(time: { start?: number; end?: number } | undefined) {
  if (time?.start === undefined || time.end === undefined) return undefined
  return Math.max(0, Math.round((time.end - time.start) / 1000))
}

/** The file name of the picture, without its folder. */
export function pictureFileName(metadata: Record<string, unknown>) {
  return typeof metadata.file === "string" ? metadata.file.split(/[\\/]/).filter(Boolean).at(-1) : undefined
}

/** The description the part keeps (in English, as the image model reads it), if the turn has got that far. */
export function pictureDescription(input: Record<string, unknown>) {
  return typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : undefined
}

export const PICTURE_FORMATS = ["square", "portrait", "landscape"] as const
export const PICTURE_SIZES = ["small", "large"] as const
export type PictureFormat = (typeof PICTURE_FORMATS)[number]
export type PictureSize = (typeof PICTURE_SIZES)[number]

/**
 * The same picture again, with a description: nothing rewrites it. The model is the one that drew it, so a new seed is
 * the only difference. Without the user's words (a picture the model made by itself), or without the format and the
 * size it was asked in, it cannot be asked again.
 */
export function pictureAgain(
  record: { input: Record<string, unknown>; metadata: Record<string, unknown> },
  prompt: string,
) {
  const { input, metadata } = record
  const text = prompt.trim()
  const model =
    typeof metadata.model === "string" ? metadata.model : typeof input.model === "string" ? input.model : undefined
  const format = PICTURE_FORMATS.find((item) => item === input.format)
  const size = PICTURE_SIZES.find((item) => item === input.size)
  if (!text || typeof input.request !== "string" || !input.request.trim() || !model || !format || !size) return
  return { request: input.request, format, size, model, prompt: text }
}
