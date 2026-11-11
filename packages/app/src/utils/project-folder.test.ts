import { afterEach, describe, expect, test } from "bun:test"
import { createSubfolder, folderIsBroad } from "./project-folder"

const http = { url: "http://127.0.0.1:4196", username: "opencode", password: "segreto" }
const realFetch = globalThis.fetch
const seen: { url: string; init?: RequestInit }[] = []

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  seen.length = 0
})

describe("the agent's answers about a folder", () => {
  test("asks if a folder is too broad, with the folder and the key of the agent", async () => {
    answer(200, { broad: true })
    expect(await folderIsBroad(http, "C:\\Users\\Àngelo\\Desktop")).toBe(true)
    expect(seen[0]!.url).toBe("http://127.0.0.1:4196/mango/folder?directory=C%3A%5CUsers%5C%C3%80ngelo%5CDesktop")
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("opencode:segreto")}`)
    answer(200, { broad: false })
    expect(await folderIsBroad(http, "C:\\progetti\\sito")).toBe(false)
  })

  test("a failed question is an error, never a quiet \"not broad\"", async () => {
    answer(500, {})
    await expect(folderIsBroad(http, "C:\\x")).rejects.toThrow("500")
  })

  test("the new subfolder comes back with its path, or the sentence of the agent", async () => {
    answer(200, { directory: "C:\\Users\\a\\Desktop\\sito" })
    expect(await createSubfolder(http, "C:\\Users\\a\\Desktop", "sito")).toBe("C:\\Users\\a\\Desktop\\sito")
    expect(JSON.parse(seen[0]!.init!.body as string)).toEqual({ parent: "C:\\Users\\a\\Desktop", name: "sito" })
    answer(400, { error: "esiste già una cartella con questo nome: scegli un altro nome" })
    await expect(createSubfolder(http, "C:\\Users\\a\\Desktop", "sito")).rejects.toThrow("esiste già una cartella")
  })
})
