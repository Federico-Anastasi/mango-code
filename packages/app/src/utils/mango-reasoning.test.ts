import { describe, expect, test } from "bun:test"
import type { MangoModelChoices } from "@/utils/mango-desktop"
import { MANGO_PROVIDER } from "@/utils/model-info"
import { reasoningControl, reasoningOf, withReasoning } from "./mango-reasoning"

const base: MangoModelChoices = {
  where: "auto",
  gpus: [],
  context: null,
  style: "recommended",
  sampling: {},
  reasoning: null,
}
const entry = (levels: unknown, chosen?: unknown) => ({
  key: "qwen",
  limits: { reasoning: levels },
  choices: { ...base, reasoning: chosen } as MangoModelChoices,
})

const mango = { id: "qwen", provider: { id: MANGO_PROVIDER } }
const none = { list: () => [] as string[], current: () => undefined }

describe("what a catalog entry says about reasoning", () => {
  test("the levels are the array, in order, and the choice is one of them", () => {
    expect(reasoningOf(entry(["low", "medium", "high"], "high"))).toEqual({
      levels: ["low", "medium", "high"],
      chosen: "high",
    })
    expect(reasoningOf(entry(["off", "on"]))).toEqual({ levels: ["off", "on"], chosen: undefined })
  })

  test("an empty array, a boolean or anything else is a model with no levels", () => {
    expect(reasoningOf(entry([])).levels).toEqual([])
    expect(reasoningOf(entry(true)).levels).toEqual([])
    expect(reasoningOf(entry(undefined)).levels).toEqual([])
  })

  test("a value that is not a level is left out", () => {
    expect(reasoningOf(entry(["low", "extreme", "high"], "extreme"))).toEqual({
      levels: ["low", "high"],
      chosen: undefined,
    })
  })
})

describe("the control under the box", () => {
  test("a model of this PC with three levels: the choice, or the middle one when none was made", () => {
    const catalog = [entry(["low", "medium", "high"], "high")]
    expect(reasoningControl({ model: mango, catalog, variants: none })).toMatchObject({
      source: "local",
      levels: ["low", "medium", "high"],
      value: "high",
    })
    expect(reasoningControl({ model: mango, catalog: [entry(["low", "medium", "high"])], variants: none })?.value).toBe(
      "high",
    )
  })

  test("a model that is on or off starts on", () => {
    expect(reasoningControl({ model: mango, catalog: [entry(["off", "on"])], variants: none })).toMatchObject({
      levels: ["off", "on"],
      value: "on",
    })
    expect(reasoningControl({ model: mango, catalog: [entry(["off", "on"], "off")], variants: none })?.value).toBe("off")
  })

  test("no levels, no control", () => {
    expect(reasoningControl({ model: mango, catalog: [entry([])], variants: none })).toBeUndefined()
  })

  test("one level alone is no choice", () => {
    expect(reasoningControl({ model: mango, catalog: [entry(["on"])], variants: none })).toBeUndefined()
  })

  test("no control while the catalog is not read, for a model it does not list, or on the other PC's engine", () => {
    expect(reasoningControl({ model: mango, catalog: undefined, variants: none })).toBeUndefined()
    expect(reasoningControl({ model: { ...mango, id: "other" }, catalog: [entry(["off", "on"])], variants: none })).toBe(
      undefined,
    )
    expect(reasoningControl({ model: mango, catalog: [entry(["off", "on"])], remote: true, variants: none })).toBe(
      undefined,
    )
    expect(reasoningControl({ model: undefined, catalog: [entry(["off", "on"])], variants: none })).toBeUndefined()
  })

  test("the Team through OpenRouter chooses among the model's variants low, medium and high", () => {
    const team = { id: "manager", provider: { id: "openrouter" } }
    const variants = { list: () => ["high", "low", "medium"], current: () => "low" }
    expect(reasoningControl({ model: team, catalog: [entry(["off", "on"])], variants })).toEqual({
      source: "team",
      levels: ["low", "medium", "high"],
      value: "low",
    })
  })

  test("the Team with no variant chosen shows the middle one; with none of the three, no control", () => {
    const team = { id: "manager", provider: { id: "openrouter" } }
    const three = { list: () => ["low", "medium", "high"], current: () => undefined }
    expect(reasoningControl({ model: team, catalog: [], variants: three })?.value).toBe("medium")
    expect(reasoningControl({ model: team, catalog: [], variants: { list: () => ["minimal"], current: () => undefined } }))
      .toBeUndefined()
    expect(reasoningControl({ model: team, catalog: [], variants: none })).toBeUndefined()
  })

  test("a model of another provider keeps the box as it is", () => {
    const other = { id: "claude", provider: { id: "anthropic" } }
    const variants = { list: () => ["low", "medium", "high"], current: () => "low" }
    expect(reasoningControl({ model: other, catalog: [], variants })).toBeUndefined()
  })
})

describe("saving the choice", () => {
  test("it goes into the model's choices as the level, the rest as it was", () => {
    const choices = entry(["low", "medium", "high"]).choices
    const saved: Record<string, unknown> = { ...withReasoning(choices, "high") }
    expect(saved).toEqual({ ...choices, reasoning: "high" })
  })
})
