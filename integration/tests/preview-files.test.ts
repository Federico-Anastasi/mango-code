// A PDF, a picture or a web page of the project opens in the Preview panel from its card in the chat, in the app's real window
// (WebView2 CDP for the web UI, the bridge's `preview.state()` for what the native panel shows):
//  - a PDF and a picture open in the panel; an SVG goes through a page that draws it as a picture, so its script never runs;
//  - an html page opens in the panel too, by its own address, and runs, also from "Open" next to its name in the chat;
//  - a file that is too big, unreadable, outside the project or of another type is refused with a reason that the card shows;
//  - the click on the card does it all, the panel opens in the conversation.
// Fake engine, no GPU. Own ports (47690-47692). With `MC_PHOTOS=<folder>` it saves a photo of the window (860 px and
// 390 px wide) there. `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47690, 47691, 47692];

let env: Environment;
let mc: MangoCode;
let p: Page;
let id = "";
let locked = "";
let ratio = 1;

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
// A page that changes its own title: the title of the panel says the script ran.
const PAGE = `<!doctype html><title>before</title><h1>Page in the panel</h1><script>document.title = "ran"</script>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><script>document.title = "RAN"</script><rect width="120" height="80" fill="#e8590c"/></svg>`;

beforeAll(async () => {
  env = await start(
    ({ project }) => [
      { tool: "write", arguments: { filePath: path.join(project, "doc.pdf"), content: PDF } },
      { tool: "write", arguments: { filePath: path.join(project, "picture.png"), content: "x" } },
      { tool: "write", arguments: { filePath: path.join(project, "page.html"), content: "x" } },
      { text: "Fatto." },
    ],
    { window: true, env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` } },
  );
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(env.project, { title: "anteprima" });
  for await (const _ of mc.turn(id, env.project, "Fammi un PDF e un'immagine", { model: "fake" }));
  // the files the agent "wrote" as text become real ones
  fs.writeFileSync(path.join(env.project, "picture.png"), PNG);
  fs.writeFileSync(path.join(env.project, "vector.svg"), SVG);
  fs.writeFileSync(path.join(env.project, "notes.docx"), "x");
  fs.writeFileSync(path.join(env.project, "script.js"), "1");
  fs.writeFileSync(path.join(env.project, "page.html"), PAGE);
  fs.writeFileSync(path.join(env.project, "old page.htm"), PAGE);
  fs.writeFileSync(path.join(env.project, "big.png"), "");
  fs.truncateSync(path.join(env.project, "big.png"), 51 * 1024 * 1024);
  locked = path.join(env.project, "locked.pdf");
  fs.writeFileSync(locked, PDF);
  // a file the user cannot read: the ACL denies reading to the current user
  spawnSync("icacls", [locked, "/deny", `${process.env.USERNAME}:(R)`]);
  ratio = await p.evaluate("window.devicePixelRatio");
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await waitFor(`document.querySelectorAll('[data-slot="session-turn-file-card"][data-preview]').length >= 2`, 60_000);
}, 200_000);

afterAll(() => {
  if (locked) spawnSync("icacls", [locked, "/remove:d", `${process.env.USERNAME}`]);
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
});

const open = (file: string) => p.evaluate(`window.__MANGO_DESKTOP__.preview.openFile(${JSON.stringify(path.join(env.project, file))}).then(() => "ok", (e) => e.code)`);
const shown = async () => {
  await Bun.sleep(1500);
  return p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`) as Promise<{ url: string; title: string }>;
};

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
Start-Sleep -Seconds 3
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

test("a PDF and a picture open in the panel, by their own address", async () => {
  expect(await open("doc.pdf")).toBe("ok");
  const pdf = await shown();
  expect(decodeURI(pdf.url)).toBe("file:///" + path.join(env.project, "doc.pdf").replace(/\\/g, "/"));
  windowPhoto("pdf-nel-pannello", ratio);
  expect(await open("picture.png")).toBe("ok");
  expect(decodeURI((await shown()).url)).toBe("file:///" + path.join(env.project, "picture.png").replace(/\\/g, "/"));
  windowPhoto("immagine-nel-pannello", ratio);
}, 60_000);

test("a web page opens in the panel, by its own address, and runs", async () => {
  for (const file of ["page.html", "old page.htm"]) {
    expect(await open(file)).toBe("ok");
    const page = await shown();
    expect(decodeURI(page.url)).toBe("file:///" + path.join(env.project, file).replace(/\\/g, "/"));
    expect(page.title).toBe("ran");
  }
  windowPhoto("pagina-nel-pannello", ratio);
}, 60_000);

test("an SVG is drawn as a picture: its script never runs", async () => {
  expect(await open("vector.svg")).toBe("ok");
  const svg = await shown();
  expect(svg.url).toContain("/preview-view/image.html");
  expect(svg.title).toBe("vector.svg");
  const page = fs.readFileSync(path.join(env.data, "preview-view", "image.html"), "utf8");
  expect(page).toContain("vector.svg");
  expect(page).not.toContain("<script");
}, 60_000);

test("what is not a PDF, a picture or a web page, is too big, is not readable or is out of the project is refused with its reason", async () => {
  expect(await open("notes.docx")).toBe("blocked_type");
  expect(await open("script.js")).toBe("blocked_type");
  expect(await open("big.png")).toBe("too_large");
  expect(await open("locked.pdf")).toBe("unreadable");
  expect(await open("gone.pdf")).toBe("not_found");
  const outside = path.join(env.root, "outside.pdf");
  fs.writeFileSync(outside, PDF);
  expect(await p.evaluate(`window.__MANGO_DESKTOP__.preview.openFile(${JSON.stringify(outside)}).then(() => "ok", (e) => e.code)`)).toBe("forbidden");
  // a refusal does not change what the panel shows
  expect((await shown()).url).toContain("/preview-view/image.html");
}, 60_000);

const card = (name: string) => `[...document.querySelectorAll('[data-slot="session-turn-file-card"]')].find((c) => c.innerText.includes(${JSON.stringify(name)}))`;

test("a click on the card of a file opens it in the panel of that conversation, and a big one says why", async () => {
  expect(await p.evaluate(`${card("doc.pdf")}.innerText`)).toContain("Documento PDF");
  // the click is on the name of the card, not on the "Open" button; the panel shows the SVG now
  expect((await shown()).url).toContain("/preview-view/image.html");
  await p.evaluate(`${card("picture.png")}.querySelector('[data-slot="session-turn-file-card-name"]').click()`);
  await waitFor(`document.querySelector('aside[aria-label="Anteprima"]') !== null`);
  expect(decodeURI((await shown()).url)).toEndWith("/picture.png");

  // the file grows over the limit: the click says so, on the card
  fs.truncateSync(path.join(env.project, "picture.png"), 51 * 1024 * 1024);
  await p.evaluate(`${card("picture.png")}.click()`);
  await waitFor(`document.body.innerText.includes("Troppo grande per l'anteprima")`);
  windowPhoto("file-troppo-grande", ratio);
  fs.writeFileSync(path.join(env.project, "picture.png"), PNG);
}, 120_000);

test("Open on an html file in the chat shows it in the panel", async () => {
  // a page has lines to read, so it is a header with its changes and not a card; "Open" is in the header
  await p.evaluate(`[...document.querySelectorAll('[data-slot="session-turn-diff-trigger"]')].find((h) => h.innerText.includes("page.html")).querySelector('[data-slot="project-file-action"]').click()`);
  await waitFor(`document.querySelector('aside[aria-label="Anteprima"]') !== null`);
  const page = await shown();
  expect(decodeURI(page.url)).toEndWith("/page.html");
  expect(page.title).toBe("ran");
  windowPhoto("apri-html-nel-pannello", ratio);
}, 120_000);

test("when the window moves to another page of the app the panel does not stay over it as a blank rectangle", async () => {
  expect((await shown()) as { visible?: boolean }).toMatchObject({ visible: true });
  // the model choice and the return, or a reload, take the whole window to another document: the web UI that placed the panel is gone
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await Bun.sleep(3000);
  expect(await p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`)).toMatchObject({ visible: false });
  windowPhoto("home-senza-pannello", ratio);
}, 60_000);
