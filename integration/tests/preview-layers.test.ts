// The Preview panel under the menus and dialogs of the page, in the app's real window (WebView2 CDP for the web UI, the
// bridge's `preview.state()` for what the native panel does). The native panel is drawn above the page, so a layer that
// reaches it makes it step aside; one that does not reach it leaves it alone:
//  - the conversation's «…» menu does not touch the panel: the panel stays live, with no picture in its place;
//  - the model menu of the top bar covers it: a picture of the page as it was takes its place, then the live page comes
//    back with no empty space between;
//  - a dialog covers it with its dimmed backdrop: the picture is under the backdrop;
//  - a capture that fails leaves the empty area and says so in the log.
// Fake engine, no GPU. Own ports (47780-47782). With `MC_PHOTOS=<folder>` it saves a photo of the window there.
// `off-screen bun test --cwd integration tests/preview-layers.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { resizeWindow } from "./window";

const [AGENT, ENGINE, DEBUG] = [47780, 47781, 47782];

let env: Environment;
let mc: MangoCode;
let p: Page;
let id = "";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
// A page that is all colors, so that a picture of it cannot be taken for an empty one.
const PAGE = `<!doctype html><title>Layers</title><body style="margin:0;height:100vh;background:linear-gradient(135deg,#e8590c,#1c7ed6 50%,#2f9e44)"><h1 style="color:white">PANEL PAGE</h1>`;

beforeAll(async () => {
  env = await start([{ text: "ok" }], {
    window: true,
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
  });
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(env.project, { title: "livelli" });
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
  const file = path.join(env.project, "layers.html");
  fs.writeFileSync(file, PAGE);
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await waitFor(`document.querySelector('[data-action="titlebar-model"]')?.innerText.includes("Fake model")`, 60_000);
  await resizeWindow(env.app.pid!, p, 900, 760);
  // the agent opens a page with the panel closed: the interface opens the panel
  await p.evaluate(`window.__MANGO_DESKTOP__.preview.go(${JSON.stringify("file:///" + file.replace(/\\/g, "/"))}).then(() => "ok")`);
  await waitFor(`document.querySelector('aside[aria-label="Anteprima"]') !== null`);
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => s.visible && s.title === "Layers")`);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
}, 30_000);

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition).catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

/** A real mouse click: the menus do not open on the DOM's `click()`. */
async function mouseClick(selector: string, text?: string) {
  const find = text
    ? `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))`
    : `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getBoundingClientRect().width > 0)`;
  const box = await p.evaluate(`(() => { const r = (${find}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}

async function escape() {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

const state = () => p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`) as Promise<{ visible: boolean }>;
const still = `document.querySelector('[data-slot="preview-page"] img[data-slot="preview-still"]')`;
const panelBox = () => p.evaluate(`(() => { const r = document.querySelector('[data-slot="preview-page"]').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, dpr: devicePixelRatio }; })()`);
const menuBox = () =>
  p.evaluate(`(() => { const r = document.querySelector('[role="menu"]').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
type Box = { left: number; top: number; right: number; bottom: number };
const crosses = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function photo(name: string) {
  if (!process.env.MC_PHOTOS) return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(process.env.MC_PHOTOS, `${name}.png`), Buffer.from(shot.result.data, "base64"));
}

/** Waits for the picture to be in the placeholder and the native panel to be out of the way. */
async function stepsAside() {
  await waitFor(`${still} !== null`);
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => !s.visible)`);
}

/** Closes what is open and waits for the live page: no picture left and the native panel shown. */
async function backLive() {
  await waitFor(`${still} === null`);
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => s.visible)`);
}

test("a menu that does not touch the panel leaves it live", async () => {
  await mouseClick('[aria-label="Altre opzioni"]');
  await waitFor(`document.querySelector('[role="menu"]') !== null`);
  expect(crosses(await menuBox(), await panelBox()), "the menu must not reach the panel for this test").toBe(false);
  await Bun.sleep(1500);
  expect((await state()).visible).toBe(true);
  expect(await p.evaluate(`${still} === null`)).toBe(true);
  await photo("menu-beside-the-panel");
  await escape();
  await waitFor(`!document.querySelector('[role="menu"]')`);
  expect((await state()).visible).toBe(true);
}, 60_000);

test("a menu over the panel puts a picture of the page in its place, and the live page comes back with no gap", async () => {
  await mouseClick('[data-action="titlebar-model"]');
  await waitFor(`document.querySelector('[role="menu"]') !== null`);
  expect(crosses(await menuBox(), await panelBox()), "the menu must reach the panel for this test").toBe(true);
  await stepsAside();
  // a PNG of the panel's size, with the page's colors in it
  const box = await panelBox();
  const picture: { w: number; h: number; colors: number; bytes: number; png: boolean } = await p.evaluate(`(async () => {
    const img = ${still};
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const colors = new Set();
    for (let x = 0; x < canvas.width; x += 17) for (let y = 0; y < canvas.height; y += 17) colors.add(context.getImageData(x, y, 1, 1).data.slice(0, 3).join());
    const bytes = await (await fetch(img.src)).arrayBuffer();
    return { w: img.naturalWidth, h: img.naturalHeight, colors: colors.size, bytes: bytes.byteLength, png: new Uint8Array(bytes).slice(1, 4).join() === "80,78,71" };
  })()`);
  expect(picture.png).toBe(true);
  expect(picture.bytes).toBeGreaterThan(1000);
  expect(Math.abs(picture.w - (box.right - box.left) * box.dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(picture.h - (box.bottom - box.top) * box.dpr)).toBeLessThanOrEqual(2);
  expect(picture.colors).toBeGreaterThan(8);
  await photo("menu-over-the-panel");

  // closing: at no moment is the native panel hidden with no picture in its place
  await escape();
  const gaps: string[] = [];
  for (let i = 0; i < 40; i++) {
    const hasStill: boolean = await p.evaluate(`${still} !== null`);
    const visible = (await state()).visible;
    if (!hasStill && !visible) gaps.push(`poll ${i}`);
    await Bun.sleep(25);
  }
  expect(gaps).toEqual([]);
  await backLive();
}, 90_000);

test("a dialog covers the panel with its dimmed backdrop, and the picture is under it", async () => {
  await mouseClick('[aria-label="Altre opzioni"]');
  await waitFor(`document.querySelector('[role="menu"]') !== null`);
  await mouseClick('[role="menuitem"]', "Elimina");
  await waitFor(`document.querySelector('[data-component="dialog-overlay"]') !== null`);
  await stepsAside();
  // the backdrop is above the picture, at a point the dialog itself does not cover: it dims it with the rest of the page
  const above: boolean = await p.evaluate(`(() => {
    const r = ${still}.getBoundingClientRect();
    const top = document.elementFromPoint(r.right - 4, r.top + r.height / 2);
    return top?.matches('[data-component="dialog-overlay"]') ?? false;
  })()`);
  expect(above).toBe(true);
  await photo("dialog-over-the-panel");
  await escape();
  await waitFor(`document.querySelector('[data-component="dialog-overlay"]') === null`);
  await backLive();
}, 90_000);

test("a capture that fails leaves the empty area and says so in the log", async () => {
  // the app refuses the picture, as the browser's own error answer to the call would
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*preview_capture*" }] });
  let refused = 0;
  p.on("Fetch.requestPaused", (e) => {
    refused++;
    void p.send("Fetch.fulfillRequest", {
      requestId: e.requestId,
      responseCode: 400,
      responseHeaders: [{ name: "Tauri-Response", value: "error" }, { name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }],
      body: btoa(JSON.stringify({ code: "io", message: "no picture" })),
    }).catch(() => {});
  });
  try {
    await mouseClick('[data-action="titlebar-model"]');
    await waitFor(`document.querySelector('[role="menu"]') !== null`);
    await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => !s.visible)`);
    expect(refused).toBeGreaterThan(0);
    expect(await p.evaluate(`${still} === null`)).toBe(true);
    const log = path.join(env.data, "logs", "ui.log");
    for (let t = 0; t < 10_000 && !(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("preview: no picture of the page")); t += 250) await Bun.sleep(250);
    expect(fs.readFileSync(log, "utf8")).toContain("preview: no picture of the page");
    // it does not try again and again while the menu stays open
    const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes("preview: no picture of the page")).length;
    await Bun.sleep(1500);
    expect(fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes("preview: no picture of the page")).length).toBe(lines);
  } finally {
    await p.send("Fetch.disable");
  }
  await escape();
  await backLive();
}, 90_000);
