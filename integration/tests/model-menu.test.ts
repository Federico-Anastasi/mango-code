// The model menu under the chat, one line for each model (the app's real window, WebView2 CDP): weight, where it runs, whether
// it reads images, and the warning only for the model the catalog marks `on_request`. Fake engine, no GPU used (the models are
// small files; where they run is what this PC's hardware says, so the test checks the form of the line and not the place).
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

test("the agent tells what the menu says: weight, where it runs, the warning of a model the catalog does not trust", async () => {
  const info = await (await fetch(`${env.agent}/mango/models/info`)).json();
  expect(Object.keys(info)).toEqual(expect.arrayContaining(["fake", "small", "huge", "weak"]));
  expect(info.small).toMatchObject({ bytes: 3 * GB, weak: false });
  expect(["gpu", "cpu"]).toContain(info.small.place);
  expect(info.huge).toMatchObject({ place: "none", weak: false });
  expect(info.weak.weak).toBe(true);
  expect(info.fake.weak).toBe(false);
}, 60_000);

test("each row of the menu has its line, and only the model on request has the warning; no internal name is above them", async () => {
  await waitFor(`document.querySelector('[data-action="prompt-model"]') !== null`, 60_000);
  await Bun.sleep(1500);
  await mouseClick('[data-action="prompt-model"]');
  await waitFor(`document.querySelectorAll('[data-slot="model-detail"]').length >= 4`);
  const rows: { name: string; detail: string; warning: string }[] = await p.evaluate(`[...document.querySelectorAll('[data-option-key]')]
    .filter((r) => r.querySelector('[data-slot="model-detail"]'))
    .map((r) => ({ name: r.querySelector('[data-slot="model-detail"]').parentElement.firstElementChild.textContent, detail: r.querySelector('[data-slot="model-detail"]').textContent, warning: r.querySelector('[data-slot="model-warning"]')?.textContent ?? "" }))`);
  const by = (name: string) => rows.find((r) => r.name === name)!;
  // weight · where; the name carries nothing else
  expect(by("Model small").detail).toMatch(/^3 GB · (Sulla scheda video|Sul processore( · .+)?)$/);
  expect(by("Model huge").detail).toBe("10.240 GB · Non ci sta in questo computer");
  expect(by("Fake model").detail).toMatch(/^1000 B · (Sulla scheda video|Sul processore)/);
  for (const name of ["Fake model", "Model small", "Model huge"]) expect(by(name).warning, name).toBe("");
  expect(by("Model weak").warning).toContain("Poco adatto a lavorare sui file");
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
}, 90_000);
