import { describe, expect, test } from "bun:test"
import { openWeb } from "@/mango-harness/world/web"

type Call = { name: string; args: Record<string, unknown> }

const answering = (reply: (call: Call) => unknown) => {
  const calls: Call[] = []
  const web = openWeb({
    callTool: async (name, args) => {
      calls.push({ name, args })
      return reply({ name, args })
    },
  })
  return { web, calls }
}

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError })

describe("search", () => {
  test("gives the results of the search tool as found pages, in its order", async () => {
    const { web, calls } = answering(() =>
      text(
        JSON.stringify({
          source: "ddg: 2 · bing: 1",
          results: [
            { title: "First", url: "https://a.example/one", snippet: "about cats", engines: ["ddg", "bing"] },
            { title: "Second", url: "https://b.example/two", snippet: "", engines: ["ddg"] },
            { title: "No address", snippet: "dropped" },
          ],
        }),
      ),
    )
    expect(await web.search("cats", 7)).toEqual([
      { title: "First", url: "https://a.example/one", text: "about cats" },
      { title: "Second", url: "https://b.example/two", text: "" },
    ])
    expect(calls).toEqual([{ name: "search", args: { query: "cats", max_results: 10, days: 7 } }])
  })

  test("a search without days asks for any date", async () => {
    const { web, calls } = answering(() => text(JSON.stringify({ source: "", results: [] })))
    await web.search("cats")
    expect(calls).toEqual([{ name: "search", args: { query: "cats", max_results: 10 } }])
  })

  test("engines that answered nothing is an empty result; engines that failed is an Error", async () => {
    const empty = answering(() => text("ERROR: all engines failed: ddg: 0 · bing: 0", true)).web
    expect(await empty.search("zzz")).toEqual([])
    const down = answering(() => text("ERROR: all engines failed: ddg: FAILED (fetch failed) · bing: FAILED (fetch failed)", true))
      .web
    const failed = await down.search("cats")
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain("FAILED")
  })

  test("a tool that cannot be called, or answers something else, is an Error", async () => {
    const broken = openWeb({
      callTool: async () => {
        throw new Error("the server is not running")
      },
    })
    expect(((await broken.search("x")) as Error).message).toBe("the server is not running")
    expect(await answering(() => text("not json")).web.search("x")).toBeInstanceOf(Error)
  })
})

describe("open", () => {
  const PAGE = [
    "# The page",
    "By Someone",
    "source: https://a.example/one",
    "",
    "Intro with [a link](https://a.example/two) and [an anchor](#top).",
    "",
    "[img: logo](https://a.example/logo.png)",
    "",
    "[](https://a.example/bare) and [local](/relative \"title\")",
    "",
    "",
    "",
    "End.",
    "",
    "[TRUNCATED at 20000 chars — re-read with a higher max_chars if needed]",
  ].join("\n")

  test("gives the title and the text, with the address of each link after its words", async () => {
    const { web, calls } = answering(() => text(PAGE))
    expect(await web.open("https://a.example/one")).toEqual({
      title: "The page",
      text: [
        "Intro with a link (https://a.example/two) and an anchor.",
        "",
        "https://a.example/bare and local",
        "",
        "End.",
      ].join("\n"),
    })
    expect(calls).toEqual([{ name: "read_url", args: { url: "https://a.example/one" } }])
  })

  test("a page that is already text has the address for title", async () => {
    const { web } = answering(() => text("plain words"))
    expect(await web.open("https://a.example/raw.txt")).toEqual({ title: "https://a.example/raw.txt", text: "plain words" })
  })

  test("a page that cannot be read says why", async () => {
    const refused = answering(() => text("ERROR: HTTP 403", true)).web
    expect(((await refused.open("https://a.example/x")) as Error).message).toBe("HTTP 403")
    const blank = answering(() => text("# Empty\nsource: https://a.example/x\n\n")).web
    expect(await blank.open("https://a.example/x")).toBeInstanceOf(Error)
  })
})
