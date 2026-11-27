import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Effect, Fiber, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Env } from "@/env"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { LLM } from "@/session/llm"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { Harness } from "@/session/harness"
import { CommandsHarness } from "@/session/commands-harness"
import { versionOf } from "@/mango-harness/version"
import { jsonSchema, tool } from "ai"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { MessageID, PartID } from "@/session/schema"

const LAUNCHER = path.resolve(import.meta.dir, "../../../../launcher")
const saved = { home: process.env.MANGO_HOME, settings: process.env.MANGO_SETTINGS }
let data: string

beforeAll(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "harness-commands-"))
  process.env.MANGO_HOME = LAUNCHER
  process.env.MANGO_SETTINGS = path.join(data, "settings.json")
  fs.writeFileSync(
    path.join(data, "choices.json"),
    JSON.stringify({
      models: {
        "commands-model": { harness: "mango-harness-2" },
        "seeing-model": { harness: "mango-harness-2" },
        "own-model": { harness: "own-first" },
      },
    }),
  )
  // a harness of the user's made from Mango Harness 1, with its own base prompt and its own words for one tool
  const own = path.join(data, "harness", "own-first")
  fs.mkdirSync(own, { recursive: true })
  fs.writeFileSync(path.join(own, "harness.json"), JSON.stringify({ name: "Own", from: "mango-harness-1" }))
  fs.writeFileSync(path.join(own, "prompt.md"), "OWN BASE PROMPT")
  fs.writeFileSync(path.join(own, "tools.json"), JSON.stringify({ bash: { description: "OWN WORDS FOR BASH" } }))
  Harness.forget()
})

afterAll(() => {
  for (const [key, value] of [
    ["MANGO_HOME", saved.home],
    ["MANGO_SETTINGS", saved.settings],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Harness.unwatch()
  Harness.forget()
  fs.rmSync(data, { recursive: true, force: true })
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected"),
    authenticate: () => Effect.die("unexpected"),
    finishAuth: () => Effect.die("unexpected"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const model = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  cost: { input: 0, output: 0 },
  options: {},
})

const PLUGIN = [
  "export default async () => ({",
  '  "experimental.chat.system.transform": (_input, output) => { output.system.push("PLUGIN SYSTEM") },',
  '  "chat.message": (_input, output) => {',
  '    output.parts.push({ id: "prt_plugin", messageID: output.message.id, sessionID: output.message.sessionID, type: "text", text: "PLUGIN MESSAGE", synthetic: true })',
  "  },",
  '  "tool.execute.after": (_input, output) => { output.output += "\\nPLUGIN AFTER" },',
  "})",
  "",
].join("\n")

const setup = Effect.fn("test.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const file = path.join(directory, "plugin.mjs")
  fs.writeFileSync(file, PLUGIN)
  fs.writeFileSync(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [pathToFileURL(file).href],
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "commands-model": model("commands-model"),
            "plain-model": model("plain-model"),
            // the smallest context the app offers
            "small-model": { ...model("small-model"), limit: { context: 32768, output: 4096 } },
            "own-model": model("own-model"),
            "seeing-model": { ...model("seeing-model"), attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
          },
          options: { apiKey: "test-key", baseURL: llm.url },
        },
      },
    }),
  )
  return { directory, llm }
})

type Calls = { name: string; args: unknown }[]
type Fake = {
  messages: string[]
  calls: Calls
  held: string[]
  closed: number
  options?: CommandsHarness.Options
}

/** A harness with the shape of the real one: its prompt comes from the version, the rules block follows the user's text. */
const fake = (): Fake => {
  const state: Fake = { messages: [], calls: [], held: [], closed: 0 }
  CommandsHarness.opening(async (options) => {
    state.options = options
    return {
      system: () => [options.version.system(options.project)],
      message: (given: string) => {
        state.messages.push(given)
        return `${given}\n\nRULES`
      },
      call: async (name: string, args: Record<string, unknown>) => {
        state.calls.push({ name, args })
        return name === "write" ? { text: "refused", failed: true } : { text: `answer of ${name}`, failed: false }
      },
      answer: () => state.held.shift(),
      close: async () => {
        state.closed++
      },
    } as unknown as Awaited<ReturnType<CommandsHarness.Opener>>
  })
  return state
}

beforeEach(() => {
  Harness.forget()
})

const run = Effect.fn("test.run")(function* (modelID: string, text = "hello") {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* prompt.prompt({
    sessionID: session.id,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make(modelID) },
    noReply: true,
    parts: [{ type: "text", text }],
  })
  return { prompt, sessions, session }
})

// A PNG of one pixel.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const bodies = (llm: TestLLMServer["Service"]) => llm.inputs.pipe(Effect.map((all) => all as Record<string, any>[]))

describe("a conversation whose harness is `commands`", () => {
  it.instance("the system message is the harness's prompt alone, and nothing is added by the plugins", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("commands-model")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const [body] = yield* bodies(llm)
      const system = body.messages.filter((message: { role: string }) => message.role === "system")
      expect(system).toHaveLength(1)
      expect(system[0].content).toBe(state.options!.version.system(state.options!.project))
      expect(system[0].content).toStartWith("You are Mango Code")
      expect(JSON.stringify(body)).not.toContain("PLUGIN")
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"])
    }),
  )

  it.instance("the tools sent are the harness's, in its order, and the user's text is the harness's message", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session, sessions } = yield* run("commands-model")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const [body] = yield* bodies(llm)
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
        "skill",
        "terminal",
        "powershell",
        "read",
        "write",
        "edit",
        "search",
        "web_search",
        "web_open",
        "page_view",
        "page_act",
        "ask",
        "plan",
      ])
      expect(body.messages[1]).toEqual({ role: "user", content: "hello\n\nRULES" })
      expect(state.messages).toEqual(["hello"])

      const stored = (yield* sessions.messages({ sessionID: session.id })).find((m) => m.info.role === "user")
      expect(stored?.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text)).toEqual(["hello"])
    }),
  )

  it.instance("a model that sees is offered page_look, and the picture of a call reaches it inside the tool message", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("seeing-model")
      CommandsHarness.opening(async (options) => {
        state.options = options
        return {
          system: () => [options.version.system(options.project)],
          message: (given: string) => given,
          call: async (name: string) =>
            name === "page_look"
              ? { text: "The picture of the page follows.", failed: false, images: [{ mime: "image/png", base64: PIXEL }] }
              : { text: "x", failed: false },
          answer: () => undefined,
          close: async () => {},
        } as unknown as Awaited<ReturnType<CommandsHarness.Opener>>
      })
      yield* llm.tool("page_look", {})
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const [first, second] = yield* bodies(llm)
      expect(first.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("page_look")
      const answer = second.messages.find((message: { role: string }) => message.role === "tool")
      expect(answer.content).toEqual([
        { type: "text", text: "The picture of the page follows." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } },
      ])
      expect(second.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1)
    }),
  )

  it.instance("a model that does not see is not offered page_look", () =>
    Effect.gen(function* () {
      fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("commands-model")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })
      const [body] = yield* bodies(llm)
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain("page_look")
    }),
  )

  it.instance("a tool call goes to the harness and the model reads its answer alone", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("commands-model")
      yield* llm.tool("read", { path: "a.txt" })
      yield* llm.tool("write", { path: "b.txt" })
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      expect(state.calls).toEqual([
        { name: "read", args: { path: "a.txt" } },
        { name: "write", args: { path: "b.txt" } },
      ])
      const last = (yield* bodies(llm)).at(-1)!
      expect(last.messages.filter((message: { role: string }) => message.role === "tool").map((message: { content: string }) => message.content)).toEqual([
        "answer of read",
        "refused",
      ])
      expect(JSON.stringify(last)).not.toContain("PLUGIN")
    }),
  )

  it.instance("the harness is made once for the conversation, with its folder and the user's own skills, and closed with it", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm, directory } = yield* setup()
      fs.mkdirSync(path.join(directory, ".opencode", "skill", "mine"), { recursive: true })
      fs.writeFileSync(
        path.join(directory, ".opencode", "skill", "mine", "SKILL.md"),
        "---\nname: mine\ndescription: My own way.\n---\n\nDo it my way.\n",
      )
      const { prompt, session, sessions } = yield* run("commands-model")
      yield* llm.tool("read", { path: "a.txt" })
      yield* llm.text("done")
      let opened = 0
      CommandsHarness.opening(async (options) => {
        opened++
        state.options = options
        return {
          system: () => [options.version.system(options.project)],
          message: (given: string) => given,
          call: async () => ({ text: "x", failed: false }),
          answer: () => undefined,
          close: async () => {
            state.closed++
          },
        } as unknown as Awaited<ReturnType<CommandsHarness.Opener>>
      })
      yield* prompt.loop({ sessionID: session.id })

      expect(opened).toBe(1)
      expect(state.options!.project).toBe(directory)
      expect(state.options!.skills).toContainEqual({ name: "mine", description: "My own way.", body: "Do it my way." })
      yield* sessions.remove(session.id)
      yield* pollWithTimeout(Effect.sync(() => (state.closed === 1 ? true : undefined)), "the harness was not closed")
    }),
  )

  it.instance("a final answer that the harness holds is not the end: its text reaches the model as a user message", () =>
    Effect.gen(function* () {
      const state = fake()
      state.held.push("OPEN A PAGE FIRST")
      const { llm } = yield* setup()
      const { prompt, session, sessions } = yield* run("commands-model")
      yield* llm.text("first answer")
      yield* llm.text("second answer")
      yield* prompt.loop({ sessionID: session.id })

      const [, second] = yield* bodies(llm)
      expect(second.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant", "user"])
      expect(second.messages[2].content).toBe("first answer")
      expect(second.messages[3].content).toBe("OPEN A PAGE FIRST")
      expect(state.messages).toEqual(["hello"])

      const first = (yield* sessions.messages({ sessionID: session.id })).find(
        (m) => m.info.role === "assistant" && m.parts.some((part) => part.type === "text" && part.text === "first answer"),
      )
      const text = first?.parts.find((part) => part.type === "text")
      expect(text?.type === "text" && text.metadata?.harness?.held).toBe(true)
    }),
  )

  it.instance("a call the engine cannot read is asked again, at most as many times as the hook says", () =>
    Effect.gen(function* () {
      fake()
      const { llm } = yield* setup()
      // as llama.cpp sends it: the stream is open, then an error event
      const unreadable = raw({
        head: [{ error: { code: 500, type: "server_error", message: "The model produced output that does not match the expected peg-native format" } }],
      })
      const { prompt, session } = yield* run("commands-model")
      yield* llm.push(unreadable, unreadable)
      yield* llm.text("done")
      const result = yield* prompt.loop({ sessionID: session.id })

      const inputs = yield* bodies(llm)
      expect(inputs).toHaveLength(3)
      expect(inputs[1]).toEqual(inputs[0])
      expect(inputs[2]).toEqual(inputs[0])
      expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
    }),
  )

  it.instance("past the number of tries the error is the conversation's", () =>
    Effect.gen(function* () {
      fake()
      const { llm } = yield* setup()
      // as llama.cpp sends it: the stream is open, then an error event
      const unreadable = raw({
        head: [{ error: { code: 500, type: "server_error", message: "The model produced output that does not match the expected peg-native format" } }],
      })
      const { prompt, session } = yield* run("commands-model")
      yield* llm.push(unreadable, unreadable, unreadable)
      const result = yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.hits).toHaveLength(3)
      expect(result.info.role === "assistant" && result.info.error).toBeTruthy()
    }),
  )

  it.instance("the question of the harness to the user is a question in the chat", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("commands-model")
      yield* llm.tool("ask", { question: "Which one?" })
      yield* llm.text("done")
      CommandsHarness.opening(async (options) => {
        state.options = options
        return {
          system: () => [options.version.system(options.project)],
          message: (given: string) => given,
          call: async () => ({ text: `the user said ${await options.user("Which one?", ["red", "blue"])}`, failed: false }),
          answer: () => undefined,
          close: async () => {},
        } as unknown as Awaited<ReturnType<CommandsHarness.Opener>>
      })
      const question = yield* Question.Service
      const loop = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      const asked = yield* pollWithTimeout(
        question.list().pipe(Effect.map((all) => all.at(0))),
        "the question did not reach the chat",
      )
      expect(asked.questions[0].question).toBe("Which one?")
      expect(asked.questions[0].options.map((option) => option.label)).toEqual(["red", "blue"])
      expect(asked.tool?.callID).toBeTruthy()
      yield* question.reply({ requestID: asked.id, answers: [["blue"]] })
      yield* Fiber.join(loop)
      const last = (yield* bodies(llm)).at(-1)!
      expect(JSON.stringify(last.messages)).toContain("the user said blue")
    }),
  )
})

describe("a conversation whose harness is not `commands`", () => {
  it.instance("keeps the base prompt, the plugins' additions and the tools of the agent", () =>
    Effect.gen(function* () {
      const state = fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("plain-model")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const [body] = yield* bodies(llm)
      expect(state.options).toBeUndefined()
      expect(JSON.stringify(body.messages)).toContain("PLUGIN SYSTEM")
      expect(JSON.stringify(body.messages)).toContain("PLUGIN MESSAGE")
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
      expect(names).toContain("bash")
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    }),
  )
})

describe("a harness of the user's made from Mango Harness 1", () => {
  it.instance("sends its own base prompt and its own description of a tool, the rest as Mango Harness 1", () =>
    Effect.gen(function* () {
      fake()
      const { llm } = yield* setup()
      const { prompt, session } = yield* run("own-model")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const [body] = yield* bodies(llm)
      expect(body.messages[0].content).toStartWith("OWN BASE PROMPT")
      expect(JSON.stringify(body.messages)).toContain("PLUGIN SYSTEM")
      const bash = body.tools.find((tool: { function: { name: string } }) => tool.function.name === "bash")
      expect(bash.function.description).toBe("OWN WORDS FOR BASH")
    }),
  )
})

describe("the request of a `commands` conversation, made", () => {
  const prepare = (commands: { system: string; stable: number; retries: number } | undefined) =>
    Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_user",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "mango", modelID: "m" },
        },
        sessionID: "ses_1",
        model: {
          id: "mango/m",
          providerID: "mango",
          api: { id: "m", url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
          capabilities: { temperature: true },
          limit: { context: 32768, output: 4096 },
          options: {},
          headers: {},
        },
        agent: { name: "build", mode: "primary", options: {}, permission: [] },
        system: ["Stable instructions."],
        env: ["Working directory: x"],
        messages: [{ role: "user", content: "Hello" }],
        tools: { zeta: {}, alpha: {} },
        provider: { id: "mango", options: {} },
        plugin: {
          trigger: (name: string, _input: unknown, output: { system?: string[] }) => {
            if (name === "experimental.chat.system.transform") output.system?.push("PLUGIN SYSTEM")
            return Effect.succeed(output)
          },
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        },
        flags: { client: "test" },
        commands,
      } as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]),
    )

  it.live("has the prompt of the harness alone, the tools in the order given and the stable length as header", () =>
    Effect.promise(async () => {
      const prepared = await prepare({ system: "Project: x. Date.", stable: 9, retries: 2 })
      expect(prepared.messages).toEqual([
        { role: "system", content: "Project: x. Date." },
        { role: "user", content: "Hello" },
      ])
      expect(Object.keys(prepared.tools)).toEqual(["zeta", "alpha"])
      expect(prepared.headers["X-Mango-Stable-Prompt"]).toBe("9")
    }),
  )

  it.live("is what it was without the harness: base prompt, plugin text, sorted tools, length of the stable part", () =>
    Effect.promise(async () => {
      const prepared = await prepare(undefined)
      expect(JSON.stringify(prepared.messages[0])).toContain("Stable instructions.\\nPLUGIN SYSTEM\\nWorking directory: x")
      expect(Object.keys(prepared.tools)).toEqual(["alpha", "zeta"])
      expect(Number(prepared.headers["X-Mango-Stable-Prompt"])).toBeGreaterThan(9)
    }),
  )
})

describe("the stable part of the prompt", () => {
  it.live("ends where the first value that changes begins", () =>
    Effect.sync(() => {
      const template = "Intro.\nProject: {{project}}. Date {{date}}.\nMore."
      expect(CommandsHarness.stableLength(template, "Intro.\nProject: demo. Date today.\nMore.")).toBe(
        Buffer.byteLength("Intro.\nProject: "),
      )
      expect(CommandsHarness.stableLength("Fixed è.", "Fixed è.\n\nInstructions from: CLAUDE.md\nx")).toBe(
        Buffer.byteLength("Fixed è."),
      )
      expect(() => CommandsHarness.stableLength(template, "Other prompt")).toThrow()
    }),
  )
})

describe("the tools of the harness with the user's own", () => {
  const entry = () => {
    const calls: string[] = []
    const definition = Harness.forModel("commands-model")
    const made = {
      id: definition.id,
      harness: {
        call: async (name: string) => {
          calls.push(name)
          return { text: `the harness says ${name}`, failed: false }
        },
      },
      version: versionOf(definition),
      definition,
      turn: { messages: 0, calls: 0 },
      running: {},
      system: "",
      stable: 0,
      retries: 0,
      said: new Map<string, string>(),
      queue: Promise.resolve(),
    } as unknown as CommandsHarness.Entry
    return { made, calls }
  }
  const own = (name: string) =>
    tool({
      description: name,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => ({ title: "", metadata: {}, output: `the answer of ${name}` }),
    })

  it.live("come after the harness's, in the order given, and the user's tool answers for itself", () =>
    Effect.promise(async () => {
      const { made, calls } = entry()
      const set = CommandsHarness.tools(made, {
        sessionID: "ses_1" as never,
        messageID: "msg_1" as never,
        own: { mcp_b: own("mcp_b"), mcp_a: own("mcp_a") },
        settle: async () => {},
      })
      expect(Object.keys(set).slice(12)).toEqual(["plan", "mcp_b", "mcp_a", "invalid"])
      expect(Object.keys(set)[0]).toBe("skill")
      const answer = await set.mcp_b.execute!({}, { toolCallId: "c1", messages: [] })
      expect(answer).toEqual({ title: "", metadata: {}, output: "the answer of mcp_b" })
      expect(calls).toEqual(["mcp_b"])
    }),
  )

  it.live("an unknown tool is answered by the harness, a known one with bad arguments by the error", () =>
    Effect.promise(async () => {
      const { made, calls } = entry()
      const set = CommandsHarness.tools(made, { sessionID: "ses_1" as never, messageID: "msg_1" as never, own: {}, settle: async () => {} })
      const options = { toolCallId: "c1", messages: [] }
      expect(await set.invalid.execute!({ tool: "nothing", error: "x" }, options)).toMatchObject({
        output: "the harness says nothing",
      })
      expect(await set.invalid.execute!({ tool: "read", error: "bad arguments" }, options)).toMatchObject({
        output: "bad arguments",
      })
      expect(calls).toEqual(["nothing"])
    }),
  )

  it.live("the calls of one message run one after the other, in the order the model wrote them", () =>
    Effect.promise(async () => {
      const { made } = entry()
      const steps: string[] = []
      const slow = {
        ...made,
        harness: {
          call: async (name: string, args: { path?: string }) => {
            steps.push(`start ${args.path ?? name}`)
            await Bun.sleep(args.path === "first" ? 50 : 1)
            steps.push(`end ${args.path ?? name}`)
            return { text: "done", failed: false }
          },
        },
      } as unknown as CommandsHarness.Entry
      const own = tool({
        description: "mine",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ title: "", metadata: {}, output: "mine" }),
      })
      const set = CommandsHarness.tools(slow, { sessionID: "ses_1" as never, messageID: "msg_1" as never, own: { mcp_x: own }, settle: async () => {} })
      await Promise.all([
        set.read.execute!({ path: "first" }, { toolCallId: "c1", messages: [] }),
        set.read.execute!({ path: "second" }, { toolCallId: "c2", messages: [] }),
        set.mcp_x.execute!({}, { toolCallId: "c3", messages: [] }),
      ])
      expect(steps).toEqual(["start first", "end first", "start second", "end second", "start mcp_x", "end mcp_x"])
    }),
  )

  it.live("a call still waiting when the user stops the turn does not run", () =>
    Effect.promise(async () => {
      const { made } = entry()
      const calls: string[] = []
      const slow = {
        ...made,
        harness: {
          call: async (name: string) => {
            calls.push(name)
            await Bun.sleep(50)
            return { text: "done", failed: false }
          },
        },
      } as unknown as CommandsHarness.Entry
      const stop = new AbortController()
      const set = CommandsHarness.tools(slow, { sessionID: "ses_1" as never, messageID: "msg_1" as never, own: {}, settle: async () => {} })
      const first = set.read.execute!({ path: "a" }, { toolCallId: "c1", messages: [], abortSignal: stop.signal })
      const second = set.write.execute!({ path: "b" }, { toolCallId: "c2", messages: [], abortSignal: stop.signal })
      await Bun.sleep(10)
      stop.abort()
      await first
      await expect(second).rejects.toThrow()
      expect(calls).toEqual(["read"])
    }),
  )

  it.live("a tool the settings switched off is not sent", () =>
    Effect.promise(async () => {
      const { made } = entry()
      const set = CommandsHarness.tools(made, {
        sessionID: "ses_1" as never,
        messageID: "msg_1" as never,
        own: {},
        settle: async () => {},
        enabled: (name) => name !== "terminal",
      })
      expect(Object.keys(set)).not.toContain("terminal")
      expect(Object.keys(set)).toContain("read")
    }),
  )

  it.live("the discipline turned on comes after the user's message and after a tool's answer, every so many", () =>
    Effect.promise(async () => {
      const { made } = entry()
      const texts = { ...made.definition.texts, "discipline-messages": "MESSAGES", "discipline-calls": "CALLS" }
      const hooks = { ...made.definition.hooks, "discipline-messages": { on: true, every: 2 }, "discipline-calls": { on: true, every: 2 } }
      const disciplined = { ...made, definition: { ...made.definition, texts, hooks }, harness: { ...made.harness, message: (given: string) => given } } as unknown as CommandsHarness.Entry
      const user = (id: string, text: string) => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] }) as never
      const said = CommandsHarness.messages(disciplined, [user("m1", "one"), user("m2", "two"), user("m3", "three")])
      expect(said.map((m) => (m.parts[0] as { text: string }).text)).toEqual(["one\n\nMESSAGES", "two", "three\n\nMESSAGES"])
      const set = CommandsHarness.tools(disciplined, { sessionID: "ses_1" as never, messageID: "msg_1" as never, own: {}, settle: async () => {} })
      const options = { toolCallId: "c1", messages: [] }
      const first = await set.read.execute!({ path: "a" }, options)
      const second = await set.read.execute!({ path: "a" }, options)
      expect((first as { output: string }).output).toBe("the harness says read")
      expect((second as { output: string }).output).toBe("the harness says read\n\nCALLS")
    }),
  )
})

const OVER = { input: 96_000, output: 20 }
const SHORT = 2_000
const roles = (body: Record<string, any>) => body.messages.map((message: { role: string }) => message.role)
const text = (content: unknown) =>
  typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("")
const toolNames = (body: Record<string, any>) => body.tools.map((item: { function: { name: string } }) => item.function.name)

describe("the summary of a long conversation, for every harness", () => {
  it.instance("the request for it is the next request with the instruction after it, and the work goes on from the last result", () =>
    Effect.gen(function* () {
      fake()
      const { llm } = yield* setup()
      const { prompt, session, sessions } = yield* run("commands-model", "read the file")
      yield* llm.push(reply().tool("read", { path: "a.txt" }).usage(OVER))
      yield* llm.text("## Objective\n- read a.txt")
      yield* llm.text("all done")
      yield* prompt.loop({ sessionID: session.id })

      const all = yield* bodies(llm)
      expect(all).toHaveLength(3)
      const [first, asked, after] = all
      // the same system message and tools, the same messages, and the instruction as a message of the user after the
      // last result: inside the result the model reads it as part of the work
      expect(asked.messages.slice(0, 2)).toEqual(first.messages)
      expect(roles(asked)).toEqual(["system", "user", "assistant", "tool", "user"])
      expect(asked.tools).toEqual(first.tools)
      expect(text(asked.messages.at(-2).content)).not.toContain("<system-reminder>")
      const instruction = text(asked.messages.at(-1).content)
      const compaction = Harness.definition("mango-harness-2").compaction
      expect(instruction).toStartWith(compaction.first)
      expect(instruction).toContain(compaction.template)
      expect(instruction).toEndWith(compaction.rule)

      // what the model reads next: the summary where the user's message was, the last exchange, and nothing asking it to go on
      expect(roles(after)).toEqual(["system", "user", "assistant", "tool"])
      expect(toolNames(after)).toEqual(toolNames(first))
      expect(text(after.messages[1].content)).toStartWith(Harness.definition("mango-harness-2").compaction.continued)
      expect(text(after.messages[1].content)).toContain("## Objective\n- read a.txt")
      expect(text(after.messages[1].content)).toContain(`${Harness.definition("mango-harness-2").compaction["files-read"]}\n- a.txt`)
      expect(JSON.stringify(after)).not.toContain("Continue if you have next steps")

      const stored = yield* sessions.messages({ sessionID: session.id })
      expect(stored.filter((item) => item.info.role === "assistant" && item.info.summary).length).toBe(1)
      // the user's own message and the one the agent wrote after the summary are the only messages of the user
      expect(stored.filter((item) => item.info.role === "user")).toHaveLength(3)
    }),
  )

  it.instance("a turn that had ended is not taken up again, and the next message of the user finds the summary in place", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "a.txt"), "alpha")
      const { prompt, session } = yield* run("plain-model", "say hello")
      yield* llm.text("hello", { usage: OVER })
      yield* llm.text("## Objective\n- greet")
      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(2)
      const [first, asked] = yield* bodies(llm)
      expect(asked.messages.slice(0, -1)).toEqual([...first.messages, { role: "assistant", content: "hello" }])
      expect(text(asked.messages.at(-1).content)).toStartWith(Harness.definition("mango-harness-1").compaction.first)
      expect(toolNames(asked)).toEqual(toolNames(first))

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("plain-model") },
        noReply: true,
        parts: [{ type: "text", text: "and now goodbye" }],
      })
      yield* llm.text("bye")
      yield* prompt.loop({ sessionID: session.id })
      const [, , next] = yield* bodies(llm)
      expect(roles(next)).toEqual(["system", "user", "assistant", "user"])
      expect(text(next.messages[1].content)).toStartWith(Harness.definition("mango-harness-1").compaction.continued)
      expect(text(next.messages.at(-1).content)).toContain("and now goodbye")
    }),
  )

  it.instance("a model that calls a tool instead of writing the summary runs nothing: the agent writes it from the calls, and the work goes on", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      // three files of about 3,300 tokens: on a context of 32,768 the last messages kept as they are hold only the last read
      for (const name of ["b1", "b2", "b3"])
        fs.writeFileSync(path.join(directory, `${name}.txt`), Array.from({ length: 600 }, (_, n) => `line ${n} of the file ${name}`).join("\n"))
      const { prompt, session, sessions } = yield* run("small-model", "read the three files")
      const read = (name: string) => reply().tool("read", { filePath: path.join(directory, `${name}.txt`) })
      yield* llm.push(read("b1").usage({ input: 2_000, output: 20 }), read("b2").usage({ input: 6_000, output: 20 }), read("b3").usage({ input: 31_000, output: 20 }))
      yield* llm.tool("write", { filePath: path.join(directory, "written.txt"), content: "no" })
      yield* llm.text("all three read")
      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(5)
      expect(fs.existsSync(path.join(directory, "written.txt"))).toBe(false)
      const stored = yield* sessions.messages({ sessionID: session.id })
      const summary = stored.find((item) => item.info.role === "assistant" && item.info.summary)
      expect(summary?.info.role === "assistant" && summary.info.error).toBeUndefined()
      expect(summary?.info.role === "assistant" && summary.info.finish).toBe("stop")

      // the next request: the summary the agent wrote, with the calls before the last messages and the start of their
      // answers, then the last read as it was
      const after = (yield* bodies(llm))[4]!
      const told = text(after.messages[1].content)
      const unwritten = Harness.definition("mango-harness-1").compaction.unwritten
      expect(told).toContain(unwritten)
      expect(told).toMatch(/- read .*b1\.txt[\s\S]*→ .*line 0 of the file b1/)
      expect(told).toMatch(/- read .*b2\.txt[\s\S]*→ .*line 0 of the file b2/)
      expect(told.split(Harness.definition("mango-harness-1").compaction["files-read"])[0]).not.toContain("b3.txt")
      expect(told).not.toContain("line 500 of the file b1")
      expect(JSON.stringify(after.messages.slice(2))).toContain("line 500 of the file b3")
      expect(summary?.parts.find((part) => part.type === "text")).toMatchObject({ text: expect.stringMatching(new RegExp(`^${RegExp.escape(unwritten)}`)) })
    }),
  )

  it.instance("results of one step larger than the room left are cut, the longest first, and the model is told how to read the rest", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      // three files of about 7,500 tokens each, read in one step at 26,000 tokens of a context of 32,768
      for (const name of ["c1", "c2", "c3"])
        fs.writeFileSync(path.join(directory, `${name}.txt`), Array.from({ length: 1_400 }, (_, n) => `line ${n} of the file ${name}`).join("\n"))
      fs.writeFileSync(path.join(directory, "small.txt"), "a small file")
      const { prompt, session, sessions } = yield* run("small-model", "read the files")
      const read = (name: string) => ({ name: "read", input: { filePath: path.join(directory, `${name}.txt`) } })
      yield* llm.push(reply().tools([read("c1"), read("c2"), read("c3"), read("small")]).usage({ input: 12_000, output: 20 }))
      yield* llm.text("read them")
      yield* prompt.loop({ sessionID: session.id })

      const all = yield* bodies(llm)
      expect(all).toHaveLength(2)
      const results = all[1]!.messages.filter((message: { role: string }) => message.role === "tool").map((message: { content: unknown }) => text(message.content))
      const cut = Harness.definition("mango-harness-1").compaction.cut.split("{{")[0]!
      expect(results.filter((result: string) => result.includes(cut))).toHaveLength(3)
      expect(results.find((result: string) => result.includes("a small file"))).not.toContain(cut)
      // what the next request adds fits in what was left of the context
      const added = results.reduce((sum: number, result: string) => sum + result.length, 0) / 4
      expect(added).toBeLessThan(32_768 - 12_000 - 4_096)
      expect(results[0]).toContain("line 0 of the file c1")
      // the cut is kept: the model reads the same result at every request
      const stored = yield* sessions.messages({ sessionID: session.id })
      const outputs = stored.flatMap((item) => item.parts).flatMap((part) => (part.type === "tool" && part.state.status === "completed" ? [part.state.output] : []))
      expect(outputs.filter((output) => output.includes(cut))).toHaveLength(3)
    }),
  )

  it.instance("the request for a summary keeps the room to reason and write it: the newest results are shortened there alone", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "b.txt"), "beta")
      // about 6,000 tokens once read
      fs.writeFileSync(path.join(directory, "a.txt"), Array.from({ length: 900 }, (_, n) => `line ${n} of the file a`).join("\n"))
      const { prompt, session, sessions } = yield* run("small-model", "read the files")
      const read = (name: string, input: number) => reply().tool("read", { filePath: path.join(directory, `${name}.txt`) }).usage({ input, output: 20 })
      yield* llm.push(read("b", 8_000), read("a", 22_000))
      yield* llm.text("## Objective\n- read a.txt")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const all = yield* bodies(llm)
      expect(all).toHaveLength(4)
      const asked = JSON.stringify(all[2])
      expect(asked).toContain("[Tool output truncated for compaction")
      expect(asked).not.toContain("line 899 of the file a")
      // what was shortened for the summary is whole after it, and in the conversation
      expect(JSON.stringify(all[3])).toContain("line 899 of the file a")
      expect(JSON.stringify(all[3])).not.toContain("[Tool output truncated for compaction")
      const stored = yield* sessions.messages({ sessionID: session.id })
      const outputs = stored.flatMap((item) => item.parts).flatMap((part) => (part.type === "tool" && part.state.status === "completed" ? [part.state.output] : []))
      expect(outputs.some((output) => output.includes("line 899 of the file a"))).toBe(true)
    }),
  )

  it.instance("after a summary a result that another summary can make room for is not cut, and the work goes on", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      const lines = (count: number, name: string) => Array.from({ length: count }, (_, n) => `line ${n} of the file ${name}`).join("\n")
      fs.writeFileSync(path.join(directory, "b.txt"), "beta")
      // about 8,000 tokens each once read
      fs.writeFileSync(path.join(directory, "a.txt"), lines(1_100, "a"))
      fs.writeFileSync(path.join(directory, "c.txt"), lines(1_100, "c"))
      const { prompt, session, sessions } = yield* run("small-model", "read the files")
      const read = (name: string, input: number) => reply().tool("read", { filePath: path.join(directory, `${name}.txt`) }).usage({ input, output: 20 })
      // the system prompt and the tools are 8,000 tokens; the first request after the summary reads 18,000: the result of c
      // does not fit in what is left (6,500), but it fits in what a second summary leaves (9,200)
      yield* llm.push(read("b", 8_000), read("a", 27_000))
      yield* llm.text("## Objective\n- one")
      yield* llm.push(read("c", 18_000))
      yield* llm.text("## Objective\n- two")
      yield* llm.text("all read")
      yield* prompt.loop({ sessionID: session.id })

      const stored = yield* sessions.messages({ sessionID: session.id })
      const outputs = stored.flatMap((item) => item.parts).flatMap((part) => (part.type === "tool" && part.state.status === "completed" ? [part.state.output] : []))
      expect(outputs.some((output) => output.includes(Harness.definition("mango-harness-1").compaction.cut.split("{{")[0]!))).toBe(false)
      expect(stored.filter((item) => item.info.role === "assistant" && item.info.summary)).toHaveLength(2)
      expect(stored.at(-1)?.parts.some((part) => part.type === "text" && part.text === "all read")).toBe(true)
    }),
  )

  it.instance("a step that fills the context again right after a summary ends the turn with an error, not with another summary", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "a.txt"), "alpha")
      const { prompt, session, sessions } = yield* run("small-model", "read it twice")
      const read = () => reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage({ input: 31_000, output: 20 })
      yield* llm.push(read())
      yield* llm.text("## Objective\n- read a.txt")
      yield* llm.push(read(), read())
      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(3)
      const stored = yield* sessions.messages({ sessionID: session.id })
      expect(stored.filter((item) => item.info.role === "assistant" && item.info.summary)).toHaveLength(1)
      const last = stored.findLast((item) => item.info.role === "assistant")!.info as SessionV1.Assistant
      expect(last.error?.name).toBe("ContextOverflowError")
      expect(JSON.stringify(last.error)).toContain("too small for this conversation")
    }),
  )

  it.instance("a summary the agent writes after another of its own says once that the model did not write it", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "a.txt"), "alpha")
      const { prompt, session, sessions } = yield* run("plain-model", "read it")
      const refused = httpError(400, { error: { message: "After the optional system message, conversation roles must alternate user/assistant" } })
      const read = () => reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage(OVER)
      yield* llm.push(read(), refused)
      yield* llm.text("it says alpha")
      yield* prompt.loop({ sessionID: session.id })
      yield* llm.push(read(), refused)
      yield* llm.text("still alpha")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("plain-model") },
        noReply: true,
        parts: [{ type: "text", text: "again" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const stored = yield* sessions.messages({ sessionID: session.id })
      const summaries = stored.filter((item) => item.info.role === "assistant" && item.info.summary)
      expect(summaries).toHaveLength(2)
      const second = summaries[1]!.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      const sentence = Harness.definition("mango-harness-1").compaction.unwritten
      expect(second.split(sentence).length - 1).toBe(1)
    }),
  )

  it.instance("an engine that refuses the request for a summary does not stop the conversation: the agent writes the summary", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "a.txt"), "alpha")
      const { prompt, session, sessions } = yield* run("plain-model", "read it")
      const refused = httpError(400, { error: { message: "After the optional system message, conversation roles must alternate user/assistant" } })
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage(OVER), refused)
      yield* llm.text("it says alpha")
      yield* prompt.loop({ sessionID: session.id })

      expect(yield* llm.calls).toBe(3)
      const stored = yield* sessions.messages({ sessionID: session.id })
      const summary = stored.find((item) => item.info.role === "assistant" && item.info.summary)
      expect(summary?.info.role === "assistant" && summary.info.error).toBeUndefined()
      const after = (yield* bodies(llm))[2]!
      expect(text(after.messages[1].content)).toContain(Harness.definition("mango-harness-1").compaction.unwritten)
      expect(stored.at(-1)?.parts.some((part) => part.type === "text" && part.text === "it says alpha")).toBe(true)
    }),
  )

  it.instance("the summary is asked for while there is still room for it: a big result that came after the last measured request counts", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      // 800 lines, about 5,000 tokens once read
      fs.writeFileSync(path.join(directory, "a.txt"), Array.from({ length: 800 }, (_, n) => `line ${n} of the file`).join("\n"))
      fs.writeFileSync(path.join(directory, "b.txt"), "beta")
      const { prompt, session } = yield* run("small-model", "read the files")
      // the first request read 8,000 tokens (the system prompt and the tools), the last one 27,020: under the 28,672 where
      // the answer cap begins, but the result of the call, the instruction and a summary of 4,096 do not fit in what is
      // left of 32,768; after a summary they do, so the result is not cut
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "b.txt") }).usage({ input: 8_000, output: 20 }))
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage({ input: 27_000, output: 20 }))
      yield* llm.text("## Objective\n- read a.txt")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const all = yield* bodies(llm)
      expect(all).toHaveLength(4)
      expect(text(all[2].messages.at(-1).content)).toStartWith(Harness.definition("mango-harness-1").compaction.first)
      expect(JSON.stringify(all[2])).not.toContain(Harness.definition("mango-harness-1").compaction.cut.split("{{")[0])
      expect(JSON.stringify(all[3])).toContain("## Objective")
    }),
  )

  it.instance("a request the engine finds too large is asked once more with every result cut short, and a second refusal is an error", () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* setup()
      fs.writeFileSync(path.join(directory, "a.txt"), Array.from({ length: 400 }, (_, n) => `line ${n} of the file`).join("\n"))
      fs.writeFileSync(path.join(directory, "b.txt"), "beta")
      const { prompt, session, sessions } = yield* run("plain-model", "read the files")
      const refused = httpError(400, { error: { code: "context_length_exceeded", message: "the request exceeds the available context size" } })
      // the long result comes before the step that fills the context: the request for a summary has it whole
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage({ input: 8_000, output: 20 }))
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "b.txt") }).usage(OVER), refused)
      yield* llm.text("## Objective\n- short")
      yield* llm.text("done")
      yield* prompt.loop({ sessionID: session.id })

      const all = yield* bodies(llm)
      expect(all).toHaveLength(5)
      // the first result alone
      const result = (body: Record<string, any>) => text(body.messages.find((message: { role: string }) => message.role === "tool").content)
      expect(result(all[2]).length).toBeGreaterThan(SHORT)
      expect(result(all[3])).toContain("[Tool output truncated for compaction")
      expect(result(all[3]).length).toBeLessThan(SHORT + 200)
      expect(text(all[3].messages.at(-1).content)).toStartWith(Harness.definition("mango-harness-1").compaction.first)
      expect(JSON.stringify(all[4])).toContain("## Objective")

      // refused twice: the agent writes the summary without the model, and the work goes on
      yield* llm.push(reply().tool("read", { filePath: path.join(directory, "a.txt") }).usage(OVER), refused, refused)
      yield* llm.text("done again")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("plain-model") },
        noReply: true,
        parts: [{ type: "text", text: "again" }],
      })
      yield* prompt.loop({ sessionID: session.id })
      const stored = yield* sessions.messages({ sessionID: session.id })
      const made = stored.filter((item) => item.info.role === "assistant" && item.info.summary).at(-1)
      expect(made?.info.role === "assistant" && made.info.error).toBeUndefined()
      expect(yield* llm.calls).toBe(9)
      // the newest result, shortened to leave the summary its room, is not longer in the request asked once more
      const newest = (body: Record<string, any>) => text(body.messages.findLast((message: { role: string }) => message.role === "tool").content)
      const [refusedOnce, askedAgain] = (yield* bodies(llm)).slice(6, 8)
      expect(newest(refusedOnce!)).toContain("[Tool output truncated for compaction")
      expect(newest(askedAgain!).length).toBeLessThanOrEqual(newest(refusedOnce!).length)
      const next = (yield* bodies(llm)).at(-1)!
      expect(text(next.messages[1].content)).toContain(Harness.definition("mango-harness-1").compaction.unwritten)
    }),
  )

  it.instance("a conversation summarised before the agent wrote its own message goes on from its summary", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Old", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("plain-model") }
      const user = (id: MessageID) => sessions.updateMessage({ id, role: "user", sessionID: session.id, agent: "build", model, time: { created: Date.now() } })
      const assistant = (id: MessageID, parentID: MessageID, extra: Record<string, unknown> = {}) =>
        sessions.updateMessage({
          id,
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          parentID,
          time: { created: Date.now() },
          finish: "stop",
          ...extra,
        })
      const words = (messageID: MessageID, value: string) =>
        sessions.updatePart({ id: PartID.ascending(), messageID, sessionID: session.id, type: "text", text: value })

      // an earlier question and its answer; then a summary asked for (the answer is its tail), with the model's summary and the
      // "Continue" message the earlier compaction added after it
      const one = MessageID.ascending()
      yield* user(one)
      yield* words(one, "old question")
      const two = MessageID.ascending()
      yield* assistant(two, one)
      yield* words(two, "old answer")
      const ask = MessageID.ascending()
      yield* user(ask)
      yield* sessions.updatePart({ id: PartID.ascending(), messageID: ask, sessionID: session.id, type: "compaction", auto: true, tail_start_id: two })
      const summary = MessageID.ascending()
      yield* assistant(summary, ask, { summary: true, mode: "compaction" })
      yield* words(summary, "OLD SUMMARY of the work")
      const resume = MessageID.ascending()
      yield* user(resume)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: resume,
        sessionID: session.id,
        type: "text",
        text: "Continue if you have next steps",
        synthetic: true,
        metadata: { compaction_continue: true },
      })
      const last = MessageID.ascending()
      yield* assistant(last, resume)
      yield* words(last, "carried on")

      yield* prompt.prompt({ sessionID: session.id, agent: "build", model, noReply: true, parts: [{ type: "text", text: "next question" }] })
      yield* llm.text("fine")
      yield* prompt.loop({ sessionID: session.id })

      const [body] = yield* bodies(llm)
      expect(roles(body)).toEqual(["system", "user", "assistant", "user", "assistant", "user"])
      expect(text(body.messages[1].content)).toBe("OLD SUMMARY of the work")
      expect(text(body.messages[2].content)).toBe("old answer")
      expect(text(body.messages.at(-1).content)).toContain("next question")
      expect(JSON.stringify(body)).not.toContain("old question")
      expect(JSON.stringify(body)).not.toContain("What did we do so far")
      expect(yield* llm.calls).toBe(1)
    }),
  )
})
