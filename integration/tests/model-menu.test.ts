// The two model menus (the app's real window, WebView2 CDP): the one in the top bar and the one under the chat list the
// same models, those on the computer, and say which one is in use and which is the default. Under the chat each row has
// its line: weight, where it runs, whether it reads images, and no judgment of the model, not even for the one the
// catalog marks `on_request`. Choosing a model in the bar uses it at once, and the conversation's model follows it.
// Fake engine, no GPU used (the models are small files; where they run is what this PC's hardware says, so the test
// checks the form of the line and not the place).
// Own ports (47696-47699). With `MC_PHOTOS=<folder>` it saves the screenshots (860 px and 390 px) there.
// `bun test --cwd integration tests/model-menu.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47696, 47697, 47698];
const GB = 1024 ** 3;

let env: Environment;
let mc: MangoCode;
let p: Page;
let id = "";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

beforeAll(async () => {
  env = await start([{ text: "ok" }], {
    window: true,
    otherModels: ["small", "huge", "weak"],
    bytes: { small: 3 * GB, huge: 10 * 2 ** 40, weak: GB },
    onRequest: ["weak"],
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
  });
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(env.project, { title: "modelli" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
});

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

/** A real mouse click: the menu does not open on the DOM's `click()`. */
async function mouseClick(selector: string) {
  const box = await p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}

test("the agent tells what the menu says: weight and where it runs, with no judgment of the model", async () => {
  const catalog = await (await fetch(`${env.agent}/mango/models`)).json();
  const by = Object.fromEntries(catalog.models.map((m: { key: string }) => [m.key, m]));
  expect(Object.keys(by)).toEqual(expect.arrayContaining(["fake", "small", "huge", "weak"]));
  for (const key of ["fake", "small", "huge", "weak"]) expect(by[key].present, key).toBe(true);
  expect(by.small).toMatchObject({ bytes: 3 * GB, verdict: { fits: true } });
  expect(["gpu", "cpu"]).toContain(by.small.verdict.where.placement);
  expect(by.huge.verdict).toMatchObject({ fits: false, where: null });
  for (const key of ["fake", "small", "huge", "weak"]) expect(by[key], key).not.toHaveProperty("weak");
}, 60_000);

test("each row of the menu that fits says where it runs, as the top bar's menu; none has a warning; no internal name is above them", async () => {
  await waitFor(`document.querySelector('[data-action="prompt-model"]') !== null`, 60_000);
  await Bun.sleep(1500);
  await mouseClick('[data-action="prompt-model"]');
  await waitFor(`document.querySelectorAll('[data-slot="model-detail"]').length >= 3`);
  const rows: { name: string; detail: string; warning: string }[] = await p.evaluate(`[...document.querySelectorAll('[data-option-key]')]
    .filter((r) => r.querySelector('[data-slot="model-detail"]'))
    .map((r) => ({ name: r.querySelector('[data-slot="model-detail"]').parentElement.firstElementChild.textContent, detail: r.querySelector('[data-slot="model-detail"]').textContent, warning: r.querySelector('[data-slot="model-warning"]')?.textContent ?? "" }))`);
  const by = (name: string) => rows.find((r) => r.name === name)!;
  // «2 schede · 128k»; the model that does not fit has no place to say
  expect(by("Model small").detail).toMatch(/^(\d+ sched[ae]|processore) · \d+k$/);
  expect(by("Fake model").detail).toMatch(/^(\d+ sched[ae]|processore) · \d+k$/);
  expect(rows.some((r) => r.name === "Model huge")).toBe(false);
  for (const name of ["Fake model", "Model small", "Model weak"]) expect(by(name).warning, name).toBe("");
  const text: string = await p.evaluate(`document.querySelector('[data-slot="model-selector-scroll"]').innerText`);
  expect(text).not.toContain("mango");
  if (process.env.MC_PHOTOS) {
    fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
    for (const [width, height] of [[860, 800], [390, 800]]) {
      await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await Bun.sleep(900);
      const shot = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.MC_PHOTOS, `menu-modelli-${width}.png`), Buffer.from(shot.result.data, "base64"));
    }
    await p.send("Emulation.clearDeviceMetricsOverride");
  }
  // closed before the next test: a menu still open would be read with the top bar's one
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('[role="menu"]')`);
}, 90_000);

const optionKeys = (menu: string) =>
  p.evaluate(`[...document.querySelectorAll('${menu} [data-option-key]')].map((r) => r.getAttribute('data-option-key'))`) as Promise<string[]>;

test("the top bar names the model in use, and its menu lists the same models as the one under the chat", async () => {
  await waitFor(`document.querySelector('[data-action="titlebar-model"]')?.innerText.includes("Fake model")`, 60_000);
  await mouseClick('[data-action="titlebar-model"]');
  await waitFor(`document.querySelectorAll('[role="menu"] [data-option-key]').length >= 4`);
  const bar = await optionKeys('[role="menu"]');
  expect(bar.sort()).toEqual(["fake", "huge", "small", "weak"]);
  const tag: string = await p.evaluate(`document.querySelector('[role="menu"] [data-option-key="fake"] [data-slot="model-tag"]')?.textContent ?? ""`);
  expect(tag).toBe("Predefinito · In uso");
  expect(await p.evaluate(`document.querySelector('[role="menu"]').innerText`)).toContain("Gestisci i modelli…");
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await Bun.sleep(500);
  await mouseClick('[data-action="prompt-model"]');
  await waitFor(`document.querySelectorAll('[role="menu"] [data-option-key^="mango:"]').length >= 4`);
  const composer = (await optionKeys('[role="menu"]')).filter((key) => key.startsWith("mango:")).map((key) => key.replace(/^mango:/, ""));
  expect(composer.sort()).toEqual(bar.sort());
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}, 90_000);

test("a model chosen in the bar is used at once, and the conversation's model follows it", async () => {
  await Bun.sleep(500);
  await mouseClick('[data-action="titlebar-model"]');
  await waitFor(`!!document.querySelector('[role="menu"] [data-option-key="small"]')`);
  await mouseClick('[role="menu"] [data-option-key="small"]');
  for (let i = 0; i < 120; i++) {
    const state = await (await fetch(`${env.engine}/control/state`)).json();
    if (state.model.phase === "ready" && state.model.model === "small") break;
    await Bun.sleep(500);
  }
  expect((await (await fetch(`${env.engine}/control/state`)).json()).model).toMatchObject({ phase: "ready", model: "small" });
  await waitFor(`document.querySelector('[data-action="titlebar-model"]')?.innerText === "Model small"`);
  await waitFor(`document.querySelector('[data-action="prompt-model"]')?.innerText.includes("Model small")`);
}, 120_000);
