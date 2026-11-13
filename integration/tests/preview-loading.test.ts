// The Preview panel while a page is loading, in the app's real window (WebView2 CDP for the web UI, the bridge's `preview.state()` for what the
// native panel is doing). A page that is on its way shows the app's own dark message instead of a blank rectangle; every kind of content (page,
// picture, PDF, SVG, a refused address) ends the loading; an address that does not answer within the limit (a short one here) is given up with a
// sentence and a "Try again" button; a page that arrived and is still loading is left alone.
// Fake engine, no GPU. Own ports (47760-47763). With `MC_PHOTOS=<folder>` it saves a photo of the window (860 px and 390 px wide) there.
// `bun test --cwd integration tests/preview-loading.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG, CONTENT] = [47760, 47761, 47762, 47763];
const LIMIT_MS = 15_000;

let env: Environment;
let mc: MangoCode;
let p: Page;
let ratio = 1;
let hanging = true;
let server: ReturnType<typeof Bun.serve>;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
// A PDF with one page that says "Panel PDF".
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 28 Tf 40 100 Td (Panel PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF
`;
/** A 240x150 PNG with a diagonal orange gradient. */
function png(width = 240, height = 150) {
  const crcTable = Array.from({ length: 256 }, (_, n) => [...Array(8)].reduce((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n));
  const crc = (b: Buffer) => (b.reduce((c, x) => crcTable[(c ^ x) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set([232, 89 + Math.round((x / width) * 120), 12 + Math.round((y / height) * 100)], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png();
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#e8590c"/></svg>`;
const base = `http://127.0.0.1:${CONTENT}`;

beforeAll(async () => {
  server = Bun.serve({
    port: CONTENT,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const u = new URL(req.url);
      const wait = Number(u.searchParams.get("ms") ?? 0);
      if (wait) await Bun.sleep(wait);
      // a server that accepts and never answers, until the test says it is back
      if (u.pathname === "/hang" && hanging) return new Promise<Response>(() => {});
      if (u.pathname === "/image.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (u.pathname === "/doc.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } });
      // arrives at once, but its picture never does: the document stays "loading"
      if (u.pathname === "/slow-picture") return new Response(`<!doctype html><title>Slow picture</title><h1>here</h1><img src="/hang?x=${Date.now()}">`, { headers: { "content-type": "text/html" } });
      return new Response(`<!doctype html><title>Page ${u.pathname}</title><body style="background:#2b2f45;color:#fff"><h1>${u.pathname}</h1>`, { headers: { "content-type": "text/html" } });
    },
  });
  env = await start([{ text: "ok" }], {
    window: true,
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}`, MANGO_PREVIEW_LIMIT_MS: String(LIMIT_MS) },
  });
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  const id = await mc.createSession(env.project, { title: "caricamento" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  fs.writeFileSync(path.join(env.project, "picture.png"), PNG);
  fs.writeFileSync(path.join(env.project, "doc.pdf"), PDF);
  fs.writeFileSync(path.join(env.project, "vector.svg"), SVG);
  ratio = await p.evaluate("window.devicePixelRatio");
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await waitFor(`document.querySelector('[data-component="prompt-input"], textarea') !== null`, 60_000);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  server?.stop(true);
  Bun.sleepSync(1500);
});

type PanelState = { url: string; loading: boolean; failed: string | null; visible: boolean };
const state = () => p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`) as Promise<PanelState>;
const go = (url: string) => p.evaluate(`window.__MANGO_DESKTOP__.preview.go(${JSON.stringify(url)}).then(() => "ok", (e) => e.code)`);
const status = () => p.evaluate(`document.querySelector('[data-slot="preview-status"]')?.textContent ?? ""`) as Promise<string>;
const file = (name: string) => p.evaluate(`window.__MANGO_DESKTOP__.preview.openFile(${JSON.stringify(path.join(env.project, name))}).then(() => "ok", (e) => e.code)`);

/** A photo of the real window (the native panel is not in the page's own screenshot) at the given CSS width. */
function windowPhoto(name: string, ratio: number) {
  if (!process.env.MC_PHOTOS) return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  for (const css of [860, 390]) {
    const out = path.join(process.env.MC_PHOTOS, `${name}-${css}.png`);
    const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id ${env.app.pid}).MainWindowHandle
[W]::SetWindowPos($h, [IntPtr](-1), 20, 20, [int](${css} * ${ratio}) + 16, [int](760 * ${ratio}), 0x40) | Out-Null
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Seconds 2
$rect = New-Object RECT
[W]::GetWindowRect($h, [ref]$rect) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($rect.L, $rect.T, 0, 0, $bmp.Size)
$bmp.Save('${out}')
`;
    spawnSync("powershell", ["-NoProfile", "-Command", script]);
  }
}

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

async function until(what: string, ok: (s: PanelState) => boolean, ms = 10_000) {
  for (let t = 0; t < ms; t += 100) {
    if (ok(await state())) return;
    await Bun.sleep(100);
  }
  throw new Error(`${what}: ${JSON.stringify(await state())}`);
}

test("a page on its way shows the app's own message, then the page", async () => {
  expect(await go(`${base}/first?ms=11000`)).toBe("ok");
  await waitFor(`document.querySelector('aside[aria-label="Anteprima"]') !== null`);
  await Bun.sleep(500);
  expect(await state()).toMatchObject({ loading: true, url: "", visible: false });
  expect(await status()).toBe("Carico l'anteprima…");
  windowPhoto("anteprima-in-caricamento", ratio);
  await until("the page arrives", (s) => s.url.endsWith("/first?ms=11000") && !s.loading, 15_000);
  await waitFor(`!document.querySelector('[data-slot="preview-status"]')`);
  expect(await state()).toMatchObject({ failed: null });
}, 60_000);

test("every kind of content ends the loading", async () => {
  const ends = async (open: () => Promise<unknown>, name: string) => {
    expect(await open(), name).toBe("ok");
    await Bun.sleep(300);
    await until(`${name} ends the loading`, (s) => !s.loading && s.url !== "", 8000);
  };
  await ends(() => go(`${base}/plain`), "a page");
  await ends(() => go(`${base}/image.png`), "a picture by address");
  await ends(() => go(`${base}/doc.pdf`), "a PDF by address");
  await ends(() => file("picture.png"), "a picture file");
  await ends(() => file("picture.png"), "the same picture file again");
  await ends(() => file("doc.pdf"), "a PDF file");
  await ends(() => file("vector.svg"), "an SVG file");
  await ends(() => go("http://127.0.0.1:47779/"), "an address that refuses the connection");
}, 90_000);

test("a data: page arrives and is not given up, however its text is written in the address", async () => {
  // WebView2 reports no end of loading for a data: address and its own address for the page is not one the app can read
  // (`Webview::url` fails): the panel used to wait the limit and then say the address does not answer
  const written = [
    `data:text/html,<title>Data page</title><h1 style="color:#c40">Hello, panel</h1> two words & more`,
    "data:text/html,%3Ctitle%3EData%20page%3C/title%3E%3Ch1%3EHello%3C/h1%3E",
    "data:text/html;base64,PHRpdGxlPkRhdGEgcGFnZTwvdGl0bGU+PGgxPkhlbGxvPC9oMT4=",
  ];
  for (const address of written) {
    expect(await go(address)).toBe("ok");
    await until(`${address.slice(0, 40)} arrives`, (s) => s.url.startsWith("data:text/html") && !s.loading, 8000);
  }
  await Bun.sleep(LIMIT_MS + 2500);
  expect(await state()).toMatchObject({ failed: null, loading: false });
  expect((await state()).url).toStartWith("data:text/html");
}, 60_000);

test("an address that does not answer is given up, with a sentence and a way to try again", async () => {
  hanging = true;
  // a page is showing: it is replaced by the sentence, not left looking as if the new address were fine
  expect(await go(`${base}/before`)).toBe("ok");
  await until("a page shows", (s) => s.url.endsWith("/before") && !s.loading);
  expect(await go(`${base}/hang`)).toBe("ok");
  await Bun.sleep(1000);
  expect(await state()).toMatchObject({ loading: true });
  await until("the panel gives up", (s) => s.failed !== null, LIMIT_MS + 6000);
  await waitFor(`document.querySelector('[data-slot="preview-status"]')?.textContent.startsWith("Non riesco ad aprire")`);
  expect(await state()).toMatchObject({ failed: `${base}/hang`, url: "", loading: false, visible: false });
  expect(await status()).toBe(`Non riesco ad aprire ${base}/hang: non risponde.`);
  windowPhoto("anteprima-non-risponde", ratio);
  // the server is back: "Riprova" opens the same address
  hanging = false;
  await p.evaluate(`document.querySelector('[data-action="preview-retry"]').click()`);
  await until("the retry arrives", (s) => s.url === `${base}/hang` && !s.loading && s.failed === null);
  await waitFor(`!document.querySelector('[data-slot="preview-status"]')`);
}, 90_000);

test("a page that arrived and is still loading is not given up", async () => {
  expect(await go(`${base}/slow-picture`)).toBe("ok");
  await Bun.sleep(LIMIT_MS + 2500);
  expect(await state()).toMatchObject({ url: `${base}/slow-picture`, failed: null });
}, 30_000);
