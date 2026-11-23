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

// two plugins that add a fixed text to the system prompt, as the app's own plugins do
const plugin = {
  trigger: (name: string, _input: unknown, output: { system?: string[] }) => {
    if (name === "experimental.chat.system.transform") output.system?.push("Fixed text of a plugin.", "Text of another plugin.")
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

const prepareWith = (input: {
  env: string[]
  system?: string[]
  plugin?: Plugin.Interface
  providerID?: string
  parentSessionID?: string
}) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "mango", modelID: "qwen" } },
      sessionID: "ses_1",
      parentSessionID: input.parentSessionID,
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

type Prepared = Awaited<ReturnType<typeof prepareWith>>

const prepare = (env: string[]) => prepareWith({ env })

const systemMessages = (result: Prepared) => result.messages.filter((message) => message.role === "system")
const systemText = (result: Prepared) => String(systemMessages(result)[0]?.content)

describe("the system prompt of a request", () => {
  test("is one system message, first, with the fixed part, the plugins' texts and the environment in this order", async () => {
    const result = await prepare(["<env>\n  Working directory: C:\\a\n</env>"])
    expect(systemMessages(result)).toHaveLength(1)
    expect(result.messages[0]?.role).toBe("system")
    expect(result.messages.slice(1).map((message) => message.role)).toEqual(["user"])
    expect(systemText(result)).toBe(
      "You are an agent.\nStable instructions.\nFixed text of a plugin.\nText of another plugin.\n<env>\n  Working directory: C:\\a\n</env>",
    )
  })

  test("is one system message also when no plugin adds anything or there is no environment", async () => {
    const result = await prepareWith({ env: [], plugin: quiet })
    expect(systemMessages(result)).toHaveLength(1)
    expect(systemText(result)).toBe("You are an agent.\nStable instructions.")
  })

  test("two projects share everything up to the working folder", async () => {
    const [a, b] = await Promise.all([prepare(["<env>C:\\a</env>"]), prepare(["<env>C:\\b</env>"])])
    const one = systemText(a)
    const two = systemText(b)
    const first = [...one].findIndex((char, index) => char !== two[index])
    expect(first).toBe(one.indexOf("C:\\a") + "C:\\".length)
  })
})

describe("the stable part of the system prompt, for the engine", () => {
  const env = ["<env>\n  Working directory: C:\\a\n</env>"]
  const bytes = (result: Prepared) => Number(result.headers["X-Mango-Stable-Prompt"])
  const stable = (result: Prepared) => Buffer.from(systemText(result)).subarray(0, bytes(result)).toString()

  test("a request to the app's engine says how many bytes of the system message come before the working folder and the date", async () => {
    const result = await prepare(env)
    expect(stable(result)).toBe("You are an agent.\nStable instructions.\nFixed text of a plugin.\nText of another plugin.")
    expect(systemText(result).slice(stable(result).length)).toBe("\n" + env[0])
  })

  test("the bytes are those of UTF-8, not the characters", async () => {
    const text = "Règles stables: è, ù, €."
    const result = await prepareWith({ system: [text], env, plugin: quiet })
    expect(stable(result)).toBe("You are an agent.\n" + text)
    expect(bytes(result)).toBeGreaterThan(("You are an agent.\n" + text).length)
  })

  test("without a working folder the whole text is stable", async () => {
    const result = await prepareWith({ env: [], plugin: quiet })
    expect(bytes(result)).toBe(Buffer.byteLength(systemText(result)))
  })

  test("a model that is not the app's has no such header", async () => {
    const result = await prepareWith({ env, providerID: "openai" })
    expect(result.headers["X-Mango-Stable-Prompt"]).toBeUndefined()
  })
})

describe("the headers of a request", () => {
  test("to the app's engine, nothing says which session it is or which program sends it", async () => {
    const result = await prepareWith({ env: [], parentSessionID: "ses_0" })
    expect(Object.keys(result.headers).map((name) => name.toLowerCase())).toEqual(["x-mango-stable-prompt"])
  })

  test("to another provider, they say which session it is", async () => {
    const result = await prepareWith({ env: [], providerID: "openrouter", parentSessionID: "ses_0" })
    expect(result.headers["x-session-affinity"]).toBe("ses_1")
    expect(result.headers["x-opencode-session-id"]).toBe("ses_1")
    expect(result.headers["x-parent-session-id"]).toBe("ses_0")
  })
})
