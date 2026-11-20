import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMRequestPrep } from "@/session/llm/request"
import type { Plugin } from "@/plugin"

const model = {
  id: "mango/qwen",
  providerID: "mango",
  api: { id: "qwen", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
  name: "qwen",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 32768, output: 4096 },
  status: "active",
  options: {},
  headers: {},
} as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]["model"]

// a plugin that adds a fixed text to the system prompt, as the app's own plugins do
const plugin = {
  trigger: (name: string, _input: unknown, output: { system?: string[] }) => {
    if (name === "experimental.chat.system.transform") output.system?.push("Fixed text of a plugin.")
    return Effect.succeed(output)
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as unknown as Plugin.Interface

// a plugin that adds nothing
const quiet = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as unknown as Plugin.Interface

const prepareWith = (input: { env: string[]; system?: string[]; plugin?: Plugin.Interface; providerID?: string }) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "mango", modelID: "qwen" } },
      sessionID: "ses_1",
      model: { ...model, providerID: input.providerID ?? "mango" },
      agent: { name: "build", mode: "primary", options: {}, permission: [], prompt: "You are an agent." },
      system: input.system ?? ["Stable instructions."],
      env: input.env,
      messages: [{ role: "user", content: "Hello" }],
      tools: {},
      provider: { id: "mango", options: {} },
      auth: undefined,
      plugin: input.plugin ?? plugin,
      flags: { outputTokenMax: 32_000, client: "test" },
    } as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]),
  )

const prepare = (env: string[]) => prepareWith({ env })

describe("the system prompt of a request", () => {
  test("ends with the working folder and the date, after what the plugins add", async () => {
    const result = await prepare(["<env>\n  Working directory: C:\\a\n</env>"])
    const text = result.system.join("\n")
    expect(text.indexOf("Fixed text of a plugin.")).toBeGreaterThan(text.indexOf("Stable instructions."))
    expect(text.endsWith("</env>")).toBe(true)
  })

  test("two projects share everything up to the working folder", async () => {
    const [a, b] = await Promise.all([prepare(["<env>C:\\a</env>"]), prepare(["<env>C:\\b</env>"])])
    const one = a.system.join("\n")
    const two = b.system.join("\n")
    const first = [...one].findIndex((char, index) => char !== two[index])
    expect(first).toBe(one.indexOf("C:\\a") + "C:\\".length)
  })
})

describe("the stable part of the system prompt, for the engine", () => {
  const env = ["<env>\n  Working directory: C:\\a\n</env>"]
  const last = (result: Awaited<ReturnType<typeof prepare>>) => result.system[result.system.length - 1]
  const bytes = (result: Awaited<ReturnType<typeof prepare>>) => Number(result.headers["X-Mango-Stable-Prompt"])

  test("a request to the app's engine says how many bytes come before the working folder and the date", async () => {
    const result = await prepare(env)
    expect(Buffer.from(last(result)).subarray(0, bytes(result)).toString()).toBe("Fixed text of a plugin.")
  })

  test("the bytes are those of UTF-8, not the characters", async () => {
    const text = "Règles stables: è, ù, €."
    const result = await prepareWith({ system: [text], env, plugin: quiet })
    expect(Buffer.from(last(result)).subarray(0, bytes(result)).toString()).toBe("You are an agent.\n" + text)
    expect(bytes(result)).toBeGreaterThan(("You are an agent.\n" + text).length)
  })

  test("without a working folder the whole text is stable", async () => {
    const result = await prepareWith({ env: [], plugin: quiet })
    expect(bytes(result)).toBe(Buffer.byteLength(last(result)))
  })

  test("a model that is not the app's has no such header", async () => {
    const result = await prepareWith({ env, providerID: "openai" })
    expect(result.headers["X-Mango-Stable-Prompt"]).toBeUndefined()
  })
})
