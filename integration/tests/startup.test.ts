// The startup, seen from outside and in the app's real window (WebView2 CDP): the window opens on the home as soon as the
// agent answers, with or without a model on the computer; the model loads after that, in the background, and the engine
// manager (the control server, born before any model) tells how it goes; nothing at startup concerns the last
// conversation, and a new conversation that is only opened makes the engine read nothing: it works when the user writes.
// Fake engine, no GPU. `bun test --cwd integration tests/startup.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, notReady } from "../client/mango-code";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const engineState = async (e: Environment) => (await fetch(`${e.engine}/engine`)).json();
/** What the control server tells the interface (`/control/state`). */
const controlState = async (e: Environment) => (await fetch(`${e.engine}/control/state`)).json();
const control = (e: Environment, route: string, body?: object) =>
  fetch(`${e.engine}/control/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
/** The requests that reached the fake engine, in order. */
const engineRequests = (e: Environment) =>
  fs.existsSync(e.engineLog) ? fs.readFileSync(e.engineLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const chats = (e: Environment) => engineRequests(e).filter((r) => r.route.startsWith("/v1/chat/completions"));

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(200);
  }
}

/** The window once it shows the home of the web UI. */
async function home(e: Environment) {
  const p = await page(e.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(e.agent + "/")}`), "the window on the home");
  return p;
}

// The projects folder is one of the test's own, never the user's Documents.
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mango-projects-"));
const opened: Environment[] = [];
afterAll(() => {
  for (const e of opened) e.close();
  Bun.sleepSync(1500);
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

test("with no model on the computer the window opens on the home, and the agent knows every model of the catalog", async () => {
  const e = await start([{ text: "unused" }], { window: true, noModels: true, otherModels: ["second"] });
  opened.push(e);
  const p = await home(e);
  // The control server is there with nothing to load, and the service file names it.
  const service = readJson(path.join(e.data, "service.json"));
  expect(service.control).toBe(service.engine);
  expect(service.reason).toBeUndefined();
  const state = await engineState(e);
  expect(state.phase).toBe("stopped");
  expect(state.model).toBeNull();
  expect(await controlState(e)).toMatchObject({ model: { phase: "none" }, default_model: null });
  // The models are declared to the agent though none is on disk: one downloaded later needs no new agent.
  const providers = await (await fetch(`${e.agent}/config/providers`)).text();
  expect(providers).toContain("Fake model");
  expect(providers).toContain("Model second");
  expect(engineRequests(e)).toHaveLength(0);
  const log = fs.readFileSync(path.join(e.data, "logs", "startup.log"), "utf8");
  for (const phase of ["control server", "models", "agent", "window on the home"]) expect(log).toContain(`startup: ${phase} (+`);
  p.close();
}, 200_000);

let env: Environment;
let p: Page;

test("with a model on the computer the home is there before the model is ready, which loads in the background", async () => {
  env = await start([{ text: "Here I am." }], {
    window: true,
    modelLoading: true,
    otherModels: ["second"],
    // The fake engine takes 10 s to load a model: the window reaches the home well before, also on a busy computer.
    env: { FAKE_ENGINE_START_MS: "10000", MANGO_PROJECTS_FOLDER: projectsRoot },
  });
  opened.push(env);
  p = await home(env);
  // the plan of the model is made before the load begins (the hardware read takes a moment on a busy computer): then the
  // engine says it is starting, and what
  await waitUntil(async () => (await engineState(env)).phase !== "stopped", "the load begun");
  const loading = await engineState(env);
  expect(loading.phase).toBe("starting");
  expect(loading.loading.name).toBe("Fake model");
  const told = await controlState(env);
  expect(told.default_model).toBe("fake");
  expect(told.model).toMatchObject({ phase: "loading", model: "fake", label: "Fake model" });
  expect(told.model.where.context).toBe(16384);
  await waitUntil(async () => (await engineState(env)).phase === "running", "the model loaded in the background");
  expect((await engineState(env)).model).toBe("fake");
  const ready = await controlState(env);
  expect(ready.model).toMatchObject({ phase: "ready", model: "fake", label: "Fake model" });
  expect(ready.revision).toBeGreaterThan(told.revision);
  // Nothing changed: the same revision.
  expect((await controlState(env)).revision).toBe(ready.revision);
  // The window stayed where it was while the model loaded.
  expect(await p.evaluate("location.pathname")).toBe("/");
}, 200_000);

test("a new conversation that is only opened makes the engine read nothing: it works when the user writes", async () => {
  const clicked = await p.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.innerText.trim().split('\\n')[0].trim() === 'Nuova conversazione');
    button?.click();
    return !!button;
  })()`);
  expect(clicked).toBe(true);
  await waitUntil(() => p.evaluate(`location.pathname === '/new-session'`), "the new conversation");
  await Bun.sleep(4000);
  expect(engineRequests(env).filter((r) => r.route.startsWith("/v1/"))).toHaveLength(0);
  expect((await engineState(env)).model).toBe("fake");
}, 120_000);

test("nothing at startup concerns the last conversation: the window opens on the home and the engine reads nothing", async () => {
  // A real conversation, left open in the window when the app closes.
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Say something")) {
  }
  await p.evaluate(`location.assign(${JSON.stringify(`${env.agent}/${Buffer.from(env.project).toString("base64url")}/session/${id}`)})`);
  await waitUntil(() => p.evaluate(`document.body.innerText.includes('Here I am.')`), "the conversation in the window");
  const before = engineRequests(env).length;
  // The user's default is not the first model of the catalog: the next start loads it.
  fs.writeFileSync(path.join(env.data, "choices.json"), JSON.stringify({ default: "second" }));
  const serviceFile = path.join(env.data, "service.json");
  const closed = readJson(serviceFile).pid;
  p.close();
  await env.restart();
  await waitUntil(() => fs.existsSync(serviceFile) && readJson(serviceFile).pid !== closed, "the service file of the new start");
  p = await home(env);
  await waitUntil(async () => (await engineState(env)).phase === "running", "the model loaded again");
  expect((await engineState(env)).model).toBe("second");
  expect((await controlState(env)).default_model).toBe("second");
  await Bun.sleep(3000);
  expect(await p.evaluate("location.pathname")).toBe("/");
  // The engine restores its memory by itself; nobody asked it to read anything.
  expect(engineRequests(env).slice(before).filter((r) => r.route.startsWith("/v1/"))).toHaveLength(0);
  p.close();
}, 300_000);

test("the control server picks another model without waiting for it, tells a start that failed and tries it again", async () => {
  // A web page cannot ask.
  const page = await fetch(`${env.engine}/control/model/use`, { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "text/plain" }, body: JSON.stringify({ model: "second" }) });
  expect(page.status).toBe(403);
  expect((await control(env, "model/use")).status).toBe(400);
  expect((await controlState(env)).model.model).toBe("second");

  // The answer comes at once, with the model picked already shown as loading (the fake engine takes 10 s to start).
  const t0 = Date.now();
  const picked = await (await control(env, "model/use", { model: "fake" })).json();
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(picked.model).toMatchObject({ phase: "loading", model: "fake", label: "Fake model" });
  await waitUntil(async () => (await controlState(env)).model.phase === "ready", "the picked model loaded");
  expect((await controlState(env)).model.model).toBe("fake");

  // A model whose file is gone does not start: the state says why, and the model before keeps running.
  const weights = path.join(env.modelsDir, "second.gguf");
  fs.renameSync(weights, `${weights}.away`);
  await control(env, "model/use", { model: "second" });
  await waitUntil(async () => (await controlState(env)).model.phase === "failed", "the failed start");
  const failed = (await controlState(env)).model;
  expect(failed).toMatchObject({ model: "second", label: "Model second" });
  expect(failed.reason).toContain("non è sul disco");
  expect((await engineState(env)).model).toBe("fake");
  // With the file back, trying again loads it.
  fs.renameSync(`${weights}.away`, weights);
  expect((await (await control(env, "model/retry")).json()).model).toMatchObject({ phase: "loading", model: "second" });
  await waitUntil(async () => (await controlState(env)).model.phase === "ready", "the model loaded at the second try");
  expect((await controlState(env)).model.model).toBe("second");
}, 200_000);

test("the style of the answers and the reasoning chosen for a model reach the engine with the next message, without loading it again", async () => {
  fs.writeFileSync(path.join(env.data, "choices.json"), JSON.stringify({ default: "second", models: { second: { style: "precise", reasoning: false } } }));
  /** How many times the engine loaded a model: a line of the manager's log each. */
  const loads = () => fs.readFileSync(path.join(env.data, "logs", "manager.log"), "utf8").split("\n").filter((l) => l.includes('"event":"restore"')).length;
  const before = loads();
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Say something", { model: "second" })) {
  }
  const sent = chats(env).filter((r) => JSON.stringify(r.body).includes("Say something")).at(-1)!.body;
  expect(sent.temperature).toBe(0.3);
  expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(loads()).toBe(before);
}, 120_000);

test("with --service and no model the app is in use all the same: other apps find the agent and ask the engine for a model", async () => {
  const e = await start([{ text: "unused" }], { noModels: true });
  opened.push(e);
  expect(notReady(e.data)).toBeNull();
  const service = (await find(e.data))!;
  expect(service.agent).toBe(e.agent);
  expect((await fetch(`${e.agent}/global/health`)).ok).toBe(true);
  // A model that is not on disk is refused with the sentence that says so, and nobody retries.
  const answer = await fetch(`${e.engine}/engine/model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "fake" }) });
  expect(answer.status).toBe(422);
  expect((await answer.json()).error.message).toContain("non è sul disco");
}, 200_000);

test("who updates from 0.1.2 keeps the model it used last (model.txt) as the saved default, and the file goes", async () => {
  const e = await start([{ text: "unused" }], { otherModels: ["second"] });
  opened.push(e);
  const choices = path.join(e.data, "choices.json");
  // the first start saves the model it loads, the first of the catalog: none was chosen
  expect(readJson(choices).default).toBe("fake");
  // as after an update from 0.1.2: no default saved, the model used last in model.txt
  fs.writeFileSync(choices, "{}");
  fs.writeFileSync(path.join(e.data, "model.txt"), "second\n");
  const serviceFile = path.join(e.data, "service.json");
  const closed = readJson(serviceFile).pid;
  await e.restart();
  await waitUntil(() => fs.existsSync(serviceFile) && readJson(serviceFile).pid !== closed, "the service file of the new start");
  await waitUntil(async () => (await controlState(e)).model.phase === "ready", "the model loaded");
  expect(await controlState(e)).toMatchObject({ model: { model: "second" }, default_model: "second" });
  expect(readJson(choices).default).toBe("second");
  expect(fs.existsSync(path.join(e.data, "model.txt"))).toBe(false);
}, 200_000);

test("a model chosen from the bar while the default still loads stops that loading and loads the chosen one", async () => {
  // The fake engine takes 15 s to load a model: time to choose another before the first is there.
  const e = await start([{ text: "unused" }], { window: true, modelLoading: true, otherModels: ["second"], env: { FAKE_ENGINE_START_MS: "15000" } });
  opened.push(e);
  const p = await home(e);
  const bar = () => p.evaluate(`(document.querySelector('[data-action="titlebar-model"]')?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;
  const click = async (selector: string) => {
    const at = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
    if (!at) throw new Error(`not on the page: ${selector}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  };
  /** The engines this environment started and that are still alive: by their command line, which names the environment's models folder. */
  const engines = (model: string) =>
    Bun.spawnSync(["powershell", "-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' -and $_.CommandLine -like '*${path.join(e.modelsDir, model + ".gguf")}*' }).Count`])
      .stdout.toString()
      .trim();

  await waitUntil(async () => (await engineState(e)).phase === "starting", "the default loading");
  await waitUntil(async () => /^Fake model · carico/.test(await bar()), "the bar says the default is loading");
  expect(await engines("fake")).toBe("1");

  await click('[data-action="titlebar-model"]');
  await waitUntil(() => p.evaluate(`!!document.querySelector('[role="menu"] [data-option-key="second"]')`) as Promise<boolean>, "the bar's menu");
  await click('[role="menu"] [data-option-key="second"]');
  // at once: the chosen model is the one loading, the bar says so, the first one is stopped
  await waitUntil(async () => (await controlState(e)).model.model === "second", "the chosen model loading");
  expect((await controlState(e)).model).toMatchObject({ phase: "loading", label: "Model second" });
  await waitUntil(async () => /^Model second · carico/.test(await bar()), "the bar names the chosen model");
  await waitUntil(async () => (await engines("fake")) === "0", "the first loading stopped");
  expect((await engineState(e)).loading?.name).toBe("Model second");
  // the chosen one comes up, the first never answered anything and is still the saved default
  await waitUntil(async () => (await controlState(e)).model.phase === "ready", "the chosen model ready", 120_000);
  expect((await engineState(e)).model).toBe("second");
  await waitUntil(async () => (await bar()) === "Model second", "the chosen model in the bar");
  expect((await controlState(e)).default_model).toBe("fake");
  expect(chats(e)).toHaveLength(0);
  p.close();
}, 240_000);
