// A picture or a PDF of the project from the phone, inside the web app: the real app with the phone port on, a WebKit
// browser with an iPhone profile (Playwright) that joins with the key and taps the cards of the files.
//  - a picture opens full screen from memory, drawn by an image element; an SVG too, and its script does not run;
//  - a PDF opens in a frame where the browser has a PDF viewer (the policy the port adds must allow the `blob:` frame:
//    no violation), otherwise it is taken as a download;
//  - the arrow closes the view;
//  - the globe, with nothing in the computer's panel, opens the last page the conversation wrote;
//  - what the model menu says about each model (`/mango/models`) reaches the phone through the port.
// Fake engine, no GPU, the port on 127.0.0.1 (`MANGO_PHONE_PC_ONLY`). Own ports (47693-47695). With `MC_PHOTOS=<folder>`
// it saves a photo (390 px wide). `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const [AGENT, ENGINE, PHONE] = [47693, 47694, 47695];
const base = `http://127.0.0.1:${PHONE}`;

let env: Environment;
let mc: MangoCode;
let browser: any;
let ui: any;
let id = "";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>document.title = "RAN"</script><rect width="120" height="80" fill="#e8590c"/></svg>`;
/** A 240x150 PNG with a diagonal orange gradient. */
function png(width = 240, height = 150) {
  const table = Array.from({ length: 256 }, (_, n) => [...Array(8)].reduce((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n));
  const crc = (b: Buffer) => (b.reduce((c, x) => table[(c ^ x) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
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

beforeAll(async () => {
  env = await start(
    ({ project }) => [
      { tool: "write", arguments: { filePath: path.join(project, "doc.pdf"), content: PDF } },
      { tool: "write", arguments: { filePath: path.join(project, "picture.png"), content: "x" } },
      { tool: "write", arguments: { filePath: path.join(project, "vector.svg"), content: SVG } },
      { tool: "write", arguments: { filePath: path.join(project, "site.html"), content: "<!doctype html><title>Sito</title><h1>Pagina del sito</h1>" } },
      { text: "Fatto." },
    ],
    { window: true, env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), MANGO_PHONE_PC_ONLY: "1", MANGO_PHONE_PORT: String(PHONE) } },
  );
  mc = new MangoCode((await find(env.data))!);
  id = await mc.createSession(env.project, { title: "telefono" });
  for await (const _ of mc.turn(id, env.project, "Fammi un PDF, un'immagine e un disegno", { model: "fake" }));
  fs.writeFileSync(path.join(env.project, "picture.png"), png());

  // the phone port on, from the window's bridge (the page of the app is the agent's)
  const targets: any[] = await (await fetch(`http://127.0.0.1:${env.cdp}/json`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.startsWith(env.agent));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  await new Promise<void>((ok) => {
    ws.onmessage = () => ok();
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.__MANGO_DESKTOP__.phone.setEnabled(true)", awaitPromise: true } }));
  });
  ws.close();
  const key = JSON.parse(fs.readFileSync(path.join(env.data, "phone.json"), "utf8")).key as string;

  const { webkit, devices } = await import("../../packages/app/node_modules/@playwright/test");
  browser = await webkit.launch();
  const context = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
  ui = await context.newPage();
  await ui.goto(`${base}/phone?key=${key}`);
  await ui.goto(`${base}/${b64(env.project)}/session/${id}`);
  await ui.waitForSelector('[data-slot="session-turn-file-card"][data-preview]', { timeout: 60_000 });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  env?.close();
  Bun.sleepSync(1500);
});

const open = async (name: string) => {
  await ui.locator('[data-slot="session-turn-file-card"]', { hasText: name }).locator('[data-slot="session-turn-file-card-name"]').click();
};
const close = () => ui.locator('[data-action="preview-back"]').click();

test("a picture opens full screen, from memory, drawn as a picture", async () => {
  await open("picture.png");
  const img = ui.locator('[data-component="phone-preview-image"]');
  await img.waitFor({ timeout: 20_000 });
  expect(await img.getAttribute("src")).toStartWith("blob:");
  await ui.waitForFunction(() => (document.querySelector('[data-component="phone-preview-image"]') as HTMLImageElement)?.naturalWidth === 240);
  if (process.env.MC_PHOTOS) {
    fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
    await ui.screenshot({ path: path.join(process.env.MC_PHOTOS, "immagine-telefono-390.png") });
  }
  await close();
  await img.waitFor({ state: "detached" });
}, 60_000);

test("an SVG is a picture too: its script does not run", async () => {
  await open("vector.svg");
  await ui.waitForFunction(() => (document.querySelector('[data-component="phone-preview-image"]') as HTMLImageElement)?.naturalWidth > 0, null, { timeout: 20_000 });
  // the page's title is what its script would have changed
  expect(await ui.title()).not.toBe("RAN");
  await close();
}, 60_000);

test("a PDF opens in a frame where the browser has a PDF viewer, otherwise it is a download; the policy does not block it", async () => {
  const violations: string[] = [];
  ui.on("console", (m: any) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  const viewer = await ui.evaluate(() => navigator.pdfViewerEnabled === true);
  if (viewer) {
    await open("doc.pdf");
    const frame = ui.locator('iframe[title="doc.pdf"]');
    await frame.waitFor({ timeout: 20_000 });
    expect(await frame.getAttribute("src")).toStartWith("blob:");
    await Bun.sleep(1500);
    expect(violations).toEqual([]);
    await close();
  } else {
    const download = ui.waitForEvent("download", { timeout: 20_000 });
    await open("doc.pdf");
    expect((await download).suggestedFilename()).toBe("doc.pdf");
    expect(await ui.locator("iframe").count()).toBe(0);
  }
  console.log(`pdfViewerEnabled in this browser: ${viewer}`);
}, 60_000);

test("the globe opens the last page the conversation wrote when the computer's panel shows none", async () => {
  // nothing was opened in the panel of the computer: the globe finds the page the conversation wrote (site.html)
  await ui.locator('[data-action="titlebar-preview"]').click();
  const frame = ui.frameLocator('[data-component="phone-preview"] iframe');
  await frame.locator("h1").waitFor({ timeout: 30_000 });
  expect(await frame.locator("h1").textContent()).toBe("Pagina del sito");
  if (process.env.MC_PHOTOS) await ui.screenshot({ path: path.join(process.env.MC_PHOTOS, "globo-telefono-390.png") });
  await close();
}, 60_000);

test("what the model menu says about each model reaches the phone through the port", async () => {
  const info = await ui.evaluate(() => fetch("/mango/models").then(async (r) => ({ status: r.status, body: await r.json() })));
  expect(info.status).toBe(200);
  const fake = info.body.models.find((m: { key: string }) => m.key === "fake");
  expect(fake).toMatchObject({ present: true, verdict: { fits: true, where: { placement: expect.stringMatching(/^(gpu|cpu)$/) } } });
}, 60_000);
