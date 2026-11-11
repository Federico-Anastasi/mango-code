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

describe("a PDF or a picture from a phone", () => {
  const file = (size: number, type = "image/png") =>
    (async (url: string) =>
      url.includes("info=1") ? new Response(JSON.stringify({ size, isDir: false })) : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": type } })) as unknown as typeof fetch

  test("a picture is shown inside the app, as a picture", async () => {
    await onThePhone()
    globalThis.fetch = file(3)
    await phoneProjectFiles("C:\\p")!.open("C:\\p\\Logo.png")
    const view = phonePreview.view()!
    expect(view).toMatchObject({ kind: "image", title: "Logo.png" })
    expect(view.src.startsWith("blob:")).toBe(true)
  })

  test("an SVG is a picture too: it is drawn by an image element, never opened as a page that can run", async () => {
    await onThePhone()
    globalThis.fetch = file(3, "image/svg+xml")
    await phoneProjectFiles("C:\\p")!.open("C:\\p\\drawing.svg")
    expect(phonePreview.view()).toMatchObject({ kind: "image", title: "drawing.svg" })
  })

  test("a file over the limit says so and is not fetched", async () => {
    await onThePhone()
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify({ size: 51 * 1024 * 1024, isDir: false }))
    }) as unknown as typeof fetch
    const refused = await phoneProjectFiles("C:\\p")!.open("C:\\p\\big.png").catch((cause) => cause)
    expect(refused).toMatchObject({ code: "too_large" })
    expect(asked).toHaveLength(1)
    expect(phonePreview.view()).toBeUndefined()
  })

  test("a file the phone port does not find says so", async () => {
    await onThePhone()
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch
    expect(await phoneProjectFiles("C:\\p")!.open("C:\\p\\gone.png").catch((cause) => cause)).toMatchObject({ code: "not_found" })
  })

  test("a PDF opens inside the app where the browser has a PDF viewer, otherwise it is taken as a download", async () => {
    await onThePhone()
    globalThis.fetch = file(3, "application/pdf")
    const original = Object.getOwnPropertyDescriptor(navigator, "pdfViewerEnabled")
    try {
      Object.defineProperty(navigator, "pdfViewerEnabled", { value: true, configurable: true })
      await phoneProjectFiles("C:\\p")!.open("C:\\p\\Report.pdf")
      expect(phonePreview.view()).toMatchObject({ kind: "pdf", title: "Report.pdf" })
      phonePreview.close()

      Object.defineProperty(navigator, "pdfViewerEnabled", { value: false, configurable: true })
      const clicked: string[] = []
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        clicked.push(this.getAttribute("href") ?? "")
      }
      try {
        await phoneProjectFiles("C:\\p")!.open("C:\\p\\Report.pdf")
      } finally {
        HTMLAnchorElement.prototype.click = click
      }
      expect(clicked).toEqual(["/phone/file?directory=C%3A%5Cp&path=C%3A%5Cp%5CReport.pdf"])
      expect(phonePreview.view()).toBeUndefined()
    } finally {
      if (original) Object.defineProperty(navigator, "pdfViewerEnabled", original)
      else delete (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled
    }
  })

  test("closing the view frees the file", async () => {
    await onThePhone()
    globalThis.fetch = file(3)
    await phoneProjectFiles("C:\\p")!.open("C:\\p\\Logo.png")
    const revoked: string[] = []
    const revoke = URL.revokeObjectURL
    URL.revokeObjectURL = (url: string) => void revoked.push(url)
    try {
      const src = phonePreview.view()!.src
      phonePreview.close()
      expect(revoked).toEqual([src])
    } finally {
      URL.revokeObjectURL = revoke
    }
    expect(phonePreview.view()).toBeUndefined()
  })
})
