// mango-code: the model, the downloads and the catalog as the agent's `/mango/state`, `/mango/models` and
// `/mango/computer` tell them, read without trusting the shape: what is not right is left out,
// so a screen shows less and never breaks, and the log says how many models were left out. Only pure functions here: the
// polling is in `context/mango.tsx`.
import type { MangoModelChoices } from "@/utils/mango-desktop"

export type Where = { placement: "gpu" | "cpu"; gpus: string[]; context: number }
export type Proposal = { model: string; label: string; where: Where }

export type ModelState =
  | { phase: "none" }
  | { phase: "loading"; model: string; label: string; seconds: number; where: Where | null }
  | { phase: "ready"; model: string; label: string; where: Where }
  | { phase: "failed"; model: string; label: string; reason: string; taken: string | null; proposal: Proposal | null }
  | { phase: "lent"; model: string; label: string }
  | { phase: "remote"; models: string[]; reachable: boolean }

export type Download = {
  model: string
  label: string
  state: "active" | "waiting" | "paused" | "failed"
  done: number
  total: number
  bytes_per_second: number
  error: string | null
  /** The model's files are on the disk: it brings only the engine the app came with. */
  engine_only: boolean
}

export type MangoState = {
  revision: number
  catalog_revision: number
  model: ModelState
  default_model: string | null
  downloads: Download[]
}

export type Verdict = {
  fits: boolean
  where: Where | null
  reason: string
  speed: "very_slow" | "slow" | "fair" | "quick" | null
  fastest: boolean
  /** A model of the user that the count does not know: its memory is estimated, the verdict may be wrong. */
  estimated: boolean
}

export type Sampling = Partial<
  Record<"temperature" | "top_p" | "top_k" | "min_p" | "presence_penalty" | "repeat_penalty", number>
>

export type CatalogEntry = {
  key: string
  label: string
  about: string
  images: boolean
  /** Added by the user («Another model»). */
  user: boolean
  /** Its files that the user chose on the computer, where they are: «Togli» takes it off the list and leaves them. */
  ownFiles: string[]
  present: boolean
  /** On the computer, waiting for the new version of its engine, which the update brings: it stays in its row. */
  waitsEngine: boolean
  bytes: number
  verdict: Verdict
  recommended: boolean
  choices: MangoModelChoices
  /** The choices possible here: places, contexts offered with the current choice, whether it can reason. */
  limits: { where: MangoModelChoices["where"][]; context: number[]; reasoning: boolean }
  sampling: Sampling | null
}

export type Computer = {
  gpus: { name: string; memory_mib: number; used: boolean; note: string }[]
  small_models: "one" | "all"
  cpu: string
  cores: number
  ram_mib: number
  disk: { path: string; used_bytes: number; free_bytes: number }
  /** `update`: the app came with a new version of the engine, and models on the disk wait for it. */
  engine: { label: string; installed: boolean; update: boolean }
  tailored: { models: number } | null
}

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

export function parseWhere(value: unknown): Where | null {
  const raw = record(value)
  const context = count(raw?.context)
  if (!raw || (raw.placement !== "gpu" && raw.placement !== "cpu") || context === undefined) return null
  return { placement: raw.placement, gpus: strings(raw.gpus), context }
}

export function parseModelState(value: unknown): ModelState {
  const raw = record(value)
  const model = text(raw?.model)
  const label = text(raw?.label) ?? model
  switch (raw?.phase) {
    case "loading":
      if (!model || !label) break
      return { phase: "loading", model, label, seconds: count(raw.seconds) ?? 0, where: parseWhere(raw.where) }
    case "ready": {
      const where = parseWhere(raw.where)
      if (!model || !label || !where) break
      return { phase: "ready", model, label, where }
    }
    case "failed": {
      if (!model || !label) break
      const proposal = record(raw.proposal)
      const proposed = text(proposal?.model)
      const where = parseWhere(proposal?.where)
      return {
        phase: "failed",
        model,
        label,
        reason: text(raw.reason) ?? "",
        taken: text(raw.taken) || null,
        proposal: proposed && where ? { model: proposed, label: text(proposal?.label) ?? proposed, where } : null,
      }
    }
    case "lent":
      if (!model || !label) break
      return { phase: "lent", model, label }
    case "remote":
      // An app older than `reachable` does not say it: the other PC is taken as answering.
      return {
        phase: "remote",
        models: strings(raw.models),
        reachable: raw.reachable !== false,
      }
  }
  return { phase: "none" }
}

const DOWNLOAD_STATES = new Set(["active", "waiting", "paused", "failed"])

export function parseState(value: unknown): MangoState | undefined {
  const raw = record(value)
  const revision = count(raw?.revision)
  if (!raw || revision === undefined) return
  const downloads = (Array.isArray(raw.downloads) ? raw.downloads : []).flatMap((item): Download[] => {
    const d = record(item)
    const model = text(d?.model)
    if (!d || !model || !DOWNLOAD_STATES.has(d.state as string)) return []
    return [
      {
        model,
        label: text(d.label) ?? model,
        state: d.state as Download["state"],
        done: count(d.done) ?? 0,
        total: count(d.total) ?? 0,
        bytes_per_second: count(d.bytes_per_second) ?? 0,
        error: text(d.error) ?? null,
        engine_only: d.engine_only === true,
      },
    ]
  })
  return {
    revision,
    catalog_revision: count(raw.catalog_revision) ?? 0,
    model: parseModelState(raw.model),
    default_model: text(raw.default_model) ?? null,
    downloads,
  }
}

const SPEEDS = new Set(["very_slow", "slow", "fair", "quick"])
const WHERE_CHOICES = new Set(["auto", "one", "all", "cpu", "pick"])
const STYLES = new Set(["recommended", "precise", "creative"])
const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repeat_penalty"] as const

/**
 * The models that read: one without its verdict, its choices or its limits is left out (the settings could not show it
 * whole), and the log (the app's `ui.log`) says how many. `undefined` when the answer is not a list of models, or none of
 * its models reads: the interface then says it cannot read them, not that there are none.
 */
export function parseCatalog(value: unknown): CatalogEntry[] | undefined {
  const items = record(value)?.models
  if (!Array.isArray(items)) return
  const read = items.flatMap((item): CatalogEntry[] => {
    const m = record(item)
    const key = text(m?.key)
    const verdict = record(m?.verdict)
    const choices = parseChoices(m?.choices)
    const limits = parseLimits(m?.limits)
    if (!m || !key || typeof m.present !== "boolean" || !verdict || !choices || !limits) return []
    return [
      {
        key,
        label: text(m.label) ?? key,
        about: text(m.about) ?? "",
        images: m.images === true,
        user: m.user === true,
        ownFiles: strings(m.own_files),
        present: m.present,
        waitsEngine: m.waits_engine === true,
        bytes: count(m.bytes) ?? 0,
        recommended: m.recommended === true,
        verdict: {
          fits: verdict.fits === true,
          where: parseWhere(verdict.where),
          reason: text(verdict.reason) ?? "",
          speed: SPEEDS.has(verdict.speed as string) ? (verdict.speed as Verdict["speed"]) : null,
          fastest: verdict.fastest === true,
          estimated: verdict.estimated === true,
        },
        choices,
        limits,
        sampling: parseSampling(m.sampling),
      },
    ]
  })
  if (read.length < items.length)
    console.error(`/mango/models: ${items.length - read.length} of the models could not be read and were left out`)
  if (items.length > 0 && read.length === 0) return
  return read
}

function parseChoices(value: unknown): MangoModelChoices | undefined {
  const raw = record(value)
  if (!raw || !WHERE_CHOICES.has(raw.where as string) || !STYLES.has(raw.style as string)) return
  if (raw.context !== null && count(raw.context) === undefined) return
  if (raw.reasoning !== null && typeof raw.reasoning !== "boolean") return
  return {
    where: raw.where as MangoModelChoices["where"],
    gpus: strings(raw.gpus),
    context: raw.context as number | null,
    style: raw.style as MangoModelChoices["style"],
    reasoning: raw.reasoning as boolean | null,
  }
}

function parseLimits(value: unknown): CatalogEntry["limits"] | undefined {
  const raw = record(value)
  if (!raw || !Array.isArray(raw.where) || !Array.isArray(raw.context)) return
  if (!raw.where.every((w) => WHERE_CHOICES.has(w)) || !raw.context.every((c) => count(c) !== undefined)) return
  return {
    where: raw.where as MangoModelChoices["where"][],
    context: raw.context as number[],
    reasoning: raw.reasoning === true,
  }
}

function parseSampling(value: unknown): Sampling | null {
  const raw = record(value)
  if (!raw) return null
  return Object.fromEntries(SAMPLING_KEYS.flatMap((key) => (typeof raw[key] === "number" ? [[key, raw[key]]] : [])))
}

/** The computer, or `undefined` when what Computer and the Home show of it is missing: processor, memory, disk, engine. */
export function parseComputer(value: unknown): Computer | undefined {
  const raw = record(value)
  const disk = record(raw?.disk)
  const engine = record(raw?.engine)
  const cpu = text(raw?.cpu)
  const cores = count(raw?.cores)
  const ram = count(raw?.ram_mib)
  if (!raw || !disk || !engine || cpu === undefined || cores === undefined || ram === undefined) return
  const tailored = count(record(raw.tailored)?.models)
  return {
    gpus: (Array.isArray(raw.gpus) ? raw.gpus : []).flatMap((item) => {
      const g = record(item)
      const name = text(g?.name)
      return g && name
        ? [{ name, memory_mib: count(g.memory_mib) ?? 0, used: g.used !== false, note: text(g.note) ?? "" }]
        : []
    }),
    small_models: raw.small_models === "all" ? "all" : "one",
    cpu,
    cores,
    ram_mib: ram,
    disk: {
      path: text(disk.path) ?? "",
      used_bytes: count(disk.used_bytes) ?? 0,
      free_bytes: count(disk.free_bytes) ?? 0,
    },
    engine: { label: text(engine.label) ?? "", installed: engine.installed === true, update: engine.update === true },
    tailored: tailored === undefined ? null : { models: tailored },
  }
}

/**
 * Something is changing (a load, a download that moves): the state is read every second, otherwise every five. A hidden
 * window, or an app that does not answer, is asked every fifteen.
 */
export function pollDelay(state: MangoState | undefined, input: { hidden: boolean; failures: number }) {
  if (input.hidden || input.failures > 0) return 15_000
  if (!state) return 5000
  if (state.model.phase === "loading") return 1000
  // a download waiting its turn starts within a second: read at five, its progress and the load after it go unseen
  return downloading(state) ? 1000 : 5000
}

/** Answers do not overtake each other: one older than the state shown (a slow read after a choice) is left out. */
export const newer = (shown: MangoState | undefined, next: MangoState) => !shown || next.revision >= shown.revision

/**
 * The model has just become ready, from the state shown before: no model was ready then, or another one. Not only
 * after a load seen: a load can end between two reads (a small model, or a read slowed by the catalog that a model
 * just arrived changes), and a download would go straight to ready. The first read, with nothing shown, is not a change.
 */
export function becameReady(shown: MangoState | undefined, next: MangoState) {
  if (!shown || next.model.phase !== "ready") return false
  return shown.model.phase !== "ready" || shown.model.model !== next.model.model
}

/** A download that will bring a model: one that runs or waits its turn. */
export const downloading = (state: MangoState) =>
  state.downloads.some((d) => d.state === "active" || d.state === "waiting")

/**
 * A message sent now waits in the interface instead of going to the engine: the model is loading, the cards are
 * lent, a download will bring the first model, the start failed (it leaves when another model is chosen or a retry
 * works), or the other PC's engine does not answer. With a model ready, or nothing on the way, it goes as usual.
 */
export function messageWaits(state: MangoState | undefined) {
  if (!state) return false
  const model = state.model
  if (model.phase === "loading" || model.phase === "lent" || model.phase === "failed") return true
  if (model.phase === "remote") return !model.reachable
  return model.phase === "none" && downloading(state)
}

/**
 * No model on the computer and none on its way: a message would have no model to leave with nor one to wait for, so
 * the composer does not send until one is chosen in Models. Before the catalog has answered nothing is known.
 */
export function noModel(state: MangoState | undefined, catalog: CatalogEntry[] | undefined) {
  if (!state || !catalog || state.model.phase !== "none" || downloading(state)) return false
  return !catalog.some((m) => m.present)
}

/** The waiting messages can leave: a model is ready here, or the other PC's engine answers. */
export function canSend(state: MangoState | undefined) {
  const model = state?.model
  return model?.phase === "ready" || (model?.phase === "remote" && model.reachable)
}

/**
 * The interface's first start: no model on the computer (nor the engine of another PC). Models whose files are there,
 * waiting for the engine the app came with, are not a first start.
 */
export function firstRun(state: MangoState | undefined, catalog: CatalogEntry[] | undefined) {
  if (!state || !catalog || state.model.phase !== "none" || engineUpdate(state)) return false
  return catalog.length > 0 && !catalog.some((m) => m.present)
}

/** The download that brings the engine the app came with to the models on the disk. */
export const engineUpdate = (state: MangoState) => state.downloads.find((d) => d.engine_only)

/** The model to propose at the first start: the catalog's, or the first that fits. */
export function recommended(catalog: CatalogEntry[]) {
  return catalog.find((m) => m.recommended) ?? catalog.find((m) => m.verdict.fits)
}

/** How long a download still takes, in seconds; undefined while its speed is not known. */
export function etaSeconds(download: Pick<Download, "done" | "total" | "bytes_per_second">) {
  if (download.bytes_per_second <= 0 || download.total <= download.done) return
  return Math.ceil((download.total - download.done) / download.bytes_per_second)
}

/** Context tokens as the user reads them: «128k». */
export const contextLabel = (tokens: number) => `${Math.round(tokens / 1024)}k`

/** The disk of the models' folder as the user names it: its drive («C:»), or the folder where it has none. */
export const diskDrive = (path: string) => /^[a-z]:/i.exec(path)?.[0].toUpperCase() ?? path

/** About how many words a context holds (0.65 words a token), in thousands: «85». */
export const contextWords = (tokens: number) => Math.round((tokens * 0.65) / 1000)

/** Where a model runs, as a line says it: the cards by name, or the processor. */
export const whereCards = (where: Where) => (where.placement === "cpu" ? undefined : where.gpus.join(" + "))

/**
 * A project whose folder is gone is told with the folder that held it, the two parts of its path before the last:
 * `C:\Users\Ada\Desktop\Progetti\sito\sito` is in «Progetti\sito».
 */
export const missingParent = (worktree: string) =>
  worktree
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-3, -1)
    .join("\\")

/** A wait as a person says it: under a minute, minutes rounded up, whole hours, or hours and minutes. */
export function etaParts(seconds: number) {
  if (seconds < 60) return { kind: "lessThanMinute" as const }
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return { kind: "minutes" as const, count: minutes }
  if (minutes % 60 === 0) return { kind: "hours" as const, hours: minutes / 60 }
  return { kind: "hoursMinutes" as const, hours: Math.floor(minutes / 60), minutes: minutes % 60 }
}

/** The download the line speaks of: the one running, otherwise the first that needs the user (paused or failed). */
export function mainDownload(state: MangoState) {
  return (
    state.downloads.find((d) => d.state === "active") ??
    state.downloads.find((d) => d.state === "failed") ??
    state.downloads.find((d) => d.state === "paused") ??
    state.downloads.find((d) => d.state === "waiting")
  )
}

/**
 * A model of the app is offered in the menus when it is on the disk; with the other PC's engine, each of the agent's.
 * Before the catalog has answered none is: a model that is not on the disk must not be offered.
 */
export function offered(state: MangoState | undefined, catalog: CatalogEntry[] | undefined, key: string) {
  if (state?.model.phase === "remote") return true
  return catalog !== undefined && catalog.find((m) => m.key === key)?.present !== false
}

/**
 * The model the engine is on or going to: its key, to keep the conversation's model the same. With no model in use, the
 * one being downloaded: the app loads it as soon as it arrives.
 */
export function engineModel(state: MangoState | undefined) {
  const model = state?.model
  if (model?.phase === "loading" || model?.phase === "ready") return model.model
  const download = state && comingDownload(state)
  if (download && !download.engine_only) return download.model
}

/** With no model in use, the download on its way (running or waiting its turn): the one the bar names. */
export function comingDownload(state: MangoState) {
  const download = mainDownload(state)
  if (state.model.phase === "none" && (download?.state === "active" || download?.state === "waiting")) return download
}

/**
 * What the Home shows on the right: the other PC's engine that does not answer, the engine the app came with arriving
 * while no model is in use, the models that cannot be read (`unreadable`: never taken for none), the first model's
 * download, the welcome with the model to choose (nothing on the computer yet), or the Home as usual.
 */
export function homeView(state: MangoState | undefined, catalog: CatalogEntry[] | undefined, unreadable = false) {
  if (!state) return "usual" as const
  if (state.model.phase === "remote") return state.model.reachable ? ("usual" as const) : ("remote" as const)
  if (state.model.phase === "none" && engineUpdate(state)) return "engine" as const
  if (state.model.phase === "none" && !catalog && unreadable) return "unreadable" as const
  if (!firstRun(state, catalog)) return "usual" as const
  return mainDownload(state) ? ("downloading" as const) : ("welcome" as const)
}

/** What the chosen models weigh together. */
export const chosenBytes = (catalog: CatalogEntry[], keys: readonly string[]) =>
  catalog.filter((m) => keys.includes(m.key)).reduce((total, m) => total + m.bytes, 0)
