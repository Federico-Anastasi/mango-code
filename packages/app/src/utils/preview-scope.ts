import { createEffect, on, type Accessor, type Setter } from "solid-js"

/**
 * The preview panel is one for the whole app, but it belongs to the conversation that opened it: moving to another one
 * finds it closed, and coming back finds it as it was left.
 */
export function rememberPerKey(opened: Accessor<boolean>, setOpened: Setter<boolean>, key: Accessor<string>) {
  const left = new Map<string, boolean>()
  createEffect(
    on(key, (now, before) => {
      if (before !== undefined) left.set(before, opened())
      setOpened(left.get(now) ?? false)
    }),
  )
}
