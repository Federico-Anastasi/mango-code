// Settings › Models in the app's real window (WebView2 CDP), with the mouse, on a computer with several models: the three
// lists (on the computer, on their way, tested ones to download), the choices of a model (where it runs, how much it
// remembers, whether it reasons) saved and read back, the default, a download started from the page with Pause, Resume
// and Cancel, «Togli dal computer» confirmed in the window, and «Un altro modello» with a GGUF file chosen in the Windows
// dialog. The link to a repo of the catalog is in downloads.test.ts, the style of the answers in settings-page.test.ts.
// The third model's file is a real download from a local server standing in for Hugging Face (`MANGO_HF_URL`), served
// slowly. Fake engine, no GPU. `bun test --cwd integration tests/settings-models.test.ts`, after `cargo build -p mango-code
// -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { answer } from "./dialog";
import { start, type Environment } from "./environment";

const MIB = 1024 * 1024;
const third = Uint8Array.from({ length: 3 * MIB }, (_, i) => (i * 31 + 3) % 251);
const files = { third: { size: third.length, sha256: new Bun.CryptoHasher("sha256").update(third).digest("hex") } };

// About 0.4 MiB a second: seven seconds for the file, time to pause it and to go on.
const server = http.createServer((req, res) => {
  if (!/^\/test\/third\/resolve\/main\/third\.gguf$/.test(req.url ?? "")) return void res.writeHead(404).end("not there");
  const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
  res.writeHead(from ? 206 : 200, { "Content-Length": third.length - from, ...(from ? { "Content-Range": `bytes ${from}-${third.length - 1}/${third.length}` } : {}) });
  (async () => {
    for (let i = from; i < third.length && !res.destroyed; i += 64 * 1024) {
      res.write(third.subarray(i, i + 64 * 1024));
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
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const get = async (route: string) => (await fetch(`${env.engine}/control/${route}`)).json();
const saved = () => JSON.parse(fs.readFileSync(path.join(env.data, "choices.json"), "utf8"));
const row = (key: string) => `[data-model-row="${key}"]`;
const rowText = (key: string) => p.evaluate(`document.querySelector(${JSON.stringify(row(key))})?.innerText ?? ""`) as Promise<string>;
const section = (title: string) =>
  p.evaluate(`(() => {
    const h = [...document.querySelectorAll('[data-component="settings-models"] h3')].find((e) => e.innerText.trim() === ${JSON.stringify(title)});
    if (!h) return null;
    const rows = [];
    for (let el = h.nextElementSibling; el && el.tagName !== "H3"; el = el.nextElementSibling) rows.push(...el.querySelectorAll('[data-model-row], [data-download-row]'));
    return rows.map((r) => r.dataset.modelRow ?? r.dataset.downloadRow);
  })()`) as Promise<string[] | null>;

/** A click with the mouse, like a person, on the first element of `selector` whose text is `label` (any, if empty). */
async function mouseClick(selector: string, label = "") {
  const at = await p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim().startsWith(${JSON.stringify(label)}));
    el?.scrollIntoView({ block: "center" });
    const q = el?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector} ${label}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/** Clicks until `done`: a row that is being redrawn (its progress moves) can miss a click. */
async function clickUntil(selector: string, done: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await mouseClick(selector).catch(() => {});
    for (let t = 0; t < 4000; t += 200) {
      if (await done().catch(() => false)) return;
      await Bun.sleep(200);
    }
  }
  throw new Error(`clicked on ${selector} and nothing happened: ${what}`);
}

async function openModels() {
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=models` });
  await waitUntil(() => exists('[data-component="settings-models"] [data-model-row]'), "the models in the settings");
}

/** The model in use again after a choice that may have loaded it again. */
async function settled(model: string) {
  await Bun.sleep(700);
  await waitUntil(async () => (await get("state")).model.phase === "ready" && (await get("state")).model.model === model, `${model} in use`, 120_000);
}

beforeAll(async () => {
  env = await start([{ text: "Eccomi." }], { window: true, context: 65536, otherModels: ["second", "third", "huge"], bytes: { huge: 10 * 2 ** 40 }, files, env: { MANGO_HF_URL: base } });
  // the third model is not on the computer: it is one of the tested ones, to download
  fs.rmSync(path.join(env.modelsDir, "third.gguf"));
  await env.restart();
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await waitUntil(async () => (await get("state")).model.phase === "ready", "the model ready");
  await openModels();
}, 300_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
});

test("the models are in three lists: on the computer, on their way, tested ones to download", async () => {
  await waitUntil(async () => (await section("Provati con Mango Code, da scaricare"))?.includes("third") === true, "the lists");
  expect(await section("Sul computer")).toEqual(["fake", "second", "huge"]);
  expect(await section("Provati con Mango Code, da scaricare")).toEqual(["third"]);
  // the first is the default and the one in use; the one that does not fit says so, closed
  const fake = await rowText("fake");
  expect(fake).toContain("Predefinito");
  expect(fake).toContain("In uso");
  expect(await rowText("second")).not.toContain("In uso");
  expect(await p.evaluate(`!!document.querySelector('${row("huge")} [data-slot="settings-model-no-fit"]')`)).toBe(true);
  expect(await rowText("third")).toContain("Scarica");
  // where the models are: the space they use, with the way to open the folder (not opened here)
  expect(await p.evaluate(`document.querySelector('[data-slot="settings-models-disk"]').innerText`)).toMatch(/Spazio usato dai modelli: .+ su /);
  expect(await exists('[data-action="settings-models-folder"]')).toBe(true);
}, 60_000);

test("where a model runs, how much it remembers and whether it reasons are its own choices, saved and read back", async () => {
  await mouseClick(`${row("fake")} button`);
  await waitUntil(() => exists(`${row("fake")} [data-slot="settings-model-detail"]`), "the choices of the model");
  const where = `${row("fake")} [data-action="settings-model-where"] button`;
  const names = (await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(where)})].map((b) => b.innerText.trim())`)) as string[];
  expect(names).toEqual(expect.arrayContaining(["Automatico", "Processore"]));

  await mouseClick(where, "Processore");
  await waitUntil(() => saved().models?.fake?.where === "cpu", "the processor saved");
  await settled("fake");
  expect((await get("models")).models.find((m: { key: string }) => m.key === "fake").verdict.where.placement).toBe("cpu");
  await waitUntil(() => p.evaluate(`document.querySelector('${row("fake")} [data-action="settings-model-where"] [aria-checked="true"], ${row("fake")} [data-action="settings-model-where"] [aria-pressed="true"]')?.innerText.includes("Processore")`) as Promise<boolean>, "the page shows it");
  await mouseClick(where, "Automatico");
  await waitUntil(() => (saved().models?.fake?.where ?? "auto") === "auto", "automatic saved");
  await settled("fake");

  // the context: the last one offered is «as much as fits», saved as no number
  const context = `${row("fake")} [data-action="settings-model-context"] button`;
  const offered = (await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(context)})].map((b) => b.innerText.trim())`)) as string[];
  expect(offered.length).toBeGreaterThan(1);
  await mouseClick(context, offered[0]);
  await waitUntil(() => typeof saved().models?.fake?.context === "number", "a context saved");
  await settled("fake");
  expect((await get("state")).model.where.context).toBe(saved().models.fake.context);
  await mouseClick(context, offered.at(-1)!);
  await waitUntil(() => (saved().models?.fake?.context ?? null) === null, "the most that fits saved");
  await settled("fake");

  // the reasoning: the fake model reasons, as most of the catalog
  const reasoning = `${row("fake")} [data-action="settings-model-reasoning"] input`;
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(reasoning)}).checked`)).toBe(true);
  await p.evaluate(`document.querySelector(${JSON.stringify(reasoning)}).click()`);
  await waitUntil(() => saved().models?.fake?.reasoning === false, "reasoning off saved");
  await waitUntil(() => p.evaluate(`document.querySelector(${JSON.stringify(reasoning)}).checked === false`) as Promise<boolean>, "the page shows it");
  // the row's controls are off while its command ends (the view is read again first): a click then would be lost
  await waitUntil(() => p.evaluate(`document.querySelector(${JSON.stringify(reasoning)}).disabled === false`) as Promise<boolean>, "the switch ready again");
  await p.evaluate(`document.querySelector(${JSON.stringify(reasoning)}).click()`);
  await waitUntil(() => (saved().models?.fake?.reasoning ?? null) !== false, "reasoning back");
}, 240_000);

test("«Usa come predefinito» makes another model the default and, with no conversation answering, loads it at once", async () => {
  await mouseClick(`${row("second")} button`);
  await waitUntil(() => exists(`${row("second")} [data-action="settings-model-default"]`), "the choices of the second model");
  await mouseClick(`${row("second")} [data-action="settings-model-default"]`);
  await waitUntil(() => saved().default === "second", "the default saved");
  // no conversation is answering: the new default is loaded now, so that the next conversation finds it ready
  await waitUntil(async () => { const m = (await get("state")).model; return m.phase === "ready" && m.model === "second"; }, "the new default in use");
  expect((await get("state")).default_model).toBe("second");
  await waitUntil(async () => (await rowText("second")).includes("Predefinito") && (await rowText("second")).includes("In uso"), "the pills follow");
  expect(await rowText("fake")).not.toContain("In uso");
  expect(await rowText("fake")).not.toContain("Predefinito");
  // the model that is already the default has no button for it
  expect(await exists(`${row("second")} [data-action="settings-model-default"]`)).toBe(false);
}, 120_000);

test("«Scarica» brings a tested model in the background: it can be paused, goes on, and arrives among the models", async () => {
  await mouseClick(`${row("third")} [data-action="settings-model-download"]`);
  await waitUntil(() => exists('[data-download-row="third"]'), "the download among those on their way");
  expect(await section("In arrivo")).toEqual(["third"]);
  expect(await section("Provati con Mango Code, da scaricare")).toBeNull();
  // the model in use is not touched
  expect((await get("state")).model).toMatchObject({ phase: "ready", model: "second" });

  await clickUntil('[data-download-row="third"] [data-action="settings-download-pause"]', async () => (await get("state")).downloads[0]?.state === "paused", "the download paused");
  await waitUntil(async () => (await p.evaluate(`document.querySelector('[data-download-row="third"]').innerText`)).includes("in pausa"), "the row says so");
  const stopped = (await get("state")).downloads[0].done;
  await Bun.sleep(1200);
  expect((await get("state")).downloads[0].done).toBe(stopped);

  await clickUntil('[data-download-row="third"] [data-action="settings-download-resume"]', async () => (await get("state")).downloads[0]?.state === "active", "the download going on");
  await waitUntil(async () => (await get("state")).downloads.length === 0, "the model arrived", 120_000);
  expect(fs.statSync(path.join(env.modelsDir, "third.gguf")).size).toBe(third.length);
  await waitUntil(async () => (await section("Sul computer"))?.includes("third") === true, "the model among those on the computer");
  expect(await exists('[data-download-row="third"]')).toBe(false);
  // it arrived after another model was in use: nothing changed
  expect((await get("state")).model).toMatchObject({ phase: "ready", model: "second" });
  expect((await get("state")).default_model).toBe("second");
}, 180_000);

test("a download cancelled from its row leaves nothing and the model is among the tested ones again", async () => {
  // to download again, slowly: take it off the computer first (the confirmation is the next test's)
  await p.evaluate(`window.__MANGO_DESKTOP__.models.remove("third")`);
  await waitUntil(async () => (await section("Provati con Mango Code, da scaricare"))?.includes("third") === true, "third among the tested ones");
  await mouseClick(`${row("third")} [data-action="settings-model-download"]`);
  await waitUntil(() => exists('[data-download-row="third"] [data-action="settings-download-cancel"]'), "the download on its way");
  await waitUntil(async () => (await get("state")).downloads[0]?.done > 0, "some bytes arrived");
  await clickUntil('[data-download-row="third"] [data-action="settings-download-cancel"]', async () => (await get("state")).downloads.length === 0, "the download cancelled");
  await waitUntil(async () => (await section("Provati con Mango Code, da scaricare"))?.includes("third") === true, "third among the tested ones again");
  await waitUntil(() => !fs.existsSync(path.join(env.modelsDir, "third.gguf")) && !fs.existsSync(path.join(env.modelsDir, "third.gguf.part")), "nothing of it left on the disk", 15_000);
}, 120_000);

test("«Togli dal computer» asks in a window, and «Togli» deletes the file and leaves the model among the tested ones", async () => {
  // the model that is in use and the default are not the one taken off
  await p.evaluate(`window.__MANGO_DESKTOP__.models.download(["third"])`);
  await waitUntil(async () => (await get("state")).downloads.length === 0 && fs.existsSync(path.join(env.modelsDir, "third.gguf")), "third back on the computer", 120_000);
  await waitUntil(async () => (await section("Sul computer"))?.includes("third") === true, "third among the models");
  await mouseClick(`${row("third")} button`);
  await waitUntil(() => exists(`${row("third")} [data-action="settings-model-remove"]`), "the choices of the model");
  await waitUntil(() => p.evaluate(`document.querySelector('${row("third")} [data-action="settings-model-remove"]').disabled === false`) as Promise<boolean>, "the button ready");
  await mouseClick(`${row("third")} [data-action="settings-model-remove"]`);
  await waitUntil(() => exists('[data-action="settings-model-remove-confirm"]'), "the window of the question");
  const dialog = (await p.evaluate(`document.querySelector('[data-action="settings-model-remove-confirm"]').closest('[role="dialog"]').innerText`)) as string;
  expect(dialog).toContain("Togli «Model third» dal computer?");
  expect(fs.existsSync(path.join(env.modelsDir, "third.gguf"))).toBe(true);
  await mouseClick('[data-action="settings-model-remove-confirm"]');
  await waitUntil(() => !fs.existsSync(path.join(env.modelsDir, "third.gguf")), "the file deleted");
  await waitUntil(async () => (await section("Provati con Mango Code, da scaricare"))?.includes("third") === true, "third among the tested ones");
  expect(await section("Sul computer")).not.toContain("third");
  expect((await get("state")).model).toMatchObject({ phase: "ready", model: "second" });
}, 240_000);

test("«Un altro modello»: a GGUF chosen in the Windows dialog is analyzed, added to the models with its file left where it is, and taken off again", async () => {
  // a file of the user with a header only: an architecture the count does not know, so the memory is an estimate
  const mine = path.join(env.root, "elsewhere", "mio-modello.gguf");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  const string = (s: string) => {
    const bytes = Buffer.from(s);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  const header = Buffer.alloc(24);
  header.write("GGUF", 0);
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(1n, 16);
  const type = Buffer.alloc(4);
  type.writeUInt32LE(8);
  fs.writeFileSync(mine, Buffer.concat([header, string("general.architecture"), type, string("zzz-test"), Buffer.alloc(MIB)]));

  await mouseClick('[data-action="settings-other-model-file"]');
  const picked = await answer(env.app.pid!, "-Path", mine);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(() => exists('[data-slot="settings-other-analysis"]'), "the analysis of the file");
  expect(await p.evaluate(`document.querySelector('[data-slot="settings-other-analysis"]').innerText`)).toContain("mio-modello");
  expect(await exists('[data-slot="settings-other-estimated"]')).toBe(true);
  await mouseClick('[data-action="settings-other-model-add"]');
  await waitUntil(async () => (await section("Sul computer"))?.includes("local-mio-modello") === true, "the model among those on the computer");
  expect(await p.evaluate(`document.querySelector('[data-slot="settings-other-model-line"]').innerText`)).toContain("mio-modello");
  expect((await get("models")).models.find((m: { key: string }) => m.key === "local-mio-modello")).toMatchObject({ user: true, present: true, own_files: [mine] });

  // taken off: its row asks, says the file stays where it is, and the file is still there
  await mouseClick(`${row("local-mio-modello")} button`);
  await waitUntil(() => exists(`${row("local-mio-modello")} [data-action="settings-model-remove"]`), "its choices");
  await mouseClick(`${row("local-mio-modello")} [data-action="settings-model-remove"]`);
  await waitUntil(() => exists('[data-action="settings-model-remove-confirm"]'), "the window of the question");
  expect((await p.evaluate(`document.querySelector('[data-action="settings-model-remove-confirm"]').closest('[role="dialog"]').innerText`)) as string).toContain("resta dov'è");
  await mouseClick('[data-action="settings-model-remove-confirm"]');
  await waitUntil(async () => !(await section("Sul computer"))?.includes("local-mio-modello"), "the model gone from the list");
  expect(fs.existsSync(mine)).toBe(true);
}, 240_000);
