// The command `read` on a PDF and on a picture, tried without a model: the PDFs are made by the headless browser of the
// harness from pages of HTML, then read as a model reads them, through the commands of Mango Harness 2.
//
import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Harness } from "@/session/harness"
import { openHarness } from "@/mango-harness/harness"
import { LOOK_SIDE } from "@/mango-harness/look"
import type { Browser } from "@/mango-harness/contracts"
import { versionOf } from "@/mango-harness/version"
import { render } from "./render"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pdf-"))
const PAGES = path.join(ROOT, "pages")
const PROJECT = path.join(ROOT, "project")
const OUTSIDE = path.join(ROOT, "outside")
process.env.MANGO_HOME = path.resolve(import.meta.dir, "..", "..", "..", "..", "launcher")

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const STYLE =
  "<style>@page{size:210mm 148mm;margin:0}body{margin:0;padding:26px;font-size:14px}.next{break-before:page}td,th{padding:4px 12px;text-align:left}</style>"
const TWO_PAGES = `<!doctype html><meta charset="utf-8">${STYLE}
<h1>Invoice 2026-014</h1><p>Nuts and Bolts Hardware Ltd</p>
<table><tr><th>Article</th><th>Quantity</th><th>Amount</th></tr>
<tr><td>Wood screws</td><td>3</td><td>20.70</td></tr>
<tr><td>Cordless drill</td><td>1</td><td>89.00</td></tr></table>
<div class="next"><h1>Total</h1><p>Grand total: 109.70 EUR</p></div>`
const SCANS = (pages: number) =>
  `<!doctype html><meta charset="utf-8">${STYLE}${Array.from({ length: pages }, (_, i) => `<div class="${i ? "next" : ""}"><img src="data:image/png;base64,${PIXEL}" width="300" height="200"></div>`).join("")}`
const PICTURE_ONLY = `<!doctype html><meta charset="utf-8">${STYLE}<img src="data:image/png;base64,${PIXEL}" width="300" height="200">`
const TEXT_THEN_SCAN = `<!doctype html><meta charset="utf-8">${STYLE}<h1>Contract</h1><div class="next"><img src="data:image/png;base64,${PIXEL}" width="300" height="200"></div>`
const LONG = `<!doctype html><meta charset="utf-8">${STYLE}${Array.from({ length: 5 }, (_, i) => `<div class="${i ? "next" : ""}"><h1>Page ${i + 1}</h1><p>Text of page ${i + 1}</p></div>`).join("")}`

// A PDF whose password is not the empty one: pdf.js cannot open it without asking.
const LOCKED = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj
4 0 obj<</Filter/Standard/V 1/R 2/P -4/O <${"11".repeat(32)}>/U <${"22".repeat(32)}>>>endobj
trailer<</Root 1 0 R/Size 5/Encrypt 4 0 R/ID[<${"33".repeat(16)}><${"33".repeat(16)}>]>>
%%EOF`

const open = (vision: boolean) => {
  const browser: Browser = {
    view: async () => new Error("not used"),
    act: async () => new Error("not used"),
    back: async () => new Error("not used"),
    close: async () => {},
  }
  const harness = openHarness({
    project: PROJECT,
    version: versionOf(Harness.definition("mango-harness-2"), { vision }),
    web: { search: async () => new Error("no network"), open: async () => new Error("no network") },
    browser,
    user: async () => "yes",
  })
  return async (command: string, args: Record<string, unknown>) => harness.call(command, args)
}

beforeAll(async () => {
  fs.mkdirSync(PAGES, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })
  fs.mkdirSync(OUTSIDE, { recursive: true })
  fs.writeFileSync(path.join(PAGES, "invoice.pdf.html"), TWO_PAGES)
  fs.writeFileSync(path.join(PAGES, "scan.pdf.html"), PICTURE_ONLY)
  fs.writeFileSync(path.join(PAGES, "long.pdf.html"), LONG)
  fs.writeFileSync(path.join(PAGES, "mixed.pdf.html"), TEXT_THEN_SCAN)
  fs.writeFileSync(path.join(PAGES, "scans.pdf.html"), SCANS(6))
  await render(PAGES, PROJECT)
  fs.copyFileSync(path.join(PROJECT, "invoice.pdf"), path.join(OUTSIDE, "invoice.pdf"))
  fs.writeFileSync(path.join(PROJECT, "broken.pdf"), "%PDF-1.4\nthis is not a PDF at all\n")
  fs.writeFileSync(path.join(PROJECT, "locked.pdf"), LOCKED)
  for (const name of ["a.docx", "b.xlsx", "c.pptx"]) fs.writeFileSync(path.join(PROJECT, name), "PK")
  const pixel = new Bun.Image(Buffer.from(PIXEL, "base64"))
  fs.writeFileSync(
    path.join(PROJECT, "wide.png"),
    await new Bun.Image(Buffer.from(PIXEL, "base64")).resize(2000, 1000).png().bytes(),
  )
  fs.writeFileSync(
    path.join(PROJECT, "photo.jpg"),
    await new Bun.Image(Buffer.from(PIXEL, "base64")).resize(40, 30).jpeg().bytes(),
  )
  fs.copyFileSync(path.join(PROJECT, "photo.jpg"), path.join(PROJECT, "photo.jpeg"))
  fs.writeFileSync(path.join(PROJECT, "photo.webp"), await pixel.resize(40, 30).webp().bytes())
  fs.writeFileSync(
    path.join(PROJECT, "drawing.gif"),
    Buffer.from("R0lGODlhAQABAIAAAP8AAAAAACwAAAAAAQABAAACAkQBADs=", "base64"),
  )
  fs.writeFileSync(path.join(PROJECT, "fake.png"), "this is not a picture")
  fs.copyFileSync(path.join(PROJECT, "wide.png"), path.join(OUTSIDE, "wide.png"))
}, 60_000)
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

test("read gives the text of a PDF page by page, in reading order, under a first line with its name and its pages", async () => {
  const call = open(false)
  const answer = await call("read", { path: "invoice.pdf" })
  expect(answer.failed).toBe(false)
  expect(answer.text).toBe(
    [
      "invoice.pdf, PDF of 2 pages, lines 1-13 of 13",
      "--- page 1 ---",
      "Invoice 2026-014",
      "",
      "Nuts and Bolts Hardware Ltd",
      "",
      "Article  Quantity  Amount",
      "Wood screws  3  20.70",
      "Cordless drill  1  89.00",
      "",
      "--- page 2 ---",
      "Total",
      "",
      "Grand total: 109.70 EUR",
    ].join("\n"),
  )
})

test("from and lines count the lines of that text: a window of it, and what is left is said by the first line", async () => {
  const call = open(false)
  const window = await call("read", { path: "long.pdf", from: 4, lines: 5 })
  expect(window.text.split("\n")[0]).toMatch(/^long\.pdf, PDF of 5 pages, lines 4-8 of \d+$/)
  expect(window.text).toContain("--- page 2 ---")
  expect(window.text).not.toContain("Page 1")
  const past = await call("read", { path: "long.pdf", from: 500 })
  expect(past.failed).toBe(true)
  expect(past.text).toStartWith("long.pdf has 24 lines.")
})

const png = (picture: { mime: string; base64: string }) => Buffer.from(picture.base64, "base64")
const PNG_MARK = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const sizeOf = async (bytes: Uint8Array) => (await new Bun.Image(bytes).metadata()) as { width: number; height: number }

test("a page with no text is given as a picture, when the model has sight, and the line says where it is", async () => {
  const answer = await open(true)("read", { path: "scan.pdf" })
  expect(answer.failed).toBe(false)
  expect(answer.text.split("\n").slice(1)).toEqual(["--- page 1 ---", "(no text on this page: picture 1 below)"])
  expect(answer.images).toHaveLength(1)
  const [picture] = answer.images ?? []
  expect([...png(picture).subarray(0, 8)]).toEqual(PNG_MARK)
  const { width, height } = await sizeOf(png(picture))
  expect(Math.max(width, height)).toBeLessThanOrEqual(LOOK_SIDE)
  expect(width / height).toBeCloseTo(210 / 148, 1)
}, 60_000)

test("a page with no text says so in one line, and no picture comes, when the model has no sight", async () => {
  const answer = await open(false)("read", { path: "scan.pdf" })
  expect(answer.text.split("\n").slice(1)).toEqual(["--- page 1 ---", "(no text on this page)"])
  expect(answer.images).toBeUndefined()
})

test("the pictures are those of the pages with no text, in the order of the pages, and the text pages have none", async () => {
  const answer = await open(true)("read", { path: "mixed.pdf" })
  expect(answer.text.split("\n").slice(1)).toEqual([
    "--- page 1 ---",
    "Contract",
    "",
    "--- page 2 ---",
    "(no text on this page: picture 1 below)",
  ])
  expect(answer.images).toHaveLength(1)
}, 60_000)

test("at most four pictures come in one read; the page left out says where to read on from", async () => {
  const call = open(true)
  const first = await call("read", { path: "scans.pdf" })
  expect(first.images).toHaveLength(4)
  const lines = first.text.split("\n")
  expect(lines.filter((line) => line.startsWith("(no text on this page: picture"))).toHaveLength(4)
  const left = lines.filter((line) => line.includes("left out"))
  expect(left).toHaveLength(2)
  const from = Number(/from line (\d+)/.exec(left[0])?.[1])
  expect(lines[from]).toBe("--- page 5 ---")
  const next = await call("read", { path: "scans.pdf", from })
  expect(next.images).toHaveLength(2)
  expect(next.text).toContain("--- page 6 ---")
}, 120_000)

test("the pictures are made only for the pages of the lines that are shown", async () => {
  const answer = await open(true)("read", { path: "mixed.pdf", from: 1, lines: 3 })
  expect(answer.images).toBeUndefined()
  expect(answer.text).not.toContain("picture")
}, 60_000)

test("a file that is not a PDF, or is locked, is an error of one line", async () => {
  const call = open(false)
  const broken = await call("read", { path: "broken.pdf" })
  expect(broken.failed).toBe(true)
  expect(broken.text).toStartWith("broken.pdf is not a readable PDF")
  expect(broken.text.split("\n")[0]).toMatch(/^broken\.pdf is not a readable PDF \([^\n)]+\)\.$/)
  const locked = await call("read", { path: "locked.pdf" })
  expect(locked.failed).toBe(true)
  expect(locked.text).toStartWith("locked.pdf is protected by a password: it cannot be read.")
})

test("a PDF outside the project follows the rules of every file there: read, and shown by its whole path; the root of the drive is refused", async () => {
  const call = open(false)
  const whole = path.join(OUTSIDE, "invoice.pdf")
  const outside = await call("read", { path: whole })
  expect(outside.failed).toBe(false)
  expect(outside.text.split("\n")[0]).toBe(`${whole}, PDF of 2 pages, lines 1-13 of 13`)
  const root = await call("read", { path: "C:/*" })
  expect(root.failed).toBe(true)
  expect(root.text).toContain("is outside the project")
})

test("Word, Excel and PowerPoint are not read", async () => {
  const call = open(false)
  for (const name of ["a.docx", "b.xlsx", "c.pptx"])
    expect((await call("read", { path: name })).text).toStartWith("`read` does not read Word, Excel and PowerPoint files.")
})

test("write still does not make a PDF", async () => {
  const answer = await open(false)("write", { path: "new.pdf", content: "x" })
  expect(answer.failed).toBe(true)
})

test("read on an image gives the picture as a PNG within the side of a page's picture, in any of the formats", async () => {
  const call = open(true)
  for (const name of ["wide.png", "photo.jpg", "photo.jpeg", "drawing.gif", "photo.webp"]) {
    const answer = await call("read", { path: name })
    expect([name, answer.failed, answer.text]).toEqual([name, false, `The picture of ${name} follows.`])
    expect(answer.images).toHaveLength(1)
    const [picture] = answer.images ?? []
    expect([...png(picture).subarray(0, 8)]).toEqual(PNG_MARK)
  }
  const [wide] = (await call("read", { path: "wide.png" })).images ?? []
  expect(await sizeOf(png(wide))).toMatchObject({ width: LOOK_SIDE, height: LOOK_SIDE / 2 })
  const [small] = (await call("read", { path: "drawing.gif" })).images ?? []
  expect(await sizeOf(png(small))).toMatchObject({ width: 1, height: 1 })
})

test("read on an image says in one line that pictures cannot be seen, when the model has no sight", async () => {
  const answer = await open(false)("read", { path: "wide.png" })
  expect(answer.failed).toBe(true)
  expect(answer.text).toStartWith("wide.png is a picture, and pictures cannot be seen in this setup.")
  expect(answer.images).toBeUndefined()
})

test("read on a file named as an image that is not one is an error that says so", async () => {
  const answer = await open(true)("read", { path: "fake.png" })
  expect(answer.failed).toBe(true)
  expect(answer.text).toStartWith("fake.png is not a picture that can be read")
  expect(answer.images).toBeUndefined()
})

test("an image outside the project is read like any file outside it", async () => {
  const answer = await open(true)("read", { path: path.join(OUTSIDE, "wide.png") })
  expect(answer.failed).toBe(false)
  expect(answer.images).toHaveLength(1)
})
