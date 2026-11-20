// mango-code: where the models are kept and the move in progress, followed from the app: `state()` once, then the
// `mango-models-dir` events. One for the whole settings page, so that the folder's row and a model's row tell the same move.
import { createSignal, onCleanup } from "solid-js"
import type { MangoModelsDir, MangoModelsDirMove } from "@/utils/mango-desktop"

const ENDS = new Set<MangoModelsDirMove["status"]>(["done", "failed", "cancelled", "moved"])

export function createModelsDir(onDone: () => void) {
  const api = () => window.__MANGO_DESKTOP__?.modelsDir
  const [state, setState] = createSignal<MangoModelsDir>()
  const [move, setMove] = createSignal<MangoModelsDirMove>({ status: "idle" })
  // the row the user started the last move from: its end is told there
  const [target, setTarget] = createSignal<string>()

  const read = () =>
    api()
      ?.state()
      .then(
        (found) => {
          setState(found)
          setMove(found.moving)
        },
        () => undefined,
      )
  void read()

  const listen = (event: Event) => {
    const detail = (event as CustomEvent<MangoModelsDirMove>).detail
    setMove(detail)
    if (!ENDS.has(detail.status)) return
    void read()
    if (detail.status === "done") onDone()
  }
  window.addEventListener("mango-models-dir", listen)
  onCleanup(() => window.removeEventListener("mango-models-dir", listen))

  return {
    state,
    move,
    target,
    /** What the user starts is told in this row until another begins. */
    start: setTarget,
    /** A move is under way or waits for the app to start again: no other can begin. */
    busy: () => ["moving", "moved", "restarting"].includes(move().status),
  }
}
