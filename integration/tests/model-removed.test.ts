// The user takes the model in use off the computer (Settings › Models › the model › «Togli dal computer», with its confirmation
// that says it is the one in use), in the app's real window with the real mouse, in three moments: with a conversation open and
// quiet, while an answer is being written, and when it is the last model on the computer. What must hold: the file is gone from the
// disk, the conversation is not left hanging (the box goes back to «Invia», the agent is idle), the user is told what happened in the
// page instead of an empty silence or a raw error, another model that is on the computer takes its place, and with none left the box
// says there is none and does not send. Fake engine. `off-screen bun test --cwd integration tests/model-removed.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

setDefaultTimeout(240_000);

const LONG = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-removed-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const page = await p.evaluate("document.body.innerText.slice(-900)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", page, "--- console ---", ...p.console.slice(-4)].join("\n"));
    }
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const body = () => p.evaluate("document.body.innerText") as Promise<string>;
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

/** A picture of the window in the folder `MANGO_TEST_SCREENSHOTS` names, if it is set. */
async function shot(name: string) {
  const folder = process.env.MANGO_TEST_SCREENSHOTS;
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  const taken = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(taken.result.data, "base64"));
}
const centre = (find: string) =>
  p.evaluate(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
async function click(find: string, what: string) {
  const at = await centre(find);
  if (!at) throw new Error(`not on the page: ${what}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const control = async (route: string) => (await fetch(`${env.engine}/control/${route}`)).json();
const sendLabel = () => p.evaluate(`${q('[data-action="prompt-submit"]')}?.getAttribute("aria-label")`) as Promise<string>;
const modelName = () => p.evaluate(`(${q('[data-action="prompt-model"]')}?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;
const standing = () => expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
const status = async () => Object.keys(await (await fetch(`${env.agent}/session/status?directory=${encodeURIComponent(site)}`)).json());
const engineChats = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r: { route: string }) => r.route.startsWith("/v1/chat/completions"));

async function freshBox() {
  const isNew = async () => ((await p.evaluate("location.pathname")) as string).endsWith("/new-session") && (await exists('[data-component="prompt-input"]'));
  const before = (await p.evaluate("location.href")) as string;
  // the title bar is still settling after a page change: a click that lands on it moving is made again
  for (let attempt = 0; attempt < 3 && !(await isNew()); attempt++) {
    await click(q('[aria-label="Nuova conversazione"]'), "Nuova conversazione");
    await waitUntil(async () => (await p.evaluate("location.href")) !== before && (await isNew()), "the box of a new conversation", 5_000).catch(() => undefined);
  }
  await waitUntil(isNew, "the box of a new conversation");
  await Bun.sleep(500);
}
async function ask(words: string) {
  await click(q('[data-component="prompt-input"]'), "the box");
  await p.send("Input.insertText", { text: words });
  await click(q('[data-action="prompt-submit"]'), "the send button");
}
/** From wherever the window is: the gear, Models, the row of the model opened and «Togli dal computer», then the confirmation. */
async function removeFromSettings(key: string, inUse: boolean) {
  await click(q('[data-action="titlebar-settings"]'), "the gear of the settings");
  await waitUntil(() => exists('[data-component="settings-page"]'), "the settings");
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=models` });
  await waitUntil(() => exists(`[data-model-row="${key}"] > button`), `the row of ${key}`);
  await click(q(`[data-model-row="${key}"] > button`), `the row of ${key}`);
  await waitUntil(() => exists(`[data-model-row="${key}"] [data-action="settings-model-remove"]`), "its choices");
  // the row is still opening when its button first shows: a click that lands on it moving is made again
  for (let attempt = 0; attempt < 3 && !(await exists('[data-action="settings-model-remove-confirm"]')); attempt++) {
    await click(q(`[data-model-row="${key}"] [data-action="settings-model-remove"]`), "Togli dal computer");
    await waitUntil(() => exists('[data-action="settings-model-remove-confirm"]'), "the confirmation", 3_000).catch(() => undefined);
  }
  await waitUntil(() => exists('[data-action="settings-model-remove-confirm"]'), "the confirmation");
  expect(await exists('[data-slot="settings-remove-in-use"]'), "the confirmation says it is the model in use").toBe(inUse);
  await click(q('[data-action="settings-model-remove-confirm"]'), "Togli");
  await waitUntil(async () => !(await exists('[data-action="settings-model-remove-confirm"]')), "the confirmation closed");
  await waitUntil(() => !fs.existsSync(path.join(env.modelsDir, `${key}.gguf`)), `${key}.gguf off the disk`);
}

beforeAll(async () => {
  env = await start([{ if: "LONGPLEASE", text: LONG }, { text: "Here I am." }], { window: true, otherModels: ["second", "third"], chunkMs: 100, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(async () => (await body()).includes("my-site"), "the project open", 60_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const present = async () => ((await control("models")).models as { key: string; present: boolean }[]).filter((m) => m.present).map((m) => m.key);

test("the model in use removed with a quiet conversation open: the file goes, the other model is the one the box names, and the next message is answered by it", async () => {
  await freshBox();
  await ask("Hello first");
  await waitUntil(async () => (await body()).includes("Here I am."), "the first answer", 60_000);
  await waitUntil(async () => (await sendLabel()) === "Invia", "the box quiet");
  const conversation = (await p.evaluate("location.href")) as string;
  expect((await control("state")).model).toMatchObject({ phase: "ready", model: "fake" });

  await removeFromSettings("fake", true);
  expect(await present()).toEqual(["second", "third"]);
  expect((await control("state")).default_model).toBe("second");

  await p.send("Page.navigate", { url: conversation });
  await waitUntil(() => exists('[data-component="prompt-input"]'), "the conversation again");
  await waitUntil(async () => (await modelName()).length > 0, "a model name under the box");
  await waitUntil(async () => (await body()).includes("Fake model non è più sul computer. Uso Model second."), "one line that says the model is gone and which one takes its place");
  expect(await modelName(), "the box does not name the model that is gone").not.toContain("Fake model");
  expect(await body(), "the page does not say a model that is on the computer is missing").not.toContain("Sul computer non c'è nessun modello");
  const before = engineChats().length;
  await ask("Hello again");
  await waitUntil(async () => engineChats().length > before, "the message at the engine", 90_000);
  expect(engineChats().at(-1).model_path.toLowerCase()).toContain("second.gguf");
  await waitUntil(async () => (await body()).split("Here I am.").length > 2, "the second answer", 60_000);
  await waitUntil(async () => (await sendLabel()) === "Invia", "the box quiet");
  const text = await body();
  await waitUntil(async () => (await modelName()).includes("Model second"), "the box names the model that answered");
  await shot("05-model-removed-answered-by-the-other-model");
  expect(text, "the conversation shows no failure of the model that is gone").not.toContain("non parte");
  expect(text, "the conversation shows no technical detail").not.toContain("Dettagli tecnici");
  await standing();
});

test("the model in use removed while an answer is being written: the answer stops, the page says so, nothing hangs, and the next message goes to the other model", async () => {
  await freshBox();
  expect((await control("state")).model).toMatchObject({ phase: "ready", model: "second" });
  await ask("LONGPLEASE write a lot");
  await waitUntil(async () => (await body()).includes("word10 "), "the answer under way", 60_000);
  const conversation = (await p.evaluate("location.href")) as string;
  await removeFromSettings("second", true);
  expect(await present()).toEqual(["third"]);
  await p.send("Page.navigate", { url: conversation });
  await waitUntil(() => exists('[data-component="prompt-input"]'), "the conversation again");
  // the turn is over one way or the other, well before the 30 s the whole answer would take
  await waitUntil(async () => (await sendLabel()) === "Invia", "the box back to «Invia»", 25_000);
  await waitUntil(async () => (await status()).length === 0, "the agent idle", 25_000);
  expect((await body()).includes("word299"), "the answer did not run on to the end after its model was removed").toBe(false);
  // the page tells what happened: an error card or a line, not a bare cut
  const told = await p.evaluate(`[...document.querySelectorAll('.error-card, [data-component="card"][data-variant="error"], [data-slot="session-turn-empty-answer"], [data-slot="session-turn-message-container"] [role="alert"]')].map((e) => e.textContent.trim()).filter(Boolean)`);
  await shot("06-model-removed-while-streaming");
  expect((told as string[]).length, "something in the page says why the answer stopped").toBeGreaterThan(0);
  expect(await body(), "what the page says has no technical detail and no path of the PC").not.toMatch(/dettaglio tecnico|\.gguf/);

  await waitUntil(async () => (await body()).includes("Model second non è più sul computer. Uso Model third."), "one line that says the model is gone and which one takes its place");
  const before = engineChats().length;
  await ask("Are you there");
  await waitUntil(async () => engineChats().length > before, "the message at the engine", 90_000);
  expect(engineChats().at(-1).model_path.toLowerCase()).toContain("third.gguf");
  expect(await body(), "the conversation shows no failure of the model that is gone").not.toContain("non parte");
  await waitUntil(async () => (await sendLabel()) === "Invia", "the box quiet again", 60_000);
  await standing();
});

test("the last model removed: the box says there is none and does not send; the conversations stay readable", async () => {
  expect(await present()).toEqual(["third"]);
  await removeFromSettings("third", true);
  expect(await present()).toEqual([]);
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(async () => (await body()).includes("my-site"), "the Home");
  await freshBox();
  await waitUntil(() => exists('[data-component="mango-status"][data-kind="empty"]'), "the line that says no model is there");
  const before = engineChats().length;
  await click(q('[data-component="prompt-input"]'), "the box");
  await p.send("Input.insertText", { text: "Is anyone there" });
  await Bun.sleep(800);
  expect(await p.evaluate(`${q('[data-action="prompt-submit"]')}.disabled`)).toBe(true);
  expect(engineChats().length).toBe(before);
  await shot("07-last-model-removed-box-says-none");
  // with no model on the computer the Home is the welcome; the conversations stay in their tabs and open with their words
  await click(`[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === "Hello first")`, "the tab of the conversation");
  await waitUntil(async () => (await body()).includes("Here I am."), "its words");
  await standing();
});
