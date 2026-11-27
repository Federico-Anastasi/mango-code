import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { SETTINGS_PATH } from "../../src/server/shared/mango-settings"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// mango-code: the page of what goes into the prompt reads `/mango/settings` also before any model is on the computer.
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("the prompt settings", () => {
  test("an agent without any model answers with nothing to list instead of an error", async () => {
    await using tmp = await tmpdir({ git: true, config: { enabled_providers: ["mango"] } })
    const response = await Server.Default().app.request(`${SETTINGS_PATH}?directory=${encodeURIComponent(tmp.path)}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ directory: tmp.path, model: null, items: [] })
  })

  test("with a model it lists what a new conversation would carry", async () => {
    const local = { name: "local", tool_call: true, attachment: false, temperature: true, limit: { context: 32768, output: 4096 } }
    await using tmp = await tmpdir({
      git: true,
      config: {
        enabled_providers: ["mango"],
        provider: {
          mango: {
            name: "mango-code",
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "dummy", baseURL: "http://127.0.0.1:9/v1" },
            models: { local },
          },
        },
      },
    })
    const response = await Server.Default().app.request(`${SETTINGS_PATH}?directory=${encodeURIComponent(tmp.path)}`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.model).toBe("local")
    expect(body.items.some((item: { type: string }) => item.type === "base")).toBe(true)
    expect(body.items.some((item: { type: string }) => item.type === "tools")).toBe(true)
  })
})

describe("the prompt settings of a harness", () => {
  const local = { name: "local", tool_call: true, attachment: false, temperature: true, limit: { context: 32768, output: 4096 } }
  const config = {
    enabled_providers: ["mango"],
    provider: {
      mango: {
        name: "mango-code",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "dummy", baseURL: "http://127.0.0.1:9/v1" },
        models: { local },
      },
    },
  }
  const url = (directory: string, harness: string) =>
    `${SETTINGS_PATH}?directory=${encodeURIComponent(directory)}&harness=${encodeURIComponent(harness)}`
  type Item = { type: string; name: string; enabled: boolean; tokens: number | null; description?: string }

  test("Mango Harness 2 lists its own prompt, tools, skills and hooks", async () => {
    await using tmp = await tmpdir({ git: true, config })
    const response = await Server.Default().app.request(url(tmp.path, "mango-harness-2"))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { harness: string; items: Item[] }
    expect(body.harness).toBe("mango-harness-2")
    const named = (type: string) => body.items.filter((item) => item.type === type).map((item) => item.name)
    expect(named("base")).toEqual(["base"])
    expect(named("tools")).toEqual(["skill", "terminal", "powershell", "read", "write", "edit", "search", "web_search", "web_open", "page_view", "page_act", "ask", "plan"])
    expect(named("skills").sort()).toEqual(["debugging", "done", "page-check", "planning", "test-first", "web-research"])
    expect(body.items.find((item) => item.type === "hooks" && item.name === "would-lose")).toMatchObject({ enabled: true, tokens: null })
    expect(body.items.find((item) => item.type === "tools" && item.name === "terminal")).toMatchObject({ description: expect.stringMatching(/^Runs one command/) })
    expect(body.items.find((item) => item.type === "hooks" && item.name === "discipline-messages")).toMatchObject({ enabled: false })
    expect(named("plugins")).toEqual([])
  })

  test("a hook switched off only for this folder is off for this harness, not for the default one", async () => {
    await using tmp = await tmpdir({ git: true, config })
    const put = await Server.Default().app.request(url(tmp.path, "mango-harness-2"), {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "tauri://localhost" },
      body: JSON.stringify({ type: "hooks", name: "would-lose", enabled: false, scope: "folder" }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ type: "hooks", name: "would-lose", enabled: false, source: "folder" })
    const second = (await (await Server.Default().app.request(url(tmp.path, "mango-harness-2"))).json()) as { items: Item[] }
    expect(second.items.find((item) => item.type === "hooks" && item.name === "would-lose")?.enabled).toBe(false)
    const first = (await (await Server.Default().app.request(url(tmp.path, "mango-harness-1"))).json()) as { items: Item[] }
    expect(first.items.some((item) => item.type === "hooks" && item.name === "would-lose")).toBe(false)
  })

  test("a harness that is not there is a 404 with its name", async () => {
    await using tmp = await tmpdir({ git: true, config })
    const response = await Server.Default().app.request(url(tmp.path, "gone"))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).toContain("gone")
  })
})
