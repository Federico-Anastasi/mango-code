// Downloading models in the background, from the app's real window (WebView2 CDP) through the bridge's `models`
// commands: the download runs while the app is in use, with progress and speed in the control server's state; the first
// model that arrives loads by itself; a paused download keeps what arrived, also across a restart of the app, and goes
// on from there; a cancelled one leaves nothing; one interrupted by closing the app goes on at the next start; a model
// taken off the computer while it downloads leaves nothing either.
// The files are real downloads from a local server standing in for Hugging Face (`MANGO_HF_URL`), served slowly.
// Fake engine, no GPU. `bun test --cwd integration tests/downloads.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";
import { resizeWindow } from "./window";

const MIB = 1024 * 1024;
/** The content of a model's file: different for each model, so a file is never taken for another. */
const content = (seed: number, size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const models: Record<string, Uint8Array> = { fake: content(1, 6 * MIB), second: content(2, 6 * MIB), third: content(3, 6 * MIB), fourth: content(4, 2 * MIB), fifth: content(5, 6 * MIB) };
const files = Object.fromEntries(Object.entries(models).map(([id, bytes]) => [id, { size: bytes.length, sha256: sha256(bytes) }]));
// `broken` is in the catalog, but the server does not have its file.
files.broken = { size: MIB, sha256: "1".repeat(64) };

/** The requests the server received: the path and the `Range` header. */
const requests: { path: string; range?: string }[] = [];
const server = http.createServer((req, res) => {
  requests.push({ path: req.url ?? "", range: req.headers.range });
  const id = /^\/test\/(\w+)\/resolve\/main\/\1\.gguf$/.exec(req.url ?? "")?.[1];
  const bytes = id ? models[id] : undefined;
  if (!bytes) return void res.writeHead(404).end("not there");
  const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
  res.writeHead(from ? 206 : 200, { "Content-Length": bytes.length - from, ...(from ? { "Content-Range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}) });
  // About 1.3 MiB a second: slow enough to see the progress, to pause and to close the app halfway.
  (async () => {
    for (let i = from; i < bytes.length && !res.destroyed; i += 64 * 1024) {
      res.write(bytes.subarray(i, i + 64 * 1024));
      await Bun.sleep(50);
    }
    res.end();
  })();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}

let env: Environment;
let p: Page;

const state = async () => (await fetch(`${env.engine}/control/state`)).json();
const downloads = async () => (await state()).downloads as { model: string; label: string; state: string; done: number; total: number; bytes_per_second: number; error: string | null }[];
/** A command of the bridge's `models`, from the window: "ok", or what it was rejected with. */
const ask = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.models.${call}.then(() => "ok", (e) => JSON.stringify(e))`) as Promise<string>;
/** The same, with what the command answered, as JSON. */
const answer = (call: string) => p.evaluate(`window.__MANGO_DESKTOP__.models.${call}.then((v) => JSON.stringify(v ?? null), (e) => "rejected " + JSON.stringify(e))`) as Promise<string>;
const file = (id: string) => path.join(env.modelsDir, `${id}.gguf`);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

async function windowOnTheHome() {
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
}

/** Closes the app and starts it again on the same folders; the window is on the home again. */
async function restart() {
  const serviceFile = path.join(env.data, "service.json");
  const closed = readJson(serviceFile).pid;
  p.close();
  await env.restart();
  await waitUntil(() => fs.existsSync(serviceFile) && readJson(serviceFile).pid !== closed, "the service file of the new start");
  await windowOnTheHome();
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, noModels: true, otherModels: ["second", "third", "fourth", "broken", "fifth"], files, env: { MANGO_HF_URL: base } });
  await windowOnTheHome();
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
});

const catalog = async () => (await (await fetch(`${env.engine}/control/models`)).json()).models as any[];

test("the control server lists the models of the catalog with what a download brings, and the computer", async () => {
  const listed = await catalog();
  expect(listed.map((m) => m.key)).toEqual(["fake", "second", "third", "fourth", "broken", "fifth"]);
  const [fake, second] = listed;
  expect(fake).toMatchObject({ label: "Fake model", user: false, present: false, bytes: models.fake.length, on_request: false });
  expect(fake.verdict.fits).toBe(true);
  expect(fake.verdict.where.context).toBe(16384);
  expect(fake.choices).toMatchObject({ where: "auto", context: null, style: "recommended", reasoning: null });
  // With nothing on disk the first model that fits is the one to propose, and only that one.
  expect(listed.filter((m) => m.recommended).map((m) => m.key)).toEqual(["fake"]);
  expect(second.present).toBe(false);

  const computer = await (await fetch(`${env.engine}/control/computer`)).json();
  expect(computer.cpu.length).toBeGreaterThan(0);
  expect(computer.ram_mib).toBeGreaterThan(0);
  expect(computer.disk.path).toBe(env.modelsDir);
  expect(computer.disk.free_bytes).toBeGreaterThan(0);
  expect(computer.engine.installed).toBe(true);
  expect(computer.small_models).toBe("one");
}, 60_000);

test("the link of a catalog model's repo, in «Un altro modello», leads to that model without asking Hugging Face", async () => {
  const asked = requests.length;
  const found = (text: string) => p.evaluate(`window.__MANGO_DESKTOP__.otherModels.search(${JSON.stringify(text)}).then((v) => JSON.stringify(v), (e) => "rejected " + JSON.stringify(e))`) as Promise<string>;
  for (const text of ["https://huggingface.co/test/second", "Test/Second", "https://huggingface.co/test/second/tree/main"])
    expect(JSON.parse(await found(text)), text).toEqual({ type: "tested", key: "second", label: expect.any(String) });
  expect(requests.length).toBe(asked);
  // a link to a file, a quantization or another branch asks for something the catalog does not have: it is looked up
  for (const text of ["https://huggingface.co/test/second/blob/main/second.gguf", "hf.co/test/second:Q8_0", "https://huggingface.co/test/second/tree/other"]) {
    const before = requests.length;
    expect(await found(text), text).not.toContain('"type":"tested"');
    expect(requests.length, text).toBeGreaterThan(before);
  }
}, 60_000);

test("«Vai al modello» brings the tested model's row into view, also a second time", async () => {
  await resizeWindow(env.app.pid!, p, 900, 400);
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=models` });
  const box = '[data-action="settings-other-model-search"] input';
  await waitUntil(() => p.evaluate(`!!document.querySelector(${JSON.stringify(box)})`), "the box of «Un altro modello»");
  await p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(box)});
    el.value = "https://huggingface.co/test/second";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.closest("form").requestSubmit();
  })()`);
  const go = '[data-action="settings-other-model-tested"]';
  await waitUntil(() => p.evaluate(`!!document.querySelector(${JSON.stringify(go)})`), "«Vai al modello»");
  const rowInView = `(() => {
    const r = document.querySelector('[data-model-row="second"]')?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.bottom <= innerHeight;
  })()`;
  const rowHidden = `(() => {
    const r = document.querySelector('[data-model-row="second"]').getBoundingClientRect();
    return r.bottom <= 0 || r.top >= innerHeight;
  })()`;
  for (const time of ["first", "second"]) {
    // the box at the top of the view, the row above it and out of view: the six rows and the box fit in 500 px
    await p.evaluate(`document.querySelector(${JSON.stringify(box)}).scrollIntoView({ block: "start" })`);
    await waitUntil(() => p.evaluate(rowHidden), `the row out of view (${time})`, 5000);
    await p.evaluate(`document.querySelector(${JSON.stringify(go)}).click()`);
    await waitUntil(() => p.evaluate(rowInView), `the row in view (${time})`, 5000);
  }
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the home");
}, 60_000);

test("a model asked from the window downloads while the app is in use, and loads by itself when it arrives", async () => {
  expect(await state()).toMatchObject({ model: { phase: "none" }, default_model: null, downloads: [] });
  const before = (await state()).catalog_revision;
  expect(await ask(`download(["fake"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.done > 0 && (await downloads())[0].bytes_per_second > 0, "bytes arriving, with a speed");
  const [d] = await downloads();
  expect(d).toMatchObject({ model: "fake", label: "Fake model", state: "active", total: models.fake.length, error: null });
  expect(d.done).toBeLessThan(d.total);
  // The window stays where it was: nothing waits for the download.
  expect(await p.evaluate("location.pathname")).toBe("/");
  expect((await fetch(`${env.agent}/global/health`)).ok).toBe(true);

  await waitUntil(async () => (await downloads()).length === 0, "the download ended");
  expect(sha256(new Uint8Array(fs.readFileSync(file("fake"))))).toBe(files.fake.sha256);
  // The catalog changed, and the only model on the computer is loaded without anybody asking.
  await waitUntil(async () => (await state()).model.phase === "ready", "the downloaded model loaded");
  expect(await state()).toMatchObject({ model: { model: "fake" }, default_model: "fake" });
  // The first model on the computer is saved as the default: a model that arrives later does not take its place.
  expect(readJson(path.join(env.data, "choices.json")).default).toBe("fake");
  expect((await state()).catalog_revision).toBeGreaterThan(before);
  // The catalog read again says so: the model is there, and the one to propose is the next.
  const listed = await catalog();
  expect(listed[0]).toMatchObject({ key: "fake", present: true, recommended: false });
  expect(listed.filter((m) => m.recommended).map((m) => m.key)).toEqual(["second"]);
  expect(fs.readFileSync(path.join(env.data, "downloads.json"), "utf8").replace(/\s/g, "")).toBe("[]");
  // The agent learns the model of new conversations without starting again: the app wrote `opencode.json` again and asked
  // it to read it (`POST /mango/reload`).
  expect(readJson(path.join(env.data, "opencode-home", "opencode.json")).model).toBe("mango/fake");
  await waitUntil(async () => (await (await fetch(`${env.agent}/config`)).json()).model === "mango/fake", "the agent read its configuration again");
}, 120_000);

test("a paused download keeps what arrived, also when the app is closed and opened again, and goes on from there", async () => {
  expect(await ask(`download(["second", "third"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.done > MIB, "a part of the model arrived");
  expect((await downloads()).map((d) => [d.model, d.state])).toEqual([["second", "active"], ["third", "waiting"]]);
  expect(await ask(`pause("third")`)).toBe("ok");
  expect(await ask(`pause("second")`)).toBe("ok");
  await waitUntil(async () => (await downloads()).every((d) => d.state === "paused" && d.bytes_per_second === 0), "both paused");
  await Bun.sleep(500);
  const arrived = fs.statSync(`${file("second")}.part`).size;
  expect(arrived).toBeGreaterThan(MIB);
  expect(arrived).toBeLessThan(models.second.length);
  expect(fs.existsSync(file("second"))).toBe(false);
  // The model in use was not touched.
  expect((await state()).model).toMatchObject({ phase: "ready", model: "fake" });
  // The top bar names only the model in use; its menu lists the downloads under the models, and each leads to its row.
  const bar = '[data-action="titlebar-model"]';
  await waitUntil(async () => (await p.evaluate(`document.querySelector(${JSON.stringify(bar)})?.innerText.trim()`)) === "Fake model", "the model in use in the bar");
  const rows = `[...document.querySelectorAll('[role="menu"] [data-action="mango-arriving"]')]`;
  const at = (selector: string) => p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  const click = async (selector: string) => {
    const point = await at(selector);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  };
  await click(bar);
  await waitUntil(async () => (await p.evaluate(`${rows}.length`)) === 2, "the downloads in the bar's menu");
  expect(await p.evaluate(`${rows}.map((r) => [r.dataset.optionKey, r.innerText.replace(/\\s+/g, " ").trim()])`)).toEqual([
    ["second", expect.stringMatching(/^In arrivo: .+ in pausa$/)],
    ["third", expect.stringMatching(/^In arrivo: .+ in pausa$/)],
  ]);
  await click('[role="menu"] [data-action="mango-arriving"][data-option-key="second"]');
  await waitUntil(() => p.evaluate(`location.pathname === "/settings" && !!document.querySelector('[data-download-row="second"]')`), "the download's row in Models");

  await restart();
  expect((await downloads()).map((d) => [d.model, d.state])).toEqual([["second", "paused"], ["third", "paused"]]);
  expect(fs.statSync(`${file("second")}.part`).size).toBe(arrived);

  const seen = requests.length;
  expect(await ask(`resume("second")`)).toBe("ok");
  await waitUntil(async () => !(await downloads()).some((d) => d.model === "second"), "the resumed download ended");
  // It asked the server only for what was missing.
  expect(requests.slice(seen)).toEqual([{ path: "/test/second/resolve/main/second.gguf", range: `bytes=${arrived}-` }]);
  expect(sha256(new Uint8Array(fs.readFileSync(file("second"))))).toBe(files.second.sha256);
  expect((await downloads()).map((d) => [d.model, d.state])).toEqual([["third", "paused"]]);
}, 200_000);

test("a cancelled download leaves nothing behind, whether it was paused or running", async () => {
  expect(await ask(`cancel("third")`)).toBe("ok");
  expect(await downloads()).toEqual([]);
  expect(await ask(`download(["third"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.done > MIB, "a part of the model arrived");
  expect(fs.existsSync(`${file("third")}.part`)).toBe(true);
  expect(await ask(`cancel("third")`)).toBe("ok");
  await waitUntil(async () => (await downloads()).length === 0 && !fs.existsSync(`${file("third")}.part`), "the partial file gone");
  expect(fs.existsSync(file("third"))).toBe(false);
  expect(readJson(path.join(env.data, "downloads.json"))).toEqual([]);
}, 120_000);

test("a model that cannot be downloaded is refused with a sentence, and a download that fails says so and can be tried again", async () => {
  const unknown = JSON.parse(await ask(`download(["ghost"])`));
  expect(unknown.code).toBe("refused");
  expect(unknown.message).toBe("Questo modello non è nel catalogo.");
  const already = JSON.parse(await ask(`download(["fake"])`));
  expect(already.message).toContain("è già sul computer");
  expect(await downloads()).toEqual([]);

  expect(await ask(`download(["broken", "fourth"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.state === "failed", "the failed download");
  const [failed] = await downloads();
  expect(failed.model).toBe("broken");
  // The server answers 404: a sentence with the model's name that says so; the address and the answer go to the log.
  expect(failed.error).toBe("Il server non dà i file di «Model broken». Riprova più tardi.");
  // The one after it went on all the same.
  await waitUntil(async () => fs.existsSync(file("fourth")), "the next download");
  expect(await ask(`cancel("broken")`)).toBe("ok");
  expect(await downloads()).toEqual([]);
}, 120_000);

test("a download interrupted by closing the app goes on by itself at the next start", async () => {
  expect(await ask(`download(["third"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.done > MIB, "a part of the model arrived");
  const seen = requests.length;
  await restart();
  await waitUntil(async () => fs.existsSync(file("third")), "the download ended after the restart");
  const [resumed] = requests.slice(seen);
  expect(resumed.path).toBe("/test/third/resolve/main/third.gguf");
  expect(Number(/^bytes=(\d+)-$/.exec(resumed.range ?? "")?.[1])).toBeGreaterThan(MIB);
  expect(sha256(new Uint8Array(fs.readFileSync(file("third"))))).toBe(files.third.sha256);
  await waitUntil(async () => (await downloads()).length === 0, "the queue empty");
}, 200_000);

test("a model taken off the computer while it downloads stops its download and leaves nothing of it", async () => {
  expect(await ask(`download(["fifth"])`)).toBe("ok");
  await waitUntil(async () => (await downloads())[0]?.done > MIB, "a part of the model arrived");
  // The removal answers once the download has stopped and its partial file is gone; nothing of the user's stays.
  expect(await answer(`remove("fifth")`)).toBe("null");
  expect(await downloads()).toEqual([]);
  expect(fs.existsSync(`${file("fifth")}.part`)).toBe(false);
  expect(fs.existsSync(file("fifth"))).toBe(false);
  expect((await catalog()).find((m) => m.key === "fifth").present).toBe(false);
  expect(readJson(path.join(env.data, "downloads.json"))).toEqual([]);
}, 120_000);

test("a removal that stops halfway says so, and the interface is told all the same", async () => {
  // A folder where the partial file of the model would be: it cannot be removed as a file, after the note of the hash.
  const part = `${file("fourth")}.part`;
  fs.mkdirSync(part);
  const before = (await state()).catalog_revision;
  const refused = JSON.parse(await ask(`remove("fourth")`));
  expect(refused.code).toBe("refused");
  expect((await state()).catalog_revision).toBeGreaterThan(before);
  expect(fs.existsSync(`${file("fourth")}.verified`)).toBe(false);
  expect(fs.existsSync(file("fourth"))).toBe(true);
  fs.rmdirSync(part);
  expect(await answer(`remove("fourth")`)).toBe("null");
  expect(fs.existsSync(file("fourth"))).toBe(false);
}, 120_000);
