// The settings page and the model menu as the app shows them (WebView2 CDP): only its six sections, no
// internal names (the group title of the model menu, the plugins that weigh nothing), no speed bar once the model has
// finished. Fake engine, no GPU. Own ports (47653-47656).
// With `MC_PHOTOS=<folder>` it saves the screenshots (860 px and 390 px) there.
// `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { atSizes } from "./window";

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
  await atSizes(env.app.pid!, p, [[860, 760], [390, 800]], async (width) => {
    await Bun.sleep(800);
    const r = await p.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.MC_PHOTOS!, `${name}-${width}.png`), Buffer.from(r.result.data, "base64"));
  });
};

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

/** A real mouse click, where the element has stopped. */
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

test("the settings list their six sections and nothing internal, and the general section is short", async () => {
  const id = await mc.createSession(env.project, { title: "prova" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);

  expect(await mouseClick('[data-action="titlebar-settings"]')).toBe(true);
  await waitFor(`document.querySelector('[data-component="settings-page"]') !== null`);
  await Bun.sleep(800);

  const sections = await p.evaluate(`[...document.querySelectorAll('[data-component="settings-page"] [data-section]')].map((b) => b.dataset.section)`);
  expect(sections).toEqual(["models", "computer", "agent", "links", "general", "help"]);
  const nav = await p.evaluate(`document.querySelector('.settings-page-nav').innerText`);
  expect(nav).not.toContain("Desktop");
  // the sections are a navigation: the one shown is the current page, and there are no tabs to read aloud
  await waitFor(`document.querySelector('[data-component="settings-page"] [aria-current="page"]') !== null`);
  expect(await p.evaluate(`document.querySelectorAll('[data-component="settings-page"] [role="tab"], [data-component="settings-page"] [role="tablist"]').length`)).toBe(0);
  // the old dialog is gone
  expect(await p.evaluate(`document.querySelector('[data-component="tabs-v2"][data-variant="settings"]')`)).toBeNull();

  expect(await mouseClick('[data-component="settings-page"] [data-section="general"]')).toBe(true);
  await waitFor(`document.querySelector('[data-pane="general"]') !== null`);
  const general = await p.evaluate(`document.querySelector('[data-pane="general"]').innerText`);
  for (const gone of ["Albero dei file", "Palette dei comandi", "Stato del server", "Mostra agente", "Carattere del terminale", "Shell del terminale"])
    expect(general, gone).not.toContain(gone);
  await photo("impostazioni-generale");
}, 120_000);

test("the agent section does not list the plugins that weigh nothing", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="agent"]')).toBe(true);
  await waitFor(`document.querySelector('[data-component="settings-prompt"] [data-slot="prompt-total"]') !== null`);
  // the plugins are in the row of the instructions: opened, it lists them
  expect(await mouseClick('[data-component="settings-prompt"] [data-kind="instructions"] button')).toBe(true);
  await waitFor(`document.querySelector('[data-component="settings-prompt"] [data-kind="instructions"][data-open]') !== null`);
  const page = await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').innerText`);
  for (const gone of ["mango-documents", "mango-project", "mango-web-diet"]) expect(page, gone).not.toContain(gone);
  await photo("impostazioni-agente");
}, 60_000);

test("the model menu has no title above the models, and the speed bar is gone once the model has finished", async () => {
  // back to the conversation, in its tab
  await p.evaluate(`history.back()`);
  await waitFor(`!!document.querySelector('[data-action="prompt-model"]')`);
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
