// A move of the models folder that is cancelled while it runs gives everything back: the engine loads its model again, the
// download that was held goes on to its end, the folder stays the one it was and no journal is left behind. From the app's
// real window through the bridge's `modelsDir` commands; the download is real, from a local server standing in for Hugging Face
// (`MANGO_HF_URL`), served slowly. Fake engine, no GPU. Run under off-screen:
// `off-screen bun test --cwd integration tests/models-cancel.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const MIB = 1024 * 1024;
const bytes = Uint8Array.from({ length: 6 * MIB }, (_, i) => (i * 31 + 2) % 251);
const files = { second: { size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") } };

const server = http.createServer((req, res) => {
  if (req.url !== "/test/second/resolve/main/second.gguf") return void res.writeHead(404).end("not there");
  res.writeHead(200, { "Content-Length": bytes.length });
  // About 1.3 MiB a second: the download is still running when the move begins.
  (async () => {
    for (let i = 0; i < bytes.length && !res.destroyed; i += 64 * 1024) {
      res.write(bytes.subarray(i, i + 64 * 1024));
      await Bun.sleep(50);
    }
    res.end();
  })();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

let env: Environment;
let p: Page;

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const serviceFile = () => path.join(env.data, "service.json");

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 90_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}

/** A command of the bridge's `modelsDir`: what it answered as JSON, or "rejected" and what it was rejected with. */
const dir = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.modelsDir.${call}.then((v) => JSON.stringify(v ?? null), (e) => "rejected " + JSON.stringify(e))`) as Promise<string>;
const moving = async () => JSON.parse(await dir("state()")).moving;
const running = async () => (await (await fetch(`${env.engine}/engine`)).json()).phase === "running";
const downloads = async () => ((await (await fetch(`${env.engine}/control/state`)).json()).downloads ?? []) as { model: string; state: string; done: number }[];
/** How many times the fake engine was started. */
const engineStarts = () => (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).length : 0);

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, freeModelsFolder: true, otherModels: ["second"], files, env: { MANGO_HF_URL: base } });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
  // The file of the second model the environment wrote is a stub of another size: the model is downloaded in full.
  fs.rmSync(path.join(env.modelsDir, "second.gguf"));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
});

test("a move cancelled while it runs gives the engine and the downloads back, and leaves the folder as it was", async () => {
  await waitUntil(async () => (await running()) && (await p.evaluate(`window.__MANGO_DESKTOP__.models.download(["second"]).then(() => "ok", (e) => JSON.stringify(e))`)) === "ok", "the download queued");
  await waitUntil(async () => (await downloads()).some((d) => d.model === "second" && d.state === "active" && d.done > 0), "the download running");
  const pid = readJson(serviceFile()).pid;
  const target = path.join(env.root, "somewhere else");
  const before = engineStarts();

  expect(await dir(`move(${JSON.stringify(target)})`)).toBe("null");
  expect(await dir("cancel()")).toBe("null");
  await waitUntil(async () => (await moving()).status === "cancelled", "the move cancelled");

  await waitUntil(running, "the model loaded again");
  expect(engineStarts(), "the engine started again").toBeGreaterThan(before);
  await waitUntil(() => fs.existsSync(path.join(env.modelsDir, "second.gguf")) && fs.statSync(path.join(env.modelsDir, "second.gguf")).size === bytes.length, "the download finished", 60_000);
  expect(fs.statSync(path.join(env.modelsDir, "second.gguf")).size).toBe(bytes.length);

  expect(fs.existsSync(target), "the folder the move made is gone").toBe(false);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
  expect(fs.existsSync(path.join(env.data, "models-move.json")), "no journal for the next start to finish").toBe(false);
  expect(JSON.parse(await dir("state()"))).toMatchObject({ path: env.modelsDir, chosen: false });
  expect(readJson(serviceFile()).pid, "the app did not start again").toBe(pid);
  expect(await dir("cancel()"), "nothing moves any more").toStartWith("rejected");
}, 200_000);
