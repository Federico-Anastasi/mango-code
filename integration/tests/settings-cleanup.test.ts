// The settings and the model menu as the app shows them (WebView2 CDP): only the pages that mean something to the user,
// no internal names (the group title of the model menu, the section title of the settings, the plugins that weigh nothing),
// no speed bar once the model has finished. Fake engine, no GPU. Own ports (47653-47656).
// With `MC_PHOTOS=<folder>` it saves the screenshots (860 px and 390 px) there.
// `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let mc: MangoCode;
let p: Page;

beforeAll(async () => {
  env = await start([{ text: "Fatto." }], {
    window: true,
    env: {
      MANGO_AGENT_PORT: "47653",
      MANGO_ENGINE_PORT: "47654",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=47655",
    },
  });
  mc = new MangoCode((await find(env.data))!);
  p = await page(47655, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
});

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const photo = async (name: string) => {
  if (!process.env.MC_PHOTOS) return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  for (const [width, height, suffix] of [[860, 760, "860"], [390, 800, "390"]] as const) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(800);
    const r = await p.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.MC_PHOTOS, `${name}-${suffix}.png`), Buffer.from(r.result.data, "base64"));
  }
  await p.send("Emulation.clearDeviceMetricsOverride");
};

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

/** A real mouse click: the settings tabs do not answer the DOM's `click()`. */
async function mouseClick(selector: string) {
  const center = () =>
    p.evaluate(`(() => {
      const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    })()`);
  let before = await center();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100);
    const now = await center();
    if (before && now && before.x === now.x && before.y === now.y) break;
    before = now;
  }
  if (!before) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: before.x, y: before.y, button: "left", clickCount: 1 });
  return true;
}

test("the settings list only pages that mean something, under no section title, and the general page is short", async () => {
  const id = await mc.createSession(env.project, { title: "prova" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);

  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: ",", code: "Comma", modifiers: 2, windowsVirtualKeyCode: 188 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: ",", code: "Comma", modifiers: 2, windowsVirtualKeyCode: 188 });
  await waitFor(`document.querySelector('[data-component="tabs-v2"]') !== null`);
  await Bun.sleep(1200);

  const tabs = await p.evaluate(`[...document.querySelectorAll('[data-component="tabs-v2"] [role="tab"]')].map((t) => t.dataset.value)`);
  expect(tabs).toEqual(expect.arrayContaining(["general", "prompt"]));
  for (const gone of ["local-models", "servers", "providers", "models"]) expect(tabs).not.toContain(gone);
  const nav = await p.evaluate(`document.querySelector('[data-component="tabs-v2"]').innerText`);
  expect(nav).not.toContain("Desktop");

  const general = await p.evaluate(`document.querySelector('[data-component="tabs-v2"]').innerText`);
  for (const gone of ["Albero dei file", "Palette dei comandi", "Stato del server", "Mostra agente", "Carattere del terminale", "Shell del terminale"])
    expect(general, gone).not.toContain(gone);
  await photo("impostazioni-generale");
}, 120_000);

test("the page of what the model reads does not list the plugins that weigh nothing", async () => {
  expect(await mouseClick('[data-component="tabs-v2"] [role="tab"][data-value="prompt"]')).toBe(true);
  await waitFor(`document.querySelectorAll('[data-component="settings-prompt"] [data-action="prompt-switch"]').length > 5`);
  const page = await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').innerText`);
  for (const gone of ["mango-documents", "mango-project", "mango-web-diet"]) expect(page, gone).not.toContain(gone);
  await photo("impostazioni-cosa-legge-il-modello");
}, 60_000);

test("the model menu has no title above the models, and the speed bar is gone once the model has finished", async () => {
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await Bun.sleep(800);
  expect(await p.evaluate(`document.querySelector('[data-component="engine-speed"]')`)).toBeNull();
  expect(await p.evaluate(`!!document.querySelector('[data-action="prompt-model"]')`)).toBe(true);
  expect(await mouseClick('[data-action="prompt-model"]')).toBe(true);
  await waitFor(`document.querySelector('[data-slot="model-selector-scroll"]') !== null`);
  const menu = await p.evaluate(`document.querySelector('[data-slot="model-selector-scroll"]').innerText`);
  expect(menu).toContain("Fake model");
  expect(menu).not.toContain("mango-code");
  await photo("menu-modelli");
}, 60_000);
