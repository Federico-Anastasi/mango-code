import { createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

/** Format of the panel: the width of the frame decides how the page is laid out. */
export type PreviewDevice = "desktop" | "tablet" | "phone"

type Store = {
  width: number
  device: PreviewDevice
}

export const PREVIEW_MIN_WIDTH = 380
const PREVIEW_DEFAULT_WIDTH = 520

/**
 * The "Preview" panel: the agent's browser inside the window.
 *
 * Width and format are kept between launches. Whether it is open is NOT: the page it showed is not
 * kept either (the native panel knows it, and the web UI asks it with `preview.state`), so at the
 * next launch it would reopen empty. It opens when the agent opens a page, or with its button.
 */
export const { use: usePreview, provider: PreviewProvider } = createSimpleContext({
  name: "Preview",
  gate: false,
  init: () => {
    const [store, setStore] = persisted(
      "preview.v1",
      createStore<Store>({ width: PREVIEW_DEFAULT_WIDTH, device: "desktop" }),
    )
    const [opened, setOpened] = createSignal(false)

    // The agent navigates while the panel is closed: the app opens it by itself, so the user sees
    // the page being built appear instead of having to go and look for it.
    onMount(() => {
      const onPreview = (event: Event) => {
        const detail = (event as CustomEvent<{ kind?: string }>).detail
        if (detail?.kind === "open") setOpened(true)
      }
      window.addEventListener("mango-preview", onPreview)
      onCleanup(() => window.removeEventListener("mango-preview", onPreview))
    })

    return {
      opened,
      width: () => store.width,
      device: () => store.device,
      open: () => setOpened(true),
      close: () => setOpened(false),
      toggle: () => setOpened((open) => !open),
      resize: (width: number) => setStore("width", Math.round(Math.max(PREVIEW_MIN_WIDTH, width))),
      setDevice: (device: PreviewDevice) => setStore("device", device),
    }
  },
})