import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { ImageModels } from "@/utils/mango-state"
import { applyView, listedImages, type ControlView } from "./view"

const images: ImageModels = {
  models: [
    {
      key: "z-image-turbo",
      label: "Z-Image Turbo",
      about: "",
      license: null,
      present: true,
      bytes: 1,
      draws: { placement: "cpu", gpus: [] },
    },
  ],
  default: "z-image-turbo",
}

describe("settings view of the models that make pictures", () => {
  test("follows the answer: a newer view without them clears the ones shown", () => {
    const [view, setView] = createStore<ControlView>({ failed: false })
    applyView(setView, { failed: false, images })
    expect(view.images?.models.map((model) => model.key)).toEqual(["z-image-turbo"])

    applyView(setView, { failed: false })
    expect(view.images).toBeUndefined()
  })

  test("a view without the catalog keeps the one shown, as before", () => {
    const [view, setView] = createStore<ControlView>({ failed: false })
    applyView(setView, { failed: false, catalog: [], computer: undefined })
    applyView(setView, { failed: true })
    expect(view.catalog).toEqual([])
    expect(view.failed).toBe(true)
  })

  test("a group with no model in it is not listed", () => {
    expect(listedImages(undefined)).toBeUndefined()
    expect(listedImages({ models: [], default: null })).toBeUndefined()
    expect(listedImages(images)).toBe(images)
  })
})
