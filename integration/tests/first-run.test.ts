// The first run seen in the app's real window (WebView2 CDP): with no models or engine on disk the app shows
// the choice (the computer, the models, what does not fit), downloads from a local server with progress,
// resumes if it is closed halfway, and then starts. Afterwards the "Modelli e motore" entry goes back to the
// choice without stopping the agent. Without a window (--service) it says what is missing instead of waiting.
// The computer is fake (a `System` described by a file, app/src-tauri/src/fake.rs); the "downloaded" engine and
// models are the fake engine and empty files, served slowly from here. No GPU is used.
// `bun test integration/tests/first-run.test.ts`, after `cargo build -p mango-code -p engine` in app/.
// The screenshots stay in %TEMP%\mango-first-run-*.png.
// The window's elements are selected by the ids of app/ui (still the Italian ones).

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { start, FAKE_ENGINE_EXE, type Environment } from "./environment";
import { launch, notReady } from "../client/mango-code";
import { page, type Page } from "./cdp";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A file served in pieces with a pause between one and the next, so the progress shows. With its declared
 *  length (`Content-Length`), like real servers do: `Bun.serve` with a stream removes it. */
function slow(res: http.ServerResponse, content: Uint8Array, piece: number, pauseMs: number) {
  res.writeHead(200, { "Content-Length": content.length });
  (async () => {
    for (let i = 0; i < content.length && !res.destroyed; i += piece) {
      res.write(content.subarray(i, i + piece));
      await Bun.sleep(pauseMs);
    }
    res.end();
  })();
}

const fakeEngineBytes = new Uint8Array(fs.readFileSync(FAKE_ENGINE_EXE));
const server = http.createServer((req, res) => {
  if (req.url === "/engine") slow(res, fakeEngineBytes, 32 * 1024, 60);
  else if (req.url === "/fake.gguf") slow(res, new Uint8Array(24 * MIB), 256 * 1024, 50);
  else if (req.url === "/second.gguf") slow(res, new Uint8Array(12 * MIB), 256 * 1024, 40);
  else res.writeHead(404).end("not there");
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

/** The computer of whoever installs: a small card, 16 GB, and three models: one on the card, one on the processor, one
 *  that does not fit. */
const fakeComputer = () => ({
  computer: { gpus: [{ name: "NVIDIA GeForce GTX 1060", memory_mib: 6144 }], cpu: "Intel Core i5-10400", cores: 6, ram_mib: 16384 },
  general: "llamacpp",
  engines: [{ name: "llamacpp", build: "cuda-12", bytes: fakeEngineBytes.length, file: path.join("llamacpp", "fake-cuda-12", "llama-server.exe"), url: `${base}/engine` }],
  models: [
    { key: "fake", label: "Fake model", images: false, file: "fake.gguf", url: `${base}/fake.gguf`, engine: "llamacpp", profile: null },
    { key: "second", label: "Second fake model", images: true, file: "second.gguf", url: `${base}/second.gguf`, engine: "llamacpp", profile: "test/second" },
    { key: "huge", label: "Huge 70-billion model", images: false, file: "huge.gguf", url: `${base}/huge.gguf`, engine: "llamacpp", profile: null },
  ],
  recommendations: [
    { model: "fake", placement: "gpu", context: 16384, reason: "Sta tutto nella memoria della scheda video.", bytes: 24 * MIB, fastest: true },
    { model: "second", placement: "cpu", context: 32768, reason: "Nelle schede video non ci sta: gira sul processore, più lento.", bytes: 12 * MIB, speed: "slow" },
    { model: "huge", placement: null, context: 0, reason: "servono 43 GB di memoria e le schede ne hanno 6.", bytes: 41 * GIB },
  ],
});

const screenshot = async (p: Page, name: string) => {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), `mango-first-run-${name}.png`), Buffer.from(r.result.data, "base64"));
  // With `MC_PHOTOS=<folder>` the choice page is also saved at 860 px and 390 px wide.
  if (!process.env.MC_PHOTOS || name !== "1-choice") return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  for (const [width, height] of [[860, 1100], [390, 1400]]) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(600);
    const shot = await p.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.MC_PHOTOS, `pagina-modelli-${width}.png`), Buffer.from(shot.result.data, "base64"));
  }
  await p.send("Emulation.clearDeviceMetricsOverride");
};

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(300);
  }
}

const appWindow = (t: { url: string }) => t.url.includes("tauri.localhost") || t.url.startsWith("tauri://");
const visible = (id: string) => `!document.getElementById('${id}').hidden`;

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const ready = (env: Environment) => {
  const f = path.join(env.data, "service.json");
  if (!fs.existsSync(f)) return false;
  const s = readJson(f);
  if (s.reason !== undefined) return false;
  env.agent = s.agent;
  env.engine = s.engine;
  return true;
};

const opened: Environment[] = [];
afterAll(async () => {
  server.close();
  for (const e of opened) e.close();
  await Bun.sleep(2000);
  for (const e of opened) {
    try {
      fs.rmSync(e.root, { recursive: true, force: true });
    } catch {}
  }
}, 30_000);

async function withWindow() {
  const env = await start([{ text: "Here I am." }], { window: true, firstRun: fakeComputer });
  opened.push(env);
  const p = await page(env.cdp!, appWindow, 120_000);
  return { env, p };
}

// --- the choice, the download, the start; then "Modelli e motore" ---------------------------------------------

let env: Environment;
let p: Page;

beforeAll(async () => {
  ({ env, p } = await withWindow());
}, 200_000);

test("without engine or models the window shows the choice: the computer, where each model runs and why one does not fit", async () => {
  await waitUntil(() => p.evaluate(visible("choice")), "the choice page");
  const text: string = await p.evaluate(`document.getElementById('choice').innerText`);
  expect(text).toContain("NVIDIA GeForce GTX 1060");
  expect(text).toContain("6 GB");
  expect(text).toContain("Intel Core i5-10400");
  expect(text).toContain("llama.cpp per le schede NVIDIA (CUDA 12)");
  expect(text).toContain("Ottimizzata per il tuo computer");
  expect(text).toContain("Fake model");
  expect(text).toContain("Consigliato");
  expect(text).toContain("Ottimizzato");
  expect(text).toContain("Non ci sta in questo computer: servono 43 GB di memoria e le schede ne hanno 6.");
  expect(text).toContain("Sulla scheda video · 16k di contesto");
  // on the processor the page says how slow, in words of a user and not in tokens
  expect(text).toContain("Sul processore · lento: una o due parole al secondo · 32k di contesto");
  expect(text).not.toContain("token");
  expect(text).toContain("Probabilmente il più veloce");
  expect(text).toContain("Per ottimizzare Mango Code su questo computer, usa un'AI di frontiera (per esempio Claude Code) con la skill di ottimizzazione inclusa");
  expect(await p.evaluate(`document.getElementById('optimize-folder').innerText`)).toMatch(/optimize$/);
  // On the processor you can choose, written prominently; the one that fits nowhere you cannot.
  expect(await p.evaluate(`document.querySelector('input[value=second]').disabled`)).toBe(false);
  expect(await p.evaluate(`document.querySelector('input[value=second]').closest('li').querySelector('.where.cpu') !== null`)).toBe(true);
  expect(await p.evaluate(`document.querySelector('input[value=huge]').disabled`)).toBe(true);
  expect(await p.evaluate(`document.querySelector('input[value=fake]').checked`)).toBe(true);
  expect(await p.evaluate(`document.querySelector('input[value=second]').checked`)).toBe(false);
  // To download: the model's 24 MiB and the engine (a little over a mebibyte).
  expect(await p.evaluate(`document.getElementById('summary').innerText`)).toMatch(/^Da scaricare: \d+ MB$/);
  // Whoever has no window in front finds written why the app is not ready yet.
  expect(readJson(path.join(env.data, "service.json")).reason).toContain("scelgano i modelli");
  await screenshot(p, "1-choice");
  // With no model ticked you cannot go on.
  await p.evaluate(`document.querySelector('input[value=fake]').click()`);
  expect(await p.evaluate(`document.getElementById('start-download').disabled`)).toBe(true);
  await p.evaluate(`document.querySelector('input[value=fake]').click()`);
  expect(await p.evaluate(`document.getElementById('start-download').disabled`)).toBe(false);
}, 120_000);

test("the versions of a model found online are small, medium or large, with the speed on the processor; their names are in the technical details", async () => {
  // what the app says about a repository with three quantizations on this fake computer (no network)
  const analysis = {
    name: "Llama-3.3-70B", source: "hugging-face", gated: false, warnings: [],
    variants: [
      { name: "IQ1_M", key: "a", bytes: 16 * GIB, placement: "cpu", speed: "very_slow", reason: "Ci sta nella RAM.", recommended: false },
      { name: "IQ3_M", key: "b", bytes: 29 * GIB, placement: "cpu", speed: "very_slow", reason: "Ci sta nella RAM.", recommended: true },
      { name: "Q8_0", key: "c", bytes: 70 * GIB, placement: null, speed: null, reason: "non ci sta", recommended: false },
    ],
  };
  await p.evaluate(`showAnalysis(${JSON.stringify(analysis)}, "unsloth/Llama-3.3-70B-GGUF")`);
  const rows: string[] = await p.evaluate(`[...document.querySelectorAll('#other-variants li')].map((li) => li.textContent)`);
  expect(rows[0]).toContain("piccolo");
  expect(rows[1]).toContain("medio");
  expect(rows[2]).toContain("grande");
  expect(rows[1]).toContain("Sul processore · molto lento: meno di una parola al secondo");
  expect(rows[2]).toContain("Non ci sta in questo computer");
  // the names of the versions are not in the list, only in the technical details
  for (const name of ["IQ1_M", "IQ3_M", "Q8_0"]) expect(rows.join(" "), name).not.toContain(name);
  const details = await p.evaluate(`document.getElementById('other-quants').textContent`);
  expect(details).toContain("IQ3_M");
  expect(await p.evaluate(`document.getElementById('other-quants').open`)).toBe(false);
  if (process.env.MC_PHOTOS) {
    await p.evaluate(`document.getElementById('other-detail').scrollIntoView()`);
    for (const [width, height] of [[860, 900], [390, 1100]]) {
      await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await Bun.sleep(600);
      await p.evaluate(`document.getElementById('other-detail').scrollIntoView()`);
      const shot = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.MC_PHOTOS, `altri-modelli-${width}.png`), Buffer.from(shot.result.data, "base64"));
    }
    await p.send("Emulation.clearDeviceMetricsOverride");
  }
  await p.evaluate(`closeAnalysis()`);
}, 60_000);

test("it downloads with progress, then the app starts as usual", async () => {
  await p.evaluate(`document.getElementById('start-download').click()`);
  await waitUntil(() => p.evaluate(visible("download")), "the download page");
  expect(await p.evaluate(`document.getElementById('download-title').innerText`)).toBe("Scarico quello che serve");
  await waitUntil(() => p.evaluate(`document.getElementById('download-steps').innerText.includes('%')`), "the progress in percent");
  // A few seconds in, the speed and the time left (the fake server sends about 5 MB/s).
  await waitUntil(() => p.evaluate(`/ MB\\/s · (meno di un minuto|circa)/.test(document.getElementById('download-steps').innerText)`), "the speed and the time left");
  const steps: string = await p.evaluate(`document.getElementById('download-steps').innerText`);
  expect(steps).toContain("Motore: llama.cpp per le schede NVIDIA (CUDA 12)");
  expect(steps).toContain("Fake model");
  await screenshot(p, "2-download");
  expect(fs.existsSync(path.join(env.data, "first-run.json"))).toBe(true);

  await waitUntil(() => ready(env), "the app ready after the download", 120_000);
  expect(fs.existsSync(path.join(env.modelsDir, "fake.gguf"))).toBe(true);
  expect(fs.statSync(path.join(env.modelsDir, "fake.gguf")).size).toBe(24 * MIB);
  expect(fs.statSync(path.join(env.enginesDir, "llamacpp", "fake-cuda-12", "llama-server.exe")).size).toBe(fakeEngineBytes.length);
  expect(fs.existsSync(path.join(env.data, "first-run.json"))).toBe(false);
  await waitUntil(() => p.evaluate(`location.href.startsWith('${env.agent}')`), "the window on the web UI");
}, 200_000);

test("\"Modelli e motore\" goes back to the choice without stopping the agent; Cancel returns to where it was", async () => {
  await p.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => p.evaluate(visible("choice")), "the choice reopened");
  expect(await p.evaluate(`document.getElementById('choice-title').innerText`)).toBe("Modelli e motore");
  expect(await p.evaluate(`!document.getElementById('cancel').hidden`)).toBe(true);
  const text: string = await p.evaluate(`document.getElementById('models').innerText`);
  expect(text).toContain("Già sul computer");
  // The one already downloaded is no longer proposed: the recommended one is the other.
  expect(await p.evaluate(`document.querySelector('input[value=fake]').checked`)).toBe(false);
  expect(await p.evaluate(`document.querySelector('input[value=second]').checked`)).toBe(true);
  await screenshot(p, "3-change");
  // The agent stayed on while the choice was shown.
  expect((await fetch(`${env.agent}/global/health`)).ok).toBe(true);
  await p.evaluate(`document.getElementById('cancel').click()`);
  await waitUntil(() => p.evaluate(`location.href.startsWith('${env.agent}')`), "the return to the web UI");
  expect(fs.existsSync(path.join(env.modelsDir, "second.gguf"))).toBe(false);
}, 120_000);

test("choosing another model downloads it and the agent restarts knowing it", async () => {
  await p.evaluate(`window.__MANGO_DESKTOP__.openModels()`);
  await waitUntil(() => p.evaluate(visible("choice")), "the choice reopened");
  await p.evaluate(`document.getElementById('start-download').click()`);
  await waitUntil(() => p.evaluate(visible("download")), "the second model's download");
  await waitUntil(() => p.evaluate(`location.href.startsWith('${env.agent}')`), "the window back on the web UI", 120_000);
  expect(fs.statSync(path.join(env.modelsDir, "second.gguf")).size).toBe(12 * MIB);
  // The restarted agent offers the new model.
  let provider = "";
  await waitUntil(async () => {
    provider = await (await fetch(`${env.agent}/config/providers`)).text();
    return provider.includes("Second fake model");
  }, "the second model among the agent's");
  expect(provider).toContain("Fake model");
}, 240_000);

// --- it resumes if it is closed halfway ----------------------------------------------------------------------

test("with the app closed halfway through the download, at the next start it resumes by itself", async () => {
  const { env: e, p: pg } = await withWindow();
  await waitUntil(() => pg.evaluate(visible("choice")), "the choice");
  await pg.evaluate(`document.getElementById('start-download').click()`);
  await waitUntil(() => pg.evaluate(`document.getElementById('download-steps').innerText.includes('%')`), "the progress");
  expect(fs.existsSync(path.join(e.data, "first-run.json"))).toBe(true);
  pg.close();
  await e.restart();
  await Bun.sleep(1500);
  const pg2 = await page(e.cdp!, appWindow, 120_000);
  // No choice: the download starts again with the same models.
  await waitUntil(() => pg2.evaluate(visible("download")), "the download resumed");
  expect(await pg2.evaluate(`document.getElementById('download-title').innerText`)).toBe("Riprendo lo scaricamento");
  await screenshot(pg2, "4-resume");
  await waitUntil(() => ready(e), "the app ready after the resume", 120_000);
  expect(fs.statSync(path.join(e.modelsDir, "fake.gguf")).size).toBe(24 * MIB);
  pg2.close();
}, 300_000);

// --- a download that fails ----------------------------------------------------------------------------------

test("a download that fails shows the error page: the report includes the screenshot only if the switch stays on", async () => {
  const broken = () => ({
    ...fakeComputer(),
    models: fakeComputer().models.map((m) => (m.key === "fake" ? { ...m, url: `${base}/missing.gguf` } : m)),
  });
  const e = await start([{ text: "Here I am." }], { window: true, firstRun: broken });
  opened.push(e);
  const pg = await page(e.cdp!, appWindow, 120_000);
  await waitUntil(() => pg.evaluate(visible("choice")), "the choice");
  await pg.evaluate(`document.getElementById('start-download').click()`);
  await waitUntil(() => pg.evaluate(visible("error")), "the error page", 120_000);
  const row = `document.getElementById('report-screenshot-row')`;
  expect(await pg.evaluate(`getComputedStyle(${row}).display !== 'none'`)).toBe(true);
  expect(await pg.evaluate(`document.getElementById('report-screenshot').checked`)).toBe(true);
  expect(await pg.evaluate(`${row}.innerText`)).toContain("Includi una schermata della finestra");
  await screenshot(pg, "5-error");
  pg.close();
}, 200_000);

// --- without a window ---------------------------------------------------------------------------------------

test("with --service, without models, it says what is missing and other apps read it at once", async () => {
  const e = await start([{ text: "Here I am." }], { firstRun: fakeComputer });
  opened.push(e);
  const serviceFile = path.join(e.data, "service.json");
  await waitUntil(() => fs.existsSync(serviceFile), "the service file");
  const s = readJson(serviceFile);
  expect(s.agent).toBeUndefined();
  expect(s.reason).toContain("senza finestra");
  expect(s.reason).toContain("Non c'è ancora nessun modello");
  expect(s.reason).toContain("Riprova");
  expect(notReady(e.data)).toBe(s.reason);
  expect(fs.readFileSync(path.join(e.data, "logs", "startup.log"), "utf8")).toContain("Non c'è ancora nessun modello");
  // The client does not wait five minutes: it reads the reason at once (the executable started does nothing).
  const t0 = Date.now();
  await expect(launch({ exe: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), dataDir: e.data })).rejects.toThrow("Mango Code is not ready");
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 120_000);
