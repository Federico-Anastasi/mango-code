import { createSignal } from "solid-js"
import type { MangoDictationState } from "./mango-desktop"

const [state, setState] = createSignal<MangoDictationState>()
let following = false

/**
 * The state of the dictation (the microphone in the chat) in the desktop app: it starts from the app's answer and follows its
 * `mango-dictation` events. Undefined in a browser, where there is no app to ask, and until the app answers.
 */
export function dictationState() {
  const api = typeof window === "undefined" ? undefined : window.__MANGO_DESKTOP__?.dictation
  if (api && !following) {
    following = true
    window.addEventListener("mango-dictation", (event) => setState((event as CustomEvent<MangoDictationState>).detail))
    // an event that arrived while the app was answering is newer
    api.state().then(
      (current) => setState((previous) => previous ?? current),
      () => undefined,
    )
  }
  return state
}

/** The user's choice. It rejects with the app's error, which the caller shows. */
export async function setDictationEnabled(enabled: boolean) {
  const api = window.__MANGO_DESKTOP__?.dictation
  if (api) setState(await api.setEnabled(enabled))
}

const [hint, setHint] = createSignal<string>()

/**
 * The sentence the microphone leaves in the settings when it leads there because the dictation is not ready: the dictation
 * row shows it until the settings close.
 */
export const dictationHint = hint

export function showDictationHint(text: string | undefined) {
  setHint(text)
}
