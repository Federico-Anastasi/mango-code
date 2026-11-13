import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

const tokens = (directory: string, model: string, kind: string, name: string, text?: string) =>
  PromptMeasurement.tokens(directory, model, { kind, name, text })

/**
 * Runs `body` in another agent process, as after a restart: it has never measured anything and reads what is on disk
 * (in `state`, the test's own by default). In `body`: `PromptMeasurement`, `file` (the weights file) and `fs`.
 */
async function anotherAgent(body: string, state = process.env.XDG_STATE_HOME!) {
  const script = `const { PromptMeasurement } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/prompt-measurement.ts"))})
    const { setEngineOrigin } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/provider/engine-timings.ts"))})
    const { Global } = await import("@opencode-ai/core/global")
    const fs = await import("node:fs")
    setEngineOrigin(${JSON.stringify(`http://127.0.0.1:${engine.port}/v1`)})
    const file = (await import("node:path")).join(Global.Path.state, "prompt-weights.json")
    console.log(JSON.stringify(await (async () => { ${body} })() ?? null))`
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, XDG_STATE_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(err).toBe("")
  return JSON.parse(out)
}

/** A state folder of its own, empty, for an agent that starts with a file in a given condition. */
const freshState = () => fs.mkdtempSync(path.join(os.tmpdir(), "prompt-weights-"))

describe("token measurement of the prompt items", () => {
  test("each item has its tokens, counted by the engine, and they come back per folder and model", async () => {
    const r = await PromptMeasurement.measure("C:\\Projects\\a", "fake", [
      { kind: "tools", name: "bash", text: "runs a command in the shell" },
      { kind: "mcp", name: "documents", text: "one two three" },
      { kind: "plugins", name: "mango-documents", text: "" },
    ])
    expect(r.errors).toEqual([])
    expect(r.unsaved).toBeUndefined()
    expect(tokens("C:\\Projects\\a", "fake", "tools", "bash", "runs a command in the shell")).toBe(6)
    expect(tokens("c:\\projects\\A", "fake", "mcp", "documents", "one two three")).toBe(3)
    expect(tokens("C:\\Projects\\a", "fake", "plugins", "mango-documents", "")).toBe(0)
    expect(tokens("C:\\Projects\\a", "fake", "mcp", "constructor")).toBeUndefined()
    // another folder, or another model (another tokenizer), have no measurements
    expect(tokens("C:\\Projects\\b", "fake", "tools", "bash")).toBeUndefined()
    expect(tokens("C:\\Projects\\a", "other", "tools", "bash")).toBeUndefined()
  })

  test("a weight is shown only for the text it was measured on; an item whose text is not known now keeps it", async () => {
    await PromptMeasurement.measure("C:\\Projects\\h", "fake", [
      { kind: "instructions", name: "CLAUDE.md", text: "Instructions from: CLAUDE.md\nbe brief" },
      { kind: "base", name: "base", text: "You are Mango Code\n  Today's date: Fri Nov 13 2026\n</env>" },
      { kind: "mcp", name: "web-search", text: "search the web" },
    ])
    expect(tokens("C:\\Projects\\h", "fake", "instructions", "CLAUDE.md", "Instructions from: CLAUDE.md\nbe brief")).toBe(5)
    // the file changed after the measurement: its weight is an old one
    expect(tokens("C:\\Projects\\h", "fake", "instructions", "CLAUDE.md", "Instructions from: CLAUDE.md\nbe very brief")).toBeUndefined()
    // another day is not another base prompt
    expect(tokens("C:\\Projects\\h", "fake", "base", "base", "You are Mango Code\n  Today's date: Sat Nov 14 2026\n</env>")).toBe(11)
    // a server that is not connected right now has no text to compare
    expect(tokens("C:\\Projects\\h", "fake", "mcp", "web-search")).toBe(3)
  })

  test("an item without text is not invented: it stays unmeasured", async () => {
    await PromptMeasurement.measure("C:\\Projects\\c", "fake", [{ kind: "mcp", name: "off" }])
    expect(tokens("C:\\Projects\\c", "fake", "mcp", "off")).toBeUndefined()
  })

  test("a new measurement of the same model updates the items it carries and keeps the others; another model starts again", async () => {
    await PromptMeasurement.measure("C:\\Projects\\d", "fake", [
      { kind: "skills", name: "pdf", text: "one two" },
      { kind: "plugins", name: "mango-discipline", text: "one two three four" },
    ])
    await PromptMeasurement.measure("C:\\Projects\\d", "fake", [{ kind: "skills", name: "pdf", text: "one two three" }])
    expect(tokens("C:\\Projects\\d", "fake", "skills", "pdf", "one two three")).toBe(3)
    expect(tokens("C:\\Projects\\d", "fake", "plugins", "mango-discipline")).toBe(4)
    await PromptMeasurement.measure("C:\\Projects\\d", "other", [{ kind: "skills", name: "pdf", text: "one" }])
    expect(tokens("C:\\Projects\\d", "other", "skills", "pdf", "one")).toBe(1)
    expect(tokens("C:\\Projects\\d", "other", "plugins", "mango-discipline")).toBeUndefined()
    expect(tokens("C:\\Projects\\d", "fake", "skills", "pdf")).toBeUndefined()
  })

  test("the folder remembers the model of its last measurement: the one picked in the chat, not the default", async () => {
    expect(PromptMeasurement.measuredModel("C:\\Projects\\e")).toBeUndefined()
    await PromptMeasurement.measure("C:\\Projects\\e", "toq", [{ kind: "tools", name: "bash", text: "one" }])
    await PromptMeasurement.measure("C:\\Projects\\e", "3.6", [{ kind: "tools", name: "bash", text: "one two" }])
    expect(PromptMeasurement.measuredModel("c:\\projects\\E")).toBe("3.6")
    expect(tokens("C:\\Projects\\e", "3.6", "tools", "bash", "one two")).toBe(2)
  })

  test("if the engine does not answer the item stays unmeasured, the error is reported, and the weights there were stay", async () => {
    broken = true
    const r = await PromptMeasurement.measure("C:\\Projects\\e", "fake", [{ kind: "tools", name: "bash", text: "one two" }])
    broken = false
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain("503")
    expect(tokens("C:\\Projects\\e", "fake", "tools", "bash")).toBeUndefined()
    // a measurement with another model that counted nothing does not wipe the good weights, here or on disk
    expect(PromptMeasurement.measuredModel("C:\\Projects\\e")).toBe("3.6")
    expect(await anotherAgent(`return PromptMeasurement.tokens("C:\\\\Projects\\\\e", "3.6", { kind: "tools", name: "bash" })`)).toBe(2)
  }, 30_000)

  test("on the engine of another PC the engine is not asked: its network door does not count tokens, and the item stays unmeasured", async () => {
    const before = calls
    process.env.MANGO_ENGINE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef"
    try {
      const r = await PromptMeasurement.measure("C:\Projects\f", "fake", [{ kind: "tools", name: "bash", text: "one two" }])
      expect(calls).toBe(before)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatch(/another PC|altro PC/)
      expect(r.errors[0]).not.toContain(process.env.MANGO_ENGINE_KEY)
      expect(tokens("C:\Projects\f", "fake", "tools", "bash")).toBeUndefined()
    } finally {
      delete process.env.MANGO_ENGINE_KEY
    }
  })

  test("the weights are on disk: another agent with the same data reads them, for that model and those texts", async () => {
    const folder = "C:\\Users\\Ada\\Documents\\Mango Code\\Contabilità prova B"
    await PromptMeasurement.measure(folder, "3.6", [
      { kind: "tools", name: "bash", text: "one two three" },
      { kind: "mcp", name: "documents", text: "one two" },
    ])
    const read = await anotherAgent(`const folder = "c:\\\\users\\\\ada\\\\documents\\\\mango code\\\\contabilità prova b"
      return [
        PromptMeasurement.measuredModel(folder),
        PromptMeasurement.tokens(folder, "3.6", { kind: "tools", name: "bash", text: "one two three" }),
        PromptMeasurement.tokens(folder, "3.6", { kind: "mcp", name: "documents", text: "one two" }),
        PromptMeasurement.tokens(folder, "ling", { kind: "tools", name: "bash", text: "one two three" }),
        PromptMeasurement.tokens(folder, "3.6", { kind: "tools", name: "bash", text: "one two three four" }),
        PromptMeasurement.takeProblem() ?? null,
      ]`)
    expect(read).toEqual(["3.6", 3, 2, null, null, null])
  }, 30_000)

  test("a file that is not valid counts as empty, is reported once, and the next measurement writes it again", async () => {
    const state = freshState()
    const read = await anotherAgent(
      `fs.mkdirSync((await import("node:path")).dirname(file), { recursive: true })
      fs.writeFileSync(file, "{ half a file")
      const before = [PromptMeasurement.measuredModel("C:\\\\Projects\\\\i"), PromptMeasurement.takeProblem(), PromptMeasurement.takeProblem() ?? null]
      const r = await PromptMeasurement.measure("C:\\\\Projects\\\\i", "3.6", [{ kind: "tools", name: "bash", text: "one two" }])
      return [...before, r.unsaved ?? null, Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))]`,
      state,
    )
    fs.rmSync(state, { recursive: true, force: true })
    expect(read[0]).toBeNull()
    expect(read[1]).toContain("not valid")
    expect(read[2]).toBeNull()
    expect(read[3]).toBeNull()
    expect(read[4]).toEqual([path.resolve("C:\\Projects\\i").toLowerCase()])
  }, 30_000)

  test("a file that cannot be read gives no weights and no error to the page, and is not written over", async () => {
    const state = freshState()
    const read = await anotherAgent(
      `fs.mkdirSync(file, { recursive: true })
      const weight = PromptMeasurement.tokens("C:\\\\Projects\\\\j", "3.6", { kind: "tools", name: "bash" }) ?? null
      const problem = PromptMeasurement.takeProblem()
      const r = await PromptMeasurement.measure("C:\\\\Projects\\\\j", "3.6", [{ kind: "tools", name: "bash", text: "one two" }])
      return [weight, problem, r.unsaved, fs.statSync(file).isDirectory()]`,
      state,
    )
    fs.rmSync(state, { recursive: true, force: true })
    expect(read[0]).toBeNull()
    expect(read[1]).toContain("prompt-weights.json")
    expect(read[2]).toContain("prompt-weights.json")
    expect(read[3]).toBe(true)
  }, 30_000)

  test("a file that cannot be written keeps the weights in memory and says why", async () => {
    const state = freshState()
    const read = await anotherAgent(
      `fs.mkdirSync(file + "." + process.pid + ".tmp", { recursive: true })
      const r = await PromptMeasurement.measure("C:\\\\Projects\\\\k", "3.6", [{ kind: "tools", name: "bash", text: "one two" }])
      return [r.unsaved, PromptMeasurement.tokens("C:\\\\Projects\\\\k", "3.6", { kind: "tools", name: "bash", text: "one two" }), fs.existsSync(file)]`,
      state,
    )
    fs.rmSync(state, { recursive: true, force: true })
    expect(read[0]).toContain("prompt-weights.json")
    expect(read[1]).toBe(2)
    expect(read[2]).toBe(false)
  }, 30_000)

  test("the file keeps the 50 folders measured last; a folder measured again counts as the newest", async () => {
    const item = [{ kind: "tools", name: "bash", text: "one" }]
    const many = async (prefix: string, count: number) => {
      for (const i of Array.from({ length: count }, (_, i) => i))
        await PromptMeasurement.measure(`C:\\Many\\${prefix}${i}`, "fake", item)
    }
    // a full file: only these 50 are in it
    await many("old", 50)
    await PromptMeasurement.measure("C:\\Many\\kept", "fake", item)
    await many("first", 10)
    await PromptMeasurement.measure("C:\\Many\\kept", "fake", item)
    await many("second", 45)
    // the newest 50: first6..first9, kept (measured again after the first ones), second0..second44
    const read = await anotherAgent(
      `const saved = JSON.parse(fs.readFileSync(file, "utf8"))
      const model = (folder) => PromptMeasurement.measuredModel("C:\\\\Many\\\\" + folder) ?? null
      return [Object.keys(saved).length, model("kept"), model("first9"), model("first5"), model("old49")]`,
    )
    expect(read).toEqual([50, "fake", "fake", null, null])
  }, 30_000)

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
