import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { ImageModels } from "./mango-state"
import {
  lastTurnWasPicture,
  offeredWriters,
  pictureFailure,
  pictureMode,
  pictureModel,
  pictureModels,
  pictureRequest,
} from "./mango-picture"

const entry = (key: string, present: boolean) => ({
  key,
  label: key,
  about: "",
  license: null,
  present,
  bytes: 0,
  draws: { placement: "gpu" as const, gpus: [] },
})
const images: ImageModels = { models: [entry("a", false), entry("b", true), entry("c", true)], default: "c" }
const message = (id: string, role: "user" | "assistant") => ({ id, role }) as Message
const tool = (name: string, input: Record<string, unknown>) =>
  ({ type: "tool", tool: name, state: { status: "completed", input } }) as unknown as Part
const parts = (table: Record<string, Part[]>) => (id: string) => table[id] ?? []

describe("the box opens on the kind of the last turn", () => {
  test("a picture asked with words makes the conversation a picture one", () => {
    const messages = [message("u1", "user"), message("a1", "assistant")]
    expect(lastTurnWasPicture(messages, parts({ a1: [tool("image_generate", { request: "a red Vespa" })] }))).toBe(true)
  })
  test("a picture the model made by itself, or a text answer, does not", () => {
    const messages = [message("u1", "user"), message("a1", "assistant")]
    expect(
      lastTurnWasPicture(messages, parts({ a1: [tool("image_generate", { prompt: "a red Vespa", name: "vespa" })] })),
    ).toBe(false)
    expect(lastTurnWasPicture(messages, parts({ a1: [tool("read", { filePath: "a" })] }))).toBe(false)
    expect(lastTurnWasPicture([], parts({}))).toBe(false)
  })
  test("only the last answer counts", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      message("u2", "user"),
      message("a2", "assistant"),
    ]
    expect(
      lastTurnWasPicture(messages, parts({ a1: [tool("image_generate", { request: "x" })], a2: [tool("write", {})] })),
    ).toBe(false)
    expect(
      lastTurnWasPicture(messages, parts({ a1: [tool("write", {})], a2: [tool("image_generate", { request: "x" })] })),
    ).toBe(true)
  })
  test("what the user chose in the box wins over the history", () => {
    expect(pictureMode(undefined, true)).toBe("picture")
    expect(pictureMode(undefined, false)).toBe("text")
    expect(pictureMode({ mode: "text" }, true)).toBe("text")
    expect(pictureMode({ mode: "picture" }, false)).toBe("picture")
    expect(pictureMode({ format: "portrait" }, true)).toBe("picture")
  })
})

describe("the model that draws", () => {
  test("only the models on the computer are offered, in the catalog's order", () => {
    expect(pictureModels(images).map((m) => m.key)).toEqual(["b", "c"])
    expect(pictureModels(undefined)).toEqual([])
  })
  test("the conversation's choice, then the default, then the first on the computer", () => {
    expect(pictureModel({ model: "b" }, images)?.key).toBe("b")
    expect(pictureModel(undefined, images)?.key).toBe("c")
    // a model that left the computer is not the choice any more; a default that is not there neither
    expect(pictureModel({ model: "a" }, images)?.key).toBe("c")
    expect(pictureModel(undefined, { ...images, default: "a" })?.key).toBe("b")
    expect(pictureModel(undefined, { models: [entry("a", false)], default: "a" })).toBeUndefined()
    expect(pictureModel(undefined, undefined)).toBeUndefined()
  })
})

describe("what is sent for the words in the box", () => {
  const base = {
    text: "  an old pizzeria sign  ",
    pick: undefined,
    images,
    rewrite: true,
    rewriter: null,
    offered: [{ providerID: "mango", modelID: "ling" }],
  }
  test("the defaults: square, small, the default model, and the agent chooses who rewrites", () => {
    expect(pictureRequest(base)).toEqual({
      request: "an old pizzeria sign",
      format: "square",
      size: "small",
      model: "c",
    })
  })
  test("the choices of the box", () => {
    expect(pictureRequest({ ...base, pick: { model: "b", format: "landscape", size: "large" } })).toEqual({
      request: "an old pizzeria sign",
      format: "landscape",
      size: "large",
      model: "b",
    })
  })
  test("rewriting off: the words go as they are", () => {
    expect(
      pictureRequest({ ...base, rewrite: false, rewriter: { providerID: "mango", modelID: "ling" } })?.rewrite,
    ).toBe(false)
  })
  test("the chosen rewriter goes when the agent still offers it, otherwise the agent chooses", () => {
    expect(pictureRequest({ ...base, rewriter: { providerID: "mango", modelID: "ling" } })?.rewrite).toEqual({
      providerID: "mango",
      modelID: "ling",
    })
    expect(pictureRequest({ ...base, rewriter: { providerID: "openai", modelID: "gone" } })).not.toHaveProperty(
      "rewrite",
    )
  })
  test("nothing to send without words or without a model that draws", () => {
    expect(pictureRequest({ ...base, text: "  \n " })).toBeUndefined()
    expect(pictureRequest({ ...base, images: { models: [entry("a", false)], default: "a" } })).toBeUndefined()
    expect(pictureRequest({ ...base, images: undefined })).toBeUndefined()
  })
})

test("the sentence of a refusal is read from either shape the agent uses", () => {
  expect(pictureFailure({ error: { message: "busy" } })).toBe("busy")
  expect(pictureFailure({ name: "BusyError", data: { message: "Session is busy" } })).toBe("Session is busy")
  expect(pictureFailure(undefined)).toBeUndefined()
  expect(pictureFailure({})).toBeUndefined()
})

describe("the models that may rewrite", () => {
  const model = (provider: string, id: string) => ({ id, provider: { id: provider } })
  const list = [model("mango", "ling"), model("mango", "gone"), model("openai", "gpt"), model("openai", "hidden")]
  test("the visible ones, and of this computer's only those on the disk", () => {
    const offered = offeredWriters(list, {
      visible: (key) => key.modelID !== "hidden",
      onDisk: (id) => id !== "gone",
    })
    expect(offered.map((m) => `${m.provider.id}/${m.id}`)).toEqual(["mango/ling", "openai/gpt"])
  })
})
