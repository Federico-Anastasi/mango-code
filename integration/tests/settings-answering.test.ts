// The settings while a conversation answers, in the app's real window (WebView2 CDP): the page opens all the same, the
// answer goes on in its own tab, and a line at the top names the conversation and its model and says what applies when;
// when the answer ends the line goes away.
// The fake engine writes a long text in slow pieces. `bun test --cwd integration tests/settings-answering.test.ts`,
// after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

// about twenty seconds of answer: time to open the settings and read the line, also on a busy computer
const LONG = Array.from({ length: 200 }, (_, i) => `parola${i}`).join(" ");

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;

/** A click with the mouse, like a person. */
async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

const chats = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter(
    (r: { route: string }) => r.route.startsWith("/v1/chat/completions"),
  );

beforeAll(async () => {
  env = await start([{ text: LONG }], { window: true, chunkMs: 100 });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home");
  await waitUntil(async () => (await (await fetch(`${env.engine}/control/state`)).json()).model.phase === "ready", "the model ready", 120_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
});

test("while a conversation answers the settings open and say, at the top, who is answering and what applies when", async () => {
  await mouseClick('[aria-label="Nuova conversazione"]');
  await waitUntil(() => exists('[contenteditable="true"]'), "the composer of a new conversation");
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, "Scrivi il riepilogo di ottobre"); })()`);
  await Bun.sleep(300);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitUntil(() => chats().length > 0, "the message at the engine");
  await waitUntil(async () => ((await p.evaluate("document.body.innerText")) as string).includes("parola3"), "the answer being written");

  await mouseClick('[aria-label="Apri le impostazioni"]');
  await waitUntil(() => exists('[data-component="settings-page"]'), "the settings page");
  const line = '[data-component="settings-answering"]';
  await waitUntil(() => exists(line), "the line at the top");
  const text = (await p.evaluate(`document.querySelector(${JSON.stringify(line)}).innerText`)) as string;
  expect(text).toContain("sta rispondendo con Fake model");
  expect(text).toContain("Puoi cambiare tutto: ciò che riguarda quel modello vale dalla prossima risposta, il resto subito.");
  // the sections are all there: nothing is closed to whoever opens the page meanwhile
  expect(await p.evaluate(`document.querySelectorAll('[data-component="settings-page"] [data-section]').length`)).toBe(6);

  // the answer went on in its tab and ends: the line goes away by itself
  await waitUntil(async () => !(await exists(line)), "the line gone when the answer ends", 90_000);
}, 180_000);
