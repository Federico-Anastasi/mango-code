import { describe, expect, test } from "bun:test"
import {
  pictureAgain,
  pictureDescription,
  pictureFileName,
  pictureFrameWidth,
  pictureProgress,
  pictureSeconds,
  pictureSides,
  pictureStage,
  pictureTime,
  pictureWords,
} from "./picture-state"

describe("what the row of a picture says", () => {
  test("each stage has its words; drawing says the step", () => {
    expect(pictureWords({ stage: "rewriting" }).key).toBe("ui.picture.stage.rewriting")
    expect(pictureWords({ stage: "waiting" }).key).toBe("ui.picture.stage.waiting")
    expect(pictureWords({ stage: "preparing" }).key).toBe("ui.picture.stage.preparing")
    expect(pictureWords({ stage: "finishing" }).key).toBe("ui.picture.stage.finishing")
    expect(pictureWords({ stage: "drawing", step: 5, steps: 8 })).toEqual({
      key: "ui.picture.stage.drawing",
      params: { step: 5, steps: 8 },
    })
  })
  test("drawing without a step yet is still preparing; no stage at all is the start", () => {
    expect(pictureWords({ stage: "drawing", step: 0, steps: 0 }).key).toBe("ui.picture.stage.preparing")
    expect(pictureWords({}).key).toBe("ui.picture.stage.starting")
    expect(pictureWords({ stage: "somewhere else" }).key).toBe("ui.picture.stage.starting")
    expect(pictureStage({ stage: "somewhere else" })).toBeUndefined()
  })
  test("the bar fills with the steps, is full while finishing, and is absent before the first step", () => {
    expect(pictureProgress({ stage: "drawing", step: 2, steps: 8 })).toBe(25)
    expect(pictureProgress({ stage: "drawing", step: 0, steps: 8 })).toBe(0)
    expect(pictureProgress({ stage: "drawing", step: 20, steps: 8 })).toBe(100)
    expect(pictureProgress({ stage: "finishing", step: 8, steps: 8 })).toBe(100)
    expect(pictureProgress({ stage: "preparing" })).toBeUndefined()
    expect(pictureProgress({ stage: "drawing" })).toBeUndefined()
  })
})

describe("the frame of the picture", () => {
  test("its long side is 320 px whatever the proportions", () => {
    expect(pictureFrameWidth(pictureSides({ width: 1024, height: 1024 }))).toBe(320)
    expect(pictureFrameWidth(pictureSides({ width: 1280, height: 720 }))).toBe(320)
    expect(pictureFrameWidth(pictureSides({ width: 576, height: 1024 }))).toBe(180)
  })
  test("a part that does not say how big the picture is gets a square", () => {
    expect(pictureSides({})).toEqual({ width: 1, height: 1 })
    expect(pictureFrameWidth(pictureSides({ width: 0, height: "x" }))).toBe(320)
  })
})

describe("what the part tells of the picture", () => {
  test("the seconds it took, from the part's times", () => {
    expect(pictureSeconds({ start: 1000, end: 16_400 })).toBe(15)
    expect(pictureSeconds({ start: 1000 })).toBeUndefined()
    expect(pictureSeconds(undefined)).toBeUndefined()
  })
  test("a picture waiting for the user's permission says so and counts no time", () => {
    expect(pictureWords({ stage: "asking" }).key).toBe("ui.picture.stage.asking")
    expect(pictureTime({ stage: "asking" }, { start: 1000, end: undefined })).toBeUndefined()
  })
  test("a picture in the line has no time to count, and one that began counts from there, not from the part's start", () => {
    const time = { start: 1000, end: undefined }
    expect(pictureTime({ stage: "waiting" }, time)).toBeUndefined()
    expect(pictureTime({ stage: "waiting", began: 5000 }, time)).toBeUndefined()
    expect(pictureTime({ stage: "preparing", began: 21_000 }, time)).toEqual({ start: 21_000, end: undefined })
    expect(pictureSeconds(pictureTime({ file: "a.png", began: 21_000 }, { start: 1000, end: 41_400 }))).toBe(20)
    expect(pictureTime({ stage: "rewriting" }, time)).toEqual({ start: 1000, end: undefined })
    expect(pictureTime({ stage: "drawing" }, undefined)).toBeUndefined()
  })
  test("the file name, from either kind of path", () => {
    expect(pictureFileName({ file: "C:\\P\\immagini\\vespa-2.png" })).toBe("vespa-2.png")
    expect(pictureFileName({ file: "/p/images/vespa.png" })).toBe("vespa.png")
    expect(pictureFileName({})).toBeUndefined()
  })
  test("the description, once the turn has written it", () => {
    expect(pictureDescription({ prompt: "a red Vespa" })).toBe("a red Vespa")
    expect(pictureDescription({ prompt: "  " })).toBeUndefined()
    expect(pictureDescription({ request: "una Vespa" })).toBeUndefined()
  })
})

describe("a picture made again", () => {
  const record = {
    input: { request: "a red Vespa", format: "portrait", size: "large", prompt: "old", name: "vespa" },
    metadata: { model: "b", seed: 7, file: "C:\\p\\images\\vespa.png" },
  }
  test("the same request, format, size and model, with the description as it is", () => {
    expect(pictureAgain(record, " a red Vespa, photograph ")).toEqual({
      request: "a red Vespa",
      format: "portrait",
      size: "large",
      model: "b",
      prompt: "a red Vespa, photograph",
    })
  })
  test("the model asked for stands in when the picture did not record the one that drew it", () => {
    expect(pictureAgain({ input: { ...record.input, model: "c" }, metadata: {} }, "x")?.model).toBe("c")
  })
  test("a picture the model made by itself, an empty description or no model give nothing", () => {
    expect(pictureAgain({ input: { prompt: "p", name: "n" }, metadata: record.metadata }, "x")).toBeUndefined()
    expect(pictureAgain(record, "  ")).toBeUndefined()
    expect(pictureAgain({ input: record.input, metadata: {} }, "x")).toBeUndefined()
  })
  test("a picture that does not say its format or its size is not made again in another shape", () => {
    const { format: _format, ...noFormat } = record.input
    expect(pictureAgain({ input: noFormat, metadata: record.metadata }, "x")).toBeUndefined()
    expect(pictureAgain({ input: { ...record.input, size: "huge" }, metadata: record.metadata }, "x")).toBeUndefined()
  })
})
