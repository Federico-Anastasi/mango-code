// "Use the engine of another PC" with two real apps on this PC and the fake engine: A shares its engine (127.0.0.1, the hook
// `MANGO_SHARE_PC_ONLY`), B is a laptop at its first start (no graphics card, no models, nothing on disk) that pastes A's code
// and talks through it without downloading a byte. Then the failures (wrong code, a PC that does not answer, A that disappears
// and comes back, a renewed key), the way back to the engine of the PC, and C, an app that already works and moves to A's engine
// and back. No GPU and no real model; the firewall is not tried (127.0.0.1). The photos are in %TEMP%\mango-engine-remote-*.png,
// at 860 px (a 150% laptop).

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
const MIB = 1024 * 1024;

const appWindow = (t: { url: string }) => t.url.includes("tauri.localhost") || t.url.startsWith("tauri://");
const visible = (id: string) => `!document.getElementById('${id}').hidden`;
const text = (id: string) => `document.getElementById('${id}').innerText`;
/** The headings of the page are in capitals (the style): what is read is compared without the case. */
const lower = (id: string) => `${text(id)}.toLowerCase()`;

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
const narrow = (p: Page) => p.send("Emulation.setDeviceMetricsOverride", { width: 860, height: 900, deviceScaleFactor: 1, mobile: false });

// What a download would ask: nothing may come.
let downloads = 0;
const never = http.createServer((_, res) => {
  downloads++;
  res.writeHead(404).end();
});
await new Promise<void>((ok) => never.listen(0, "127.0.0.1", ok));
const neverUrl = `http://127.0.0.1:${(never.address() as net.AddressInfo).port}`;

/** A laptop without a graphics card, with nothing on disk. */
const laptop = () => ({
  computer: { gpus: [], cpu: "Intel Core i5-1135G7", cores: 4, ram_mib: 8192 },
  general: "llamacpp",
  engines: [{ name: "llamacpp", build: "cuda-12", bytes: 40 * MIB, file: path.join("llamacpp", "fake-cuda-12", "llama-server.exe"), url: `${neverUrl}/engine` }],
  models: [{ key: "fake", label: "Fake model", images: false, file: "fake.gguf", url: `${neverUrl}/fake.gguf`, engine: "llamacpp", profile: null }],
  recommendations: [{ model: "fake", placement: "cpu", context: 16384, reason: "Gira sul processore, più lento.", bytes: 24 * MIB }],
});

const opened: Environment[] = [];
let A: Environment; // shares its engine
let pa: Page;
let portA: number;
let code = "";
let key = "";

const bridgeA = (call: string) => pa.evaluate(`window.__MANGO_DESKTOP__.engineShare.${call}`);

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

// --- the PC with the engine: the sharing sits on the "Models and engine" page --------------------------------------

test("A: the sharing section is on the Models and engine page, with where to paste the code", async () => {
  await narrow(pa);
  await pa.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => pa.evaluate(visible("choice")), "the Models and engine page");
  await waitUntil(() => pa.evaluate(visible("share")), "the sharing section");
  const off: string = await pa.evaluate(lower("share"));
  expect(off).toContain("condividi il motore con i miei pc");
  expect(off).toContain("spento, la porta è chiusa");
  expect(off).toContain("uso il motore di un altro mio pc");
  expect(off).not.toContain("mango://");
  expect(await pa.evaluate(visible("share-details"))).toBe(false);

  await pa.evaluate(`document.getElementById('share-on').click()`);
  await waitUntil(() => pa.evaluate(visible("share-details")), "the sharing turned on");
  const on: string = await pa.evaluate(text("share"));
  expect(on).toContain(`127.0.0.1:${portA}`);
  expect(on).toContain("Copia il codice");
  expect(on).toContain("Nuova chiave");
  expect(on).toContain("in chiaro sul Wi-Fi");
  // The page shows the address, never the key.
  expect(on).not.toMatch(/[0-9a-f]{48}/);
  expect(await pa.evaluate(`document.documentElement.innerHTML.match(/[0-9a-f]{48}/)`)).toBeNull();
  await pa.evaluate(`document.getElementById('share').scrollIntoView()`);
  await Bun.sleep(300);
  await shot(pa, "condividi");

  const state = await bridgeA("state()");
  expect(state).toMatchObject({ enabled: true, listening: true });
  code = state.home.code;
  key = code.split("/").pop()!;
  // Cancel goes back to where it was; the sharing stays on.
  await pa.evaluate(`document.getElementById('cancel').click()`);
  await waitUntil(() => pa.evaluate(`location.href.startsWith('${A.agent}')`), "the return to the web UI");
  expect((await bridgeA("state()")).enabled).toBe(true);
}, 120_000);

// --- B: a laptop at its first start ---------------------------------------------------------------------------------

let B: Environment;
let pb: Page;

test("B: at the first start the page offers the engine of another PC and the models only as a second road", async () => {
  B = await start([{ text: "unused" }], { window: true, firstRun: laptop });
  opened.push(B);
  pb = await page(B.cdp!, appWindow, 120_000);
  await narrow(pb);
  await waitUntil(() => pb.evaluate(visible("choice")), "the choice page");
  const card: string = await pb.evaluate(lower("remote"));
  expect(card).toContain("uso il motore di un altro mio pc");
  expect(card).toContain("collega");
  expect(await pb.evaluate(visible("local"))).toBe(true);
  expect(await pb.evaluate(text("computer"))).toContain("Nessuna scheda video utilizzabile");
  // Nothing to share before there is an engine.
  expect(await pb.evaluate(`document.getElementById('share').hidden`)).toBe(true);
  // The field of the code hides what is pasted, like a password.
  expect(await pb.evaluate(`document.getElementById('remote-code').type`)).toBe("password");
  await shot(pb, "primo-avvio");
}, 200_000);

async function paste(p: Page, value: string) {
  await p.evaluate(`(() => { const i = document.getElementById('remote-code'); i.value = ${JSON.stringify(value)}; document.getElementById('remote-form').requestSubmit(); })()`);
}

test("B: a text that is not a code, a wrong key and a PC that does not answer each say what to do", async () => {
  await paste(pb, "hello");
  await waitUntil(() => pb.evaluate(`${text("remote-status")}.includes('codice di collegamento')`), "the sentence for a text that is not a code");

  const wrong = code.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
  await paste(pb, wrong);
  await waitUntil(() => pb.evaluate(`${text("remote-status")}.includes('non è valido, oppure la condivisione è spenta')`), "the sentence for a wrong key");

  const nobody = await freePort();
  await paste(pb, `mango://127.0.0.1:${nobody}/${key}`);
  await waitUntil(() => pb.evaluate(`${text("remote-status")}.includes('non risponde')`), "the sentence for a PC that does not answer");
  const said: string = await pb.evaluate(text("remote-status"));
  expect(said).toContain("è acceso?");
  expect(said).toContain("condivisione accesa");
  expect(said).not.toContain(key);
  await pb.evaluate(`document.getElementById('remote').scrollIntoView()`);
  await Bun.sleep(300);
  await shot(pb, "non-risponde");
  // Still at the choice: nothing was saved and nothing started.
  expect(fs.existsSync(path.join(B.data, "remote-engine.json"))).toBe(false);
  expect(await pb.evaluate(visible("choice"))).toBe(true);
}, 120_000);

let mcB: MangoCode;

test("B: the right code starts the app on A's engine, with no download and no graphics card read", async () => {
  await paste(pb, code);
  await waitUntil(() => {
    const f = path.join(B.data, "service.json");
    return fs.existsSync(f) && readJson(f).agent !== undefined;
  }, "B ready", 120_000);
  const service = readJson(path.join(B.data, "service.json"));
  expect(service.engine).toBeNull();
  B.agent = service.agent;
  expect(downloads).toBe(0);
  expect(fs.existsSync(path.join(B.data, "first-run.json"))).toBe(false);
  expect(fs.readdirSync(B.modelsDir).filter((f) => f.endsWith(".gguf"))).toEqual([]);
  expect(fs.existsSync(path.join(B.enginesDir, "llamacpp", "fake-cuda-12"))).toBe(false);
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
  expect(models[0].name).toBe("Fake model · sul PC 127.0.0.1");

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
  await waitUntil(() => pb.evaluate(`document.body.innerText.includes('Fake model · sul PC 127.0.0.1')`), "the model with the PC in the chat");
  await Bun.sleep(500);
  await shot(pb, "chat");
}, 60_000);

test("B: Models and engine says which engine is in use, with no local models to choose", async () => {
  await pb.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => pb.evaluate(visible("choice")), "the page");
  await waitUntil(() => pb.evaluate(visible("remote-using")), "the state of the PC in use");
  const using: string = await pb.evaluate(text("remote-using"));
  expect(using).toContain("Stai usando il motore del PC 127.0.0.1");
  expect(using).toContain("Fake model");
  expect(using).toContain("Torna al motore di questo PC");
  expect(await pb.evaluate(visible("local"))).toBe(false);
  expect(await pb.evaluate(`document.getElementById('share').hidden`)).toBe(true);
  expect(await pb.evaluate(`document.getElementById('start-download').hidden`)).toBe(true);
  expect(await pb.evaluate(`document.documentElement.innerHTML.includes(${JSON.stringify(key)})`)).toBe(false);
  await shot(pb, "motore-remoto-attivo");
  // The agent stayed on while the page was shown; Cancel goes back.
  expect((await fetch(`${B.agent}/global/health`)).ok).toBe(true);
  await pb.evaluate(`document.getElementById('cancel').click()`);
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the return to the web UI");
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

  // A comes back with the same key (turning it off is what wipes it): the agent was trying again.
  A.app = A.launch([]);
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${portA}/mango/models`, { headers: { authorization: `Bearer ${key}` } })).ok, "A's port open again", 90_000);
  await turning;
  stop();
  expect(steps.some((s) => s.type === "error")).toBe(false);
  expect(said(steps)).toBe(SAID);
}, 240_000);

test("B: A renews the key: the chat says to paste the new code, and pasting it on the page puts B back at work", async () => {
  pa.close();
  pa = await page(A.cdp!, (t) => t.url.startsWith(A.agent), 120_000);
  const renewed = (await bridgeA("newKey()")).home.code as string;
  expect(renewed).not.toBe(code);

  const steps = await turn(mcB, B, "Hello once more");
  const error = steps.find((s) => s.type === "error") as Extract<Step, { type: "error" }> | undefined;
  expect(JSON.stringify(error?.error)).toContain("Modelli e motore");

  await pb.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => pb.evaluate(visible("remote-using")), "the page");
  await paste(pb, renewed);
  await waitUntil(() => pb.evaluate(`location.href.startsWith('${B.agent}')`), "the window back on the web UI", 120_000);
  await waitUntil(async () => !!(await find(B.data)), "the agent back", 120_000);
  mcB = new MangoCode((await find(B.data))!);
  expect(readJson(path.join(B.data, "remote-engine.json")).key).toBe(renewed.split("/").pop());
  code = renewed;
  key = renewed.split("/").pop()!;
  expect(said(await turn(mcB, B, "Hello after the new code"))).toBe(SAID);
}, 240_000);

test("B: going back to this PC's engine forgets A and brings the first-start choice back, still without downloading", async () => {
  await pb.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => pb.evaluate(visible("remote-using")), "the page");
  await pb.evaluate(`document.getElementById('remote-back').click()`);
  await waitUntil(() => pb.evaluate(`${visible("choice")} && ${visible("local")}`), "the choice of this PC's models");
  expect(fs.existsSync(path.join(B.data, "remote-engine.json"))).toBe(false);
  expect(await pb.evaluate(`document.getElementById('remote-using').hidden`)).toBe(true);
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

test("C: moves to A's engine from Models and engine; its own engine stops and the conversation goes to A", async () => {
  C = await start([{ text: OWN }], { window: true });
  opened.push(C);
  pc = await page(C.cdp!, (t) => t.url.startsWith(C.agent));
  await narrow(pc);
  mcC = new MangoCode((await find(C.data))!);
  expect(said(await turn(mcC, C, "Hello"))).toBe(OWN);

  await pc.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => pc.evaluate(visible("choice")), "the page");
  expect(await pc.evaluate(visible("remote-using"))).toBe(false);
  const mine = chats(C);
  const theirs = chats(A);
  await paste(pc, code);
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
  await narrow(pc);
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
