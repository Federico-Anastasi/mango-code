import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@/mango-harness/contracts"
import { openPanelBrowser } from "@/mango-harness/world/browser"

setDefaultTimeout(60000)

const CHROME = join(
  process.env.LOCALAPPDATA ?? "",
  "ms-playwright",
  "chromium_headless_shell-1243",
  "chrome-headless-shell-win64",
  "chrome-headless-shell.exe",
)
const present = existsSync(CHROME)
if (!present) console.warn(`browser tests skipped: no headless Chromium at ${CHROME}`)

const folders: string[] = []
let chrome: ReturnType<typeof Bun.spawn> | undefined
let port = 0
let site: ReturnType<typeof Bun.serve>
const pages = new Map<string, { body: string; status?: number }>()

const temp = async (prefix: string) => {
  const folder = await mkdtemp(join(tmpdir(), prefix))
  folders.push(folder)
  return folder
}

beforeAll(async () => {
  if (!present) return
  const profile = await temp("hb-panel-")
  chrome = Bun.spawn(
    [
      CHROME,
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-extensions",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
    { windowsHide: true, stdout: "ignore", stderr: "ignore" },
  )
  const announced = async (until: number): Promise<number> => {
    if (Date.now() > until) throw new Error("the headless browser did not start")
    const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
    const first = Number(text.split("\n")[0])
    if (Number.isInteger(first) && first > 0) return first
    await Bun.sleep(50)
    return announced(until)
  }
  port = await announced(Date.now() + 20000)
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      const found = pages.get(path)
      if (found)
        return new Response(found.body, {
          status: found.status ?? 200,
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        })
      return new Response("Not found", { status: path === "/favicon.ico" ? 204 : 404 })
    },
  })
})

afterAll(async () => {
  site?.stop(true)
  if (chrome) {
    await Bun.spawn(["taskkill", "/PID", String(chrome.pid), "/T", "/F"], {
      windowsHide: true,
      stdout: "ignore",
      stderr: "ignore",
    }).exited
    await chrome.exited
  }
  await Promise.all(
    folders.map((folder) => rm(folder, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })),
  )
})

const address = (path: string) => `http://127.0.0.1:${site.port}${path}`

const withBrowser = async (
  html: Record<string, string>,
  run: (
    open: (path?: string) => Promise<Page>,
    browser: ReturnType<typeof openPanelBrowser>,
  ) => Promise<void>,
): Promise<void> => {
  pages.clear()
  Object.entries(html).forEach(([path, body]) => pages.set(path, { body }))
  const browser = openPanelBrowser({ project: await temp("hb-project-"), env: { MANGO_PANEL_CDP: String(port) } })
  const open = async (path = "/"): Promise<Page> => {
    const page = await browser.view(address(path))
    if (page instanceof Error) throw page
    return page
  }
  try {
    await run(open, browser)
  } finally {
    await browser.close()
  }
}

const act = async (
  browser: ReturnType<typeof openPanelBrowser>,
  ...args: Parameters<ReturnType<typeof openPanelBrowser>["act"]>
): Promise<Page> => {
  const page = await browser.act(...args)
  if (page instanceof Error) throw page
  return page
}

describe.skipIf(!present)("page as text", () => {
  test("texts and controls come in document order", async () => {
    const html = `<!doctype html><title>Order</title><body>
      <h1>Welcome</h1>
      <p>First paragraph</p>
      <a href="other.html">Docs</a>
      <ul><li>One</li><li>Two</li></ul>
      <table><tr><td>a</td><td>b</td></tr></table>
      <label for="n">Name:</label><input id="n" value="Anna">
      <input type="checkbox" id="c" aria-label="Agree" checked>
      <textarea placeholder="Notes"></textarea>
      <select name="size"><option>Small</option><option selected>Large</option></select>
      <button>Save</button><input type="submit" value="Send">
      <div role="button">Fake</div>
      <p>Last</p></body>`
    await withBrowser({ "/": html }, async (open) => {
      const page = await open()
      expect(page.title).toBe("Order")
      expect(page.address).toBe(address("/"))
      expect(page.status).toBe(200)
      expect(page.items).toEqual([
        { text: "Welcome" },
        { text: "First paragraph" },
        { control: "link", label: "Docs" },
        { text: "One" },
        { text: "Two" },
        { text: "a | b" },
        { control: "field", label: "Name: Anna" },
        { control: "field", label: "Agree: checked" },
        { control: "field", label: "Notes" },
        { control: "field", label: "size: Large (options: Small | Large)" },
        { control: "button", label: "Save" },
        { control: "button", label: "Send" },
        { control: "button", label: "Fake" },
        { text: "Last" },
      ])
    })
  })

  test("hidden things are left out", async () => {
    const html = `<!doctype html><body>
      <p>Seen</p>
      <p style="display:none">gone one</p>
      <p style="visibility:hidden">gone two</p>
      <p hidden>gone three</p>
      <button style="width:0;height:0;padding:0;border:0">gone four</button>
      <div style="display:none"><a href="x.html">gone five</a></div>
      <button style="visibility:hidden">gone six</button>
      <input type="hidden" name="secret" value="gone seven">
      <p style="opacity:0">gone eight</p>
      <div style="opacity:0"><button>gone nine</button></div></body>`
    await withBrowser({ "/": html }, async (open) => {
      expect((await open()).items).toEqual([{ text: "Seen" }])
    })
  })

  test("at most 400 items, and a last line says when the page has more", async () => {
    const rows = (count: number) =>
      `<!doctype html><body>${Array.from({ length: count }, (_, i) => `<p>row ${i}</p>`).join("")}</body>`
    await withBrowser({ "/": rows(600), "/exact": rows(400) }, async (open) => {
      const { items } = await open()
      expect(items).toHaveLength(401)
      expect(items.at(-2)).toEqual({ text: "row 399" })
      expect(items.at(-1)).toEqual({ text: "(The page goes on: only its first 400 items are shown.)" })
      expect((await open("/exact")).items).toHaveLength(400)
    })
  })
})

describe.skipIf(!present)("errors", () => {
  test("console.error, an exception and a missing script show once each", async () => {
    const html = `<!doctype html><body><p>x</p>
      <script src="missing.js"></script>
      <script>
        console.error("boom");
        console.error("boom");
        console.log("quiet");
        throw new Error("thrown");
      </script></body>`
    await withBrowser({ "/": html }, async (open) => {
      const { errors } = await open()
      expect(errors.filter((line) => line === "boom")).toHaveLength(1)
      expect(errors.some((line) => line.includes("Uncaught Error: thrown") && /line \d+/.test(line))).toBe(true)
      expect(errors.some((line) => line.includes("missing.js") && line.includes("404"))).toBe(true)
      expect(errors.some((line) => line.includes("quiet"))).toBe(false)
      expect(new Set(errors).size).toBe(errors.length)
    })
  })

  test("an error caused by an action is reported", async () => {
    const html = `<!doctype html><body><button onclick="console.error('clicked wrong')">Go</button></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      expect((await open()).errors).toEqual([])
      expect((await act(browser, "click", 1)).errors).toEqual(["clicked wrong"])
    })
  })
})

describe.skipIf(!present)("acting", () => {
  test("a click changes a text", async () => {
    const html = `<!doctype html><body><p id="t">before</p>
      <button onclick="document.getElementById('t').textContent='after'">Change</button></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      expect((await act(browser, "click", 1)).items).toEqual([
        { text: "after" },
        { control: "button", label: "Change" },
      ])
    })
  })

  test("typing in a field and clicking a button that reads it", async () => {
    const html = `<!doctype html><body><input id="i" placeholder="Your name" value="old">
      <button onclick="document.getElementById('o').textContent='Hello ' + document.getElementById('i').value">Greet</button>
      <p id="o"></p>
      <input id="e" placeholder="Echo" oninput="document.getElementById('o').textContent='typed:' + this.value"></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      await act(browser, "type", 1, "Anna")
      const greeted = await act(browser, "click", 2)
      expect(greeted.items).toContainEqual({ text: "Hello Anna" })
      expect(greeted.items).toContainEqual({ control: "field", label: "Your name: Anna" })
      expect((await act(browser, "type", 3, "xyz")).items).toContainEqual({ text: "typed:xyz" })
    })
  })

  test("typing an empty text empties the field", async () => {
    const html = `<!doctype html><body><input placeholder="Your name" value="old"></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      expect((await act(browser, "type", 1, "")).items).toEqual([{ control: "field", label: "Your name" }])
    })
  })

  test("typing into a select picks the option, and one it does not have comes with those it has", async () => {
    const html = `<!doctype html><body><select><option>Red</option><option>Green</option></select></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      expect((await act(browser, "type", 1, "Green")).items).toEqual([
        { control: "field", label: "select: Green (options: Red | Green)" },
      ])
      const wrong = await browser.act("type", 1, "Blue")
      expect(wrong).toBeInstanceOf(Error)
      expect((wrong as Error).message).toBe('Control 1 has no option "Blue". Its options: Red | Green.')
    })
  })

  test("Enter submits a form", async () => {
    const html = `<!doctype html><body>
      <form onsubmit="event.preventDefault(); document.getElementById('o').textContent='sent ' + this.q.value">
        <input name="q" placeholder="Query"></form><p id="o"></p></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      await act(browser, "type", 1, "cats")
      expect((await act(browser, "press", 1, "Enter")).items).toContainEqual({ text: "sent cats" })
    })
  })

  test("press without a control goes to the focused element", async () => {
    const html = `<!doctype html><body>
      <input id="a" placeholder="A" onkeydown="document.getElementById('o').textContent='key:' + event.key">
      <p id="o"></p></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      await open()
      await act(browser, "click", 1)
      expect((await act(browser, "press", undefined, "Escape")).items).toContainEqual({ text: "key:Escape" })
      expect((await act(browser, "press", undefined, "x")).items).toContainEqual({ text: "key:x" })
    })
  })

  test("a link to another page navigates, and back returns", async () => {
    const files = {
      "/": `<!doctype html><title>Home</title><body><input aria-label="Name"><a href="/sub/next">Next</a></body>`,
      "/sub/next": `<!doctype html><title>Next page</title><body><h1>Arrived</h1><a href="/">Back</a></body>`,
    }
    await withBrowser(files, async (open, browser) => {
      await open()
      const page = await act(browser, "click", 2)
      expect(page.title).toBe("Next page")
      expect(page.items).toEqual([{ text: "Arrived" }, { control: "link", label: "Back" }])
      expect(page.address).toBe(address("/sub/next"))
      const back = await browser.back()
      if (back instanceof Error) throw back
      expect([back.title, back.address]).toEqual(["Home", address("/")])
    })
  })

  test("an alert is accepted and reported", async () => {
    const html = `<!doctype html><body><p>page</p><button onclick="alert('Saved!'); document.title='after'">Save</button>
      <script>alert("on load")</script></body>`
    await withBrowser({ "/": html }, async (open, browser) => {
      expect((await open()).items).toContainEqual({ text: "Dialog: on load" })
      const page = await act(browser, "click", 1)
      expect(page.items).toContainEqual({ text: "Dialog: Saved!" })
      expect(page.items).not.toContainEqual({ text: "Dialog: on load" })
      expect(page.title).toBe("after")
    })
  })

  test("no page open, or a control that is not there, is an Error", async () => {
    await withBrowser({ "/": `<!doctype html><body><button>Only</button></body>` }, async (open, browser) => {
      const none = await browser.act("click", 1)
      expect(none).toBeInstanceOf(Error)
      expect((none as Error).message).toContain("No page is open")
      expect(await browser.back()).toBeInstanceOf(Error)
      await open()
      const missing = await browser.act("click", 2)
      expect(missing).toBeInstanceOf(Error)
      expect((missing as Error).message).toContain("2")
      expect(await browser.act("click")).toBeInstanceOf(Error)
      expect(await browser.act("type", 1)).toBeInstanceOf(Error)
    })
  })
})

describe.skipIf(!present)("targets", () => {
  test("a page the site does not have comes with the status the site answered", async () => {
    await withBrowser({}, async (_open, browser) => {
      const page = await browser.view(address("/services"))
      if (page instanceof Error) throw page
      expect(page.status).toBe(404)
    })
  })

  test("a file of the project opens, with the files it loads", async () => {
    const files = {
      "index.html": `<!doctype html><title>File</title><body><p id="o">waiting</p><script type="module" src="app.js"></script></body>`,
      "app.js": `import { greeting } from "./lib.js";
        const data = await (await fetch("data.json")).json();
        document.getElementById("o").textContent = greeting + " " + data.name;`,
      "lib.js": `export const greeting = "Hi";`,
      "data.json": `{"name":"Anna"}`,
    }
    const project = await temp("hb-project-")
    await Promise.all(
      Object.entries(files).map(async ([name, content]) => {
        await mkdir(join(project, name, ".."), { recursive: true })
        await writeFile(join(project, name), content)
      }),
    )
    const browser = openPanelBrowser({ project, env: { MANGO_PANEL_CDP: String(port) } })
    try {
      const page = await browser.view(join(project, "index.html"))
      if (page instanceof Error) throw page
      expect(page.title).toBe("File")
      expect(page.items).toEqual([{ text: "Hi Anna" }])
      expect(page.errors).toEqual([])
      const missing = await browser.view(join(project, "nothing.html"))
      expect(missing).toBeInstanceOf(Error)
      expect((missing as Error).message).toContain("nothing.html")
    } finally {
      await browser.close()
    }
  })

  test("a page of the project comes from the address the app serves it at", async () => {
    pages.clear()
    pages.set("/site/index.html", { body: `<!doctype html><title>Served</title><p>from the app</p>` })
    const project = await temp("hb-project-")
    await writeFile(join(project, "index.html"), "unused")
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const asked = (await request.json()) as { path: string }
        return new URL(request.url).pathname === "/control/site" && asked.path === join(project, "index.html")
          ? Response.json({ url: address("/site/index.html") })
          : new Response("no", { status: 404 })
      },
    })
    const browser = openPanelBrowser({
      project,
      env: { MANGO_PANEL_CDP: String(port), MANGO_CONTROL_URL: `http://127.0.0.1:${app.port}` },
    })
    try {
      const page = await browser.view(join(project, "index.html"))
      if (page instanceof Error) throw page
      expect([page.title, page.items]).toEqual(["Served", [{ text: "from the app" }]])
    } finally {
      await browser.close()
      app.stop(true)
    }
  })
})

describe.skipIf(!present)("the panel", () => {
  const list = async () =>
    (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; type: string; url: string }[]

  test("without a panel, view says there is no browser", async () => {
    const browser = openPanelBrowser({ project: await temp("hb-project-"), env: {} })
    const page = await browser.view(address("/"))
    expect(page).toBeInstanceOf(Error)
    expect((page as Error).message).toContain("no browser")
    await browser.close()
  })

  test("a port that does not answer is an Error, not a hang", async () => {
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const closed = free.port
    free.stop(true)
    const browser = openPanelBrowser({ project: await temp("hb-project-"), env: { MANGO_PANEL_CDP: String(closed) } })
    expect(await browser.view(address("/"))).toBeInstanceOf(Error)
    await browser.close()
  })

  test("the page the panel already shows is reused, and a panel with none gets one", async () => {
    await withBrowser({ "/": `<!doctype html><title>One</title><p>x</p>` }, async (open) => {
      const before = await list()
      await open()
      expect((await list()).filter((target) => target.type === "page")).toHaveLength(
        before.filter((target) => target.type === "page").length,
      )
      await Promise.all(before.map((target) => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)))
      await Bun.sleep(500)
      expect((await list()).filter((target) => target.type === "page")).toHaveLength(0)
      expect((await open()).title).toBe("One")
      expect((await list()).filter((target) => target.type === "page")).toHaveLength(1)
    })
  })

  test("a port that shows the app's own window is refused", async () => {
    pages.clear()
    pages.set("/", { body: `<!doctype html><title>Mango Code</title><p>the app</p>` })
    pages.set("/other", { body: `<!doctype html><title>Other</title>` })
    const created = (await (
      await fetch(`http://127.0.0.1:${port}/json/new?${address("/")}`, { method: "PUT" })
    ).json()) as { id: string }
    await Bun.sleep(500)
    const browser = openPanelBrowser({ project: await temp("hb-project-"), env: { MANGO_PANEL_CDP: String(port) } })
    try {
      const page = await browser.view(address("/other"))
      expect(page).toBeInstanceOf(Error)
      expect((page as Error).message).toContain("Mango Code's own window")
    } finally {
      await browser.close()
      await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`)
    }
  })
})
