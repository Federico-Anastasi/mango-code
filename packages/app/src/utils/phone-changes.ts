import { createSignal } from "solid-js"

const [opened, setOpened] = createSignal(false)
const [actions, setActions] = createSignal<HTMLElement>()

/**
 * On a phone the changes of a conversation are a screen of their own, opened from the top bar and left with its back arrow.
 * The bar and the page are in different parts of the app: this is what they share. It is closed again when the route changes.
 */
export const phoneChanges = {
  opened,
  open: () => setOpened(true),
  close: () => setOpened(false),
  toggle: () => setOpened((value) => !value),
}

/** The place in the top bar where the page of a conversation puts its menu (the bar is created after the page may have asked for it). */
export const phoneBarActions = { element: actions, set: setActions }
