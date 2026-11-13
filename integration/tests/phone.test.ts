// "From your phone" with the real app: off by default; turned on from the settings (the window's bridge), the link
// with the key gives the cookie and from there the web UI and the agent's routes pass through the phone port; a
// foreign page does not; turned off, the port closes. The port sits on 127.0.0.1 (`MANGO_PHONE_PC_ONLY`, only in
// development builds): the test does not make Windows ask to open it on the network. The rules one by one are the
// tests of the `phone` crate (`cargo test -p phone`); that it listens only on the addresses of the links is one of them.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let p: Page;
let port: number;
let base: string;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

beforeAll(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = await start([{ text: "Hello from the fake engine." }], {
    window: true,
    env: { MANGO_PHONE_PC_ONLY: "1", MANGO_PHONE_PORT: String(port), MANGO_NETWORK_PUBLIC: "1" },
  });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const bridge = (code: string) => p.evaluate(`window.__MANGO_DESKTOP__.phone.${code}`);
const key = () => JSON.parse(fs.readFileSync(path.join(env.data, "phone.json"), "utf8")).key as string;

test("off by default: the port is not open", async () => {
  expect((await bridge("state()")).enabled).toBe(false);
  expect(fs.existsSync(path.join(env.data, "phone.json"))).toBe(false);
  expect(await fetch(`${base}/`).then(() => "open", () => "closed")).toBe("closed");
});

test("on: with the link you get in and the web UI and the agent pass; without it, no", async () => {
  const state = await bridge("setEnabled(true)");
  expect(state.enabled).toBe(true);
  expect(state.listening).toBe(true);
  expect(state.port).toBe(port);
  // Windows calls the home network public (here by the development switch): the link says so; Tailscale's never does
  if (state.home) expect(state.home.public).toBe(true);
  if (state.away) expect(state.away.public).toBe(false);

  expect((await fetch(`${base}/`, { headers: { accept: "text/html" } })).status).toBe(401);
  expect((await fetch(`${base}/phone?key=wrong`, { redirect: "manual" })).status).toBe(401);

  const entry = await fetch(`${base}/phone?key=${key()}`, { redirect: "manual" });
  expect(entry.status).toBe(303);
  const cookie = entry.headers.get("set-cookie")!.split(";")[0];
  expect(cookie).toStartWith("mango_phone=");

  const home = await fetch(`${base}/`, { headers: { cookie, accept: "text/html" } });
  expect(home.status).toBe(200);
  expect(await home.text()).toContain('id="root"');
  const directory = encodeURIComponent(env.project);
  const sessions = await fetch(`${base}/session?directory=${directory}`, { headers: { cookie } });
  expect(sessions.status).toBe(200);
  expect(Array.isArray(await sessions.json())).toBe(true);
  // The phone's web UI sends the phone port's Origin: the agent treats it as its own.
  const fromPage = await fetch(`${base}/session?directory=${directory}`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
  expect(fromPage.status).toBe(200);

  const foreign = await fetch(`${base}/session?directory=${directory}`, { method: "POST", headers: { cookie, origin: "https://foreign-site.example", "content-type": "application/json" }, body: "{}" });
  expect(foreign.status).toBe(403);
  expect((await fetch(`${base}/mango/reload`, { method: "POST", headers: { cookie } })).status).toBe(403);
  // The log does not have the key.
  expect(fs.readFileSync(path.join(env.data, "logs", "phone.log"), "utf8")).not.toContain(key());
}, 60_000);

test("off: the port closes and the link is no longer valid", async () => {
  const old = key();
  expect((await bridge("setEnabled(false)")).enabled).toBe(false);
  expect(await fetch(`${base}/`).then(() => "open", () => "closed")).toBe("closed");
  await bridge("setEnabled(true)");
  expect((await fetch(`${base}/phone?key=${old}`, { redirect: "manual" })).status).toBe(401);
  await bridge("setEnabled(false)");
});

// The web UI as a phone gets it: the page of the phone port (its cookie, its Origin) on a 390 px screen, and no bridge of
// the app's window (the window is the app's: only a browser of its own has none). From there the paths are the same and
// what is the computer's says so. Any Chromium that Playwright has installed will do; with none, the test fails saying so.
const SECTIONS = ["models", "computer", "agent", "links", "general", "help"];
let browser: any;
let ui: any;

/** The newest Chromium Playwright installed on this PC, or `undefined` for the one its own version asks for. */
function installedChromium() {
  const folder = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const newest = fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1) : undefined;
  const exe = newest && path.join(folder, newest, "chrome-win64", "chrome.exe");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

const read = (route: string) => ui.evaluate(`fetch(${JSON.stringify(route)}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

test("from a phone-sized page: the Home has «Archived» at the top, beside the search", async () => {
  await bridge("setEnabled(true)");
  const { chromium } = await import("../../packages/app/node_modules/@playwright/test");
  browser = await chromium.launch({ executablePath: installedChromium() });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "it-IT" });
  ui = await context.newPage();
  await ui.goto(`${base}/phone?key=${key()}`);
  await ui.waitForSelector('[data-component="home-mobile"]', { timeout: 60_000 });
  expect(await ui.evaluate("typeof window.__MANGO_DESKTOP__")).toBe("undefined");

  const archived = ui.locator('[data-action="home-toggle-archived"]');
  expect(await archived.count()).toBe(1);
  const search = await ui.locator('[data-component="home-mobile"] input[type="search"]').boundingBox();
  const button = (await archived.boundingBox())!;
  // on the search's line, a thumb wide, inside the screen
  expect(Math.abs(button.y + button.height / 2 - (search!.y + search!.height / 2))).toBeLessThan(4);
  expect(button.width).toBeGreaterThanOrEqual(44);
  expect(button.x + button.width).toBeLessThanOrEqual(390);
  if (process.env.MC_PHOTOS) {
    fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
    await ui.screenshot({ path: path.join(process.env.MC_PHOTOS, "telefono-home-390.png") });
  }
  await archived.click();
  await ui.waitForSelector('[data-component="home-mobile"] input[type="search"]', { state: "detached" });
  expect(await archived.innerText()).toBe("Torna alle conversazioni");
  await archived.click();
  await ui.waitForSelector('[data-component="home-mobile"] input[type="search"]');
}, 120_000);

test("every section of the settings opens from the phone and says what is done from the computer", async () => {
  for (const section of SECTIONS) {
    await ui.goto(`${base}/settings?section=${section}`);
    await ui.waitForFunction((name: string) => document.querySelector(`[data-pane="${name}"]`) !== null && document.body.innerText.includes("Si fa dal computer"), section, { timeout: 30_000 });
    if (process.env.MC_PHOTOS) await ui.screenshot({ path: path.join(process.env.MC_PHOTOS, `telefono-impostazioni-${section}-390.png`) });
  }
  // the models are read through the port: the list is there, what changes the computer is off
  await ui.goto(`${base}/settings?section=models`);
  await ui.waitForSelector('[data-model-row="fake"]', { timeout: 30_000 });
  for (const action of ["settings-models-add", "settings-models-folder"]) expect(await ui.locator(`[data-action="${action}"]`).isDisabled(), action).toBe(true);
  // the cards of the connections cannot read what they would say (the phone is on, a key may be saved): they claim nothing, except the other PC's engine, which the agent's state tells
  await ui.goto(`${base}/settings?section=links`);
  await ui.waitForSelector('[data-link-card="remote"] .settings-page-pill', { timeout: 30_000 });
  expect(await ui.locator(".settings-page-link-card .settings-page-pill").allInnerTexts()).toEqual(["Non collegato"]);
  await ui.goto(`${base}/settings?section=help`);
  expect(await ui.locator('[data-action="settings-open-logs"]').isDisabled()).toBe(true);
}, 150_000);

test("the phone reads the state, the models and the computer and chooses the model; the computer's own routes stay shut", async () => {
  const state = await read("/mango/state");
  expect(state.status).toBe(200);
  expect(state.body.model.phase).toBe("ready");
  const models = await read("/mango/models");
  expect(models.status).toBe(200);
  expect(models.body.models.map((m: any) => m.key)).toContain("fake");
  const computer = await read("/mango/computer");
  expect(computer.status).toBe(200);
  expect(typeof computer.body.cpu).toBe("string");
  const chosen = await ui.evaluate(`fetch("/mango/model/use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fake" }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  expect(chosen.status).toBe(200);
  expect(chosen.body.model.model).toBe("fake");
  for (const route of ["/mango/processes", "/mango/extra-folders"]) expect((await read(route)).status, route).toBe(403);
  await browser.close();
  await bridge("setEnabled(false)");
}, 60_000);

/** Another computer of its own (with the window's bridge to turn the phone on), and a phone-sized Chromium on its phone port. */
async function otherPhone(options: Parameters<typeof start>[1]) {
  const phonePort = await freePort();
  const other = await start([], { ...options, window: true, env: { MANGO_PHONE_PC_ONLY: "1", MANGO_PHONE_PORT: String(phonePort), MANGO_NETWORK_PUBLIC: "1" } });
  const app = await page(other.cdp!, (t) => t.url.startsWith(other.agent));
  await app.evaluate("window.__MANGO_DESKTOP__.phone.setEnabled(true)");
  const otherKey = JSON.parse(fs.readFileSync(path.join(other.data, "phone.json"), "utf8")).key as string;
  const { chromium } = await import("../../packages/app/node_modules/@playwright/test");
  const own = await chromium.launch({ executablePath: installedChromium() });
  const context = await own.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "it-IT" });
  const phone = await context.newPage();
  const address = `http://127.0.0.1:${phonePort}`;
  await phone.goto(`${address}/phone?key=${otherKey}`);
  const close = async () => {
    await own.close();
    app.close();
    other.close();
    Bun.sleepSync(1500);
    try {
      fs.rmSync(other.root, { recursive: true, force: true });
    } catch {}
  };
  return { env: other, phone, address, close };
}

test("a computer with no model: the phone gets the first-start Home, where nothing is downloaded from, and says where it is done", async () => {
  const other = await otherPhone({ noModels: true });
  try {
    const phone = other.phone;
    await phone.waitForSelector('[data-component="mango-welcome"]', { timeout: 60_000 });
    if (process.env.MC_PHOTOS) await phone.screenshot({ path: path.join(process.env.MC_PHOTOS, "telefono-primo-avvio-390.png") });
    expect(await phone.locator('[data-action="mango-start"]').count()).toBe(0);
    // nothing is downloaded from here: the note about the download («Ne aggiungi altri…») is not said
    expect(await phone.locator('[data-component="mango-recommended"]').innerText()).not.toContain("da scaricare");
    // the way to choose is there, and it says it is done from the computer; nothing offers to download or add a file
    await phone.locator('[data-action="mango-choose"]').click();
    await phone.waitForSelector('[data-component="mango-choose-list"]');
    expect(await phone.locator('[data-slot="mango-pc-only"]').innerText()).toContain("Si fa dal computer");
    expect(await phone.locator('[data-action="mango-start-chosen"]').count()).toBe(0);
    expect(await phone.locator('[data-action="mango-pick-file"]').count()).toBe(0);
    // a conversation can be opened and written in; its line says there is no model, and the way it points to says where it is done
    const directory = Buffer.from(other.env.project).toString("base64url");
    await phone.goto(`${other.address}/${directory}/session`);
    await phone.locator('[data-action="mango-choose-model"]').click({ timeout: 60_000 });
    await phone.waitForSelector('[data-component="settings-page"]');
    expect(phone.url()).toContain("section=models");
    expect(await phone.locator('[data-slot="settings-pc-only"]').innerText()).toContain("Si fa dal computer");
  } finally {
    await other.close();
  }
}, 240_000);

test("a computer with no project yet: the phone cannot start the first conversation and says where it is done", async () => {
  const other = await otherPhone({});
  try {
    const phone = other.phone;
    await phone.waitForSelector('[data-slot="home-pc-only"]', { timeout: 60_000 });
    if (process.env.MC_PHOTOS) await phone.screenshot({ path: path.join(process.env.MC_PHOTOS, "telefono-senza-progetti-390.png") });
    expect(await phone.locator('[data-slot="home-pc-only"]').innerText()).toContain("Si fa dal computer");
    expect(await phone.locator('[data-action="home-new-session"]').isDisabled()).toBe(true);
  } finally {
    await other.close();
  }
}, 240_000);
