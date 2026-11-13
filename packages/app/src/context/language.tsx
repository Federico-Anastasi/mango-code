import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { pluralCategory, type UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { Persist, persisted } from "@/utils/persist"
import { authHeaders } from "@/utils/server"
import { showToast } from "@/utils/toast"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import {
  createDesktopNativeBundle,
  detectDesktopNativeLocale,
  DESKTOP_NATIVE_ENGLISH,
  DESKTOP_NATIVE_LABELS,
  DESKTOP_NATIVE_LOCALES,
  DESKTOP_NATIVE_LOCALE_TAGS,
  type DesktopNativeBundle,
  type DesktopNativeLocale,
} from "@/i18n/desktop-native"

export type Locale = DesktopNativeLocale
/** What the language picker offers: one of the two languages, or the system's (browser) language. */
export type LanguageChoice = Locale | "system"
export type Direction = "ltr" | "rtl"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>
type PluralKey =
  | UiI18nPluralKey
  | "session.question.pending"
  | "session.followupDock.summary"
  | "session.revertDock.summary"
  | "settings.computer.tailored.models"
  | "settings.agent.count.tools"
  | "settings.agent.count.mcp"
  | "settings.agent.count.skills"
  | "settings.agent.count.files"
type Source = { dict: Record<string, string> }

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

const LOCALES: readonly Locale[] = DESKTOP_NATIVE_LOCALES

const INTL = DESKTOP_NATIVE_LOCALE_TAGS

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

const merge = (app: Promise<Source>, ui: Promise<Source>) =>
  Promise.all([app, ui]).then(([a, b]) => ({ ...base, ...i18n.flatten({ ...a.dict, ...b.dict }) }) as Dictionary)

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  it: () => merge(import("@/i18n/it"), import("@opencode-ai/ui/i18n/it")),
}

function loadDict(locale: Locale) {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const load = loaders[locale]
  return load().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"
  return detectDesktopNativeLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("opencode.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

// The language is kept by the agent server, in the settings file shared with the app and the terminal.
const LANGUAGE_PATH = "/mango/language"
let languageServer: { url: URL; headers: Record<string, string> } | undefined
let initialChoice: LanguageChoice = "system"

function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale)
}

async function readServerLanguage(server: NonNullable<typeof languageServer>) {
  try {
    const response = await fetch(server.url, { headers: server.headers, signal: AbortSignal.timeout(3000) })
    if (!response.ok) return
    const body = (await response.json()) as { language?: unknown }
    return isLocale(body.language) ? body.language : undefined
  } catch {
    return
  }
}

const savedListeners = new Set<() => void>()

/**
 * Runs `listener` each time a choice of language reaches the server: what the app's server says from then on (the catalog,
 * the computer) is in that language. It returns the function that stops it.
 */
export function onLanguageSaved(listener: () => void) {
  savedListeners.add(listener)
  return () => {
    savedListeners.delete(listener)
  }
}

async function writeServerLanguage(choice: LanguageChoice) {
  if (!languageServer) throw new Error("language server not set")
  const response = await fetch(languageServer.url, {
    method: "PUT",
    headers: { ...languageServer.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ language: choice === "system" ? null : choice }),
  })
  if (!response.ok) throw new Error(`${response.status}`)
}

/**
 * The language to start with: the one the server returns; without one (or without an answer), the stored one, else
 * the browser's.
 */
export async function loadInitialLocale(server: { url: string; auth?: { username: string; password: string } }) {
  languageServer = {
    url: new URL(LANGUAGE_PATH, server.url),
    headers: authHeaders(server.auth ?? {}),
  }
  const chosen = await readServerLanguage(languageServer)
  initialChoice = chosen ?? "system"
  const locale = chosen ?? readStoredLocale() ?? detectLocale()
  if (locale === "en") return locale
  return loadDict(locale).then(
    () => locale,
    () => "en" as const,
  )
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: { locale?: Locale; onNativeTranslations?: (bundle: DesktopNativeBundle) => void }) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: initial,
      }),
    )

    const [choice, setChoice] = createSignal<LanguageChoice>(initialChoice)
    const locale = createMemo<Locale>(() => (choice() === "system" ? normalizeLocale(store.locale) : (choice() as Locale)))
    const intl = createMemo(() => INTL[locale()])
    const [layout, setLayout] = createStore({ direction: undefined as Direction | undefined })
    const direction = createMemo(() => layout.direction ?? "ltr")
    const layoutLocale = createMemo(() => {
      if (!layout.direction) return intl()
      // Kobalte derives menu direction from locale rather than accepting a direction override.
      return layout.direction === "rtl" ? "ar" : "en"
    })

    const [dict] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })

    const t = i18n.translator(() => dict() ?? base, i18n.resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const plural = (key: PluralKey, count: number, params?: Record<string, string | number | boolean>) => {
      const category = pluralCategory(intl(), count)
      const current = (dict.loading ? base : (dict() ?? base)) as Record<string, string>
      const candidate = `${key}.${category}`
      const fallback = `${key}.other`
      return i18n.resolveTemplate(current[candidate] ?? current[fallback] ?? fallback, { ...params, count })
    }

    const label = (value: LanguageChoice) =>
      value === "system" ? t("settings.general.row.language.system") : DESKTOP_NATIVE_LABELS[value]

    createEffect(() => {
      if (typeof document !== "object") return
      const value = locale()
      document.documentElement.lang = intl()
      document.documentElement.dir = direction()
      document.cookie = cookie(value)
    })

    createEffect(() => {
      if (!props.onNativeTranslations || dict.loading) return
      const current = dict()
      if (!current) return
      props.onNativeTranslations(
        createDesktopNativeBundle(locale(), (key) => current[key] ?? DESKTOP_NATIVE_ENGLISH[key]),
      )
    })

    return {
      ready,
      locale,
      intl,
      direction,
      layoutLocale,
      locales: LOCALES,
      choice,
      choices: ["it", "en", "system"] as const satisfies readonly LanguageChoice[],
      label,
      t,
      plural,
      setChoice(next: LanguageChoice) {
        setChoice(next)
        setStore("locale", next === "system" ? detectLocale() : next)
        writeServerLanguage(next).then(
          () => savedListeners.forEach((listener) => listener()),
          () => showToast({ variant: "error", title: t("settings.general.row.language.saveError") }),
        )
      },
      setDirection(next: Direction) {
        setLayout("direction", next === "ltr" ? undefined : next)
      },
    }
  },
})
