import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { ENGINE_WARMUP_PATH } from "../../src/server/shared/engine-warmup"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// mango-code: the engine warmup route builds the request of a new conversation in the folder `?directory=`
// and sends it to the engine with a single token; the outcome says how many tokens the engine read.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function post(directory?: string) {
  const query = directory === undefined ? "" : `?directory=${encodeURIComponent(directory)}`
  return Server.Default().app.request(ENGINE_WARMUP_PATH + query, { method: "POST" })
}

/** A fake engine: answers in streaming with llama-server's `timings`. */
function fakeEngine(promptTokens: number) {
  const seen: { headers: Headers; body: Record<string, any> }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({ headers: request.headers, body: (await request.json()) as Record<string, any> })
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "local" }
      const body =
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
          timings: { prompt_n: promptTokens, prompt_ms: 1234.5, predicted_n: 1, predicted_ms: 20 },
        }) +
        "data: [DONE]\n\n"
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, seen }
}

const mangoConfig = (baseURL: string) => ({
  model: "mango/local",
  provider: {
    mango: {
      name: "mango-code",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "dummy", baseURL },
      models: {
        local: {
          name: "local",
          tool_call: true,
          reasoning: true,
          attachment: false,
          temperature: true,
          limit: { context: 32768, output: 4096 },
        },
      },
    },
  },
})

describe("engine warmup", () => {
  test("without a folder answers 400", async () => {
    const response = await post()
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain("directory")
  })

  test("folder that does not exist: 404 like the other routes", async () => {
    await using tmp = await tmpdir()
    const response = await post(path.join(tmp.path, "does-not-exist"))
    expect(response.status).toBe(404)
    expect((await response.json()).name).toBe("DirectoryNotFound")
  })

  test("sends the engine the request of a new conversation with a single token and reports its prefill", async () => {
    const engine = fakeEngine(13637)
    try {
      await using tmp = await tmpdir({ git: true, config: mangoConfig(`http://127.0.0.1:${engine.server.port}/v1`) })
      const response = await post(tmp.path)
      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json).toMatchObject({ ready: true, model: "mango/local", promptTokens: 13637, promptMs: 1234.5 })
      expect(json.tools).toBeGreaterThan(0)

      expect(engine.seen).toHaveLength(1)
      const [request] = engine.seen
      expect(request.headers.get("x-mango-warmup")).toBe("1")
      expect(request.body.max_tokens ?? request.body.max_completion_tokens).toBe(1)
      // the system prompt names the folder: that is why the base is per folder
      expect(request.body.messages[0].role).toBe("system")
      expect(request.body.messages[0].content).toContain(`Working directory: ${tmp.path}`)
      expect(request.body.messages.at(-1).role).toBe("user")
      expect(request.body.tools.length).toBe(json.tools)
    } finally {
      engine.server.stop(true)
    }
  })

  test("engine that does not answer: ready false with the reason, not a server error", async () => {
    await using tmp = await tmpdir({ git: true, config: mangoConfig("http://127.0.0.1:9/v1") })
    const response = await post(tmp.path)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.ready).toBe(false)
    expect(typeof json.error).toBe("string")
  })

  test("the default model is not on the local engine: skipped, no requests", async () => {
    const engine = fakeEngine(1)
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "other/model",
          provider: {
            other: {
              name: "other",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "x", baseURL: `http://127.0.0.1:${engine.server.port}/v1` },
              models: { model: { name: "m", tool_call: true, limit: { context: 8000, output: 1000 } } },
            },
          },
        },
      })
      const response = await post(tmp.path)
      const json = await response.json()
      expect(json.ready).toBe(false)
      expect(json.skipped).toContain("other/model")
      expect(engine.seen).toHaveLength(0)
    } finally {
      engine.server.stop(true)
    }
  })
})
