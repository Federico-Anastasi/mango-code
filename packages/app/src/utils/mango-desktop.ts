import type { Platform } from "@/context/platform"

/** Bridge to the Mango Code desktop app: the app (Tauri) defines it in every page, a normal browser does not. */
export type MangoDesktop = {
  pickDirectories(opts?: { title?: string; multiple?: boolean }): Promise<string[] | null>
  /** Where "New project" creates projects when no other folder is chosen. */
  projectsFolder(): Promise<string>
  /** Creates `<parent>\<name>` (without `parent`, in the default folder) and returns its path. */
  createProject(name: string, parent?: string): Promise<string>
  readClipboardImage(): Promise<ArrayBuffer | null>
  openExternal(url: string): Promise<void>
  /** "Models and engine": the window moves to the app page that downloads or removes models and changes the engine. */
  openModels(): Promise<void>
  /** Project files, by absolute path: they reject with { code, message } (not_found, forbidden, blocked_type, ...). */
  fileInfo(path: string): Promise<{ size: number; isDir: boolean }>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  /** The "Preview" panel (native browser inside the window). Only in the desktop app. */
  preview?: MangoPreview
  /** "Use my Chrome" in the settings: the choice applies to the next browser request. */
  chrome?: MangoChrome
  /** The Team: the OpenRouter key and the choices of the "Team" settings page. */
  team?: MangoTeam
  /** "From your phone" in the settings: the service that brings the web UI to the phone. */
  phone?: MangoPhone
}

/** A link for the phone (with the key) and its QR as SVG. */
export type MangoPhoneAccess = { address: string; link: string; qr: string }

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
export type MangoPreviewState = { url: string; title: string; loading: boolean }

export type MangoPreview = {
  /** Rectangle of the placeholder in the page (CSS pixels) and zoom: the native panel overlaps it. */
  place(rect: { x: number; y: number; width: number; height: number; dpr: number; zoom: number; visible: boolean }): Promise<void>
  go(url: string): Promise<void>
  nav(action: "back" | "forward" | "reload" | "stop"): Promise<void>
  state(): Promise<MangoPreviewState>
  /** The panel's page in the default Windows browser. */
  openExternal(): Promise<void>
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
  "pickNativeDirectories" | "projectsFolder" | "createProjectFolder" | "readClipboardImage" | "openExternal" | "projectFiles"
> {
  return {
    async pickNativeDirectories(opts) {
      const picked = await bridge.pickDirectories(opts)
      if (!picked) return null
      return opts?.multiple ? picked : (picked[0] ?? null)
    },
    projectsFolder: () => bridge.projectsFolder(),
    createProjectFolder: (name, parent) => bridge.createProject(name, parent),
    projectFiles: {
      info: (path) => bridge.fileInfo(path),
      open: (path) => bridge.openPath(path),
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

/** True only inside the Mango Code desktop app (the bridge is there); a normal browser stays as it is. */
export function inMangoDesktop() {
  return typeof window !== "undefined" && !!window.__MANGO_DESKTOP__
}
