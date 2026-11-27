// The pictures of PDF pages, for the pages that have no text to read. pdf.js draws them on a canvas as large as the
// pictures of a page, in a browser of their own: Chrome or Edge without a window and without the net, on a throwaway
// folder that holds the page that draws, the library and a copy of the file. Nothing of the project is served and the
// app's panel is not touched.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
// The library is carried inside the agent as text, to be served to the page that draws.
import * as pdfjsText from "unpdf/pdfjs" with { type: "text" }
import type { Picture } from "./contracts"
import { LOOK_SIDE } from "./look"
import { stop } from "./terminal"
import { connect } from "./world/browser"

const pdfjs = (pdfjsText as unknown as { default: string }).default
const DRAWING_SECONDS = 60
const STARTING_SECONDS = 15

const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]

const drawing = (
  pages: number[],
) => `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c"></canvas>
<script type="module">
window.pictures = (async () => {
  const lib = await import("./pdfjs.mjs")
  const pdfjs = lib.default ?? lib
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await (await fetch("doc.pdf")).arrayBuffer()) }).promise
  const canvas = document.getElementById("c")
  const pictures = []
  for (const number of ${JSON.stringify(pages)}) {
    const page = await doc.getPage(number)
    const base = page.getViewport({ scale: 1 })
    const view = page.getViewport({ scale: Math.min(1, ${LOOK_SIDE} / Math.max(base.width, base.height)) })
    canvas.width = Math.max(1, Math.round(view.width))
    canvas.height = Math.max(1, Math.round(view.height))
    const context = canvas.getContext("2d")
    context.fillStyle = "#fff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport: view }).promise
    pictures.push(canvas.toDataURL("image/png").split(",")[1])
  }
  return pictures
})()
</script>`

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

/** Waits for `seconds` at most, then gives an Error that says what took too long. */
const late = <T>(work: Promise<T>, seconds: number, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const over = new Promise<Error>((done) => {
    timer = setTimeout(() => done(new Error(`${what} took more than ${seconds} seconds`)), seconds * 1000)
  })
  return Promise.race([work, over]).finally(() => clearTimeout(timer))
}

/** The picture of each of `pages` (numbered from 1) of the PDF `file`, in the order given; an Error if they could not be
 *  drawn. */
export async function pageSights(file: string, pages: number[]): Promise<Picture[] | Error> {
  const browser = (await Promise.all(BROWSERS.map(async (candidate) => ((await exists(candidate)) ? candidate : undefined)))).find(
    Boolean,
  )
  if (!browser) return new Error("there is no Chrome or Edge on this computer to draw the page")
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mango-pdfpage-"))
  const site = path.join(folder, "site")
  await fs.mkdir(site)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1)
      if (!["page.html", "pdfjs.mjs", "doc.pdf"].includes(name)) return new Response("", { status: 404 })
      const type = name.endsWith(".html") ? "text/html" : name.endsWith(".mjs") ? "text/javascript" : "application/pdf"
      return new Response(Bun.file(path.join(site, name)), { headers: { "content-type": type } })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let cdp: Awaited<ReturnType<typeof connect>> | undefined
  try {
    await Promise.all([
      fs.writeFile(path.join(site, "pdfjs.mjs"), pdfjs),
      fs.copyFile(file, path.join(site, "doc.pdf")),
      fs.writeFile(path.join(site, "page.html"), drawing(pages)),
    ])
    const profile = path.join(folder, "profile")
    child = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        // Every address but the machine's own fails: the page that draws needs nothing from the net.
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        `http://127.0.0.1:${server.port}/page.html`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
    )
    let starting = true
    const port = await late(
      (async () => {
        const announced = path.join(profile, "DevToolsActivePort")
        while (starting && !(await exists(announced))) await Bun.sleep(100)
        return starting ? Number((await fs.readFile(announced, "utf8")).split("\n")[0]) : new Error("the wait was given up")
      })(),
      STARTING_SECONDS,
      "starting the browser",
    ).finally(() => {
      starting = false
    })
    if (port instanceof Error) return port
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
      type: string
      url: string
      webSocketDebuggerUrl: string
    }[]
    const target = targets.find((item) => item.type === "page" && item.url.endsWith("/page.html"))
    if (!target) return new Error("the browser did not open the page that draws")
    const connected = await connect(target.webSocketDebuggerUrl, () => undefined)
    cdp = connected
    // The page may still be loading when it is reached: its first context goes away, and the question is asked again.
    let waiting = true
    const drawn = async () => {
      while (waiting) {
        const asked = await connected
          .send<{ result: { value?: string[] }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
            expression:
              "new Promise((done) => (function wait() { window.pictures ? done(window.pictures) : setTimeout(wait, 50) })())",
            awaitPromise: true,
            returnByValue: true,
          })
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
        if (!(asked instanceof Error) || !/context/i.test(asked.message)) return asked
        await Bun.sleep(100)
      }
      return new Error("the drawing was stopped")
    }
    const reply = await late(drawn(), DRAWING_SECONDS, "drawing").finally(() => {
      waiting = false
    })
    if (reply instanceof Error) return reply
    if (reply.exceptionDetails || !reply.result.value) return new Error(reply.exceptionDetails?.text ?? "the page was not drawn")
    return reply.result.value.map((base64) => ({ mime: "image/png" as const, base64 }))
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    cdp?.close()
    if (child?.pid) await stop(child.pid)
    server.stop(true)
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined)
  }
}
