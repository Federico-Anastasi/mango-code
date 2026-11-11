import { describe, expect, test } from "bun:test"
import { modelsInfo } from "../../src/server/shared/mango-models"

describe("what the model menu says about each model", () => {
  test("it is what the app put in the environment, by model key", () => {
    const info = { "3.6": { bytes: 18209036576, place: "cpu", speed: "fair", weak: false }, toq: { bytes: 9489952128, place: "gpu", speed: null, weak: true } }
    expect(modelsInfo({ MANGO_MODELS_INFO: JSON.stringify(info) })).toEqual(info)
  })

  test("an agent that the app did not start has nothing to say, and a broken value says nothing instead of breaking the menu", () => {
    expect(modelsInfo({})).toEqual({})
    for (const broken of ["", "{", "[]", "null", "3", '"x"']) expect(modelsInfo({ MANGO_MODELS_INFO: broken }), broken).toEqual({})
  })
})
