import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { PREVIEW_MIN_WIDTH, type PreviewDevice } from "@/context/preview"

/**
 * The "Preview" panel: the agent's browser inside the window.
 *
 * The page is drawn by a NATIVE webview, not an iframe: it sits on top of a placeholder of this
 * page, and here we only say where to put it (`preview.place`). This way the agent drives the same
 * page the user sees (CDP), without Chrome installed and without windows that open by themselves.
 */

const DEVICES: { id: PreviewDevice; icon: string; label: string; width?: number }[] = [
  { id: "phone", icon: "phone", label: "preview.device.phone", width: 390 },
  { id: "tablet", icon: "tablet", label: "preview.device.tablet", width: 834 },
  { id: "desktop", icon: "monitor", label: "preview.device.desktop" },
]

/** How often the panel is asked which page it is showing (back/forward included). */
const SYNC_MS = 700

export function PreviewPanel(props: {
  width: number
  device: PreviewDevice
  onResize: (width: number) => void
  onDevice: (device: PreviewDevice) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const api = () => window.__MANGO_DESKTOP__?.preview
  const [address, setAddress] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [url, setUrl] = createSignal("")
  const [title, setTitle] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  let placeholder: HTMLDivElement | undefined

  const deviceWidth = createMemo(() => DEVICES.find((device) => device.id === props.device)?.width)

  const place = () => {
    const el = placeholder
    const bridge = api()
    if (!el || !bridge) return
    const rect = el.getBoundingClientRect()
    // A tablet in a narrow panel is shown SHRUNK, not squeezed: the page must lay out
    // at 834 px and then scale (like the device mode of developer browsers).
    const target = deviceWidth() ?? rect.width
    const zoom = target > 0 ? Math.min(1, rect.width / target) : 1
    void bridge
      .place({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
        zoom,
        visible: !!url() && rect.width >= 1 && rect.height >= 1,
      })
      .catch(() => {})
  }

  const sync = async () => {
    const bridge = api()
    if (!bridge) return
    try {
      const state = await bridge.state()
      setUrl(state.url)
      setTitle(state.title)
      setLoading(state.loading)
      if (!editing()) setAddress(state.url)
      place()
    } catch {
      // the panel may disappear while it is being queried (app closing): nothing to do
    }
  }

  onMount(() => {
    const el = placeholder
    if (!el) return
    const observer = new ResizeObserver(() => place())
    observer.observe(el)
    const timer = window.setInterval(() => void sync(), SYNC_MS)
    void sync()
    onCleanup(() => {
      observer.disconnect()
      window.clearInterval(timer)
      void api()
        ?.place({ x: 0, y: 0, width: 0, height: 0, dpr: 1, zoom: 1, visible: false })
        .catch(() => {})
    })
  })

  // Changing the format changes the rectangle: the webview is repositioned right away.
  createEffect(() => {
    props.device
    queueMicrotask(place)
  })

  const go = () => {
    const bridge = api()
    const value = address().trim()
    if (!bridge || !value) return
    setEditing(false)
    void bridge.go(value).catch(() => {})
  }

  const nav = (action: "back" | "forward" | "reload" | "stop") => {
    void api()?.nav(action).catch(() => {})
  }

  return (
    <aside
      class="hidden xl:flex order-last shrink-0 h-full flex-col border-s border-border-weaker-base bg-background-base"
      style={{ width: `${props.width}px` }}
      aria-label={language.t("preview.title")}
    >
      <div class="relative h-full min-h-0 flex flex-col">
        <div class="absolute inset-y-0 -start-1 z-10">
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={props.width}
            min={PREVIEW_MIN_WIDTH}
            max={typeof window === "undefined" ? 1200 : Math.max(PREVIEW_MIN_WIDTH, window.innerWidth * 0.7)}
            onResize={props.onResize}
          />
        </div>

        <div class="flex h-10 shrink-0 items-center gap-1 border-b border-border-weaker-base px-2">
          <IconButtonV2
            icon={<Icon name="chevron-left" />}
            variant="ghost-muted"
            size="large"
            aria-label={language.t("preview.back")}
            onClick={() => nav("back")}
          />
          <IconButtonV2
            icon={<Icon name="chevron-right" />}
            variant="ghost-muted"
            size="large"
            aria-label={language.t("preview.forward")}
            onClick={() => nav("forward")}
          />
          <IconButtonV2
            icon={<Icon name={loading() ? "stop-square" : "reload"} />}
            variant="ghost-muted"
            size="large"
            aria-label={loading() ? language.t("preview.stop") : language.t("preview.reload")}
            onClick={() => nav(loading() ? "stop" : "reload")}
          />

          <input
            class="h-7 min-w-0 flex-1 rounded-md border border-border-weaker-base bg-background-stronger px-2 text-[13px] text-text-strong outline-none focus:border-border-strong-base"
            value={address()}
            spellcheck={false}
            autocomplete="off"
            aria-label={language.t("preview.address")}
            placeholder={language.t("preview.placeholder")}
            title={title() || url()}
            onFocus={(event) => {
              setEditing(true)
              event.currentTarget.select()
            }}
            onBlur={() => {
              setEditing(false)
              setAddress(url())
            }}
            onInput={(event) => setAddress(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              go()
            }}
          />

          <div class="mx-1 flex items-center gap-0.5">
            {DEVICES.map((device) => (
              <TooltipV2
                value={device.width ? `${language.t(device.label)} · ${device.width} px` : language.t(device.label)}
                placement="bottom"
              >
                <IconButtonV2
                  icon={<Icon name={device.icon} />}
                  variant="ghost-muted"
                  size="large"
                  aria-label={language.t(device.label)}
                  aria-pressed={props.device === device.id}
                  class={props.device === device.id ? "bg-background-stronger" : undefined}
                  onClick={() => props.onDevice(device.id)}
                />
              </TooltipV2>
            ))}
          </div>

          <IconButtonV2
            icon={<Icon name="outline-square-arrow" />}
            variant="ghost-muted"
            size="large"
            aria-label={language.t("preview.openExternal")}
            onClick={() => void api()?.openExternal().catch(() => {})}
          />
          <IconButtonV2
            icon={<Icon name="close" />}
            variant="ghost-muted"
            size="large"
            aria-label={language.t("preview.close")}
            onClick={props.onClose}
          />
        </div>

        <div class="relative min-h-0 flex-1 overflow-hidden bg-background-stronger">
          <div
            ref={placeholder}
            class="absolute inset-y-0 mx-auto"
            style={{ width: deviceWidth() ? `${deviceWidth()}px` : "100%", "max-width": "100%" }}
          >
            <Show when={!url()}>
              <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-text-weak">
                <Icon name="globe" size="large" />
                <p class="max-w-[36ch] text-[13px] leading-relaxed">{language.t("preview.empty")}</p>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </aside>
  )
}

/** The button in the title bar: opens and closes the panel. */
export function PreviewToggle(props: { opened: () => boolean; toggle: () => void }) {
  const language = useLanguage()
  return (
    <TooltipV2 value={language.t("preview.toggle")} placement="bottom">
      <IconButtonV2
        icon={<Icon name="globe" />}
        variant="ghost-muted"
        size="large"
        aria-label={language.t("preview.toggle")}
        aria-pressed={props.opened()}
        class={props.opened() ? "bg-background-stronger" : undefined}
        onClick={props.toggle}
      />
    </TooltipV2>
  )
}