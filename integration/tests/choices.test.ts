// The user's choices about the models and the computer, from the app's real window (WebView2 CDP) through the bridge's
// `models` and `computer` commands: the default model, the context of a model (the one in use is loaded again with it),
// the cards the models use, and taking a model off the computer. What the interface reads back comes from the control
// server. Fake engine, no GPU of its own: what depends on this PC's cards is checked only if it has some.
// `bun test --cwd integration tests/choices.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}

const get = async (route: string) => (await fetch(`${env.engine}/control/${route}`)).json();
const state = () => get("state");
const model = async (key: string) => ((await get("models")).models as any[]).find((m) => m.key === key);
/** A command of the bridge, from the window: "ok", or what it was rejected with. */
const ask = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.${call}.then(() => "ok", (e) => JSON.stringify(e))`) as Promise<string>;
const saved = () => JSON.parse(fs.readFileSync(path.join(env.data, "choices.json"), "utf8"));
/** How many times the engine loaded a model: a line of the manager's log each. */
const loads = () => fs.readFileSync(path.join(env.data, "logs", "manager.log"), "utf8").split("\n").filter((l) => l.includes('"event":"restore"')).length;

/** The model in use again after a choice that may have changed its plan: a reload begins a moment after the command answers. */
async function settled() {
  await Bun.sleep(700);
  await waitUntil(async () => (await state()).model.phase === "ready", "the model in use again");
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, otherModels: ["second"], context: 65536 });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
});

test("the default model is the one the user says, and a model that is not in the catalog is refused", async () => {
  expect((await state()).default_model).toBe("fake");
  // None was chosen: the model the app started with is saved as the default, so one that arrives later does not take its place.
  expect(saved().default).toBe("fake");
  const before = (await state()).catalog_revision;
  expect(await ask(`models.setDefault("second")`)).toBe("ok");
  expect((await state()).default_model).toBe("second");
  expect((await state()).catalog_revision).toBeGreaterThan(before);
  expect(saved().default).toBe("second");
  const refused = JSON.parse(await ask(`models.setDefault("ghost")`));
  expect(refused.code).toBe("refused");
  // the sentence for the user; the model asked and the technical detail go to the log
  expect(refused.message).toBe("Il modello richiesto non è tra quelli di Mango Code.");
  expect(fs.readFileSync(path.join(env.data, "logs", "startup.log"), "utf8")).toContain("«ghost» unknown");
  expect(await ask(`models.setDefault(null)`)).toBe("ok");
  expect((await state()).default_model).toBe("fake");
  // The model in use did not change for that.
  expect((await state()).model).toMatchObject({ phase: "ready", model: "fake" });
  expect(loads()).toBe(1);
}, 60_000);

test("a context chosen for the model in use loads it again with that context; the style does not", async () => {
  const running = (await state()).model.where.context;
  expect(running).toBe(65536);
  expect(await ask(`models.setChoices("fake", { where: "auto", gpus: [], context: 32768, style: "creative", reasoning: null })`)).toBe("ok");
  await waitUntil(async () => (await state()).model.phase === "ready" && (await state()).model.where.context === 32768, "the model loaded again with the chosen context");
  expect(loads()).toBe(2);
  const listed = await model("fake");
  expect(listed.choices).toMatchObject({ where: "auto", context: 32768, style: "creative" });
  expect(listed.verdict.where.context).toBe(32768);
  expect(listed.limits.context.at(-1)).toBe(65536);
  expect(saved().models.fake).toMatchObject({ context: 32768, style: "creative" });

  // Only how it writes changes: nothing to load again.
  expect(await ask(`models.setChoices("fake", { where: "auto", gpus: [], context: 32768, style: "precise", reasoning: false })`)).toBe("ok");
  await Bun.sleep(1500);
  expect(loads()).toBe(2);
  expect((await model("fake")).choices).toMatchObject({ style: "precise", reasoning: false });

  // A choice that makes no sense is refused with its sentence, and nothing is saved.
  const refused = JSON.parse(await ask(`models.setChoices("fake", { where: "pick", gpus: [], context: null, style: "recommended", reasoning: null })`));
  expect(refused.code).toBe("refused");
  expect(refused.message).toContain("nessuna");
  expect(saved().models.fake.where).toBe("auto");
}, 120_000);

test("the computer's choices are saved and read back", async () => {
  expect((await get("computer")).small_models).toBe("one");
  expect(await ask(`computer.setSmallModels("all")`)).toBe("ok");
  expect((await get("computer")).small_models).toBe("all");
  expect(await ask(`computer.setSmallModels("one")`)).toBe("ok");
  // A card left out of the models, if this PC has one that can be.
  const card = ((await get("computer")).gpus as any[]).find((g) => g.used && !g.note);
  if (!card) return;
  expect(await ask(`computer.setGpuUsed(${JSON.stringify(card.name)}, false)`)).toBe("ok");
  expect(((await get("computer")).gpus as any[]).find((g) => g.name === card.name).used).toBe(false);
  expect(saved().computer.unused_gpus).toEqual([card.name]);
  // Whatever leaving the card out did to the plan of the model in use, the model is in use again.
  await settled();
  expect(await ask(`computer.setGpuUsed(${JSON.stringify(card.name)}, true)`)).toBe("ok");
  expect(((await get("computer")).gpus as any[]).find((g) => g.name === card.name).used).toBe(true);
  await settled();
}, 120_000);

test("a model taken off the computer is stopped if it is the one in use, its file is deleted and nothing takes its place", async () => {
  expect(await ask(`models.setDefault("fake")`)).toBe("ok");
  await settled();
  expect((await state()).model).toMatchObject({ phase: "ready", model: "fake" });
  expect(await ask(`models.remove("fake")`)).toBe("ok");
  expect(fs.existsSync(path.join(env.modelsDir, "fake.gguf"))).toBe(false);
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(true);
  expect((await model("fake")).present).toBe(false);
  expect(await state()).toMatchObject({ model: { phase: "none" }, default_model: "second" });
  expect(saved().default).toBeNull();
  expect((await (await fetch(`${env.engine}/engine`)).json()).phase).toBe("stopped");
  await Bun.sleep(1500);
  expect((await state()).model.phase).toBe("none");
  const refused = JSON.parse(await ask(`models.remove("ghost")`));
  expect(refused.code).toBe("refused");
  // The other model is there to be used.
  await fetch(`${env.engine}/control/model/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "second" }) });
  await waitUntil(async () => (await state()).model.phase === "ready", "the other model loaded");
  expect((await state()).model.model).toBe("second");
}, 120_000);

test("a model from a file of the user taken off the computer leaves the list and the menu; the file stays where it is", async () => {
  const mine = path.join(env.root, "elsewhere", "mine.gguf");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, "");
  const entry = { label: "Mine", gguf: mine, origin: "local", files: [{ path: mine, size: 1000 }], memory: { kv_kib_token: 1, state_mib: 0 } };
  expect(await ask(`otherModels.add(${JSON.stringify({ key: "local-mine", entry })})`)).toBe("ok");
  await waitUntil(async () => (await model("local-mine"))?.present === true, "the model of the file on the computer");
  expect((await model("local-mine")).own_files).toEqual([mine]);
  expect((await model("second")).own_files).toEqual([]);

  expect(await ask(`models.remove("local-mine")`)).toBe("ok");
  expect(await model("local-mine")).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "user-models.json"), "utf8")).models).toEqual({});
  expect(fs.existsSync(mine)).toBe(true);
  expect(saved().models["local-mine"]).toBeUndefined();
}, 60_000);
