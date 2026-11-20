// What the interface remembers (the open projects, the drafts and their attachments, the preferences) lives in the app's
// data folder (`ui-state.json`, `ui-state\blobs`), not in the browser of the window, so it does not depend on the port the
// agent listens on: when the preferred port is taken by another program the app takes a free one and the window shows the
// same projects and the same draft. The first start copies what the window's browser had kept for the
// preferred port's origin, once, and leaves it where it was, also when another program holds that port: the app serves that
// origin to a hidden window itself, and no request reaches the program that holds the port (the browser's own empty
// connections to it, opened when the window navigates, carry nothing). A state file the app cannot read is shown, not
// replaced.
// Fake engine, no GPU. `off-screen bun test --cwd integration tests/ui-state.test.ts`, after `cargo build -p mango-code -p engine`
// in app/ and `app\scripts\build-agent.ps1`.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mango-ui-state-"));
const site = path.join(base, "remembered-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<h1>hello</h1>");

let env: Environment | undefined;
let p: Page | undefined;
const holders: net.Server[] = [];
/**
 * The requests (connections that sent bytes) the program on the preferred port received: the app never sends it any. The
 * window's browser opens a few empty connections to the origin when it navigates to it, with no data on them: they are
 * not requests and are not counted.
 */
let reached = 0;
const sockets: net.Socket[] = [];

afterEach(() => {
  reached = 0;
  p?.close();
  sockets.splice(0).forEach((socket) => socket.destroy());
  holders.splice(0).forEach((s) => s.close());
  env?.close();
  env = undefined;
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const stateFile = () => path.join(env!.data, "ui-state.json");
const state = () => readJson(stateFile());

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await (async () => condition())().catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(200);
  }
}

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

/** Another program takes the port: listening on it, as soon as the app that held it has let it go. */
async function hold(port: number) {
  const s = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", () => reached++);
    socket.on("error", () => {});
  });
  await waitUntil(
    () =>
      new Promise<boolean>((ok) => {
        s.once("error", () => ok(false));
        s.listen(port, "127.0.0.1", () => ok(true));
      }),
    `port ${port} to be free`,
    30_000,
  );
  holders.push(s);
}

/** The app is up again after a restart: its service file is its own, not the one the closed app left. */
async function restarted(e: Environment) {
  await waitUntil(() => fs.existsSync(path.join(e.data, "service.json")) && readJson(path.join(e.data, "service.json")).pid === e.app.pid, "the new app's service file", 120_000);
  return readJson(path.join(e.data, "service.json"));
}

const composer = (e: Page) => e.evaluate(`document.querySelector('[contenteditable="true"]')?.innerText ?? null`) as Promise<string | null>;

test("the projects and the draft are the same when another program holds the port, and the log says which port was used", async () => {
  const preferred = await freePort();
  env = await start([{ text: "ok" }], { window: true, noModels: true, args: [`${site}\\.`], env: { MANGO_AGENT_PORT: String(preferred) } });
  expect(new URL(env.agent).port).toBe(String(preferred));
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("remembered-site")`), "the project in the window");
  await waitUntil(() => JSON.stringify(state().entries).includes("remembered-site"), "the project kept by the app");
  expect(state().imported).toBe(true);

  const { MangoCode, find } = await import("../client/mango-code");
  const id = await new MangoCode((await find(env.data))!).createSession(site, { title: "draft" });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(site))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const conversation = (agent: string) => `${agent}/${b64}/session/${id}`;
  await p.send("Page.navigate", { url: conversation(env.agent) });
  await waitUntil(() => p!.evaluate(`!!document.querySelector('[contenteditable="true"]')`), "the composer");
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, 'a draft that stays'); })()`);
  await waitUntil(() => Object.values<string>(state().drafts).some((d) => d.includes("a draft that stays")), "the draft kept by the app");
  const before = state();

  p.close();
  const e = env;
  await e.restart(() => hold(preferred));
  const service = await restarted(e);
  expect(new URL(service.agent).port).not.toBe(String(preferred));
  e.agent = service.agent;
  expect(fs.readFileSync(path.join(e.data, "logs", "startup.log"), "utf8")).toContain(`port ${preferred} is busy, the agent uses ${new URL(service.agent).port}`);
  expect((await fetch(`${service.agent}/mango/language`)).ok).toBe(true);

  p = await windowPage(e.cdp!, service.agent);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("remembered-site")`), "the project in the window on the other port");
  await p.send("Page.navigate", { url: conversation(service.agent) });
  await waitUntil(async () => (await composer(p!)) === "a draft that stays", "the draft in the composer on the other port");
  const after = state();
  // the same state; the page may write a document with its fields in another order
  const parsed = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, text]) => [
        key,
        (() => {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        })(),
      ]),
    );
  const saved = parsed(before.entries);
  for (const key of Object.keys(saved)) expect(parsed(after.entries)[key], key).toEqual(saved[key]);
  expect(parsed(after.drafts)).toEqual(parsed(before.drafts));
}, 400_000);

/** Closes the window's browser the way «Quit» closes it: the latest changes it keeps in memory are written to its files. */
async function closeBrowser(e: Environment) {
  const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${e.cdp}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((ok, ko) => ((ws.onopen = ok), (ws.onerror = ko)));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
}

/** What the browser keeps in the origin of the preferred port: a project list with the agent's address in it, a preference, a draft with an attachment. */
async function keepInOldOrigin(e: Environment, window: Page) {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const legacyServer = JSON.stringify({ list: [], projects: { local: [{ worktree: "C:\\legacy\\project", expanded: true }] }, lastProject: {}, recentlyClosed: {} });
  const legacyTabs = JSON.stringify([{ type: "session", server: e.agent, sessionId: "legacy" }]);
  await window.evaluate(`(async () => {
    localStorage.setItem("opencode.global.dat:server", ${JSON.stringify(legacyServer)});
    localStorage.setItem("mango.legacy.preference", "kept");
    localStorage.setItem("mango.legacy.tabs", ${JSON.stringify(legacyTabs)});
    const request = indexedDB.open("opencode-drafts", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("documents"); request.result.createObjectStore("blobs"); };
    const db = await new Promise((ok, ko) => { request.onsuccess = () => ok(request.result); request.onerror = () => ko(request.error); });
    const transaction = db.transaction(["documents", "blobs"], "readwrite");
    transaction.objectStore("documents").put(JSON.stringify({ attachments: [{ blob: { id: ${JSON.stringify(id)} } }] }), "default:draft:legacy");
    transaction.objectStore("blobs").put(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), ${JSON.stringify(id)});
    await new Promise((ok, ko) => { transaction.oncomplete = ok; transaction.onerror = () => ko(transaction.error); });
  })()`);
  await closeBrowser(e);
  const profile = path.join(e.data, "finestra", "EBWebView", "Default");
  const written = (dir: string, text: string) =>
    fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(log|ldb)$/.test(f) && fs.readFileSync(path.join(dir, f)).includes(text));
  await waitUntil(() => written(path.join(profile, "Local Storage", "leveldb"), "mango.legacy.preference"), "the browser's storage written", 20_000);
  await waitUntil(() => fs.existsSync(path.join(profile, "IndexedDB")) && fs.readdirSync(path.join(profile, "IndexedDB")).some((d) => written(path.join(profile, "IndexedDB", d), id)), "the browser's drafts written", 20_000);
  return { id, bytes, written: (text: string) => written(path.join(profile, "Local Storage", "leveldb"), text) };
}

/** Back to the app of the version before: its state file and attachments are not there, only what the browser kept. */
const forgetTheAppsState = (e: Environment) => async () => {
  fs.rmSync(stateFile(), { force: true });
  fs.rmSync(`${stateFile()}.bak`, { force: true });
  fs.rmSync(path.join(e.data, "ui-state"), { recursive: true, force: true });
};

function expectCopied(e: Environment, kept: { id: string; bytes: Uint8Array }) {
  const copied = state();
  expect(copied.entries["mango.legacy.preference"]).toBe("kept");
  expect(JSON.parse(copied.entries["opencode.global.dat:server"]).projects.local[0].worktree).toBe("C:\\legacy\\project");
  expect(Object.keys(copied.drafts)).toEqual(["default:draft:legacy"]);
  expect(new Uint8Array(fs.readFileSync(path.join(e.data, "ui-state", "blobs", kept.id)))).toEqual(kept.bytes);
}

test("on its first start the app copies what the window's browser kept, once, and leaves it where it was", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => state().imported === true, "the first start's mark");
  const kept = await keepInOldOrigin(env, p);
  p.close();

  const e = env;
  await e.restart(forgetTheAppsState(e));
  await restarted(e);
  p = await windowPage(e.cdp!, e.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && state().imported === true, "the copy", 60_000);

  expectCopied(e, kept);
  // the agent address is not in the file, and the browser keeps its own copy as it was
  expect(state().entries["mango.legacy.tabs"]).toBe('[{"type":"session","server":"@agent-origin@","sessionId":"legacy"}]');
  expect(JSON.parse((await p.evaluate(`localStorage.getItem("mango.legacy.tabs")`)) as string)[0].server).toBe(e.agent);
  // the browser's data is still there
  expect(await p.evaluate(`localStorage.getItem("mango.legacy.preference")`)).toBe("kept");
  expect(await p.evaluate(`new Promise((ok) => { const r = indexedDB.open("opencode-drafts", 1); r.onsuccess = () => { const q = r.result.transaction("documents").objectStore("documents").count(); q.onsuccess = () => ok(q.result); } })`)).toBe(1);

  // Once: what the browser gets later is not copied by a later start.
  await p.evaluate(`localStorage.setItem("mango.legacy.preference", "changed in the browser")`);
  await closeBrowser(e);
  p.close();
  await e.restart();
  await restarted(e);
  p = await windowPage(e.cdp!, e.agent);
  expect(await p.evaluate(`localStorage.getItem("mango.legacy.preference")`)).toBe("changed in the browser");
  await Bun.sleep(1500);
  expect(state().entries["mango.legacy.preference"]).toBe("kept");
  expect(state().imported).toBe(true);
}, 400_000);

test("with the preferred port held by another program the first start still copies the window's old storage, and no request reaches that program", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => state().imported === true, "the first start's mark");
  const preferred = Number(new URL(env.agent).port);
  const kept = await keepInOldOrigin(env, p);
  p.close();

  const e = env;
  await e.restart(async () => {
    await forgetTheAppsState(e)();
    await hold(preferred);
  });
  const service = await restarted(e);
  expect(new URL(service.agent).port).not.toBe(String(preferred));
  e.agent = service.agent;
  p = await windowPage(e.cdp!, service.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && state().imported === true, "the copy", 60_000);

  expectCopied(e, kept);
  expect(state().entries["mango.legacy.tabs"]).toBe('[{"type":"session","server":"@agent-origin@","sessionId":"legacy"}]');
  expect(reached, "the program that holds the port received nothing from the app").toBe(0);
  const log = fs.readFileSync(path.join(e.data, "logs", "startup.log"), "utf8");
  expect(log).toContain(`port ${preferred} is still busy`);
  expect(log).toContain(`port ${preferred} is busy, the agent uses ${new URL(service.agent).port}`);
  // the browser's data is still where it was
  expect(kept.written("mango.legacy.preference")).toBe(true);
}, 400_000);

test("the first start waits a moment for the other program to let go of the preferred port, and then uses it", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => state().imported === true, "the first start's mark");
  const preferred = Number(new URL(env.agent).port);
  const kept = await keepInOldOrigin(env, p);
  p.close();

  const e = env;
  let holder: net.Server | undefined;
  await e.restart(async () => {
    await forgetTheAppsState(e)();
    await hold(preferred);
    holder = holders[holders.length - 1];
    // the old agent is slow to leave: it lets go a couple of seconds into the new app's start
    setTimeout(() => holder?.close(), 2500);
  });
  const service = await restarted(e);
  expect(new URL(service.agent).port).toBe(String(preferred));
  e.agent = service.agent;
  p = await windowPage(e.cdp!, service.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && state().imported === true, "the copy", 60_000);
  expectCopied(e, kept);
  expect(fs.readFileSync(path.join(e.data, "logs", "startup.log"), "utf8")).not.toContain("is still busy");
}, 400_000);

test("a state the app cannot read is shown with its files, and the files are not touched", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => fs.existsSync(stateFile()), "a state file");
  p.close();
  const e = env;
  const broken = '{"version":1,"entries":';
  const backup = '{"version":1,"entr';
  await e.restart(async () => {
    fs.writeFileSync(stateFile(), broken);
    fs.writeFileSync(`${stateFile()}.bak`, backup);
  });
  await restarted(e);
  p = await windowPage(e.cdp!, e.agent);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("ui-state.json.bak")`), "the page that says the state cannot be read");
  expect(await p.evaluate(`document.body.innerText.includes("ui-state.json")`)).toBe(true);
  expect(await p.evaluate(`document.querySelector('[data-component="mango-welcome"]') === null && document.querySelector('[contenteditable="true"]') === null`)).toBe(true);
  expect(fs.readFileSync(stateFile(), "utf8")).toBe(broken);
  expect(fs.readFileSync(`${stateFile()}.bak`, "utf8")).toBe(backup);
}, 300_000);

test("a state file that cannot be read gives way to the copy of the state before the last write, and the window says so", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("remembered-site")`), "the project in the window");
  await waitUntil(() => fs.existsSync(`${stateFile()}.bak`) && JSON.stringify(state().entries).includes("remembered-site"), "the project kept, and a copy of the state before it");
  const e = env;
  p.close();
  await e.restart(async () => fs.writeFileSync(stateFile(), ""));
  await restarted(e);
  p = await windowPage(e.cdp!, e.agent);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("copia di sicurezza")`), "the notice that the state came from its copy");
  expect(await p.evaluate(`document.body.innerText.includes("ui-state.json")`)).toBe(false);
  await waitUntil(() => p!.evaluate(`document.querySelector('[data-component="mango-welcome"]') !== null || !!document.querySelector('[contenteditable="true"]')`), "the interface");
  // the next write makes a good file again
  await waitUntil(() => { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")).version === 1 } catch { return false } }, "a readable state file", 30_000);
}, 300_000);

test("a state that cannot be written is told in the window and written again by itself when the disk allows it", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && state().imported === true, "the first start's mark");

  const { MangoCode, find } = await import("../client/mango-code");
  const id = await new MangoCode((await find(env.data))!).createSession(site, { title: "unsaved" });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(site))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
  await waitUntil(() => p!.evaluate(`!!document.querySelector('[contenteditable="true"]')`), "the composer");

  // The temporary file the app writes first cannot be created: a folder is in its place.
  fs.mkdirSync(`${stateFile()}.tmp`);
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, 'a draft the disk refuses'); })()`);
  await waitUntil(() => p!.evaluate(`document.body.innerText.includes("Impossibile salvare le modifiche")`), "the notice that the changes cannot be saved", 30_000);
  expect(Object.values<string>(state().drafts).some((d) => d.includes("a draft the disk refuses"))).toBe(false);

  fs.rmdirSync(`${stateFile()}.tmp`);
  await waitUntil(() => Object.values<string>(state().drafts).some((d) => d.includes("a draft the disk refuses")), "the draft written by the retry", 30_000);
  await waitUntil(() => p!.evaluate(`!document.body.innerText.includes("Impossibile salvare le modifiche")`), "the notice gone", 30_000);
}, 300_000);
