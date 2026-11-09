import { afterEach, describe, expect, test } from "bun:test"
import { phoneProjectFiles } from "./phone-files"
import { phonePreview } from "./phone-preview"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  phonePreview.close()
})

async function onThePhone() {
  globalThis.fetch = (async () => new Response(JSON.stringify({ port: 47097, page: null }))) as unknown as typeof fetch
  await phonePreview.detect()
}

describe("the project's files from a phone", () => {
  test("there are none until the phone port answers", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html>")) as unknown as typeof fetch
    await phonePreview.detect()
    expect(phoneProjectFiles("C:\\p")).toBeUndefined()
  })

  test("size and absence come from the phone port, always for the conversation's project", async () => {
    await onThePhone()
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      asked.push(url)
      return url.includes("missing") ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ size: 11264, isDir: false }))
    }) as unknown as typeof fetch
    const files = phoneProjectFiles("C:\\My project")!
    expect(await files.info("C:\\My project\\a è.docx")).toEqual({ size: 11264, isDir: false })
    expect(asked[0]).toBe("/phone/file?directory=C%3A%5CMy%20project&path=C%3A%5CMy%20project%5Ca%20%C3%A8.docx&info=1")
    expect(await files.info("C:\\My project\\missing.pdf").catch((cause) => cause)).toMatchObject({ code: "not_found" })
    // there is no folder to show on a phone
    expect(files.reveal).toBeUndefined()
  })

  test("a web page opens in the preview and the other documents are taken as downloads", async () => {
    await onThePhone()
    const posted: unknown[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ port: 47097, page: { path: "/index.html", title: "", label: "x", local: true } }))
    }) as unknown as typeof fetch
    const files = phoneProjectFiles("C:\\p")!
    await files.open("C:\\p\\site\\index.html")
    expect(posted).toEqual([{ directory: "C:\\p", path: "C:\\p\\site\\index.html" }])
    expect(phonePreview.view()).toBeDefined()

    const clicked: { href: string; download: string }[] = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.getAttribute("download") ?? "none" })
    }
    try {
      await files.open("C:\\p\\Relazione.docx")
    } finally {
      HTMLAnchorElement.prototype.click = original
    }
    expect(posted).toHaveLength(1)
    expect(clicked).toEqual([{ href: "/phone/file?directory=C%3A%5Cp&path=C%3A%5Cp%5CRelazione.docx", download: "" }])
  })
})
