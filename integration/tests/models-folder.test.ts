// Choosing where the models are kept, from the app's real window through the bridge's `modelsDir` commands: the preview
// changes nothing; a move stops the engine, renames the files, writes the choice and the app starts again by itself with the
// fake engine started from the new folder; a move that cannot be done (a file another program holds) puts everything back
// and the app goes on as it was; a folder with files of its own is used as it is. The same for one model's files
// (`previewModel`, `moveModel`): the app goes on and the engine starts from the new place.
// Fake engine, no GPU. Run under off-screen: `off-screen bun test --cwd integration tests/models-folder.test.ts`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

let env: Environment;
let p: Page;
let holder: ChildProcess | undefined;

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const serviceFile = () => path.join(env.data, "service.json");

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 90_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(200);
  }
}

/** A command of the bridge's `modelsDir`: what it answered as JSON, or "rejected" and what it was rejected with. */
const dir = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.modelsDir.${call}.then((v) => JSON.stringify(v ?? null), (e) => "rejected " + JSON.stringify(e))`) as Promise<string>;
const answer = async (call: string) => JSON.parse(await dir(call));

/** The models the fake engine was started with, in order: the `-m` of each request it logged. */
const started = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).model_path as string) : []).filter(
    (m, i, all) => m && m !== all[i - 1],
  );

async function windowOnTheHome() {
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
}

const running = async () => (await (await fetch(`${env.engine}/engine`)).json()).phase === "running";

/** The app started again by itself: a new process wrote the service file, and the model runs. */
async function restarted(closed: number) {
  await waitUntil(() => fs.existsSync(serviceFile()) && readJson(serviceFile()).pid !== closed, "the app started again by itself", 150_000);
  const service = readJson(serviceFile());
  env.agent = service.agent;
  env.engine = service.engine;
  p.close();
  await windowOnTheHome();
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
    const pid = readJson(serviceFile()).pid;
    if (pid !== env.app.pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
  env?.close();
});

test("the choice starts as the default folder, and the preview of another folder changes nothing", async () => {
  const state = await answer("state()");
  expect(state).toMatchObject({ path: env.modelsDir, default_path: env.modelsDir, chosen: false, pinned: false, moving: { status: "idle" } });
  expect(started().at(-1)).toBe(path.join(env.modelsDir, "fake.gguf"));

  const target = path.join(env.root, "elsewhere");
  const preview = await answer(`preview(${JSON.stringify(target)})`);
  expect(preview).toMatchObject({ files: 2, same_volume: true, destination: "empty", refusal: null, move_refusal: null, links: [], partial_files: 0 });
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readdirSync(env.modelsDir).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);

  expect((await dir(`preview(${JSON.stringify(env.modelsDir)})`)).startsWith("{")).toBe(true);
  expect((await answer(`preview(${JSON.stringify(env.modelsDir)})`)).refusal).not.toBeNull();
  expect(await dir(`move(${JSON.stringify(env.modelsDir)})`)).toStartWith("rejected");
}, 120_000);

test("one model's files go to another folder, the app goes on, and the engine starts from there", async () => {
  const fast = path.join(env.root, "fast disk");
  fs.mkdirSync(fast);
  const pid = readJson(serviceFile()).pid;
  expect(await answer(`previewModel("second", ${JSON.stringify(fast)})`)).toMatchObject({ model: "second", files: 1, refusal: null });

  expect(await dir(`moveModel("second", ${JSON.stringify(fast)})`)).toBe("null");
  await waitUntil(async () => (await answer("state()")).moving.status === "done", "the model moved");

  expect(fs.existsSync(path.join(fast, "second.gguf"))).toBe(true);
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(false);
  expect(fs.existsSync(path.join(env.modelsDir, "fake.gguf"))).toBe(true);
  expect(readJson(serviceFile()).pid, "the app did not start again").toBe(pid);
  expect(await running()).toBe(true);
  expect(readJson(path.join(env.data, "model-files.json")).files.second ?? readJson(path.join(env.data, "model-files.json")).files["second.gguf"]).toMatchObject({ at: path.join(fast, "second.gguf"), own: true });
  const catalog = (await (await fetch(`${env.engine}/control/models`)).json()).models as { key: string; present: boolean }[];
  expect(catalog.find((m) => m.key === "second")?.present).toBe(true);

  // The model starts from its new place.
  await fetch(`${env.engine}/engine/model`, { method: "POST", body: JSON.stringify({ model: "second" }), headers: { "content-type": "application/json" } });
  await waitUntil(() => started().at(-1) === path.join(fast, "second.gguf"), "the engine started from the new place", 60_000);

  // And back in the models folder.
  expect(await dir(`moveModel("second")`)).toBe("null");
  await waitUntil(async () => (await answer("state()")).moving.status === "done" && fs.existsSync(path.join(env.modelsDir, "second.gguf")), "the model back");
  expect(fs.existsSync(path.join(env.data, "model-files.json"))).toBe(false);
}, 180_000);

test("a file another program holds stops the move: everything is put back and the app goes on as it was", async () => {
  const target = path.join(env.root, "blocked");
  const file = path.join(env.modelsDir, "second.gguf");
  holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Start-Sleep 300`], { stdio: "ignore", windowsHide: true });
  await waitUntil(() => spawnSync("powershell.exe", ["-NoProfile", "-Command", `try { [IO.File]::Open('${file}', 'Open', 'Write', 'ReadWrite').Close(); 'free' } catch { 'held' }`], { encoding: "utf8", windowsHide: true }).stdout.trim() === "held", "the file held");
  const pid = readJson(serviceFile()).pid;

  expect(await dir(`move(${JSON.stringify(target)})`)).toBe("null");
  await waitUntil(async () => (await answer("state()")).moving.status === "failed", "the move failed");

  const state = await answer("state()");
  expect(state.moving.message.length).toBeGreaterThan(0);
  expect(state).toMatchObject({ path: env.modelsDir, chosen: false });
  expect(fs.readdirSync(env.modelsDir).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
  expect(readJson(serviceFile()).pid).toBe(pid);
  await waitUntil(running, "the model loaded again");
  holder.pid && spawnSync("taskkill", ["/PID", String(holder.pid), "/F"]);
  holder = undefined;
}, 120_000);

test("the models move to the chosen folder, the app starts again by itself, and the engine starts from the new folder", async () => {
  const target = path.join(env.root, "chosen folder");
  const closed = readJson(serviceFile()).pid;

  expect(await dir(`move(${JSON.stringify(target)})`)).toBe("null");
  await restarted(closed);

  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim()).toBe(target);
  expect(fs.readdirSync(target).sort()).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.readdirSync(env.modelsDir)).toEqual([]);
  expect(await answer("state()")).toMatchObject({ path: target, default_path: env.modelsDir, chosen: true, moving: { status: "idle" } });
  await waitUntil(running, "the model loaded from the new folder");
  expect(started().at(-1)).toBe(path.join(target, "fake.gguf"));
  const computer = await (await fetch(`${env.engine}/control/computer`)).json();
  expect(computer.disk.path).toBe(target);
}, 300_000);

test("a folder with files of its own is used as it is, and the app starts again on it", async () => {
  const mine = path.join(env.root, "my own folder");
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
  const previous = path.join(env.root, "chosen folder");
  const preview = await answer(`preview(${JSON.stringify(mine)})`);
  expect(preview).toMatchObject({ destination: "has_files", refusal: null });
  expect(preview.move_refusal).not.toBeNull();
  expect(await dir(`move(${JSON.stringify(mine)})`)).toStartWith("rejected");

  const closed = readJson(serviceFile()).pid;
  // The app ends right after the command: its answer may never arrive.
  void dir(`use(${JSON.stringify(mine)})`).catch(() => {});
  await restarted(closed);

  expect(await answer("state()")).toMatchObject({ path: mine, chosen: true });
  expect(fs.readFileSync(path.join(mine, "notes.txt"), "utf8")).toBe("mine");
  expect(fs.readdirSync(previous).sort(), "nothing moved").toEqual(["fake.gguf", "second.gguf"]);
  const catalog = (await (await fetch(`${env.engine}/control/models`)).json()).models as { key: string; present: boolean }[];
  expect(catalog.map((m) => m.present)).toEqual([false, false]);

  // Back to the default folder: the choice goes away. Only what is Mango Code's moves: the file that is not stays where it is,
  // and the preview says so.
  const ownPreview = await answer(`preview(${JSON.stringify(env.modelsDir)})`);
  expect(ownPreview).toMatchObject({ files: 0, foreign_files: 1, refusal: null, move_refusal: null });
  expect(ownPreview.staying).toContain("1");
  const back = readJson(serviceFile()).pid;
  expect(await dir(`move(${JSON.stringify(env.modelsDir)})`)).toBe("null");
  await restarted(back);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
  expect(await answer("state()")).toMatchObject({ path: env.modelsDir, chosen: false });
  expect(fs.readFileSync(path.join(mine, "notes.txt"), "utf8"), "a file that is not Mango Code's stays").toBe("mine");
  expect(fs.existsSync(path.join(env.modelsDir, "notes.txt"))).toBe(false);
}, 400_000);

test("a move that leaves something behind waits until the user has seen what, and then the app starts again", async () => {
  expect(await dir("cancel()"), "nothing moves").toMatch(/Nessuno spostamento in corso|No move in progress/);
  expect(await dir("restart()"), "nothing is done").toMatch(/Nessuno spostamento da concludere|No move to finish/);

  // A model of the user's behind a junction in the models folder: the junction is not followed, so that model stays behind it.
  const outside = path.join(env.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "mine.gguf"), "");
  const link = path.join(env.modelsDir, "linked");
  fs.symlinkSync(outside, link, "junction");
  const gguf = path.join(link, "mine.gguf");
  fs.writeFileSync(
    path.join(env.data, "user-models.json"),
    JSON.stringify({ models: { "mine-linked": { label: "Mine", gguf, ctx: 32768, files: [{ path: gguf, size: 1000 }], memory: { kv_kib_token: 1, state_mib: 0 } } } }),
  );
  const target = path.join(env.root, "target with a link behind");
  expect(await answer(`preview(${JSON.stringify(target)})`)).toMatchObject({ links: ["linked"], model_links: ["linked"], refusal: null, move_refusal: null });
  const closed = readJson(serviceFile()).pid;

  expect(await dir(`move(${JSON.stringify(target)})`)).toBe("null");
  await waitUntil(async () => (await answer("state()")).moving.status === "moved", "the move done and waiting");

  expect((await answer("state()")).moving).toEqual({ status: "moved", left: ["linked"] });
  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim()).toBe(target);
  expect(fs.existsSync(path.join(link, "mine.gguf")), "what is behind the link stays").toBe(true);
  expect(await dir("cancel()"), "the choice is written: too late").toMatch(/Non si può più annullare|can no longer be cancelled/);
  expect(await dir(`move(${JSON.stringify(path.join(env.root, "another"))})`), "nothing else moves from the folder in memory").toStartWith("rejected");
  await Bun.sleep(4000);
  expect(readJson(serviceFile()).pid, "the app waits for the user").toBe(closed);
  // What the move stopped stays stopped: the app has the old folder in memory, so the model does not start on it.
  const asked = await fetch(`${env.engine}/engine/model`, { method: "POST", body: JSON.stringify({ model: "fake" }), headers: { "content-type": "application/json" } });
  expect(asked.status, "the engine does not start on the old folder while the app waits").toBe(422);
  expect(await running()).toBe(false);

  void dir("restart()").catch(() => {});
  await restarted(closed);
  expect(await answer("state()")).toMatchObject({ path: target, chosen: true, moving: { status: "idle" } });
  expect(await dir("restart()"), "the new app has no move to finish").toMatch(/Nessuno spostamento da concludere|No move to finish/);
  fs.rmdirSync(link);
}, 300_000);
