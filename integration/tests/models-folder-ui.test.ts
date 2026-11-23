// Choosing where the models are kept from Settings, in the app's real window with the mouse and the real Windows folder
// picker: Settings › Computer has the row «Cartella dei modelli» («Cambia…», the question with what the move would do,
// «Sposta», «Annulla», «Usa questa cartella» for a folder with files of its own, the progress and the end of a move in the
// row), and a model's detail in Settings › Models puts that model's files in another folder and back. Fake engine, no GPU.
// Run under off-screen: `off-screen bun test --cwd integration tests/models-folder-ui.test.ts`, after
// `cargo build -p mango-code -p engine` in app/ and `app\scripts\build-agent.ps1`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { answer } from "./dialog";
import { start, type Environment } from "./environment";

let env: Environment;
let p: Page;
let holder: ChildProcess | undefined;

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const serviceFile = () => path.join(env.data, "service.json");
const appPid = () => readJson(serviceFile()).pid as number;
const running = async () => (await (await fetch(`${env.engine}/engine`)).json()).phase === "running";

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 90_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const text = (selector: string) => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`) as Promise<string>;
const texts = (selector: string) => p.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent).join("\\n")`) as Promise<string>;
const dir = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.modelsDir.${call}.then((v) => JSON.stringify(v ?? null), (e) => "rejected " + JSON.stringify(e))`) as Promise<string>;
const state = async () => JSON.parse(await dir("state()"));

/**
 * A click with the mouse, like a person, on the first enabled element of `selector` whose text starts with `label` (any, if
 * empty): a button that is off while the row finishes a command is waited for.
 */
async function mouseClick(selector: string, label = "") {
  const where = () =>
    p.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => !e.disabled && e.innerText.trim().startsWith(${JSON.stringify(label)}));
      el?.scrollIntoView({ block: "center" });
      const q = el?.getBoundingClientRect();
      return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    })()`) as Promise<{ x: number; y: number } | undefined>;
  let at = await where();
  for (let waited = 0; !at && waited < 15_000; waited += 200) {
    await Bun.sleep(200);
    at = await where();
  }
  if (!at) throw new Error(`not on the page (or off): ${selector} ${label}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/** Clicks `selector` the moment it is on the page (an observer in the page): for a button that lives as long as a quick step. */
const clickWhenShown = (selector: string) =>
  p.evaluate(`new Promise((ok, fail) => {
    const click = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    };
    if (click()) return ok(true);
    const watcher = new MutationObserver(() => click() && (watcher.disconnect(), ok(true)));
    watcher.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => { watcher.disconnect(); fail(new Error("never shown: " + ${JSON.stringify(selector)})); }, 30000);
  })`);

async function windowOnTheHome() {
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
}

/** The app started again by itself: a new process wrote the service file and the window is on the home again. */
async function restarted(closed: number) {
  await waitUntil(() => fs.existsSync(serviceFile()) && appPid() !== closed, "the app started again by itself", 150_000);
  env.agent = readJson(serviceFile()).agent;
  env.engine = readJson(serviceFile()).engine;
  p.close();
  await windowOnTheHome();
}

async function openSettings(section: "computer" | "models", ready: string) {
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=${section}` });
  await waitUntil(() => exists(ready), `Settings › ${section}`);
}
const CHANGE = '[data-action="settings-folder-change"]';
const ASK = '[data-slot="settings-move-ask"]';
const row = (key: string) => `[data-model-row="${key}"]`;

/** «Cambia…», and the real folder picker answered with `folder`: the question about it is on the page. */
async function choose(folder: string) {
  // the Windows picker takes a folder that is there (it has «New folder» for the rest)
  fs.mkdirSync(folder, { recursive: true });
  await waitUntil(() => exists(`${CHANGE}:not([disabled])`), "«Cambia…» ready");
  await mouseClick(CHANGE);
  const picked = await answer(appPid(), "-Path", folder);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(() => exists(ASK), "the question about the folder");
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, freeModelsFolder: true, otherModels: ["second"] });
  await windowOnTheHome();
}, 200_000);

afterAll(() => {
  holder?.pid && spawnSync("taskkill", ["/PID", String(holder.pid), "/F"]);
  p?.close();
  // The app that started again is not the one the environment started: it is stopped by its id.
  try {
    if (appPid() !== env.app.pid) spawnSync("taskkill", ["/PID", String(appPid()), "/T", "/F"]);
  } catch {}
  env?.close();
});

test("Settings › Computer shows the models folder, and the question about a folder changes nothing until «Sposta»", async () => {
  await openSettings("computer", CHANGE);
  const line = await texts('[data-slot="settings-v2-row-title"]');
  expect(line).toContain("Cartella dei modelli");
  const rowText = (await p.evaluate(`document.querySelector(${JSON.stringify(CHANGE)}).closest('[data-component="settings-v2-row"]').innerText`)) as string;
  expect(rowText).toContain(env.modelsDir);
  expect(rowText).toMatch(/ su [A-Z]:/);

  const target = path.join(env.root, "somewhere");
  await choose(target);
  const asked = await text(ASK);
  expect(asked).toContain(`Spostare i modelli in ${target}?`);
  expect(asked).toContain("2 modelli");
  expect(asked).toContain("È lo stesso disco: sposto e basta.");
  expect(asked).toContain("alla fine Mango Code si riavvia");
  expect(await exists('[data-action="settings-move-go"]')).toBe(true);
  expect(await exists('[data-action="settings-move-use"]')).toBe(false);
  expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.readdirSync(env.modelsDir).sort()).toEqual(["fake.gguf", "second.gguf"]);

  await mouseClick('[data-action="settings-move-dismiss"]');
  await waitUntil(async () => !(await exists(ASK)), "the question gone");
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
}, 120_000);

test("a file another program holds stops the move: the row says so, and everything is as it was", async () => {
  const file = path.join(env.modelsDir, "second.gguf");
  holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Start-Sleep 300`], { stdio: "ignore", windowsHide: true });
  await waitUntil(() => spawnSync("powershell.exe", ["-NoProfile", "-Command", `try { [IO.File]::Open('${file}', 'Open', 'Write', 'ReadWrite').Close(); 'free' } catch { 'held' }`], { encoding: "utf8", windowsHide: true }).stdout.trim() === "held", "the file held");
  const pid = appPid();

  await choose(path.join(env.root, "blocked"));
  await mouseClick('[data-action="settings-move-go"]');
  await waitUntil(() => exists('[data-slot="settings-move-failed"]'), "the failure in the row", 60_000);
  expect((await text('[data-slot="settings-move-failed"]')).length).toBeGreaterThan(10);
  expect(await exists(ASK)).toBe(false);
  expect(await exists(CHANGE)).toBe(true);
  expect(fs.readdirSync(env.modelsDir).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
  expect(appPid()).toBe(pid);
  await waitUntil(running, "the model loaded again");
  holder.pid && spawnSync("taskkill", ["/PID", String(holder.pid), "/F"]);
  holder = undefined;
}, 180_000);

test("a move cancelled from the row stops, says so, and leaves the folder as it was", async () => {
  await openSettings("computer", CHANGE);
  const pid = appPid();
  await choose(path.join(env.root, "cancelled"));
  await mouseClick('[data-action="settings-move-go"]');
  // the model and the downloads are stopped first: «Annulla» is in the row while that goes on, and is pressed as it appears
  await clickWhenShown('[data-action="settings-move-stop"]');
  await waitUntil(async () => (await state()).moving.status === "cancelled" || (await state()).moving.status === "restarting", "the move over");

  expect((await state()).moving.status).toBe("cancelled");
  await waitUntil(() => exists('[data-slot="settings-move-cancelled"]'), "«Spostamento annullato.» in the row");
  expect(fs.readdirSync(env.modelsDir).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.readdirSync(path.join(env.root, "cancelled"))).toEqual([]);
  expect(fs.existsSync(path.join(env.data, "models-move.json"))).toBe(false);
  expect(appPid()).toBe(pid);
  await waitUntil(running, "the model loaded again");
}, 180_000);

test("one model's files go to another folder from its detail, and come back", async () => {
  await openSettings("models", `${row("second")} > button`);
  await mouseClick(`${row("second")} > button`);
  await waitUntil(() => exists(`${row("second")} [data-action="settings-model-move"]`), "the detail of the model");
  expect(await exists(`${row("second")} [data-action="settings-model-move-back"]`), "not elsewhere yet: no way back").toBe(false);

  const fast = path.join(env.root, "fast disk");
  fs.mkdirSync(fast);
  await mouseClick(`${row("second")} [data-action="settings-model-move"]`);
  const picked = await answer(appPid(), "-Path", fast);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(() => exists(`${row("second")} ${ASK}`), "the question about the model");
  const asked = await text(`${row("second")} ${ASK}`);
  expect(asked).toContain(`in ${fast}?`);
  expect(asked).toContain("È lo stesso disco: sposto e basta.");
  expect(asked, "the app goes on: no restart").not.toContain("riavvia");
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(true);

  const pid = appPid();
  await mouseClick(`${row("second")} [data-action="settings-move-go"]`);
  await waitUntil(() => exists(`${row("second")} [data-slot="settings-model-placed"]`), "the row says where the files are", 60_000);
  expect(await text(`${row("second")} [data-slot="settings-model-placed"]`)).toContain(fast);
  expect(fs.existsSync(path.join(fast, "second.gguf"))).toBe(true);
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(false);
  expect(appPid(), "the app did not start again").toBe(pid);
  await waitUntil(() => exists(`${row("second")} [data-action="settings-model-move-back"]`), "the way back");

  await mouseClick(`${row("second")} [data-action="settings-model-move-back"]`);
  await waitUntil(() => exists(`${row("second")} ${ASK}`), "the question about putting it back");
  expect(await text(`${row("second")} ${ASK}`)).toContain(`Riportare`);
  await mouseClick(`${row("second")} [data-action="settings-move-go"]`);
  await waitUntil(async () => !(await exists(`${row("second")} [data-slot="settings-model-placed"]`)), "the row without a place", 60_000);
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(true);
  expect(fs.existsSync(path.join(fast, "second.gguf"))).toBe(false);
  expect(await exists(`${row("second")} [data-action="settings-model-move-back"]`)).toBe(false);
}, 180_000);

test("the models move to the folder chosen, the app starts again by itself and the row shows the new folder", async () => {
  await openSettings("computer", CHANGE);
  const target = path.join(env.root, "chosen folder");
  const closed = appPid();
  await choose(target);
  await mouseClick('[data-action="settings-move-go"]');
  await restarted(closed);

  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim()).toBe(target);
  expect(fs.readdirSync(target).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.readdirSync(env.modelsDir)).toEqual([]);
  await openSettings("computer", CHANGE);
  const rowText = (await p.evaluate(`document.querySelector(${JSON.stringify(CHANGE)}).closest('[data-component="settings-v2-row"]').innerText`)) as string;
  expect(rowText).toContain(target);
  await waitUntil(running, "the model loaded from the new folder");
}, 300_000);

test("a folder with files of its own is not merged: «Usa questa cartella» takes it as it is", async () => {
  const mine = path.join(env.root, "my own folder");
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
  const previous = path.join(env.root, "chosen folder");
  await openSettings("computer", CHANGE);
  await choose(mine);
  const asked = await text(ASK);
  expect(asked).toContain(`${mine} contiene già dei file`);
  expect(asked).toContain("Non unisco due cartelle");
  expect(asked).toContain(previous);
  expect(await exists('[data-action="settings-move-go"]'), "nothing to move").toBe(false);

  const closed = appPid();
  await mouseClick('[data-action="settings-move-use"]');
  await restarted(closed);
  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim()).toBe(mine);
  expect(fs.readFileSync(path.join(mine, "notes.txt"), "utf8")).toBe("mine");
  expect(fs.readdirSync(previous).sort(), "nothing moved").toEqual(["fake.gguf", "second.gguf"]);
  await openSettings("computer", CHANGE);
  expect(await texts('[data-component="settings-v2-row"]')).toContain(mine);
}, 300_000);

test("a move that leaves something behind waits in the row until «Riavvia»", async () => {
  // a model of the user's behind a junction in the models folder: the junction is not followed, so that model stays behind it
  const current = path.join(env.root, "my own folder");
  const outside = path.join(env.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "mine.gguf"), "");
  const link = path.join(current, "linked");
  fs.symlinkSync(outside, link, "junction");
  const gguf = path.join(link, "mine.gguf");
  fs.writeFileSync(
    path.join(env.data, "user-models.json"),
    JSON.stringify({ models: { "mine-linked": { label: "Mine", gguf, ctx: 32768, files: [{ path: gguf, size: 1000 }], memory: { kv_kib_token: 1, state_mib: 0 } } } }),
  );
  const target = path.join(env.root, "target with a link behind");
  const closed = appPid();

  await openSettings("computer", CHANGE);
  await choose(target);
  expect(await text(ASK)).toContain("Restano dove sono, con i modelli che contengono: linked");
  await mouseClick('[data-action="settings-move-go"]');
  await waitUntil(() => exists('[data-action="settings-move-restart"]'), "«Riavvia» in the row", 90_000);
  expect(await text('[data-component="settings-v2-row"]:has([data-action="settings-move-restart"])')).toContain("Nella vecchia restano: linked");
  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim()).toBe(target);
  await Bun.sleep(3000);
  expect(appPid(), "the app waits for the user").toBe(closed);

  await mouseClick('[data-action="settings-move-restart"]');
  await restarted(closed);
  await openSettings("computer", CHANGE);
  expect(await texts('[data-component="settings-v2-row"]')).toContain(target);
  fs.rmdirSync(link);
}, 300_000);
