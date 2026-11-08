import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import { LANGUAGE_PATH } from "../../src/server/shared/mango-language"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// mango-code: the language route reads and writes the `language` key of the settings file (MANGO_SETTINGS),
// keeping the other keys.
const original = process.env.MANGO_SETTINGS
let file: string

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mango-language-")), "settings.json")
  process.env.MANGO_SETTINGS = file
})

afterEach(async () => {
  if (original === undefined) delete process.env.MANGO_SETTINGS
  else process.env.MANGO_SETTINGS = original
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const get = () => Server.Default().app.request(LANGUAGE_PATH)
const put = (body: unknown) =>
  Server.Default().app.request(LANGUAGE_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const saved = () => JSON.parse(fs.readFileSync(file, "utf8"))

describe("language", () => {
  test("without a settings file or a choice the language is null", async () => {
    expect(await (await get()).json()).toEqual({ language: null })
    fs.writeFileSync(file, JSON.stringify({ prompt: {} }))
    expect(await (await get()).json()).toEqual({ language: null })
  })

  test("an invalid language in the file counts as no choice", async () => {
    fs.writeFileSync(file, JSON.stringify({ language: "fr" }))
    expect(await (await get()).json()).toEqual({ language: null })
  })

  test("PUT saves the choice, GET returns it and the other keys stay", async () => {
    fs.writeFileSync(file, JSON.stringify({ prompt: { tools: { webfetch: false } } }))
    const response = await put({ language: "en" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ language: "en" })
    expect(await (await get()).json()).toEqual({ language: "en" })
    expect(saved()).toEqual({ prompt: { tools: { webfetch: false } }, language: "en" })

    await put({ language: "it" })
    expect(saved().language).toBe("it")
  })

  test("PUT creates the settings file when it does not exist yet", async () => {
    expect((await put({ language: "it" })).status).toBe(200)
    expect(saved()).toEqual({ language: "it" })
  })

  test("PUT null removes the choice (follow the system) and keeps the other keys", async () => {
    fs.writeFileSync(file, JSON.stringify({ language: "en", prompt: {} }))
    const response = await put({ language: null })
    expect(await response.json()).toEqual({ language: null })
    expect(saved()).toEqual({ prompt: {} })
  })

  test("PUT with another value is refused and changes nothing", async () => {
    fs.writeFileSync(file, JSON.stringify({ language: "en" }))
    for (const body of [{ language: "fr" }, { language: 1 }, {}, "it"]) {
      const response = await put(body)
      expect(response.status).toBe(400)
      expect(typeof (await response.json()).error).toBe("string")
    }
    expect(saved()).toEqual({ language: "en" })
  })

  test("PUT does not overwrite a settings file that is not a JSON object", async () => {
    fs.writeFileSync(file, "[1]")
    expect((await put({ language: "en" })).status).toBe(500)
    expect(fs.readFileSync(file, "utf8")).toBe("[1]")
  })

  test("without MANGO_SETTINGS PUT fails and GET returns null", async () => {
    delete process.env.MANGO_SETTINGS
    expect(await (await get()).json()).toEqual({ language: null })
    expect((await put({ language: "en" })).status).toBe(500)
  })

  test("error texts follow the chosen language", async () => {
    await put({ language: "en" })
    expect((await (await put({ language: "fr" })).json()).error).toContain("must be")
    await put({ language: "it" })
    expect((await (await put({ language: "fr" })).json()).error).toContain("deve essere")
  })
})
