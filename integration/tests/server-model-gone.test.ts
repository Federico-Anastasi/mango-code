// A conversation made on the model of an external server, and the server taken off the app while it is open: the conversation is
// never left naming a model that no longer exists. The box names the model that takes its place, one line says so, and the next
// message is answered by it. Fake engines (the local one and the server), the app's real window.
// `off-screen bun test --cwd integration tests/server-model-gone.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, removeRoot, start, type Environment } from "./environment";

setDefaultTimeout(300_000);

const MODEL = "server-model";

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const page = await p.evaluate("document.body.innerText.slice(-700)").catch(() => "");
      throw new Error(`waited too long for: ${what}\n${page}`);
    }
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
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

let env: Environment;
let p: Page;
let server: ChildProcess;
let serverDir: string;
let serverPort: number;

const body = () => p.evaluate("document.body.textContent") as Promise<string>;
const modelName = () => p.evaluate(`(document.querySelector('[data-action="prompt-model"]')?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;
const bridge = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.servers.${call}.then((v) => v ?? null, (e) => ({ rejected: e }))`);
const service = () => readJson(path.join(env.data, "service.json"));
const serviceWritten = () => {
  const f = path.join(env.data, "service.json");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
};
const engineChats = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r: { route: string }) => r.route.startsWith("/v1/chat/completions"));

async function startedAgain(before: number) {
  await waitUntil(() => serviceWritten() > before && readJson(path.join(env.data, "service.json")).agent !== undefined, "the app started again", 120_000);
  p.close();
  p = await windowPage(env.cdp!, service().agent, 120_000);
  await waitUntil(() => p.evaluate(`!!window.__MANGO_DESKTOP__?.servers`), "the bridge on the new page", 60_000);
}

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
async function click(selector: string, what: string) {
  const at = await centre(`document.querySelector(${JSON.stringify(selector)})`);
  if (!at) throw new Error(`not on the page: ${what}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

beforeAll(async () => {
  serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-server-gone-"));
  serverPort = await freePort();
  const script = path.join(serverDir, "script.json");
  fs.writeFileSync(script, JSON.stringify([{ text: "Hello from the server." }]));
  server = spawn(FAKE_ENGINE_EXE, ["-m", path.join(serverDir, `${MODEL}.gguf`), "--port", String(serverPort)], {
    cwd: serverDir,
    env: { ...process.env, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_CHUNK_MS: "5", FAKE_ENGINE_CTX: "16384" },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${serverPort}/health`)).ok, "the server up", 20_000);
  env = await start([{ text: "Here I am." }], { window: true });
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

test("the server of the conversation's model taken off: the box names the local model, a line says so, and the next message is answered by it", async () => {
  const before = serviceWritten();
  expect(await bridge(`add("127.0.0.1:${serverPort}", "")`)).toEqual({ context: null });
  await startedAgain(before);
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "on the server" });
  for await (const _ of mc.turn(id, env.project, "Hello", { model: `server-1/${MODEL}` })) void _;

  await p.send("Page.navigate", { url: `${service().agent}/${b64(env.project)}/session/${id}` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="prompt-model"]')`), "the box");
  await waitUntil(async () => (await modelName()).includes(MODEL), "the box names the model of the server");

  const again = serviceWritten();
  expect(await bridge(`remove("server-1")`)).toBe(null);
  await startedAgain(again);
  await p.send("Page.navigate", { url: `${service().agent}/${b64(env.project)}/session/${id}` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="prompt-model"]')`), "the box again");
  await waitUntil(async () => (await body()).includes(`${MODEL} non è più disponibile`), "one line that says the model of the server is gone and which one takes its place");
  expect(await modelName()).not.toContain(MODEL);
  await shot("08-server-model-gone");

  const chats = engineChats().length;
  await click('[data-component="prompt-input"]', "the box");
  await p.send("Input.insertText", { text: "Are you there" });
  await click('[data-action="prompt-submit"]', "the send button");
  await waitUntil(() => engineChats().length > chats, "the message at the local engine", 90_000);
  await waitUntil(async () => (await body()).split("Here I am.").length > 1, "the answer");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
});
