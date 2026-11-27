// The sentences the app writes about a model, and the dates in them, follow the language chosen in Settings › General, as soon as it
// is chosen: «misurato il 26 ottobre 2026» in Italian, «measured on October 26, 2026» in English, never the date as the
// file writes it. A computer whose measured setup is in the catalog (three cards), the real window, the real mouse.
// `off-screen bun test --cwd integration tests/language-dates.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { saveScreenshot, start, type Environment } from "./environment";

setDefaultTimeout(180_000);

const nvidia = (index: number, name: string, memory_mib: number, cc: [number, number]) => ({ index, name, vendor: "nvidia", memory_mib, shared_mib: 0, cuda_driver: [12, 6], cc });
const computer = {
  gpus: [nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, [8, 6]), nvidia(1, "NVIDIA GeForce GTX 1080", 8192, [6, 1]), nvidia(2, "NVIDIA GeForce GTX 1660 SUPER", 6144, [7, 5])],
  cpu: { name: "Fake CPU", cores: 8, avx2: true, avx512: false },
  ram_mib: 65_536,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-language-"));
const hardware = path.join(root, "hardware.json");
fs.writeFileSync(hardware, JSON.stringify(computer));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

let env: Environment;
let p: Page;

beforeAll(async () => {
  env = await start([{ text: "Done." }], { window: true, realCatalog: true, env: { MANGO_HARDWARE: hardware }, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitUntil(condition: () => Promise<boolean>, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await condition().catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}\n${await p.evaluate("document.body.innerText.slice(-600)")}`);
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const shot = async (name: string) => saveScreenshot(env, name, (await p.send("Page.captureScreenshot", { format: "png" })).result.data);
async function click(selector: string, text = "") {
  const at = (await p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!at) throw new Error(`not on the page: ${selector} ${text}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function openSettings(section: string) {
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=${section}` });
  await waitUntil(() => exists(`[data-component="settings-page"] [data-pane="${section}"]`), `the section ${section}`);
}
/** The language, through Settings › General, as a user changes it. */
async function chooseLanguage(name: "English" | "Italiano") {
  await openSettings("general");
  await click('[data-action="settings-language"] button', name);
  await waitUntil(async () => ((await p.evaluate("document.documentElement.lang")) as string).startsWith(name === "English" ? "en" : "it"), "the page in that language");
  await waitUntil(async () => JSON.parse(fs.readFileSync(path.join(env.data, "settings.json"), "utf8")).language === (name === "English" ? "en" : "it"), "the language saved");
}
/** What the row of the model 3.6 says about its setup, opened; `fromGeneral`: reached from the sidebar of the page the language was chosen on, without reloading it. */
async function setupOfModel(fromGeneral = false) {
  if (fromGeneral) {
    await waitUntil(() => exists('[data-section="models"]'), "the sidebar");
    await click('[data-section="models"]');
  }
  else await openSettings("models");
  await waitUntil(() => exists('[data-model-row="3.6"]'), "the model", 40_000);
  if (!(await exists('[data-model-row="3.6"] [data-slot="settings-model-detail"]'))) await click('[data-model-row="3.6"] > button');
  await waitUntil(() => exists('[data-model-row="3.6"] [data-slot="settings-model-detail"]'), "the model opened");
  await Bun.sleep(600);
  return (await p.evaluate(`document.querySelector('[data-model-row="3.6"]').textContent`)) as string;
}

test("Italian: the model's setup says when it was measured as a date is written, not as the file has it", async () => {
  const text = await setupOfModel();
  expect(text).toContain("misurato il 26 ottobre 2026");
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  await shot("04-models-measured-it");
});

test("English: the same sentence, in English, as soon as the language is chosen", async () => {
  await chooseLanguage("English");
  const text = await setupOfModel(true);
  expect(text).toContain("measured on October 26, 2026");
  expect(text).not.toContain("misurato");
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  await shot("05-models-measured-en");
});

test("English: nothing of Models is left in Italian after the change, with the model closed or open", async () => {
  const page = (await p.evaluate(`document.querySelector('[data-component="settings-models"]').textContent`)) as string;
  for (const italian of ["misurato", "Ha un assetto", "Ci sta col suo motore", "non ancora misurato", "Scarica"]) expect(page, italian).not.toContain(italian);
});

test("Italian again: the sentence comes back in Italian", async () => {
  await chooseLanguage("Italiano");
  expect(await setupOfModel(true)).toContain("misurato il 26 ottobre 2026");
});

// The list with a time on each row is the Home of a narrow window and of the phone (under 768 px).
test("the time of a conversation in the Home of a narrow window follows the language of the app, not the computer's", async () => {
  const json = { "Content-Type": "application/json" };
  await fetch(`${env.agent}/session?directory=${encodeURIComponent(site)}`, { method: "POST", headers: json, body: JSON.stringify({ title: "A dated conversation" }) });
  const row = '[data-component="home-session-row"]';
  const time = async () => {
    await p.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
    await p.send("Page.navigate", { url: env.agent });
    await waitUntil(async () => ((await p.evaluate(`[...document.querySelectorAll('${row}')].map((r) => r.textContent).join("|")`)) as string).includes("A dated conversation"), "the conversation in the Home");
    const shown = (await p.evaluate(`[...document.querySelectorAll('${row}')].find((r) => r.textContent.includes("A dated conversation")).textContent`)) as string;
    await p.send("Emulation.clearDeviceMetricsOverride", {});
    return shown;
  };
  await chooseLanguage("English");
  expect(await time()).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  await chooseLanguage("Italiano");
  expect(await time()).not.toMatch(/[AP]M/);
});
