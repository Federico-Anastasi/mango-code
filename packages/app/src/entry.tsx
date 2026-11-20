// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { createBrowserDraftStore } from "@/utils/draft-store"
import { dict as en } from "@/i18n/en"
import { authFromToken, defaultServerToUse } from "@/utils/server"
import { browserOrigin, openUiState, reloadPage } from "@/utils/ui-state"
import { uiStorage } from "@/utils/ui-storage"
import { mangoDesktopError, mangoPlatform } from "@/utils/mango-desktop"
import { followKeyboard } from "@/utils/visible-area"
import { forgetTerminal } from "@/utils/forget-terminal"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getRootNotFoundError = () => en["error.dev.rootNotFound"]

const getStorage = (key: string) => {
  try {
    return uiStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  try {
    if (value !== null) {
      uiStorage.setItem(key, value)
      return
    }
    uiStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => defaultServerToUse(getStorage(DEFAULT_SERVER_URL_KEY), !!window.__MANGO_DESKTOP__)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, onClick) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    window.focus()
    onClick?.()
    notification.close()
  }
}

const openExternal: Platform["openExternal"] = (value) => {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

const restart: Platform["restart"] = () => reloadPage()

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const createPlatform = (draftStore: Platform["draftStore"]): Platform => ({
  platform: "web",
  draftStore,
  version: pkg.version,
  openExternal,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
  // inside the Mango Code desktop app: native folder picker, new project, clipboard and external links
  ...(window.__MANGO_DESKTOP__ ? mangoPlatform(window.__MANGO_DESKTOP__) : {}),
})

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

/** The state the app keeps for the interface cannot be read: the page says so and why, and nothing is drawn over it. */
function showUiStateError(root: HTMLElement, cause: unknown) {
  console.error("the interface's state is unreadable", cause)
  const message = document.createElement("p")
  message.textContent = mangoDesktopError(cause).message
  message.style.cssText = "max-width: 36rem; margin: 20vh auto; padding: 0 1rem; line-height: 1.5; user-select: text"
  root.replaceChildren(message)
  root.style.cssText = "background: var(--mango-ground); color: var(--mango-text); font-family: var(--mango-font-text)"
}

if (root instanceof HTMLElement) {
  followKeyboard(root)
  const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
  void loadInitialLocale({ url: getCurrentUrl(), auth }).then(async (locale) => {
    clearAuthToken()
    // Inside the Mango Code window the app keeps the interface's state: it is read before anything draws or reads it.
    const bridge = window.__MANGO_DESKTOP__?.uiState
    const state = bridge ? await openUiState(bridge, browserOrigin()).catch((cause: unknown) => showUiStateError(root, cause)) : undefined
    if (bridge && !state) return
    // Before anything reads the storage: what the terminal of older releases saved goes (a storage that cannot be read stays as it is).
    try {
      forgetTerminal(uiStorage)
    } catch {}
    const platform = createPlatform(state?.draftStore ?? createBrowserDraftStore())
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!auth,
      http: {
        url: getCurrentUrl(),
        ...auth,
      },
    }
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface
              defaultServer={ServerConnection.Key.make(getDefaultUrl())}
              canonicalLocalServer={ServerConnection.key(server)}
              servers={[server]}
              disableHealthCheck
            />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  })
}
