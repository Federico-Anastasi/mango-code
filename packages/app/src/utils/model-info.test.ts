import { describe, expect, test } from "bun:test"
import { modelDetail, parseModelsInfo } from "./model-info"

const dict: Record<string, string> = {
  "dialog.model.info.gpu": "On the graphics card",
  "dialog.model.info.cpu": "On the processor",
  "dialog.model.info.speed.slow": "slow",
  "dialog.model.info.none": "Does not fit in this computer",
  "dialog.model.info.images": "Reads images",
  "dialog.model.info.weak": "Not suited to working on files",
}
const t = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), dict[key] ?? key)

describe("the line the model menu shows under a name", () => {
  test("weight, where it runs and images, in this order", () => {
    expect(modelDetail({ bytes: 18 * 1024 ** 3, place: "gpu" }, { images: true }, t, "en")).toEqual({ line: "18 GB · On the graphics card · Reads images", warning: undefined })
  })

  test("on the processor it says how fast; another PC's model has no weight and no place (its name says the PC)", () => {
    expect(modelDetail({ bytes: 2 * 1024 ** 3, place: "cpu", speed: "slow" }, { images: false }, t, "en")?.line).toBe("2 GB · On the processor · slow")
    expect(modelDetail({ place: "remote" }, { images: true }, t, "en")?.line).toBe("Reads images")
    expect(modelDetail({ bytes: 5 * 1024 ** 3, place: "none" }, { images: false }, t, "en")?.line).toBe("5 GB · Does not fit in this computer")
  })

  test("the warning is there only when the agent says the catalog does not trust the model", () => {
    expect(modelDetail({ bytes: 1024 ** 3, place: "gpu", weak: true }, { images: false }, t, "en")?.warning).toBe("Not suited to working on files")
    expect(modelDetail({ bytes: 1024 ** 3, place: "gpu" }, { images: false }, t, "en")?.warning).toBeUndefined()
  })

  test("a model the agent knows nothing about has no line", () => {
    expect(modelDetail(undefined, { images: true }, t)).toBeUndefined()
  })
})

describe("the agent's answer", () => {
  test("it is read by model key; what is not right is left out", () => {
    expect(
      parseModelsInfo({
        a: { bytes: 100, place: "cpu", speed: "fair", remote: null, weak: false },
        b: { bytes: -1, place: "moon", speed: "warp", weak: "yes" },
        c: null,
      }),
    ).toEqual({ a: { bytes: 100, place: "cpu", speed: "fair" }, b: {} })
    for (const nothing of [undefined, null, [], "x", 3]) expect(parseModelsInfo(nothing)).toEqual({})
  })
})
