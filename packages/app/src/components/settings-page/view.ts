// mango-code: the settings' view of the state, the catalog and the computer read by `context/mango.tsx`, kept in a store
// so that a row keeps its own object across reads.
import { reconcile, type SetStoreFunction } from "solid-js/store"
import type { CatalogEntry, Computer, MangoState } from "@/utils/mango-state"

/**
 * `failed`: the state does not read; `computerFailed`: the computer did not read the last time it was asked;
 * `catalogFailed`: the catalog answered, but none of its models read.
 */
export type ControlView = {
  state?: MangoState
  catalog?: CatalogEntry[]
  computer?: Computer
  failed: boolean
  computerFailed?: boolean
  catalogFailed?: boolean
}

/**
 * A new view into a store, each list matched by its own key (models by `key`, downloads by `model`, cards by `name`):
 * a row keeps its place and its own state (a value shown, a dialog) when the list changes order or grows. What the new
 * view lacks (not read yet, or no longer read) keeps what there was. The store takes copies: it changes its objects in
 * place, and those it is given belong to the reader.
 */
export function applyView(set: SetStoreFunction<ControlView>, next: ControlView) {
  set("failed", next.failed)
  set("computerFailed", next.computerFailed)
  set("catalogFailed", next.catalogFailed)
  if (next.state) set("state", reconcile(structuredClone(next.state), { key: "model" }))
  if (next.catalog) set("catalog", reconcile(structuredClone(next.catalog), { key: "key" }))
  if (next.computer) set("computer", reconcile(structuredClone(next.computer), { key: "name" }))
}
