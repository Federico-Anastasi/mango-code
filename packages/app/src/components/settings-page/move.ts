// mango-code: what Settings says about moving the models: the question asked before a move, how far a move is, and which
// row a move belongs to. The components only draw it.
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import type { useLanguage } from "@/context/language"
import type { MangoModelsDirMove, MangoMovePreview, MangoPlacePreview } from "@/utils/mango-desktop"
import { diskDrive } from "@/utils/mango-state"

type Language = Pick<ReturnType<typeof useLanguage>, "t" | "plural" | "intl">

/** What a copy keeps free on the disk beyond the files, as the app asks for it. */
const MARGIN = 1024 ** 3

/** The question before a move: the title, the paragraphs, and what the card offers (nothing when the folder cannot be used). */
export type MoveAsk = {
  title: string
  paragraphs: string[]
  /** The paths in the title and the paragraphs: drawn in the code font. */
  paths: string[]
  action?: "move" | "use"
}

/**
 * What the disk of the destination says, after the size: the free space, whether the files are renamed or copied, what stops.
 * Not enough room says only that.
 */
function diskLines(
  where: { bytes: number; free: number; to: string; sameDisk: boolean; fits: boolean },
  kind: "folder" | "model",
  language: Language,
) {
  const t = language.t
  const drive = diskDrive(where.to)
  const free = formatFileSize(where.free, language.intl())
  if (!where.fits)
    return [t("settings.move.noSpace", { drive, free, needed: formatFileSize(where.bytes + MARGIN, language.intl()) })]
  const stops = t(kind === "folder" ? "settings.move.stops" : "settings.move.stops.model")
  if (where.sameDisk) return [t("settings.move.sameDisk"), stops]
  const other = t(kind === "folder" ? "settings.move.otherDisk" : "settings.move.otherDisk.model")
  return [t("settings.move.free", { drive, free }), other, stops]
}

/**
 * What moving the models folder to `preview.to` would do. `models` is how many models are in the folder, when known: the
 * preview counts files.
 */
export function folderAsk(preview: MangoMovePreview, models: number | undefined, language: Language): MoveAsk {
  const t = language.t
  const folder = preview.to
  if (preview.refusal)
    return { title: t("settings.move.cannot.title", { folder }), paragraphs: [preview.refusal], paths: [folder] }
  if (preview.destination === "has_files")
    return {
      title: t("settings.move.hasFiles.title", { folder }),
      paragraphs: [t("settings.move.hasFiles.body", { old: preview.from }), ...(preview.warning ? [preview.warning] : [])],
      paths: [folder, preview.from],
      action: "use",
    }
  const size = formatFileSize(preview.bytes, language.intl())
  const head = !preview.files
    ? t("settings.move.nothing")
    : models
      ? language.plural("settings.move.models", models, { size })
      : t("settings.move.size", { size })
  const fits = !preview.move_refusal
  const disk = { bytes: preview.bytes, free: preview.free_bytes, to: folder, sameDisk: preview.same_volume, fits }
  return {
    title: t("settings.move.folder.title", { folder }),
    paragraphs: [
      [head, ...(preview.files ? diskLines(disk, "folder", language) : [t("settings.move.stops")])].join(" "),
      ...(preview.warning ? [preview.warning] : []),
      ...(preview.model_links.length ? [t("settings.move.links", { links: preview.model_links.join(", ") })] : []),
      ...(preview.staying ? [preview.staying] : []),
    ],
    paths: [folder, ...preview.model_links],
    action: fits ? "move" : undefined,
  }
}

/** What putting one model's files in `folder` (`back`: in the models folder again) would do. */
export function modelAsk(
  preview: MangoPlacePreview,
  target: { name: string; folder: string; back: boolean },
  language: Language,
): MoveAsk {
  const t = language.t
  const { name, folder } = target
  if (preview.refusal)
    return { title: t("settings.move.cannot.title", { folder }), paragraphs: [preview.refusal], paths: [folder] }
  const size = formatFileSize(preview.bytes, language.intl())
  const fits = !preview.move_refusal
  return {
    title: t(target.back ? "settings.move.back.title" : "settings.move.model.title", { name, folder }),
    paragraphs: [
      [
        t("settings.move.size", { size }),
        ...diskLines(
          { bytes: preview.bytes, free: preview.free_bytes, to: folder, sameDisk: preview.same_volume, fits },
          "model",
          language,
        ),
      ].join(" "),
      ...(preview.warning ? [preview.warning] : []),
    ],
    paths: [folder],
    action: fits ? "move" : undefined,
  }
}

/** A sentence cut into the parts that are one of `paths` and those that are not, in order. */
export function pathParts(text: string, paths: string[]) {
  const found = paths.filter((path) => path && text.includes(path)).toSorted((a, b) => b.length - a.length)
  if (!found.length) return [{ text, path: false }]
  const pattern = new RegExp(`(${found.map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`)
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, path: found.includes(part) }))
}

export type Moving = Extract<MangoModelsDirMove, { status: "moving" }>

/**
 * How far a move is: the bar from 0 to 100, the line under it, and whether it can still be cancelled (not once the old
 * files are being removed: the choice is written).
 */
export function moveProgress(move: Moving, language: Language) {
  const t = language.t
  const progress = move.progress
  if (!progress) return { value: 0, line: t("settings.move.preparing"), cancellable: true }
  const locale = language.intl()
  const name = progress.current?.split(/[\\/]/).at(-1) ?? ""
  const amount = t("mango.status.amount", {
    done: formatFileSize(progress.done_bytes, locale),
    total: formatFileSize(progress.total_bytes, locale),
  })
  const share = (done: number, total: number) => (total > 0 ? Math.min(100, (done / total) * 100) : 0)
  switch (progress.stage) {
    case "moving":
      return {
        value: share(progress.done_files, progress.total_files),
        line: t("settings.move.files", { done: progress.done_files, total: progress.total_files }),
        cancellable: true,
      }
    case "copying":
      return {
        value: share(progress.done_bytes, progress.total_bytes),
        line: [amount, name].filter(Boolean).join(" · "),
        cancellable: true,
      }
    case "verifying":
      return {
        value: share(progress.done_bytes, progress.total_bytes),
        line: [amount, t("settings.move.verifying", { name })].join(" · "),
        cancellable: true,
      }
    case "saving":
      return { value: 100, line: t("settings.move.saving"), cancellable: true }
    case "removing":
      return { value: 100, line: t("settings.move.removing"), cancellable: false }
  }
}

/**
 * The move that concerns a row (`"folder"` or a model's key): one under way is told by what it moves; the end of the last
 * one (`done`, `failed`, `cancelled`) by what the user started in this page, which is `target`. A move that waits for the
 * app to start again (`moved`, `restarting`) is the folder's.
 */
export function moveOf(move: MangoModelsDirMove, target: string | undefined, row: string) {
  if (move.status === "idle") return
  if (move.status === "moving") return (move.model ?? "folder") === row ? move : undefined
  if (move.status === "moved" || move.status === "restarting") return row === "folder" ? move : undefined
  return target === row ? move : undefined
}
