import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import { HARNESS_PATH } from "../../src/server/shared/mango-harness"
import { Harness } from "../../src/session/harness"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// mango-code: the harnesses of the settings page: the list, a copy of the user's, its changes and its removal.
let data: string
const saved = process.env.MANGO_SETTINGS

beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "harness-route-"))
  process.env.MANGO_SETTINGS = path.join(data, "settings.json")
  Harness.forget()
})

afterEach(async () => {
  Harness.unwatch()
  if (saved === undefined) delete process.env.MANGO_SETTINGS
  else process.env.MANGO_SETTINGS = saved
  fs.rmSync(data, { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app
// the settings page is the app's own window
const page = { "content-type": "application/json", origin: "tauri://localhost" }
const send = (method: string, query: string, body?: unknown) =>
  app().request(`${HARNESS_PATH}${query}`, { method, headers: page, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe("the harnesses of the settings page", () => {
  test("the list has Mango Code's two, and says which one is the default", async () => {
    const response = await app().request(HARNESS_PATH)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { default: string; harnesses: { id: string; fixed: boolean; kind: string }[] }
    expect(body.default).toBe("mango-harness-1")
    expect(body.harnesses.map((h) => [h.id, h.fixed, h.kind])).toEqual([
      ["mango-harness-1", true, "opencode"],
      ["mango-harness-2", true, "commands"],
    ])
  })

  test("a harness shows its prompt, its tools and every hook its kind runs, with numbers and texts", async () => {
    const body = (await (await app().request(`${HARNESS_PATH}?id=mango-harness-2`)).json()) as {
      prompt: string
      tools: Record<string, string>
      hooks: Record<string, { on: boolean; every?: number }>
      texts: Record<string, string>
    }
    expect(body.prompt).toStartWith("You are Mango Code")
    expect(Object.keys(body.tools)).toContain("terminal")
    expect(body.hooks["every-calls"]).toEqual({ on: true, every: 8 })
    expect(body.hooks["discipline-messages"]).toEqual({ on: false, every: 3 })
    expect(body.texts["would-lose"]).toContain("{{what}}")
    const first = (await (await app().request(`${HARNESS_PATH}?id=mango-harness-1`)).json()) as { hooks: object }
    expect(Object.keys(first.hooks)).toEqual(["discipline-messages", "discipline-calls"])
  })

  test("duplicate, change, remove", async () => {
    const made = await send("POST", "", { from: "mango-harness-2", name: "My harness" })
    expect(made.status).toBe(200)
    const { id } = (await made.json()) as { id: string }
    expect(id).toBe("my-harness")
    const changed = await send("PUT", `?id=${id}`, { name: "Renamed", hooks: { "every-calls": { every: 5 } }, texts: { "every-calls": "Now." } })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ name: "Renamed", fixed: false, from: "mango-harness-2", hooks: { "every-calls": { on: true, every: 5 } }, texts: { "every-calls": "Now." } })
    const gone = await send("DELETE", `?id=${id}`)
    expect(gone.status).toBe(200)
    expect((await (await app().request(HARNESS_PATH)).json()).harnesses).toHaveLength(2)
  })

  test("a change that is not valid says why and writes nothing; Mango Code's own are not changed", async () => {
    const { id } = (await (await send("POST", "", { from: "mango-harness-1", name: "Mine" })).json()) as { id: string }
    const bad = await send("PUT", `?id=${id}`, { hooks: { "discipline-calls": { every: 0 } } })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toContain("every")
    const fixed = await send("PUT", "?id=mango-harness-1", { name: "Other" })
    expect(fixed.status).toBe(400)
  })

  test("a harness shows the texts of the summary, and the user's own changes one of them", async () => {
    const shown = (await (await app().request(`${HARNESS_PATH}?id=mango-harness-1`)).json()) as { compaction: Record<string, string> }
    expect(Object.keys(shown.compaction)).toEqual([...Harness.COMPACTION_TEXTS])
    expect(shown.compaction.first).toStartWith("Create a new anchored summary")
    const { id } = (await (await send("POST", "", { from: "mango-harness-1", name: "Mine" })).json()) as { id: string }
    const changed = await send("PUT", `?id=${id}`, { compaction: { first: "Summarise the work." } })
    expect(changed.status).toBe(200)
    expect(((await changed.json()) as { compaction: Record<string, string> }).compaction).toMatchObject({
      first: "Summarise the work.",
      update: shown.compaction.update,
    })
    const empty = await send("PUT", `?id=${id}`, { compaction: { first: " " } })
    expect(empty.status).toBe(400)
    const wrong = await send("PUT", `?id=${id}`, { compaction: { first: 3 } })
    expect(wrong.status).toBe(400)
  })

  test("without Origin nothing is changed: a connected app does not edit the harnesses", async () => {
    const response = await app().request(HARNESS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "mango-harness-1", name: "X" }) })
    expect(response.status).toBe(403)
  })
})
