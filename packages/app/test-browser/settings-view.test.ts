import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { applyView, type ControlView } from "@/components/settings-page/view"
import { parseCatalog, parseState } from "@/utils/mango-state"

const where = { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 131072 }
const entry = (key: string) => ({
  key,
  label: key,
  present: true,
  bytes: 1,
  verdict: { fits: true, where, reason: "Sta." },
  choices: { where: "auto", gpus: [], context: null, style: "recommended", reasoning: null },
  limits: { where: ["auto"], context: [], reasoning: false },
})
const download = (model: string) => ({
  model,
  label: model,
  state: "active",
  done: 1,
  total: 2,
  bytes_per_second: 1,
  error: null,
})
const state = (downloads: string[]) =>
  parseState({ revision: 1, catalog_revision: 1, model: { phase: "none" }, downloads: downloads.map(download) })

describe("the view of the models", () => {
  test("a new view keeps each row's own object when its list changes order or grows", () => {
    const [view, setView] = createStore<ControlView>({ failed: false })
    applyView(setView, {
      failed: false,
      catalog: parseCatalog({ models: [entry("a"), entry("b")] }),
      state: state(["x"]),
    })
    const b = view.catalog![1]
    const x = view.state!.downloads[0]
    applyView(setView, {
      failed: false,
      catalog: parseCatalog({ models: [entry("c"), entry("a"), entry("b")] }),
      state: state(["y", "x"]),
    })
    expect(view.catalog!.map((model) => model.key)).toEqual(["c", "a", "b"])
    expect(view.catalog![2]).toBe(b)
    expect(view.state!.downloads[1]).toBe(x)
    // a view without a catalog (the state did not read) keeps the one there was
    applyView(setView, { failed: true })
    expect(view.failed).toBe(true)
    expect(view.catalog!).toHaveLength(3)
  })
})
