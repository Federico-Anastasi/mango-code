import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTransform } from "@/provider/transform"
import type { Plugin } from "@/plugin"

// Ids of models a user can add: none is a cloud model, but each contains the name of a well-known model family.
const ids = [
  "x-claude-distill",
  "gpt-oss-20b",
  "qwen-gpt-coder",
  "kimi-x",
  "mistral-x",
  "glm-4.7",
  "deepseek-r1-distill",
]
const plain = "qwen3-4b"

const modelOf = (id: string) =>
  ({
    id: `mango/${id}`,
    providerID: "mango",
    api: { id, url: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible" },
    name: id,
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
    release_date: "",
  }) as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]["model"]

const quiet = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as unknown as Plugin.Interface

const prepare = (id: string) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: "msg_user",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "mango", modelID: id },
      },
      sessionID: "ses_1",
      model: modelOf(id),
      agent: { name: "build", mode: "primary", options: {}, permission: [] },
      system: ["Stable instructions."],
      env: [],
      messages: [{ role: "user", content: "Hello" }],
      tools: {},
      provider: { id: "mango", options: {} },
      auth: undefined,
      plugin: quiet,
      flags: { client: "test" },
    } as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]),
  )

// A turn that ends in a tool result followed by the next user message, with ids that a strict provider would rewrite.
const history = (): ModelMessage[] => [
  { role: "system", content: "System." },
  { role: "user", content: "List the files." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      { type: "tool-call", toolCallId: "call:1/ä", toolName: "bash", input: { command: "ls" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call:1/ä",
        toolName: "bash",
        output: { type: "text", value: "a.txt" },
      },
    ],
  },
  { role: "user", content: "Thanks." },
  { role: "assistant", content: [{ type: "text", text: "Welcome." }] },
]

describe("the request for a model the user added is the same whatever the model is called", () => {
  test("the system prompt is the same", async () => {
    const baseline = (await prepare(plain)).messages[0]
    for (const id of ids) expect((await prepare(id)).messages[0]).toEqual(baseline)
  })

  test("no sampling parameter is set for the model's name", async () => {
    for (const id of ids) {
      const { params } = await prepare(id)
      expect(params.temperature).toBeUndefined()
      expect(params.topP).toBeUndefined()
      expect(params.topK).toBeUndefined()
    }
  })

  test("the messages keep their shape: ids unchanged, nothing invented, no cache marks", () => {
    const baseline = ProviderTransform.message(history(), modelOf(plain))
    expect(baseline).toEqual(history())
    for (const id of ids) {
      const result = ProviderTransform.message(history(), modelOf(id))
      expect(result).toEqual(baseline)
      expect(JSON.stringify(result)).not.toContain("cache")
    }
  })
})
