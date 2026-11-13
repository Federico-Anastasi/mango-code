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
