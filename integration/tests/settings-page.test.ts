// The settings "Prompt" page, inside the app's window (WebView2 CDP): every entry with its weight in tokens, the switch
// that turns it off for all folders, the "only this folder" choice. Fake engine. The screenshot of the page stays in
// %TEMP%\mango-settings.png (and "-middle", "-bottom" when scrolling it). `bun test integration`, after
// `cargo build -p mango-code -p engine` in app/;
// `MANGO_OPENCODE=<folder with web\mango-code.exe>` tries a separate build of the agent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const url = () => `${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}`;
const read = async () => (await fetch(url())).json();
const entry = (s: any, type: string, name: string) => s.items.find((v: any) => v.type === type && v.name === name);

beforeAll(async () => {
  env = await start([{ text: "Done." }], { window: true });
  mc = new MangoCode((await find(env.data))!);
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

/** Click on an element of the page, by selector and text. */
const click = (selector: string, text = "") =>
  p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** Click with the mouse, like a person: the settings tabs do not answer the DOM's `click()`. The dialog enters
 *  with an animation: the click goes where the element has stopped (same position in two readings). */
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
  const r = before;
  if (!r) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  return true;
}

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

test("the page shows every entry with its weight, and the switches change what the model reads", async () => {
  // a new conversation measures the entries
  const id = await mc.createSession(env.project, { title: "prompt" });
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
  for (let i = 0; i < 60 && entry(await read(), "tools", "bash")?.tokens == null; i++) await Bun.sleep(500);

  await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);

  // settings (Ctrl+,) → "Prompt" tab
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: ",", code: "Comma", modifiers: 2, windowsVirtualKeyCode: 188 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: ",", code: "Comma", modifiers: 2, windowsVirtualKeyCode: 188 });
  await waitFor(`document.querySelector('[data-component="tabs-v2"]') !== null`);
  expect(await mouseClick('[data-component="tabs-v2"] [role="tab"][data-value="prompt"]')).toBe(true);
  await waitFor(`document.querySelectorAll('[data-component="settings-prompt"] [data-action="prompt-switch"]').length > 5`);

  // the page text is Italian: the environment's language is "it"
  const text = await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').innerText`);
  expect(text).toContain("Prima richiesta di una conversazione nuova:");
  expect(text).toContain("Strumenti di base");
  expect(text).toContain("Server MCP");
  expect(text).toContain("Skill");
  expect(text).toContain("File di istruzioni");
  expect(text).toContain("Plugin");
  expect(text).toContain("Tutte le cartelle");
  expect(text).toMatch(/webfetch/);
  expect(text).toMatch(/\d+ token/);

  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "mango-settings.png"), Buffer.from(shot.result.data, "base64"));

  // switches "webfetch" off for all folders
  const toggle = (name: string) => `document.querySelector('[data-action="prompt-switch"][data-name="${name}"] input')`;
  expect(await p.evaluate(`${toggle("webfetch")}.checked`)).toBe(true);
  await p.evaluate(`${toggle("webfetch")}.click()`);
  await waitFor(`${toggle("webfetch")}.checked === false`);
  expect(entry(await read(), "tools", "webfetch")).toMatchObject({ enabled: false, source: "default" });
  // the default file also holds the language: compare the prompt key
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "settings.json"), "utf8")).prompt).toEqual({ tools: { webfetch: false } });
  expect(fs.existsSync(path.join(env.project, ".mango", "settings.json"))).toBe(false);

  // "only this folder": switches "skill" (the entry) off only here, and the folder's file is born
  expect(await click('[data-component="settings-prompt"] button', "Solo project")).toBe(true);
  await p.evaluate(`${toggle("skill")}.click()`);
  await waitFor(`${toggle("skill")}.checked === false`);
  expect(JSON.parse(fs.readFileSync(path.join(env.project, ".mango", "settings.json"), "utf8"))).toEqual({ prompt: { tools: { skill: false } } });
  await waitFor(`document.querySelector('[data-component="settings-prompt"]').innerText.includes('Cambiata solo per questa cartella')`);
  // at the bottom of the page: MCP servers, skills, instructions and plugins, and the note of the entries changed only for the folder
  await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').closest('.settings-v2-panel').scrollTop = 1e6`);
  await Bun.sleep(300);
  const bottom = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "mango-settings-bottom.png"), Buffer.from(bottom.result.data, "base64"));
  await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').closest('.settings-v2-panel').scrollTop = 560`);
  await Bun.sleep(300);
  const middle = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "mango-settings-middle.png"), Buffer.from(middle.result.data, "base64"));

  // the next message no longer carries the two tools
  const before = fs.readFileSync(env.engineLog, "utf8").split("\n").filter((l) => l.includes('"/v1/chat/completions"')).length;
  const id2 = await mc.createSession(env.project);
  for await (const _ of mc.turn(id2, env.project, "Again", { model: "fake" }));
  const requests = fs.readFileSync(env.engineLog, "utf8").split("\n").filter((l) => l.includes('"/v1/chat/completions"')).map((l) => JSON.parse(l));
  const tools = requests[before].body.tools.map((t: any) => t.function.name);
  expect(tools).not.toContain("webfetch");
  expect(tools).not.toContain("skill");
  expect(tools).toContain("bash");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 180_000);
