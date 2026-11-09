import { afterEach, describe, expect, test } from "bun:test"
import { localLink, openLocalLinks, phonePreview, previewSrc } from "./phone-preview"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  phonePreview.close()
})

/** The phone port's `/phone/preview`, as the page sees it: every call is kept with its method and body. */
function answer(status: number, json: unknown) {
  const calls: { method: string; body?: unknown }[] = []
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status })
  }) as typeof fetch
  return calls
}

describe("the preview's address", () => {
  test("is the phone's own address with the preview port and the page's path", () => {
    expect(previewSrc("192.168.1.20", { port: 47097, page: { path: "/blog/a?x=1", title: "", label: "x", local: true } })).toBe(
      "http://192.168.1.20:47097/blog/a?x=1",
    )
    expect(previewSrc("100.64.0.2", { port: 47097, page: null })).toBe("http://100.64.0.2:47097/")
  })
})

describe("links to the computer's own pages", () => {
  test("only http on localhost or 127.0.0.1", () => {
    expect(localLink("http://localhost:3000/")).toBe("http://localhost:3000/")
    expect(localLink("http://127.0.0.1:5173/a?b=1")).toBe("http://127.0.0.1:5173/a?b=1")
    for (const other of [
      "https://localhost:3000/",
      "http://192.168.1.5:3000/",
      "http://localhost.evil.com:3000/",
      "http://example.com/",
      "file:///C:/a.html",
      "mailto:a@b.it",
      "/relative",
      "",
    ]) {
      expect(localLink(other)).toBeUndefined()
    }
  })

  test("a tap on one is taken over; other links and modified taps are left alone", () => {
    const opened: string[] = []
    const stop = openLocalLinks((url) => opened.push(url))
    const tap = (href: string, init: MouseEventInit = {}) => {
      const link = document.createElement("a")
      link.href = href
      const inner = document.createElement("span")
      link.append(inner)
      document.body.append(link)
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
      inner.dispatchEvent(event)
      link.remove()
      return event.defaultPrevented
    }
    expect(tap("http://localhost:3000/x")).toBe(true)
    expect(tap("https://example.com/")).toBe(false)
    expect(tap("http://localhost:3000/y", { ctrlKey: true })).toBe(false)
    expect(tap("http://localhost:3000/z", { button: 1 })).toBe(false)
    expect(opened).toEqual(["http://localhost:3000/x"])
    stop()
    expect(tap("http://localhost:3000/after")).toBe(false)
  })
})

describe("asking the phone port", () => {
  test("the page is seen only if the answer has the preview port", async () => {
    answer(200, "<!doctype html>")
    await phonePreview.detect()
    expect(phonePreview.available()).toBe(false)
    answer(404, { error: "x" })
    await phonePreview.detect()
    expect(phonePreview.available()).toBe(false)
    answer(200, { port: 47097, page: null })
    await phonePreview.detect()
    expect(phonePreview.available()).toBe(true)
  })

  test("opening shows what the panel has; opening a page asks the panel first", async () => {
    const calls = answer(200, { port: 47097, page: { path: "/index.html", title: "Home", label: "x", local: true } })
    await phonePreview.open()
    expect(calls).toEqual([{ method: "GET", body: undefined }])
    expect(phonePreview.view()?.src).toBe(`http://${location.hostname}:47097/index.html`)
    expect(phonePreview.view()?.title).toBe("Home")
    phonePreview.close()
    expect(phonePreview.view()).toBeUndefined()

    await phonePreview.openPage({ url: "http://localhost:3000/" })
    expect(calls[1]).toEqual({ method: "POST", body: { url: "http://localhost:3000/" } })
    expect(phonePreview.view()).toBeDefined()
  })

  test("a refusal says why and shows nothing", async () => {
    answer(403, { error: "the file is not inside the project folder" })
    await expect(phonePreview.openPage({ directory: "C:\\p", path: "C:\\x.html" })).rejects.toThrow("the file is not inside")
    expect(phonePreview.view()).toBeUndefined()
  })
})
