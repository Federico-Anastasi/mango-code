import { createSignal } from "solid-js"
import { previewKind } from "@opencode-ai/session-ui/project-file"
import type { Platform } from "@/context/platform"
import type { UpdaterPlatform, UpdaterState } from "@/updater"

/** The user's choices for one model. */
export type MangoModelChoices = {
  where: "auto" | "one" | "all" | "cpu" | "pick"
  /** The cards by name, only with `where: "pick"`. */
  gpus: string[]
  /** `null`: the largest that fits. */
  context: number | null
  style: "recommended" | "precise" | "creative"
  /** `null`: as the model wants. */
  reasoning: boolean | null
}

/** Bridge to the Mango Code desktop app: the app (Tauri) defines it in every page, a normal browser does not. */
export type MangoDesktop = {
  pickDirectories(opts?: { title?: string; multiple?: boolean }): Promise<string[] | null>
  /** Where "New project" creates projects when no other folder is chosen. */
  projectsFolder(): Promise<string>
  /** Creates `<parent>\<name>` (without `parent`, in the default folder) and returns its path. */
  createProject(name: string, parent?: string): Promise<string>
  readClipboardImage(): Promise<ArrayBuffer | null>
  openExternal(url: string): Promise<void>
  /** The last section of the settings the tray asked and not read yet; reading it empties it. */
  pendingSettings(): Promise<{ section: string } | null>
  /**
   * The size of the window's page: the browser's zoom (1 = 100%), the same as Ctrl+ and Ctrl-. `set` gives the zoom set,
   * within 25% and 500%; every change, from here or from the keys, arrives as "mango-zoom" on window with the zoom.
   */
  zoom?: { get(): Promise<number>; set(zoom: number): Promise<number> }
  /**
   * "Report a problem": logs, PC details, (if asked) the window and the files the user chose go to Mango Code, the
   * first three anonymized and the files as they are: `{ sent: true }`.
   * A build without the report address saves a file on the Desktop and opens a GitHub issue: `{ sent: false, file }`.
   */
  reportProblem(report?: { error?: string; note?: string; screenshot?: boolean; files?: File[] }): Promise<{ sent: boolean; file?: string }>
  /** What a report may carry (`maxBytes`: the user's files together). */
  reportInfo(): Promise<{ maxBytes: number; attachments: boolean; screenshot: boolean }>
  /** The app's logs folder in File Explorer. */
  openLogs(): Promise<void>
  /** The answer to `mango-close-notice`: `true` the notice is up and the window stays, `false` the window goes now. */
  closeNoticeAnswer?(shown: boolean): Promise<void>
  /** "OK" on the notice of the first X: the app remembers it was read and hides the window. */
  closeNoticeSeen?(): Promise<void>
  /** Automatic updates: the app checks the GitHub releases and downloads the new version; install() restarts into it.
   *  `automatic`: the check of each start is on; setAutomatic() saves that choice. */
  updates?: {
    state(): Promise<MangoUpdateReport>
    check(): Promise<MangoUpdateReport>
    /**
     * Turns the check at each start on or off, and gives the new report. It rejects like `models`. An app before 0.1.4
     * has neither this nor `automatic` in its report: the page then leaves the choice off.
     */
    setAutomatic?(automatic: boolean): Promise<MangoUpdateReport>
    install(): Promise<void>
  }
  /** Project files, by absolute path: they reject with { code, message } (not_found, forbidden, blocked_type, ...). */
  fileInfo(path: string): Promise<{ size: number; isDir: boolean }>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  /**
   * The models to download: one runs at a time, the others wait. The downloads themselves are in the control server's
   * state (`/mango/state`). They reject with `{ code: "refused", message }`, where `message` is the sentence to show;
   * `code` is `"token"` for a refusal of Hugging Face that the user's token answers.
   */
  models?: {
    download(keys: string[]): Promise<void>
    /** Keeps what has arrived. */
    pause(key: string): Promise<void>
    resume(key: string): Promise<void>
    /** Deletes what has arrived. */
    cancel(key: string): Promise<void>
    /** The model loaded when the app opens; `null`: the first on the computer. */
    setDefault(key: string | null): Promise<void>
    /** Where the model runs and how. If it is the one in use and its place or context changed, it loads again after the answer in progress. */
    setChoices(key: string, choices: MangoModelChoices): Promise<void>
    /**
     * Takes the model off the computer; if it is the one in use it is stopped first. A model the user added also leaves
     * the list, and the files the user chose stay where they are.
     */
    remove(key: string): Promise<void>
    openFolder(): Promise<void>
  }
  /**
   * «Another model»: a model from Hugging Face or a GGUF on the computer, added to the user's list. They reject like
   * `models`: `code` `"token"` when the user's token answers the refusal.
   */
  otherModels?: {
    /**
     * A name searches Hugging Face; a link (or `owner/name`, a result's id) gives the analysis of that repo at once, or
     * the model of the catalog it is the repo of.
     */
    search(text: string): Promise<MangoOtherFound>
    /** The analysis of a GGUF on the computer. */
    analyze(what: { file: string }): Promise<MangoAnalysis>
    /** The Windows file picker for a GGUF; `null` if the user cancels. */
    pickFile(): Promise<string | null>
    /** Puts a quantization of an analysis in the user's list: the models list shows it, to download or ready. */
    add(candidate: { key: string; entry: unknown }): Promise<void>
    /** Takes a model that is not on the computer out of the user's list (`models.remove` takes one that is there). */
    remove(key: string): Promise<void>
  }
  /** The Hugging Face token, kept in the Windows Credential Manager: the page never reads it back. They reject like `models`. */
  token?: {
    status(): Promise<boolean>
    /** Checks it with Hugging Face, then saves it. */
    save(token: string): Promise<void>
    remove(): Promise<void>
  }
  /** The computer's choices about the models. They reject like `models`. */
  computer?: {
    /** A graphics card, by name, is used by the models or left out of them. */
    setGpuUsed(name: string, used: boolean): Promise<void>
    /** Where a model that fits one card runs. */
    setSmallModels(smallModels: "one" | "all"): Promise<void>
    /** «How it is tuned»: the folder of the skill that tunes Mango Code on this PC, to give to a frontier AI. */
    openOptimize(): Promise<void>
    /**
     * «Update the engine»: the models on the disk that wait for the engine the app came with are queued, their download
     * brings only the engine. It answers the sentence to show.
     */
    updateEngine(): Promise<string>
  }
  /** «Lend the engine to my PCs»: the other PCs of the user use this one's models with a code. */
  engineShare?: MangoEngineShare
  /** «Use the engine of another PC»: connect checks the code with that PC and the app starts again on its engine. */
  engineRemote?: MangoEngineRemote
  /** The "Preview" panel (native browser inside the window). Only in the desktop app. */
  preview?: MangoPreview
  /** "Use my Chrome" in the settings: the choice applies to the next browser request. */
  chrome?: MangoChrome
  /** The Team: the OpenRouter key and the choices of the "Team" settings page. */
  team?: MangoTeam
  /** "From your phone" in the settings: the service that brings the web UI to the phone. */
  phone?: MangoPhone
  /** Dictation (the microphone in the chat), a choice of the user: its models download in the background when it is turned on. */
  dictation?: MangoDictation
}

/**
 * What the app says of the updates: the state, whether the check at each start is on (the user's choice), and
 * `checked_at`, when the last check that got an answer ended (milliseconds since 1970), null before one.
 */
export type MangoUpdateReport = UpdaterState & { automatic?: boolean; checked_at?: number | null }

/** A repo of Hugging Face found by name; `gated`: it asks to accept terms, and the token, to download it. */
export type MangoSearchResult = { id: string; downloads: number; likes: number; gated: boolean }

export type MangoOtherFound =
  | { type: "results"; results: MangoSearchResult[] }
  | { type: "analysis"; repo: string; analysis: MangoAnalysis }
  /** The repo of a model of the catalog: it is already among the tested ones, tuned for Mango Code. */
  | { type: "tested"; key: string; label: string }

/**
 * How a quantization would run here, with or without the image encoder; `placement` null: it does not fit. `context`:
 * the one it would run with, null if it does not fit.
 */
export type MangoFit = {
  bytes: number
  placement: "gpu" | "cpu" | null
  context: number | null
  /** The cards it would take, by name: none on the processor or when it does not fit. */
  gpus: string[]
  speed: "very_slow" | "slow" | "fair" | "quick" | null
  reason: string
  entry: unknown
}

/** A quantization, with the same one with the image encoder if the repo has it. `recommended`: the one proposed. */
export type MangoVariant = MangoFit & {
  name: string
  key: string
  recommended: boolean
  with_images: MangoFit | null
}

/**
 * What the app says of a model before adding it (`engine_cfg::other_models::Analysis`). `estimated`: Mango Code does not
 * know this kind of model yet, its memory is estimated from the weight of its files; the first warning says so.
 */
export type MangoAnalysis = {
  name: string
  source: "hugging-face" | "local"
  gated: boolean
  estimated: boolean
  variants: MangoVariant[]
  warnings: { severe: boolean; text: string }[]
}

/** Where the other PCs reach the engine; `code` (`mango://ip:port/key`) is copied, never shown. */
export type MangoShareAccess = { address: string; code: string }

export type MangoEngineShareState = {
  enabled: boolean
  listening: boolean
  port: number
  /** Why the port is not open even though it is on. */
  error: string | null
  /** On the home network; null if off or without a network. */
  home: MangoShareAccess | null
  /** From outside with Tailscale; null if off or without Tailscale. */
  away: MangoShareAccess | null
}

/** They reject with { code, message }: `message` is the sentence to show. */
export type MangoEngineShare = {
  state(): Promise<MangoEngineShareState>
  setEnabled(enabled: boolean): Promise<MangoEngineShareState>
  /** A new key: the codes given before no longer work. */
  newKey(): Promise<MangoEngineShareState>
}

/** They reject with { code, message } (bad_code, rejected, unreachable, no_models, not_mango): `message` is the sentence to show. */
export type MangoEngineRemote = {
  connect(code: string): Promise<void>
  /** Back to the engine of this PC: the app starts again. */
  disconnect(): Promise<void>
}

/** `waiting`: on, it downloads as soon as the app is ready. `ready`: the microphone works. */
export type MangoDictationState = {
  enabled: boolean
  status: "off" | "waiting" | "downloading" | "ready" | "error"
  doneMb: number
  sizeMb: number
  error: string | null
}

/** Changes arrive as the `mango-dictation` event on window. */
export type MangoDictation = {
  state(): Promise<MangoDictationState>
  /** Saves the choice; off also deletes the models. */
  setEnabled(enabled: boolean): Promise<MangoDictationState>
}

/** A link for the phone (with the key) and its QR as SVG. */
export type MangoPhoneAccess = {
  address: string
  link: string
  qr: string
  /** Windows calls this network public (a café's): the link travels in the clear for whoever is on it. */
  public: boolean
}

export type MangoPhoneState = {
  enabled: boolean
  listening: boolean
  port: number
  /** Why the port is not open even though it is on. */
  error: string | null
  /** On the home network; null if off or without a network. */
  home: MangoPhoneAccess | null
  /** From outside with Tailscale; null if off or if Tailscale is not there. */
  away: MangoPhoneAccess | null
}

export type MangoPhone = {
  state(): Promise<MangoPhoneState>
  setEnabled(enabled: boolean): Promise<MangoPhoneState>
  /** A new key: the previous link is no longer valid and the phones that joined must join again. */
  newKey(): Promise<MangoPhoneState>
}

/** Address, title and loading state of the panel, as the webview engine sees them. */
export type MangoPreviewState = { url: string; title: string; loading: boolean; failed: string | null; visible: boolean }

export type MangoPreview = {
  /**
   * Rectangle of the placeholder in the page (CSS pixels), zoom, and how round its corners are (CSS pixels; the two bottom ones,
   * or all four with `roundTop`): the native panel overlaps it.
   */
  place(rect: { x: number; y: number; width: number; height: number; dpr: number; zoom: number; radius: number; roundTop: boolean; visible: boolean }): Promise<void>
  go(url: string): Promise<void>
  nav(action: "back" | "forward" | "reload" | "stop"): Promise<void>
  state(): Promise<MangoPreviewState>
  /** The panel's page in the default Windows browser. */
  openExternal(): Promise<void>
  /** A PDF, a picture or a web page of a project, by absolute path; rejects with { code, message } (not_found, forbidden, blocked_type, too_large, ...). */
  openFile(path: string): Promise<void>
}

export type MangoChrome = {
  info(): Promise<{ installed: boolean; debugging: boolean; enabled: boolean }>
  setEnabled(enabled: boolean): Promise<void>
}

export type MangoTeamInfo = {
  /** Whether the key is in the Credential Manager; the key never goes through the page. */
  key: boolean
  agents: number
  max: number
  manager: string
  agent: string
  models: { key: string; label: string }[]
}

/** setKey, removeKey and save restart the agent; they reject with { code, message }: invalid_key, invalid_choices, io. */
export type MangoTeam = {
  info(): Promise<MangoTeamInfo>
  setKey(key: string): Promise<void>
  removeKey(): Promise<void>
  save(agents: number, manager: string, agent: string): Promise<void>
}

declare global {
  interface Window {
    __MANGO_DESKTOP__?: MangoDesktop
  }
}

/** Error of the app commands: `code` chooses the text to show, `message` is the technical detail. */
export type MangoDesktopError = { code: string; message: string }

export function mangoDesktopError(cause: unknown): MangoDesktopError {
  if (cause && typeof cause === "object" && "code" in cause && "message" in cause) return cause as MangoDesktopError
  return { code: "io", message: cause instanceof Error ? cause.message : String(cause) }
}

const externalProtocols = new Set(["http:", "https:", "mailto:"])

/** Functions of the web platform that go through the bridge inside the desktop app. */
export function mangoPlatform(
  bridge: MangoDesktop,
): Pick<
  Platform,
  | "pickNativeDirectories"
  | "projectsFolder"
  | "createProjectFolder"
  | "readClipboardImage"
  | "openExternal"
  | "projectFiles"
  | "updater"
> {
  return {
    updater: bridge.updates ? mangoUpdater(bridge.updates) : undefined,
    async pickNativeDirectories(opts) {
      const picked = await bridge.pickDirectories(opts)
      if (!picked) return null
      return opts?.multiple ? picked : (picked[0] ?? null)
    },
    projectsFolder: () => bridge.projectsFolder(),
    createProjectFolder: (name, parent) => bridge.createProject(name, parent),
    projectFiles: {
      info: (path) => bridge.fileInfo(path),
      // a PDF, a picture or a web page opens in the panel; the other documents in their Windows program
      open: (path) => (previewKind(path) && bridge.preview ? bridge.preview.openFile(path) : bridge.openPath(path)),
      reveal: (path) => bridge.revealPath(path),
    },
    async readClipboardImage() {
      const png = await bridge.readClipboardImage()
      if (!png) return null
      return new File([png], `pasted-image-${Date.now()}.png`, { type: "image/png" })
    },
    openExternal(value) {
      if (!URL.canParse(value)) return
      const url = new URL(value)
      if (!externalProtocols.has(url.protocol)) return
      bridge.openExternal(url.href).catch((cause: unknown) => console.error("external link not opened", cause))
    },
  }
}

/** The browser's own steps of zoom (those of Ctrl+ and Ctrl-), from 25% to 500%. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** The step after `zoom` going bigger (`1`) or smaller (`-1`); at an end, the end. A zoom between two steps goes to the next. */
export function nextZoom(zoom: number, direction: 1 | -1) {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.005) ?? ZOOM_STEPS.at(-1)!
  return ZOOM_STEPS.findLast((step) => step < zoom - 0.005) ?? ZOOM_STEPS[0]
}

/** True only inside the Mango Code desktop app (the bridge is there); a normal browser stays as it is. */
export function inMangoDesktop() {
  return typeof window !== "undefined" && !!window.__MANGO_DESKTOP__
}

/**
 * The updater of the web UI (Install-and-restart button in the title bar, notice, Settings > Help) on top of the
 * app's: the state starts from the app and then follows its "mango-update" events.
 */
function mangoUpdater(updates: NonNullable<MangoDesktop["updates"]>): UpdaterPlatform {
  const [state, setState] = createSignal<UpdaterState>({ status: "idle" })
  const [automatic, setAutomatic] = createSignal(true)
  const [checkedAt, setCheckedAt] = createSignal<number>()
  const apply = (report: MangoUpdateReport) => {
    setState(report)
    if (typeof report.automatic === "boolean") setAutomatic(report.automatic)
    if (typeof report.checked_at === "number") setCheckedAt(report.checked_at)
    return report
  }
  const choose = updates.setAutomatic
  window.addEventListener("mango-update", (event) => apply((event as CustomEvent<MangoUpdateReport>).detail))
  updates.state().then(apply, () => undefined)
  return {
    state,
    // the choice only where the app has it
    automatic: choose && automatic,
    checkedAt,
    check: () => updates.check().then(apply),
    setAutomatic: choose && (async (next) => void apply(await choose(next))),
    install: () =>
      updates.install().catch((cause: unknown) => {
        setState({ status: "error", message: mangoDesktopError(cause).message })
      }),
  }
}
