import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { setEngineOrigin } from "@/provider/engine-timings"
import { PromptMeasurement } from "@/session/prompt-measurement"

// An engine that counts one word per token, like the app's fake engine.
let engine: ReturnType<typeof Bun.serve>
let calls = 0
let broken = false

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++
      if (broken) return new Response("no engine", { status: 503 })
      const { content } = (await req.json()) as { content: string }
      return Response.json({ tokens: content.split(/\s+/).filter(Boolean).map(() => 0) })
    },
  })
  setEngineOrigin(`http://127.0.0.1:${engine.port}/v1`)
})

afterAll(() => engine.stop(true))

describe("token measurement of the prompt items", () => {
  test("each item has its tokens, counted by the engine, and they come back per folder and model", async () => {
    const r = await PromptMeasurement.measure("C:\\Projects\\a", "fake", [
      { kind: "tools", name: "bash", text: "runs a command in the shell" },
      { kind: "mcp", name: "documents", text: "one two three" },
      { kind: "plugins", name: "mango-documents", text: "" },
    ])
    expect(r.errors).toEqual([])
    expect(PromptMeasurement.tokens("C:\\Projects\\a", "fake", "tools", "bash")).toBe(6)
    expect(PromptMeasurement.tokens("c:\\projects\\A", "fake", "mcp", "documents")).toBe(3)
    expect(PromptMeasurement.tokens("C:\\Projects\\a", "fake", "plugins", "mango-documents")).toBe(0)
    // another folder, or another model (another tokenizer), have no measurements
    expect(PromptMeasurement.tokens("C:\\Projects\\b", "fake", "tools", "bash")).toBeUndefined()
    expect(PromptMeasurement.tokens("C:\\Projects\\a", "other", "tools", "bash")).toBeUndefined()
  })

  test("an item without text is not invented: it stays unmeasured", async () => {
    await PromptMeasurement.measure("C:\\Projects\\c", "fake", [{ kind: "mcp", name: "off" }])
    expect(PromptMeasurement.tokens("C:\\Projects\\c", "fake", "mcp", "off")).toBeUndefined()
  })

  test("a new measurement of the same model updates the items it carries and keeps the others; another model starts again", async () => {
    await PromptMeasurement.measure("C:\\Projects\\d", "fake", [
      { kind: "skills", name: "pdf", text: "one two" },
      { kind: "plugins", name: "mango-discipline", text: "one two three four" },
    ])
    await PromptMeasurement.measure("C:\\Projects\\d", "fake", [{ kind: "skills", name: "pdf", text: "one two three" }])
    expect(PromptMeasurement.tokens("C:\\Projects\\d", "fake", "skills", "pdf")).toBe(3)
    expect(PromptMeasurement.tokens("C:\\Projects\\d", "fake", "plugins", "mango-discipline")).toBe(4)
    await PromptMeasurement.measure("C:\\Projects\\d", "other", [{ kind: "skills", name: "pdf", text: "one" }])
    expect(PromptMeasurement.tokens("C:\\Projects\\d", "other", "skills", "pdf")).toBe(1)
    expect(PromptMeasurement.tokens("C:\\Projects\\d", "other", "plugins", "mango-discipline")).toBeUndefined()
    expect(PromptMeasurement.tokens("C:\\Projects\\d", "fake", "skills", "pdf")).toBeUndefined()
  })

  test("the folder remembers the model of its last measurement: the one picked in the chat, not the default", async () => {
    expect(PromptMeasurement.measuredModel("C:\\Projects\\e")).toBeUndefined()
    await PromptMeasurement.measure("C:\\Projects\\e", "toq", [{ kind: "tools", name: "bash", text: "one" }])
    await PromptMeasurement.measure("C:\\Projects\\e", "3.6", [{ kind: "tools", name: "bash", text: "one two" }])
    expect(PromptMeasurement.measuredModel("c:\\projects\\E")).toBe("3.6")
    expect(PromptMeasurement.tokens("C:\\Projects\\e", "3.6", "tools", "bash")).toBe(2)
  })

  test("if the engine does not answer the item stays unmeasured and the error is reported", async () => {
    broken = true
    const r = await PromptMeasurement.measure("C:\\Projects\\e", "fake", [{ kind: "tools", name: "bash", text: "one two" }])
    broken = false
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain("503")
    expect(PromptMeasurement.tokens("C:\\Projects\\e", "fake", "tools", "bash")).toBeUndefined()
  })

  test("what a plugin adds to a message comes back per conversation, only once", () => {
    PromptMeasurement.recordPlugin("ses_1", "mango-discipline", ["reminder one", "two"])
    PromptMeasurement.recordPlugin("ses_1", "mango-discipline", [])
    PromptMeasurement.recordPlugin("ses_1", "mango-web-diet", [])
    PromptMeasurement.recordPlugin(undefined, "mango-discipline", ["without a conversation"])
    const seen = PromptMeasurement.takePlugins("ses_1")
    expect(seen?.get("mango-discipline")).toBe("reminder one\ntwo")
    // a plugin that ran without adding anything weighs zero: it is not "unmeasured"
    expect(seen?.get("mango-web-diet")).toBe("")
    expect(PromptMeasurement.takePlugins("ses_1")).toBeUndefined()
    // after the measurement the conversation collects nothing more
    PromptMeasurement.recordPlugin("ses_1", "mango-discipline", ["late"])
    expect(PromptMeasurement.takePlugins("ses_1")).toBeUndefined()
    expect(calls).toBeGreaterThan(0)
  })
})
