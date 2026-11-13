import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Server } from "../../src/server/server"
import { RELOAD_PATH } from "../../src/server/shared/mango-reload"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// mango-code: after the app rewrote opencode.json, `/mango/reload` makes the agent read it again, but never under an
// answer in progress: reading it again would interrupt it.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

/** A fake engine whose answers to the conversation wait for `release`; the title of the conversation answers at once. */
function engine() {
  const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "local" }
  const answer =
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n"
  const held = Promise.withResolvers<void>()
  const asked = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const title = (await request.text()).includes("Generate a title")
      if (!title) {
        asked.resolve()
        await held.promise
      }
      return new Response(answer, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, release: held.resolve, asked: asked.promise }
}

const localModel = (name: string) => ({
  name,
  tool_call: true,
  attachment: false,
  temperature: true,
  limit: { context: 32768, output: 4096 },
})

const config = (baseURL: string, models: string[]) => ({
  model: "mango/local",
  enabled_providers: ["mango"],
  provider: {
    mango: {
      name: "mango-code",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "dummy", baseURL },
      models: Object.fromEntries(models.map((key) => [key, localModel(key)])),
    },
  },
})

function call(directory: string, route: string, init?: RequestInit) {
  return Server.Default().app.request(route, {
    ...init,
    headers: { "x-opencode-directory": directory, "content-type": "application/json", ...init?.headers },
  })
}

async function models(directory: string) {
  const body = await (await call(directory, "/config/providers")).json()
  return Object.keys(body.providers.find((p: { id: string }) => p.id === "mango")?.models ?? {}).sort()
}

const rewrite = (directory: string, baseURL: string, keys: string[]) =>
  Bun.write(path.join(directory, "opencode.json"), JSON.stringify(config(baseURL, keys)))

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("timed out")
}

describe("reading the configuration again", () => {
  test("with no conversation answering it is read again at once", async () => {
    const fake = engine()
    try {
      const baseURL = `http://127.0.0.1:${fake.server.port}/v1`
      await using tmp = await tmpdir({ git: true, config: config(baseURL, ["local"]) })
      expect(await models(tmp.path)).toEqual(["local"])
      await rewrite(tmp.path, baseURL, ["added", "local"])
      const response = await call(tmp.path, RELOAD_PATH, { method: "POST" })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ reloaded: true })
      expect(await models(tmp.path)).toEqual(["added", "local"])
    } finally {
      fake.server.stop(true)
    }
  }, 30_000)

  test("a dispose that fails answers 500, not reloaded", async () => {
    const fake = engine()
    // A listener that breaks when a folder is disposed makes the dispose fail.
    const broken = (event: GlobalEvent) => {
      if (event.payload?.type === "server.instance.disposed") throw new Error("listener broke")
    }
    GlobalBus.on("event", broken)
    const off = () => GlobalBus.off("event", broken)
    try {
      const baseURL = `http://127.0.0.1:${fake.server.port}/v1`
      await using tmp = await tmpdir({ git: true, config: config(baseURL, ["local"]) })
      expect(await models(tmp.path)).toEqual(["local"])
      const response = await call(tmp.path, RELOAD_PATH, { method: "POST" })
      expect(response.status).toBe(500)
      expect((await response.json()).error).toContain("listener broke")
    } finally {
      off()
      fake.server.stop(true)
    }
  }, 30_000)

  test("an answer in progress keeps the configuration before, and it is read again when the answer ends", async () => {
    const fake = engine()
    try {
      const baseURL = `http://127.0.0.1:${fake.server.port}/v1`
      await using tmp = await tmpdir({ git: true, config: config(baseURL, ["local"]) })
      const session = await (await call(tmp.path, "/session", { method: "POST", body: "{}" })).json()
      const sent = await call(tmp.path, `/session/${session.id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
      })
      expect(sent.status).toBeLessThan(300)
      await fake.asked

      await rewrite(tmp.path, baseURL, ["added", "local"])
      const response = await call(tmp.path, RELOAD_PATH, { method: "POST" })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ reloaded: false })
      expect(await models(tmp.path)).toEqual(["local"])

      fake.release()
      await until(async () => (await models(tmp.path)).includes("added"))
      // The answer was not interrupted: it ended with the engine's text and no error.
      const messages = await (await call(tmp.path, `/session/${session.id}/message`)).json()
      const last = messages.at(-1)
      expect(last.info.role).toBe("assistant")
      expect(last.info.error).toBeUndefined()
      expect(last.parts.some((p: { type: string; text?: string }) => p.type === "text" && p.text === "Hello")).toBe(true)
    } finally {
      fake.server.stop(true)
    }
  }, 30_000)
})
