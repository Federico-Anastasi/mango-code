// "Use the engine of another PC" with two real apps on this PC and the fake engine: A shares its engine (127.0.0.1, the hook
// `MANGO_SHARE_PC_ONLY`), B is an app at its first start (no models, nothing on disk) that pastes A's code and talks through it
// without downloading a byte. Then the failures (wrong code, a PC that does not answer, A that disappears and comes back, a
// renewed key), the way back to the engine of the PC, and C, an app that already works and moves to A's engine and back.
// Everything goes through the bridge of the window (`engineShare`, `engineRemote`), as the settings use it: the app's own page
// only shows the error of a start, and there the way back to this PC's engine. No GPU and no real model; the firewall is not
// tried (127.0.0.1). The photos are in %TEMP%\mango-engine-remote-*.png, of the window as it opens.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const SAID = "Hello from the shared engine.";
const OWN = "Hello from my own engine.";

const appWindow = (t: { url: string }) => t.url.includes("tauri.localhost") || t.url.startsWith("tauri://");
const visible = (id: string) => `!document.getElementById('${id}').hidden`;
const text = (id: string) => `document.getElementById('${id}').innerText`;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(300);
  }
}

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const killTree = (e: Environment) => spawnSync("taskkill", ["/PID", String(e.app.pid), "/T", "/F"]);

/** Everything under a folder that holds the key, except the file that is meant to keep it. */
function filesWith(dir: string, key: string, except: string[], found: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) filesWith(f, key, except, found);
    else if (!except.includes(entry.name)) {
      try {
        if (fs.readFileSync(f).includes(key)) found.push(f);
      } catch {}
    }
  }
  return found;
}

const shot = async (p: Page, name: string) => {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), `mango-engine-remote-${name}.png`), Buffer.from(r.result.data, "base64"));
};

// What a download would ask (the files of the models stand in for Hugging Face here): nothing may come.
let downloads = 0;
const never = http.createServer((_, res) => {
  downloads++;
  res.writeHead(404).end();
});
await new Promise<void>((ok) => never.listen(0, "127.0.0.1", ok));
const neverUrl = `http://127.0.0.1:${(never.address() as net.AddressInfo).port}`;

const opened: Environment[] = [];
let A: Environment; // shares its engine
let pa: Page;
let portA: number;
let code = "";
let key = "";

const bridgeA = (call: string) => pa.evaluate(`window.__MANGO_DESKTOP__.engineShare.${call}`);
/** A command of the bridge from a window: what it answered, or { rejected: { code, message } }. */
const ask = (p: Page, call: string) => p.evaluate(`window.__MANGO_DESKTOP__.${call}.then((v) => v ?? null, (e) => ({ rejected: e }))`);

beforeAll(async () => {
  portA = await freePort();
  A = await start([{ text: SAID }], { window: true, env: { MANGO_SHARE_PC_ONLY: "1", MANGO_SHARE_PORT: String(portA) } });
  opened.push(A);
  pa = await page(A.cdp!, (t) => t.url.startsWith(A.agent));
}, 200_000);

afterAll(async () => {
  never.close();
  for (const e of opened) e.close();
  await Bun.sleep(2000);
  for (const e of opened) {
    try {
      fs.rmSync(e.root, { recursive: true, force: true });
    } catch {}
  }
}, 60_000);

// --- the PC with the engine: the sharing, from the bridge -----------------------------------------------------------

test("A: the sharing is off at first; on, it gives the address and the code, and the window never holds the key", async () => {
  const off = await bridgeA("state()");
  expect(off).toMatchObject({ enabled: false, listening: false });
  const on = await bridgeA("setEnabled(true)");
  expect(on).toMatchObject({ enabled: true, listening: true });
  code = on.home.code;
  key = code.split("/").pop()!;
  expect(code).toBe(`mango://127.0.0.1:${portA}/${key}`);
  // The code is given to whoever asks for it to copy it; nothing in the page keeps it.
  expect(await pa.evaluate(`document.documentElement.innerHTML.includes(${JSON.stringify(key)})`)).toBe(false);
}, 120_000);

// --- B: an app at its first start ---------------------------------------------------------------------------------

let B: Environment;
let pb: Page;

test("B: with no model yet the app opens on its home, and pasting a code is what the bridge offers besides the models", async () => {
  B = await start([{ text: "unused" }], { window: true, noModels: true, env: { MANGO_HF_URL: neverUrl } });
  opened.push(B);
  pb = await page(B.cdp!, () => true, 120_000);
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the window on the web UI");
  expect(await (await fetch(`${B.engine}/control/state`)).json()).toMatchObject({ model: { phase: "none" }, default_model: null });
  expect(await pb.evaluate(`typeof window.__MANGO_DESKTOP__.engineRemote.connect`)).toBe("function");
  await shot(pb, "primo-avvio");
}, 200_000);

test("B: a text that is not a code, a wrong key and a PC that does not answer each say what to do", async () => {
  const notACode = await ask(pb, `engineRemote.connect("hello")`);
  expect(notACode.rejected.code).toBe("bad_code");
  expect(notACode.rejected.message).toContain("codice di collegamento");
  expect(notACode.rejected.message).toContain("Impostazioni › Collegamenti");

  const wrong = code.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
  const rejected = await ask(pb, `engineRemote.connect(${JSON.stringify(wrong)})`);
  expect(rejected.rejected.message).toContain("non è valido, oppure la condivisione è spenta");

  const nobody = await freePort();
  const silent = await ask(pb, `engineRemote.connect(${JSON.stringify(`mango://127.0.0.1:${nobody}/${key}`)})`);
  expect(silent.rejected.code).toBe("unreachable");
  expect(silent.rejected.message).toContain("non risponde");
  expect(silent.rejected.message).toContain("è acceso?");
  expect(silent.rejected.message).toContain("condivisione accesa");
  expect(JSON.stringify(silent)).not.toContain(key);
  // Nothing was saved and nothing started again: the window is where it was.
  expect(fs.existsSync(path.join(B.data, "remote-engine.json"))).toBe(false);
  expect(await pb.evaluate(`location.href.startsWith('${B.agent}')`)).toBe(true);
}, 120_000);

let mcB: MangoCode;

/** A click with the mouse, like a person, on the Home of the first start. */
async function click(p: Page, selector: string) {
  const at = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
/** Pastes `value` in the code box of the Home and presses «Connetti». */
async function pasteCode(p: Page, value: string) {
  if (!(await p.evaluate(`!!document.querySelector('[data-action="mango-other-pc-connect"]')`))) await click(p, '[data-action="mango-other-pc"]');
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="mango-other-pc-connect"]')`), "the box for the code");
  await p.evaluate(`(() => { const el = document.querySelector('[data-action="mango-other-pc-connect"]').parentElement.querySelector("input"); el.focus(); el.select(); })()`);
  await p.send("Input.insertText", { text: value });
  await waitUntil(() => p.evaluate(`!document.querySelector('[data-action="mango-other-pc-connect"]').disabled`), "«Connetti» on");
  await click(p, '[data-action="mango-other-pc-connect"]');
}

test("B: on the Home a text that is not a code and a wrong key each say what to do, and nothing is saved", async () => {
  await pasteCode(pb, "hello");
  await waitUntil(() => pb.evaluate(`document.body.innerText.includes("codice di collegamento")`), "the sentence for a text that is not a code");
  const wrong = code.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
  await pasteCode(pb, wrong);
  await waitUntil(() => pb.evaluate(`document.body.innerText.includes("non è valido, oppure la condivisione è spenta")`), "the sentence for a wrong key");
  expect(await pb.evaluate(`document.body.innerText.includes(${JSON.stringify(key)})`)).toBe(false);
  expect(fs.existsSync(path.join(B.data, "remote-engine.json"))).toBe(false);
  expect(await pb.evaluate(`!!document.querySelector('[data-component="mango-welcome"]')`)).toBe(true);
}, 120_000);

test("B: the right code pasted on the Home starts the app on A's engine, with no download", async () => {
  await pasteCode(pb, code);
  // The agent starts again on A's engine: the service file then has no engine of this PC.
  await waitUntil(() => {
    const f = path.join(B.data, "service.json");
    return fs.existsSync(f) && readJson(f).agent !== undefined && readJson(f).engine === null;
  }, "B on A's engine", 120_000);
  expect(downloads).toBe(0);
  // The app's own server is there all the same, and says whose engine is in use.
  const told = await (await fetch(`${readJson(path.join(B.data, "service.json")).control}/control/state`)).json();
  expect(told.model).toMatchObject({ phase: "remote", address: `127.0.0.1:${portA}`, models: ["Fake model"] });
  expect(fs.readdirSync(B.modelsDir).filter((f) => f.endsWith(".gguf"))).toEqual([]);
  expect(readJson(path.join(B.data, "remote-engine.json"))).toEqual({ address: `127.0.0.1:${portA}`, key });
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the window on the web UI");
  mcB = new MangoCode((await find(B.data))!);
}, 200_000);

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
let lastSession = "";

async function turn(mc: MangoCode, env: Environment, say: string, on?: (s: Step) => void) {
  const id = (lastSession = await mc.createSession(env.project, { title: "remote" }));
  const steps: Step[] = [];
  for await (const s of mc.turn(id, env.project, say, { model: "fake" })) {
    steps.push(s);
    on?.(s);
  }
  return steps;
}
const said = (steps: Step[]) => steps.filter((s) => s.type === "text").map((s) => (s as Extract<Step, { type: "text" }>).delta).join("");
const chats = (e: Environment) =>
  fs.existsSync(e.engineLog)
    ? fs.readFileSync(e.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.route.startsWith("/v1/chat/completions")).length
    : 0;
const refusals = () => (fs.readFileSync(path.join(A.data, "logs", "manager.log"), "utf8").match(/share refused/g) ?? []).length;

test("B: a whole conversation goes through A's engine, the models are A's, and the key stays out of every log", async () => {
  const models = await mcB.models(B.project);
  expect(models.map((m) => m.key)).toEqual(["fake"]);
  expect(models[0].name).toBe("Fake model · sull'altro PC");

  // What the agent tells its clients (the window, a phone, another app) about its providers never has the key.
  for (const route of ["/config/providers", "/provider"]) expect(await (await fetch(`${B.agent}${route}`)).text()).not.toContain(key);

  const before = chats(A);
  const steps = await turn(mcB, B, "Hello");
  expect(steps.some((s) => s.type === "error")).toBe(false);
  expect(said(steps)).toBe(SAID);
  expect(chats(A)).toBeGreaterThan(before);
  expect(fs.existsSync(B.engineLog)).toBe(false);

  // The agent's reads of the engine (`/slots`, `/engine`) carry the key: A refuses nothing.
  const refused = refusals();
  const speed = await fetch(`${B.agent}/mango/engine/speed`);
  expect(speed.ok).toBe(true);
  expect(refusals()).toBe(refused);

  // The key: only where it is meant to be kept.
  expect(filesWith(B.data, key, ["remote-engine.json"])).toEqual([]);
  expect(filesWith(A.data, key, ["engine-share.json"]).filter((f) => !f.includes("finestra"))).toEqual([]);
}, 120_000);

test("B: the chat names the PC whose model answers", async () => {
  await pb.send("Page.navigate", { url: `${B.agent}/${b64(B.project)}/session/${lastSession}` });
  await waitUntil(() => pb.evaluate(`document.body.innerText.includes("Fake model · sull'altro PC")`), "the model with the PC in the chat");
  await Bun.sleep(500);
  await shot(pb, "chat");
}, 60_000);

test("B: the state says which engine is in use, and the window never holds the key", async () => {
  const control = readJson(path.join(B.data, "service.json")).control;
  const told = await (await fetch(`${control}/control/state`)).json();
  expect(told.model).toMatchObject({ phase: "remote", address: `127.0.0.1:${portA}`, models: ["Fake model"] });
  expect(await pb.evaluate(`document.documentElement.innerHTML.includes(${JSON.stringify(key)})`)).toBe(false);
  // A model of this PC cannot be picked meanwhile: the control server says why.
  const use = await fetch(`${control}/control/model/use`, { method: "POST", body: JSON.stringify({ model: "fake" }) });
  expect(use.status).toBe(409);
}, 120_000);

/** What the agent tells while it waits to try again: the sentence of the status "retry". */
function retryMessages(mc: MangoCode, env: Environment) {
  const seen: string[] = [];
  const stop = mc.listen(env.project, (e) => {
    if (e.type === "session.status" && e.properties?.status?.type === "retry") seen.push(String(e.properties.status.message));
  });
  return { seen, stop };
}

test("B: A disappears in the middle: the chat says so, the app keeps answering, and when A is back the same message goes through", async () => {
  const { seen, stop } = retryMessages(mcB, B);
  killTree(A);
  const steps: Step[] = [];
  const turning = (async () => {
    for await (const s of mcB.turn(await mcB.createSession(B.project, { title: "gone" }), B.project, "Hello again", { model: "fake" })) steps.push(s);
  })();
  await waitUntil(() => seen.length > 0, "the sentence in the chat", 60_000);
  expect(seen[0]).toContain("Il PC con il motore non risponde");
  expect(seen[0]).toContain("condivisione accesa");
  expect(seen[0]).not.toContain(key);
  // Nothing is stuck: the agent and the window answer.
  expect((await fetch(`${B.agent}/global/health`)).ok).toBe(true);
  expect(await pb.evaluate(`1 + 1`)).toBe(2);
  // The state says it too: the app asks A every few seconds.
  const reachable = async () => (await (await fetch(`${readJson(path.join(B.data, "service.json")).control}/control/state`)).json()).model.reachable;
  await waitUntil(async () => (await reachable()) === false, "the state says A does not answer", 60_000);

  // A comes back with the same key (turning it off is what wipes it): the agent was trying again.
  A.app = A.launch([]);
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${portA}/mango/models`, { headers: { authorization: `Bearer ${key}` } })).ok, "A's port open again", 90_000);
  await turning;
  stop();
  expect(steps.some((s) => s.type === "error")).toBe(false);
  expect(said(steps)).toBe(SAID);
  await waitUntil(async () => (await reachable()) === true, "the state says A answers again", 60_000);
}, 240_000);

test("B: A renews the key: the chat says to paste the new code, and pasting it on the page puts B back at work", async () => {
  pa.close();
  pa = await page(A.cdp!, (t) => t.url.startsWith(A.agent), 120_000);
  const renewed = (await bridgeA("newKey()")).home.code as string;
  expect(renewed).not.toBe(code);

  const steps = await turn(mcB, B, "Hello once more");
  const error = steps.find((s) => s.type === "error") as Extract<Step, { type: "error" }> | undefined;
  expect(JSON.stringify(error?.error)).toContain("Impostazioni › Collegamenti");

  const service = path.join(B.data, "service.json");
  const written = fs.statSync(service).mtimeMs;
  expect(await ask(pb, `engineRemote.connect(${JSON.stringify(renewed)})`)).toBeNull();
  // The command answers before the agent starts again, and the service file of the new start looks like the old one:
  // the agent is back when the file is written again.
  await waitUntil(async () => fs.statSync(service).mtimeMs > written && !!(await find(B.data)), "the agent back", 120_000);
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the window back on the web UI", 120_000);
  mcB = new MangoCode((await find(B.data))!);
  expect(readJson(path.join(B.data, "remote-engine.json")).key).toBe(renewed.split("/").pop());
  code = renewed;
  key = renewed.split("/").pop()!;
  expect(said(await turn(mcB, B, "Hello after the new code"))).toBe(SAID);
}, 240_000);

test("B: going back to this PC's engine forgets A and opens the home with no model, still without downloading", async () => {
  expect(await ask(pb, `engineRemote.disconnect()`)).toBeNull();
  await waitUntil(async () => (await find(B.data))?.engine != null, "B on its own engine", 120_000);
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the window on the web UI");
  expect(fs.existsSync(path.join(B.data, "remote-engine.json"))).toBe(false);
  expect((await (await fetch(`${(await find(B.data))!.engine}/engine`)).json()).phase).toBe("stopped");
  expect(downloads).toBe(0);
}, 120_000);

// --- C: an app that already works on its own engine ---------------------------------------------------------------

let C: Environment;
let pc: Page;
let mcC: MangoCode;

async function readyC() {
  await waitUntil(async () => !!(await find(C.data)), "C ready", 180_000);
  const service = (await find(C.data))!;
  C.agent = service.agent;
  mcC = new MangoCode(service);
  return service;
}

test("C: moves to A's engine from the bridge; its own engine stops and the conversation goes to A", async () => {
  C = await start([{ text: OWN }], { window: true });
  opened.push(C);
  pc = await page(C.cdp!, (t) => t.url.startsWith(C.agent));
  mcC = new MangoCode((await find(C.data))!);
  expect(said(await turn(mcC, C, "Hello"))).toBe(OWN);

  expect((await (await fetch(`${C.engine}/control/state`)).json()).model.phase).not.toBe("remote");
  const mine = chats(C);
  const theirs = chats(A);
  expect(await ask(pc, `engineRemote.connect(${JSON.stringify(code)})`)).toBeNull();
  await waitUntil(async () => (await find(C.data))?.engine === null, "C restarted on A's engine", 180_000);
  await readyC();
  expect(said(await turn(mcC, C, "Hello from C"))).toBe(SAID);
  expect(chats(A)).toBeGreaterThan(theirs);
  expect(chats(C)).toBe(mine);
  // The model of this PC is not holding the memory any more.
  expect(C.engine && (await (await fetch(`${C.engine}/engine`)).json()).phase).not.toBe("running");
}, 360_000);

test("C: if A is off at the next start the page says so and one button goes back to this PC's engine", async () => {
  killTree(A);
  pc.close();
  await C.restart();
  await Bun.sleep(1500);
  pc = await page(C.cdp!, appWindow, 120_000);
  await waitUntil(() => pc.evaluate(visible("error")), "the error page", 120_000);
  const sentence: string = await pc.evaluate(text("error-sentence"));
  expect(sentence).toContain("Il PC con il motore non risponde");
  expect(sentence).not.toContain(key);
  expect(await pc.evaluate(visible("local-engine"))).toBe(true);
  expect(await pc.evaluate(`document.getElementById('local-engine').innerText`)).toBe("Torna al motore di questo PC");
  await shot(pc, "errore-avvio");

  await pc.evaluate(`document.getElementById('local-engine').click()`);
  await waitUntil(async () => !!(await find(C.data)), "C ready on its own engine", 180_000);
  expect(fs.existsSync(path.join(C.data, "remote-engine.json"))).toBe(false);
  const service = (await find(C.data))!;
  C.agent = service.agent;
  expect(service.engine).toContain("127.0.0.1");
  expect(said(await turn(new MangoCode(service), C, "Hello again"))).toBe(OWN);
}, 360_000);
