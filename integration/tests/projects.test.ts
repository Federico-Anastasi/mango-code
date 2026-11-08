// The projects from the app's window, driven like a user (WebView2 CDP): open an existing folder with the
// Windows picker, create a new one in a chosen location, reopen a project already used. The picker is the real
// one: `selector.ps1` drives it. Fake engine, no GPU.
// `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { answer } from "./dialog";

let env: Environment;
let p: Page;

beforeAll(async () => {
  env = await start([{ text: "ok" }], { window: true });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
  await Bun.sleep(3000);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const text = () => p.evaluate("document.body.innerText") as Promise<string>;

/** Click on a page button, found by its text. */
async function click(label: string) {
  const r = await p.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(e => e.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(label)});
    if (!el) return 'not found';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  })()`);
  expect(`${label}: ${r}`).toBe(`${label}: ok`);
}

/** Answers the Windows folder picker opened by the tests' app. */
async function picker(...args: string[]) {
  const r = await answer(env.app.pid!, ...args);
  expect(r.code, `${r.output}\nPage:\n${r.code ? await text() : ""}`).toBe(0);
}

async function waitUntil(condition: () => Promise<boolean>, timeout = 20_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    if (await condition()) return;
    await Bun.sleep(300);
  }
}

const workFolder = (name: string) => {
  const folder = path.join(env.root, name);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "index.html"), "<h1>hello</h1>");
  return folder;
};

test("the bridge commands that touch the window answer even with the Preview panel", async () => {
  const command = (name: string, args: object) =>
    p.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:mango-bridge|${name}', ${JSON.stringify(args)}).then(() => 'ok', (e) => JSON.stringify(e))`);
  expect(await command("set_titlebar_color", { r: 10, g: 10, b: 10 })).toBe("ok");
  expect(await command("preview_place", { x: 0, y: 0, width: 100, height: 100, dpr: 1, zoom: 1, visible: false })).toBe("ok");
}, 60_000);

test("an existing folder opens with the Windows picker", async () => {
  const folder = workFolder("test-site");
  await click("Apri una cartella esistente");
  await picker("-Path", folder);
  await waitUntil(async () => (await text()).includes("test-site"));
  expect(await text()).toContain("test-site");
  expect(await text()).not.toContain("Richiesta non riuscita");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 120_000);

test("cancelling the picker changes nothing and shows no errors", async () => {
  const before = await text();
  await click("Apri una cartella esistente");
  await picker("-Cancel");
  await Bun.sleep(1500);
  expect(await text()).toBe(before);
}, 60_000);
