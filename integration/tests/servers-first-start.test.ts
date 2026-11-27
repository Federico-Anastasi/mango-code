// «Use a server» on the first start, in the app's real window, on a computer with no model: the welcome offers it beside
// the models to download; the address of a server without a key starts the app again with the server's model as the
// default, nothing is downloaded, the Home is the usual one and a conversation goes to the server. Fake engine as the
// server, no GPU. The photos are kept in the environment's folder, or in the one `MANGO_TEST_SCREENSHOTS` names.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, removeRoot, saveScreenshot, start, type Environment } from "./environment";

const MODEL = "first-model";
const SAID = "Hello from the server.";

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

let env: Environment;
let p: Page;
let server: ChildProcess;
let serverDir: string;
let serverPort: number;
let serverLog: string;

const service = () => readJson(path.join(env.data, "service.json"));
const serviceWritten = () => {
  const f = path.join(env.data, "service.json");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
};
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const files = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [e.name])) : [];

beforeAll(async () => {
  serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-server-"));
  serverPort = await freePort();
  serverLog = path.join(serverDir, "requests.jsonl");
  const script = path.join(serverDir, "script.json");
  fs.writeFileSync(script, JSON.stringify([{ text: SAID }]));
  server = spawn(FAKE_ENGINE_EXE, ["-m", path.join(serverDir, `${MODEL}.gguf`), "--port", String(serverPort)], {
    cwd: serverDir,
    env: { ...process.env, FAKE_ENGINE_CTX: "32768", FAKE_ENGINE_LOG: serverLog, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_CHUNK_MS: "5" },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${serverPort}/health`)).ok, "the server up", 20_000);
  env = await start([{ text: "Local." }], { window: true, noModels: true });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 200_000);

afterAll(async () => {
  p?.close();
  env?.close();
  if (server?.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
  await Bun.sleep(1500);
  if (env) removeRoot(env.root);
  fs.rmSync(serverDir, { recursive: true, force: true });
}, 60_000);

test("a server chosen on the first start is the default: nothing is downloaded, the Home is the usual one, the conversation goes to it", async () => {
  await waitUntil(() => exists('[data-component="mango-welcome"] [data-action="mango-server"]'), "the welcome with «Use a server»", 60_000);
  await p.evaluate(`document.querySelector('[data-action="mango-server"]').click()`);
  const address = '[data-component="mango-welcome"] input[aria-label="Indirizzo del server"]';
  await waitUntil(() => exists(address), "the server's form", 20_000);
  await p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(address)});
    el.focus();
    el.value = ${JSON.stringify(`127.0.0.1:${serverPort}`)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot(env, "mango-servers-first-start", shot.result.data);
  const before = serviceWritten();
  await p.evaluate(`document.querySelector('[data-action="mango-server-connect"]').click()`);

  await waitUntil(() => serviceWritten() > before && service().agent !== undefined, "the app started again", 120_000);
  p.close();
  p = await windowPage(env.cdp!, service().agent, 120_000);
  expect(readJson(path.join(env.data, "servers.json")).default).toEqual({ server: "server-1", model: MODEL });
  const state = await (await fetch(`${service().control}/control/state`)).json();
  expect(state.server_model).toBe(`server-1/${MODEL}`);
  expect(state.downloads).toEqual([]);
  expect(["ready", "loading"]).not.toContain(state.model.phase);
  expect(files(env.modelsDir)).toEqual([]);

  // the Home as usual: no welcome, no download
  await waitUntil(() => exists('[data-component="home-session-search"]'), "the usual Home, with the conversations", 60_000);
  expect(await exists('[data-component="mango-welcome"]')).toBe(false);
  expect(await exists('[data-component="mango-downloading"]')).toBe(false);

  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "first" });
  const steps: Step[] = [];
  for await (const s of mc.turn(id, env.project, "Hello")) steps.push(s);
  expect(steps.some((s) => s.type === "error")).toBe(false);
  expect(steps.filter((s) => s.type === "text").map((s) => (s as Extract<Step, { type: "text" }>).delta).join("")).toBe(SAID);
  const chats = fs.readFileSync(serverLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.route.startsWith("/v1/chat/completions"));
  expect(chats.some((r) => r.body.model === MODEL && r.body.stream === true && Array.isArray(r.body.tools) && r.body.messages.length > 1)).toBe(true);
}, 300_000);
