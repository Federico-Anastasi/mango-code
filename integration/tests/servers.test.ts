// «Use a server» with the fake engine as an OpenAI-compatible server that asks for a key: added through the bridge of the window,
// as the settings use it. A wrong key and an address that does not answer each say what is wrong and save nothing; the right
// key saves the server (its key only in the Credential Manager of the test), the app starts again with its model in the menu,
// and a conversation on it goes to the server without the manager's headers. A default on the server keeps the local model
// from loading at start; removing the server brings the local default back. A second server, without a key and without
// `/props`, is added from Settings › Connections: the card asks for the context, proposing 32.768, and saves the number
// given; «Refresh the list» reads its models again after it changed, without a restart, and a default on a model that is
// gone goes back to the local one. The photos are kept in the environment's folder, or in the one `MANGO_TEST_SCREENSHOTS`
// names.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, removeRoot, saveScreenshot, start, type Environment } from "./environment";

const KEY = "sk-test-server-key-0123456789";
const SAID = "Hello from the server.";
const MODEL = "server-model";

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

/** A click with the mouse, like a person: the menus open on the pointer, not on a click event alone. */
async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

let env: Environment;
let p: Page;
let server: ChildProcess;
let plain: ChildProcess | undefined;
let plainPort: number;
let serverDir: string;
let serverPort: number;
let serverLog: string;

const ask = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.servers.${call}.then((v) => v ?? null, (e) => ({ rejected: e }))`);
const serversFile = () => path.join(env.data, "servers.json");
const requests = () =>
  fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const service = () => readJson(path.join(env.data, "service.json"));

const serviceWritten = () => {
  const f = path.join(env.data, "service.json");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
};

/** The app started again: it wrote its service file anew (the restart removes it, the start writes it once the agent
 *  answers, often on the same port), with the window on the agent. */
async function startedAgain(before: number) {
  await waitUntil(() => serviceWritten() > before && readJson(path.join(env.data, "service.json")).agent !== undefined, "the app started again", 120_000);
  p.close();
  p = await windowPage(env.cdp!, service().agent, 120_000);
  await waitUntil(() => p.evaluate(`!!window.__MANGO_DESKTOP__?.servers`), "the bridge on the new page", 60_000);
}

/** The fake engine as a server with one model, `model`, on `port`; `extra`: its key, its context. */
async function fakeServer(model: string, port: number, extra: Record<string, string>) {
  const script = path.join(serverDir, "script.json");
  fs.writeFileSync(script, JSON.stringify([{ text: SAID }]));
  const child = spawn(FAKE_ENGINE_EXE, ["-m", path.join(serverDir, `${model}.gguf`), "--port", String(port)], {
    cwd: serverDir,
    env: { ...process.env, FAKE_ENGINE_LOG: serverLog, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_CHUNK_MS: "5", ...extra },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, `the server of ${model} up`, 20_000);
  return child;
}

const stopServer = async (child: ChildProcess | undefined, port: number) => {
  if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  await waitUntil(async () => !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)), "the server down", 20_000);
};

/** Writes in a field as typing does: the page listens to `input`. */
const type = (selector: string, text: string) =>
  p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const agentConfig = () => readJson(path.join(env.data, "opencode-home", "opencode.json"));

beforeAll(async () => {
  serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-server-"));
  serverPort = await freePort();
  serverLog = path.join(serverDir, "requests.jsonl");
  server = await fakeServer(MODEL, serverPort, { FAKE_ENGINE_KEY: KEY, FAKE_ENGINE_CTX: "16384" });
  env = await start([{ text: "Local." }], { window: true });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 200_000);

afterAll(async () => {
  p?.close();
  env?.close();
  for (const child of [server, plain]) if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  await Bun.sleep(1500);
  if (env) removeRoot(env.root);
  fs.rmSync(serverDir, { recursive: true, force: true });
}, 60_000);

test("a wrong key and an address that does not answer each say what is wrong, and nothing is saved", async () => {
  const wrong = await ask(`add("127.0.0.1:${serverPort}", "sk-wrong")`);
  expect(wrong.rejected.message).toContain("rifiuta la chiave");
  const nobody = await freePort();
  const silent = await ask(`add("127.0.0.1:${nobody}", "")`);
  expect(silent.rejected.message).toContain("non risponde");
  expect(fs.existsSync(serversFile())).toBe(false);
  expect(await ask("state()")).toEqual({ list: [], default: null });
}, 120_000);

let mc: MangoCode;
const said = (steps: Step[]) => steps.filter((s) => s.type === "text").map((s) => (s as Extract<Step, { type: "text" }>).delta).join("");

test("the right key saves the server, the app starts again, and a conversation on its model goes to the server alone", async () => {
  const before = serviceWritten();
  expect(await ask(`add("127.0.0.1:${serverPort}", ${JSON.stringify(KEY)})`)).toEqual({ context: null });
  await startedAgain(before);
  const saved = readJson(serversFile());
  expect(saved.list).toEqual([{ id: "server-1", url: `http://127.0.0.1:${serverPort}/v1`, key: true, models: [{ id: MODEL, ctx: 16384, images: false }], context: null }]);
  // the key is in no file of the app (a file another process holds open, WebView2's, is not read)
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else
        try {
          if (fs.readFileSync(f).includes(KEY)) found.push(f);
        } catch {}
    }
  };
  walk(env.root);
  expect(found).toEqual([]);
  mc = new MangoCode((await find(env.data))!);
  const servers = await mc.servers(env.project);
  expect(servers.map((s) => ({ id: s.id, name: s.name, models: s.models.map((m) => [m.key, m.context]) }))).toEqual([
    { id: "server-1", name: `127.0.0.1:${serverPort}`, models: [[`server-1/${MODEL}`, 16384]] },
  ]);

  const before2 = requests().length;
  const local = fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).length : 0;
  const id = await mc.createSession(env.project, { title: "server" });
  const steps: Step[] = [];
  for await (const s of mc.turn(id, env.project, "Hello", { model: `server-1/${MODEL}` })) steps.push(s);
  expect(steps.some((s) => s.type === "error")).toBe(false);
  expect(said(steps)).toBe(SAID);
  const chats = requests().slice(before2).filter((r) => r.route.startsWith("/v1/chat/completions"));
  expect(chats.length).toBeGreaterThan(0);
  for (const r of chats) {
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(r.headers).filter((h) => h.startsWith("x-mango"))).toEqual([]);
    expect(r.body.model).toBe(MODEL);
  }
  // the local engine saw none of it
  const localNow = fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean) : [];
  expect(localNow.slice(local).filter((l) => JSON.parse(l).route.startsWith("/v1/chat/completions"))).toEqual([]);

  // the conversation in the window, and the menu under the chat: this PC's group and the server's
  await p.send("Page.navigate", { url: `${service().agent}/${b64(env.project)}/session/${id}` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="prompt-model"]')`), "the model button", 60_000);
  await Bun.sleep(1500);
  await mouseClick('[data-action="prompt-model"]');
  await waitUntil(() => p.evaluate(`!!document.querySelector('[role="menu"] [data-option-key="server-1:${MODEL}"]')`), "the server's model in the menu", 20_000);
  expect(await p.evaluate(`!!document.querySelector('[role="menu"] [data-option-key="mango:fake"]')`)).toBe(true);
  const menu: string = await p.evaluate(`document.querySelector('[role="menu"]').innerText`);
  expect(menu).toContain("Questo PC");
  expect(menu).toContain(`127.0.0.1:${serverPort}`);
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot(env, "mango-servers-menu", shot.result.data);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}, 240_000);

test("a default on the server keeps the local model from loading at start; removing the server brings the local one back", async () => {
  expect(await ask(`setDefault("server-1", ${JSON.stringify(MODEL)})`)).toBe(null);
  expect(readJson(serversFile()).default).toEqual({ server: "server-1", model: MODEL });
  const config = readJson(path.join(env.data, "opencode-home", "opencode.json"));
  expect(config.model).toBe(`server-1/${MODEL}`);

  // the app opens again: no local model loads
  const before = serviceWritten();
  await env.restart();
  await startedAgain(before);
  await Bun.sleep(3000);
  const state = await (await fetch(`${service().control}/control/state`)).json();
  expect(state.model.phase).not.toBe("ready");
  expect(state.model.phase).not.toBe("loading");

  const again = serviceWritten();
  expect(await ask(`remove("server-1")`)).toBe(null);
  await startedAgain(again);
  expect(readJson(serversFile())).toEqual({ list: [], default: null, last: 1 });
  expect(readJson(path.join(env.data, "opencode-home", "opencode.json")).model).toBe("mango/fake");
}, 300_000);

test("a server that does not say the context: Connections asks for it, proposing 32.768, and saves the number given", async () => {
  plainPort = await freePort();
  plain = await fakeServer("plain-model", plainPort, {});
  await p.send("Page.navigate", { url: `${service().agent}/settings?section=links` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="settings-servers-open"]')`), "the card", 60_000);
  await p.evaluate(`document.querySelector('[data-action="settings-servers-open"]').click()`);
  const card = '[data-link-card="servers"]';
  const address = `${card} input[aria-label="Indirizzo del server"]`;
  const submit = `document.querySelector('${card} [data-action="settings-servers-form"] button[type="submit"]').click()`;
  await waitUntil(() => p.evaluate(`!!document.querySelector('${address}')`), "the form", 20_000);
  await type(address, `127.0.0.1:${plainPort}`);
  await p.evaluate(submit);
  const context = `${card} input[aria-label="Contesto dei modelli, in token"]`;
  await waitUntil(() => p.evaluate(`document.querySelector('${context}')?.value === "32768"`), "the context proposed", 60_000);
  expect(await p.evaluate(`document.querySelector('[data-slot="settings-servers-status"]').textContent`)).toContain("non dice quanto contesto");
  expect(readJson(serversFile()).list).toEqual([]);
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot(env, "mango-servers-context", shot.result.data);

  const before = serviceWritten();
  await type(context, "40000");
  await waitUntil(() => p.evaluate(`!document.querySelector('${card} [data-action="settings-servers-form"] button[type="submit"]').disabled`), "the button on", 20_000);
  await p.evaluate(submit);
  await startedAgain(before);
  // the window is back where the server was added, not on the home
  await waitUntil(
    async () => (await p.evaluate(`location.pathname + location.search`)) === "/settings?section=links" && (await p.evaluate(`!!document.querySelector('${card}')`)),
    "the window back on Connections",
    60_000,
  );
  const saved = readJson(serversFile());
  // the id of the server removed before is not given again
  expect(saved).toEqual({
    list: [{ id: "server-2", url: `http://127.0.0.1:${plainPort}/v1`, key: false, models: [{ id: "plain-model", ctx: 40000, images: false }], context: 40000 }],
    default: null,
    last: 2,
  });
}, 300_000);

test("«Refresh the list» reads the models again without a restart, and a default on a model that is gone goes back to the local one", async () => {
  expect(await ask(`setDefault("server-2", "plain-model")`)).toBe(null);
  expect(agentConfig().model).toBe("server-2/plain-model");
  await stopServer(plain, plainPort);
  plain = await fakeServer("plain-model-2", plainPort, {});

  const before = serviceWritten();
  expect(await ask(`refresh("server-2")`)).toEqual({ gone: "plain-model", context: null });
  const saved = readJson(serversFile());
  expect(saved.list[0].models).toEqual([{ id: "plain-model-2", ctx: 40000, images: false }]);
  expect(saved.default).toBe(null);
  const offered = JSON.stringify(agentConfig().provider["server-2"]);
  expect(offered).toContain('"plain-model-2"');
  expect(offered).not.toContain('"plain-model"');
  expect(agentConfig().model).toBe("mango/fake");
  // the agent reads its configuration again by itself: the new model is offered, the app did not start again
  const agent = new MangoCode((await find(env.data))!);
  await waitUntil(async () => (await agent.servers(env.project)).some((s) => s.models.some((m) => m.key === "server-2/plain-model-2")), "the new model offered by the agent", 60_000);
  expect(serviceWritten()).toBe(before);
}, 180_000);
