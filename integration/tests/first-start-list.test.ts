// The first start when the user chooses the models from the list, in the app's real
// window (WebView2 CDP), on a computer with no model: «Scarica e comincia» with two models downloads both, one after the
// other, and says which comes next; with both paused the Home stands still with «Riprendi», which goes on with the first; the first
// model to arrive loads by itself and becomes the default, and the second one that arrives afterwards does not take its
// place. The files are real downloads from a local server standing in for Hugging Face (`MANGO_HF_URL`), served slowly.
// Fake engine, no GPU. `bun test --cwd integration tests/first-start-list.test.ts`, after `cargo build -p mango-code -p engine`
// in app/. The recommended button and what happens while the model downloads are in first-start.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const MIB = 1024 * 1024;
const content = (seed: number, size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const models: Record<string, Uint8Array> = { fake: content(1, 6 * MIB), second: content(2, 2 * MIB) };
const files = Object.fromEntries(Object.entries(models).map(([id, bytes]) => [id, { size: bytes.length, sha256: sha256(bytes) }]));

// About 0.4 MiB a second: the first file lasts about fifteen seconds, time to pause it and to go on.
const server = http.createServer((req, res) => {
  const id = /^\/test\/(\w+)\/resolve\/main\/\1\.gguf$/.exec(req.url ?? "")?.[1];
  const bytes = id ? models[id] : undefined;
  if (!bytes) return void res.writeHead(404).end("not there");
  const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
  res.writeHead(from ? 206 : 200, { "Content-Length": bytes.length - from, ...(from ? { "Content-Range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}) });
  (async () => {
    for (let i = from; i < bytes.length && !res.destroyed; i += 64 * 1024) {
      res.write(bytes.subarray(i, i + 64 * 1024));
      await Bun.sleep(150);
    }
    res.end();
  })();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}
const text = () => p.evaluate("document.body.innerText") as Promise<string>;
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const barText = () => p.evaluate(`(document.querySelector('[data-action="titlebar-model"]')?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;
const control = async () => (await fetch(`${env.engine}/control/state`)).json();
const saved = () => JSON.parse(fs.readFileSync(path.join(env.data, "choices.json"), "utf8"));

async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

beforeAll(async () => {
  env = await start([{ text: "Eccomi." }], { window: true, noModels: true, otherModels: ["second"], files, env: { MANGO_HF_URL: base } });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")} && !!document.querySelector('[data-component="mango-welcome"]')`), "the welcome on the Home", 120_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
});

test("«Scarica e comincia» of the list downloads the two models in order and says which comes next", async () => {
  await mouseClick('[data-action="mango-choose"]');
  await waitUntil(() => exists('[data-component="mango-choose-list"]'), "the list");
  await mouseClick('[data-option-key="second"] input');
  await waitUntil(async () => (await text()).includes("Scarica e comincia · 2 modelli, 8 MB"), "two models chosen");
  await mouseClick('[data-action="mango-start-chosen"]');
  await waitUntil(() => exists('[data-component="mango-downloading"]'), "the download on the Home");
  await waitUntil(async () => (await control()).downloads.length === 2, "both models in the queue");
  const downloads = (await control()).downloads as { model: string; state: string }[];
  expect(downloads.map((d) => [d.model, d.state])).toEqual([["fake", "active"], ["second", "waiting"]]);
  // the Home names the one that comes and the one that waits
  await waitUntil(async () => (await text()).includes("Dopo arriva Model second."), "the queue said on the Home");
  expect(await p.evaluate(`document.querySelector('[data-component="mango-download"] h2').innerText`)).toContain("Fake model");
  await waitUntil(async () => /^Fake model · scarico \d+%$/.test(await barText()), "the first model in the bar");
}, 90_000);

test("both paused, the Home stands still with «Riprendi», which goes on with the first one from where it was", async () => {
  const entry = async (model: string) => ((await control()).downloads as { model: string; state: string; done: number }[]).find((d) => d.model === model)!;
  // the waiting one first: the queue does not go on to it when the first one stops
  await p.evaluate(`window.__MANGO_DESKTOP__.models.pause("second")`);
  await p.evaluate(`window.__MANGO_DESKTOP__.models.pause("fake")`);
  await waitUntil(() => exists('[data-component="mango-download"][data-state="paused"]'), "the paused download on the Home");
  expect(await p.evaluate(`document.querySelector('[data-component="mango-download"] h2').innerText`)).toContain("in pausa");
  const stopped = (await entry("fake")).done;
  await Bun.sleep(1500);
  expect((await entry("fake")).done).toBe(stopped);
  await mouseClick('[data-action="mango-download-resume"]');
  await waitUntil(async () => (await entry("fake")).state === "active", "the first download going on");
  await waitUntil(() => exists('[data-component="mango-download"]:not([data-state="paused"])'), "the Home saying so");
  await waitUntil(async () => (await entry("fake")).done > stopped, "more bytes than before");
  // the other one was paused by the user and stays so
  expect((await entry("second")).state).toBe("paused");
}, 90_000);

test("the first model to arrive loads by itself and is the default; the second one does not take its place", async () => {
  await waitUntil(async () => (await control()).model.phase === "ready", "the first model ready", 120_000);
  expect((await control()).model.model).toBe("fake");
  await waitUntil(async () => (await barText()) === "Fake model", "the model in the bar");
  expect(saved().default).toBe("fake");
  // the second one goes on when the user says so, in the background, and arrives
  await p.evaluate(`window.__MANGO_DESKTOP__.models.resume("second")`);
  await waitUntil(async () => (await control()).downloads.length === 0, "the second model arrived", 120_000);
  expect(fs.statSync(path.join(env.modelsDir, "second.gguf")).size).toBe(models.second.length);
  await Bun.sleep(1500);
  expect((await control()).model).toMatchObject({ phase: "ready", model: "fake" });
  expect((await control()).default_model).toBe("fake");
  expect(saved().default).toBe("fake");
  expect(await barText()).toBe("Fake model");
}, 180_000);
