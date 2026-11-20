import { afterEach, describe, expect, mock, test } from "bun:test"
import { createComponent, onMount, onCleanup } from "solid-js"
import { render } from "solid-js/web"

// A region that listens when its own mount has run, like the real ones (they sit in a portal and subscribe in their own
// `onMount`, which runs after the mount of the component that places them): a toast made before is lost.
let listening = false
const shown: string[] = []
const Region = () => {
  onMount(() => {
    listening = true
    onCleanup(() => {
      listening = false
    })
  })
  return null
}
const show = (options: string | { description?: string }) => {
  if (listening) shown.push(typeof options === "string" ? options : (options.description ?? ""))
  return shown.length
}
mock.module("@opencode-ai/ui/toast", () => ({ Toast: { Region }, showToast: show, toaster: { dismiss: () => undefined } }))
mock.module("@opencode-ai/ui/v2/toast-v2", () => ({ ToastV2: { Region }, showToastV2: show, toasterV2: { dismiss: () => undefined } }))

const { ToastRegion, showToast, whenToastsReady } = await import("@/utils/toast")

const settle = () => new Promise<void>((done) => setTimeout(done, 20))

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  shown.length = 0
})

describe.each([false, true])("the toast region (v2: %p)", (v2) => {
  const mountRegion = () => {
    unmount = render(() => createComponent(ToastRegion, { v2 }), document.createElement("div"))
  }

  test("a toast made in the same tick as the region's mount is lost, and one made when the region is ready is shown", async () => {
    // what a component next to the region does when it mounts
    const mountedWith = () => onMount(() => void showToast({ description: "made at the mount" }))
    unmount = render(
      () => {
        mountedWith()
        whenToastsReady(() => void showToast({ description: "made when ready" }))
        return createComponent(ToastRegion, { v2 })
      },
      document.createElement("div"),
    )
    await settle()
    expect(shown).toEqual(["made when ready"])
  })

  test("what waits for the region runs once it is ready, then at once, and not when no region is there", async () => {
    const ran: string[] = []
    whenToastsReady(() => ran.push("early"))
    expect(ran).toEqual([])
    mountRegion()
    expect(ran).toEqual([])
    await settle()
    expect(ran).toEqual(["early"])
    whenToastsReady(() => ran.push("late"))
    expect(ran).toEqual(["early", "late"])
    unmount?.()
    unmount = undefined
    whenToastsReady(() => ran.push("after the region left"))
    expect(ran).toEqual(["early", "late"])
  })
})
