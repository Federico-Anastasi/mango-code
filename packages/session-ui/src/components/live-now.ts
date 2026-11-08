import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { elapsedMs } from "./step-time"

/** The client clock, updated every second only while `active` is true. */
export function createLiveNow(active: Accessor<boolean>) {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!active()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

/**
 * Time elapsed in a step. `start` and `end` are the real ones from the session data;
 * the client clock only advances the count until `end` exists.
 */
export function createElapsed(range: Accessor<{ start?: number; end?: number }>) {
  const now = createLiveNow(() => {
    const { start, end } = range()
    return typeof start === "number" && typeof end !== "number"
  })
  return () => {
    const { start, end } = range()
    return elapsedMs(start, end, now())
  }
}
