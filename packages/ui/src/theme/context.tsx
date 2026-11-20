// @refresh reload

import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"

export type ColorScheme = "light" | "dark" | "system"

const COLOR_SCHEME_KEY = "opencode-color-scheme"
const STYLE_ID = "oc-theme"

type SchemeStorage = Pick<Storage, "getItem" | "setItem">

function saved(storage: SchemeStorage | undefined): ColorScheme {
  try {
    const value = storage?.getItem(COLOR_SCHEME_KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

function systemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const modeOf = (scheme: ColorScheme) => (scheme === "system" ? systemMode() : scheme)

/** The colours are the suite's, which its stylesheet defines for both themes: the page is only told which one. */
function apply(mode: "light" | "dark") {
  const style = document.getElementById(STYLE_ID) ?? document.head.appendChild(document.createElement("style"))
  style.id = STYLE_ID
  style.textContent = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${mode === "dark" ? "plus-lighter" : "multiply"};
}`
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.dataset.mangoTheme = mode
  document.documentElement.style.backgroundColor = "var(--mango-ground)"

  // The browser's own bar takes the colour of the page
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--mango-ground").trim())
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: {
    onThemeApplied?: (mode: "light" | "dark", scheme: ColorScheme) => void
    /** Where the choice is kept; the browser's own storage when it is not given. */
    storage?: SchemeStorage
  }) => {
    const storage = props.storage ?? (typeof localStorage === "object" ? localStorage : undefined)
    const colorScheme = saved(storage)
    const [store, setStore] = createStore({ colorScheme, mode: modeOf(colorScheme) })

    const follow = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      setStore("mode", modeOf(scheme))
    }

    onMount(() => {
      // another window of the app changed the choice
      makeEventListener(window, "storage", (event: StorageEvent) => {
        if (event.key === COLOR_SCHEME_KEY) follow(saved(storage))
      })
      makeEventListener(window.matchMedia("(prefers-color-scheme: dark)"), "change", () => {
        if (store.colorScheme === "system") setStore("mode", systemMode())
      })
    })

    createEffect(() => {
      apply(store.mode)
      props.onThemeApplied?.(store.mode, store.colorScheme)
    })

    return {
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      setColorScheme(scheme: ColorScheme) {
        follow(scheme)
        // a page that may not keep anything still changes theme: the choice lasts as long as the page
        try {
          storage?.setItem(COLOR_SCHEME_KEY, scheme)
        } catch {}
      },
    }
  },
})
