import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

/** Format of the panel: the width of the frame decides how the page is laid out. */
export type PreviewDevice = "desktop" | "tablet" | "phone"

type Store = {
  opened: boolean
  width: number
  device: PreviewDevice
}

export const PREVIEW_MIN_WIDTH = 380
const PREVIEW_DEFAULT_WIDTH = 520

/**
 * The "Preview" panel: the agent's browser inside the window.
 *
 * The state that matters to the user (open, width, format) is kept between launches, like
 * the other panels of the app. The address is NOT: the native panel knows it, and the web UI
 * asks it (`preview.state`).
 */
export const { use: usePreview, provider: PreviewProvider } = createSimpleContext({
  name: "Preview",
  gate: false,
  init: () => {
    const [store, setStore] = persisted(
      "preview.v1",
      createStore<Store>({ opened: false, width: PREVIEW_DEFAULT_WIDTH, device: "desktop" }),
    )

    // The agent navigates while the panel is closed: the app opens it by itself, so the user sees
    // the page being built appear instead of having to go and look for it.
    onMount(() => {
      const onPreview = (event: Event) => {
        const detail = (event as CustomEvent<{ kind?: string }>).detail
        if (detail?.kind === "open") setStore("opened", true)
      }
      window.addEventListener("mango-preview", onPreview)
      onCleanup(() => window.removeEventListener("mango-preview", onPreview))
    })

    return {
      opened: () => store.opened,
      width: () => store.width,
      device: () => store.device,
      open: () => setStore("opened", true),
      close: () => setStore("opened", false),
      toggle: () => setStore("opened", (opened) => !opened),
      resize: (width: number) => setStore("width", Math.round(Math.max(PREVIEW_MIN_WIDTH, width))),
      setDevice: (device: PreviewDevice) => setStore("device", device),
    }
  },
})