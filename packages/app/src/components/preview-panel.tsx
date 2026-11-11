import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { PREVIEW_MIN_WIDTH, type PreviewDevice } from "@/context/preview"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { showToast } from "@/utils/toast"

/**
 * The "Preview" panel: the agent's browser inside the window.
 *
 * The page is drawn by a NATIVE webview, not an iframe: it sits on top of a placeholder of this
 * page, and here we only say where to put it (`preview.place`). This way the agent drives the same
 * page the user sees (CDP), without Chrome installed and without windows that open by themselves.
 */

/**
 * The formats. A phone and a tablet are drawn as a device (a recent iPhone and an 11-inch iPad, roughly) with the page on
 * its screen (`screen`: the screen's size and its corners, `bezel`: the body around it, all in the device's own pixels);
 * the desktop is the whole panel.
 */
const DEVICES: { id: PreviewDevice; icon: string; label: string; screen?: { width: number; height: number; radius: number; bezel: number } }[] = [
  { id: "phone", icon: "phone", label: "preview.device.phone", screen: { width: 393, height: 852, radius: 48, bezel: 11 } },
  { id: "tablet", icon: "tablet", label: "preview.device.tablet", screen: { width: 834, height: 1194, radius: 24, bezel: 14 } },
  { id: "desktop", icon: "monitor", label: "preview.device.desktop" },
]
/** The room left around a device, in CSS pixels. */
const DEVICE_MARGIN = 16
/** The smallest a device is drawn: the least zoom the native page accepts. */
const DEVICE_MIN_SCALE = 0.25

/** The most of the window the panel takes, for the CSS limit and for how far the handle goes: the same figure. */
const MAX_SHARE = 0.55
/** How often the panel is asked which page it is showing (back/forward included). */
const SYNC_MS = 700

/**
 * Whether something opened above the page (a dialog, a menu, a list, a popover) is in the way of the native panel,
 * which is drawn above all the page: then it has to step aside. Kobalte marks its topmost open layer with
 * `data-kb-top-layer` and, while a modal one is open (dialogs, menus, lists), blocks the pointer on the whole body.
 */
function layerOver(rect: DOMRect, own: HTMLElement | undefined) {
  if (document.body.style.pointerEvents === "none") return true
  return [...document.querySelectorAll<HTMLElement>("[data-kb-top-layer]")].some((layer) => {
    if (own?.contains(layer)) return false
    const box = layer.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
  })
}

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
  const [failed, setFailed] = createSignal("")
  let placeholder: HTMLDivElement | undefined
  let panel: HTMLElement | undefined
  let card: HTMLDivElement | undefined
  let stage: HTMLDivElement | undefined
  const [room, setRoom] = createSignal({ width: 0, height: 0 })

  // The device as it is drawn: whole inside the room there is, never bigger than life (like the device mode of developer
  // browsers). The page lays out at the screen's real size and is shown at `scale`.
  const shownDevice = createMemo(() => {
    const screen = DEVICES.find((device) => device.id === props.device)?.screen
    if (!screen) return undefined
    const fit = (room: number, side: number) => (room - 2 * DEVICE_MARGIN) / (side + 2 * screen.bezel)
    const scale = Math.max(DEVICE_MIN_SCALE, Math.min(1, fit(room().width, screen.width), fit(room().height, screen.height)))
    return { scale, width: screen.width * scale, height: screen.height * scale, radius: screen.radius * scale, bezel: screen.bezel * scale }
  })

  const place = () => {
    const el = placeholder
    const bridge = api()
    if (!el || !bridge) return
    const rect = el.getBoundingClientRect()
    const shown = shownDevice()
    void bridge
      .place({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
        zoom: shown?.scale ?? 1,
        // the native page is a rectangle: the app rounds it like the device's screen, or, when it fills the panel, like the
        // card's two bottom corners, which it reaches
        radius: shown?.radius ?? (card ? parseFloat(getComputedStyle(card).borderBottomLeftRadius) || 0 : 0),
        roundTop: !!shown,
        visible: !!url() && rect.width >= 1 && rect.height >= 1 && !layerOver(rect, panel),
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
      setFailed(state.failed ?? "")
      if (!editing()) setAddress(state.url)
      place()
    } catch {
      // the panel may disappear while it is being queried (app closing): nothing to do
    }
  }

  onMount(() => {
    const el = placeholder
    if (!el || !stage) return
    const measure = () => setRoom({ width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 })
    measure()
    const observer = new ResizeObserver(() => {
      measure()
      place()
    })
    observer.observe(el)
    observer.observe(stage)
    // Layers open and close in portals under the body: the panel steps aside and comes back with them.
    const portals = new MutationObserver(() => place())
    portals.observe(document.body, { childList: true, attributes: true, attributeFilter: ["style"] })
    const topLayer = new MutationObserver(() => place())
    topLayer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-kb-top-layer"] })
    const timer = window.setInterval(() => void sync(), SYNC_MS)
    void sync()
    onCleanup(() => {
      observer.disconnect()
      portals.disconnect()
      topLayer.disconnect()
      window.clearInterval(timer)
      void api()
        ?.place({ x: 0, y: 0, width: 0, height: 0, dpr: 1, zoom: 1, radius: 0, roundTop: false, visible: false })
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
    // an address the panel refuses (a scheme it does not open) says why instead of doing nothing
    void bridge
      .go(value)
      .catch((error) => showToast({ title: language.t("common.requestFailed"), description: mangoDesktopError(error).message }))
  }

  const retry = () => {
    const bridge = api()
    const target = failed()
    if (bridge && target) void bridge.go(target).catch(() => {})
  }

  const nav = (action: "back" | "forward" | "reload" | "stop") => {
    void api()?.nav(action).catch(() => {})
  }

  return (
    <aside
      ref={panel}
      // Next to the chat, like the review panel, from 768 px (a laptop at 150% is ~860 px wide): never more than 55%
      // of the room, so the chat stays readable. Only below 768 px it covers the chat; its X or the globe bring it back.
      // A card like the chat's, with the same gap around it: the chat's frame already leaves the gap between the two.
      class="relative flex order-last shrink-0 flex-col my-2 me-2 max-md:absolute max-md:inset-0 max-md:z-30 max-md:m-0 max-md:!w-full max-md:!max-w-none"
      style={{ width: `${props.width}px`, "max-width": `${MAX_SHARE * 100}%` }}
      aria-label={language.t("preview.title")}
    >
      {/* Outside the card, which cuts what goes over its rounded edge: the handle sits across it. */}
      <div class="absolute inset-y-0 -start-1 z-10">
        <ResizeHandle
          direction="horizontal"
          edge="start"
          size={props.width}
          min={PREVIEW_MIN_WIDTH}
          max={typeof window === "undefined" ? 1200 : Math.max(PREVIEW_MIN_WIDTH, window.innerWidth * MAX_SHARE)}
          onResize={props.onResize}
        />
      </div>
      <div
        ref={card}
        class="flex-1 min-h-0 flex flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] max-md:rounded-none max-md:shadow-none"
      >
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
                value={device.screen ? `${language.t(device.label)} · ${device.screen.width} × ${device.screen.height} px` : language.t(device.label)}
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

        <div ref={stage} class="relative min-h-0 flex-1 overflow-hidden bg-background-stronger flex items-center justify-center">
          {/* The body of the device: what shows of it is the edge around the screen. Without a device it is the whole room. */}
          <div
            class="shrink-0"
            classList={{ "size-full": !shownDevice(), "bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.16),0_12px_32px_rgb(0_0_0/0.4)]": !!shownDevice() }}
            style={shownDevice() ? { padding: `${shownDevice()!.bezel}px`, "border-radius": `${shownDevice()!.radius + shownDevice()!.bezel}px` } : undefined}
          >
            <div
              ref={placeholder}
              data-slot="preview-page"
              class="overflow-hidden bg-background-stronger"
              classList={{ "size-full": !shownDevice() }}
              style={shownDevice() ? { width: `${shownDevice()!.width}px`, height: `${shownDevice()!.height}px`, "border-radius": `${shownDevice()!.radius}px` } : undefined}
            >
              <Show when={!url()}>
                <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-text-weak">
                  <Icon name="globe" size="large" />
                  <p class="max-w-[36ch] text-[13px] leading-relaxed" data-slot="preview-status">
                    {failed()
                      ? language.t("preview.failed", { address: failed() })
                      : loading()
                        ? language.t("preview.loading")
                        : language.t("preview.empty")}
                  </p>
                  <Show when={failed()}>
                    <ButtonV2 type="button" variant="neutral" onClick={retry} data-action="preview-retry">
                      {language.t("preview.retry")}
                    </ButtonV2>
                  </Show>
                </div>
              </Show>
            </div>
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