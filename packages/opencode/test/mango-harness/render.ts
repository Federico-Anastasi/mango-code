// Makes the PDF and PNG files a test reads from pages of HTML, with Chrome or Edge without a window: every file
// `<name>.pdf.html` or `<name>.png.html` of a folder becomes `<name>.pdf` or `<name>.png` under another, and the folder
// of pages is removed. A PNG is as large as the `render-size` of its page (`<meta name="render-size"
// content="760,560">`); a PDF is as large as its `@page`.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const AT_ONCE = 3
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]

const chromeFile = async () => {
  const found = (
    await Promise.all(CHROME_PATHS.map(async (file) => ((await Bun.file(file).exists()) ? file : undefined)))
  ).find(Boolean)
  if (!found) throw new Error(`Neither Chrome nor Edge is in ${CHROME_PATHS.join(" or ")}.`)
  return found
}

const renderOne = async (chrome: string, source: string, target: string) => {
  const html = await Bun.file(source).text()
  const size = /<meta name="render-size" content="(\d+),(\d+)">/.exec(html)
  const pdf = target.endsWith(".pdf")
  const profile = await mkdtemp(path.join(tmpdir(), "hb-render-"))
  await mkdir(path.dirname(target), { recursive: true })
  const child = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      ...(pdf
        ? ["--no-pdf-header-footer", `--print-to-pdf=${target}`]
        : [`--screenshot=${target}`, `--window-size=${size?.[1] ?? 760},${size?.[2] ?? 600}`, "--hide-scrollbars"]),
      `file:///${source.replaceAll("\\", "/").replaceAll(" ", "%20")}`,
    ],
    { windowsHide: true, stdout: "ignore", stderr: "ignore" },
  )
  await child.exited
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined)
  if (!(await Bun.file(target).exists())) throw new Error(`Chrome made no ${path.basename(target)}`)
}

/** Renders every page of `pages` into `into`, then removes `pages`. */
export async function render(pages: string, into: string) {
  const sources = (await readdir(pages, { recursive: true })).filter((file) => /\.(pdf|png)\.html$/.test(file))
  const chrome = await chromeFile()
  const queue = [...sources]
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, sources.length) }, async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift())
        await renderOne(chrome, path.join(pages, file), path.join(into, file.replace(/\.html$/, "")))
    }),
  )
  await rm(pages, { recursive: true, force: true })
}

