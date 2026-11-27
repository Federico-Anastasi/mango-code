// Settings › Models, the group of the models that make pictures, in the app's real window (WebView2 CDP), with the mouse:
// the models of the catalog with their line, license, weight and the labels of the default and of the engine that is on,
// «Usa come predefinito» kept and read back, «Scarica» in the background with Pause and Resume, «Togli dal computer»
// confirmed in the window, and the two choices about rewriting the request, kept in the interface's own settings.
// A model is downloaded from a local server standing in for Hugging Face (`MANGO_HF_URL`), served slowly. Fake engines,
// no GPU needed. Screenshots of the group go to the folder in `MANGO_SHOTS`, if set. `bun test --cwd integration
// tests/settings-images.test.ts`, after `cargo build -p mango-code -p engine -p images` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";
import { atSizes } from "./window";

const KIB = 1024;
const third = Uint8Array.from({ length: 256 * KIB }, (_, i) => (i * 31 + 3) % 251);
const files = { pic3: { size: third.length, sha256: new Bun.CryptoHasher("sha256").update(third).digest("hex") } };

// Three files of 256 KiB, about 100 KiB a second: eight seconds for the model, time to pause it and to go on.
const server = http.createServer((req, res) => {
  if (!/^\/test\/pic3\/resolve\/main\/pic3-(d\.gguf|e\.gguf|v\.safetensors)$/.test(req.url ?? "")) return void res.writeHead(404).end("not there");
  const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
  res.writeHead(from ? 206 : 200, { "Content-Length": third.length - from, ...(from ? { "Content-Range": `bytes ${from}-${third.length - 1}/${third.length}` } : {}) });
  (async () => {
    for (let i = from; i < third.length && !res.destroyed; i += 16 * KIB) {
      res.write(third.subarray(i, i + 16 * KIB));
      await Bun.sleep(150);
    }
    res.end();
  })();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

// Like File Explorer: the folder with `\.` at the end.
const site = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mango-pictures-")), "picture-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<h1>hello</h1>");

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
const GROUP = "Fanno immagini";
// The titles of the groups are shown in capitals by the stylesheet: they are matched as they are written.
const section = (title: string) =>
  p.evaluate(`(() => {
    const h = [...document.querySelectorAll('[data-component="settings-models"] h3')].find((e) => e.textContent.trim() === ${JSON.stringify(title)});
    if (!h) return null;
    const rows = [];
    for (let el = h.nextElementSibling; el && el.tagName !== "H3"; el = el.nextElementSibling) rows.push(...el.querySelectorAll('[data-model-row], [data-download-row]'));
    return rows.map((r) => r.dataset.modelRow ?? r.dataset.downloadRow);
  })()`) as Promise<string[] | null>;
/** What the interface keeps of its own settings (`images.*`), as the app has it on disk: the page is told to send what it holds first. */
async function kept() {
  await p.evaluate(`window.dispatchEvent(new Event("pagehide"))`);
  await Bun.sleep(200);
  const file = path.join(env.data, "ui-state.json");
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).entries : {};
  return JSON.parse(entries["settings.v3"] ?? "{}").images as { rewrite: boolean; rewriter: { providerID: string; modelID: string } | null };
}

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
  await waitUntil(() => exists(`[data-component="settings-models"] ${row("pic1")}`), "the pictures in the settings");
}

/** The row of a model that makes pictures, open: its actions are in it. */
async function openRow(key: string) {
  if (await exists(`${row(key)} [data-slot="settings-image-detail"]`)) return;
  await mouseClick(`${row(key)} button`);
  await waitUntil(() => exists(`${row(key)} [data-slot="settings-image-detail"]`), `the actions of ${key}`);
}

const shots = process.env.MANGO_SHOTS;
/** The group «Fanno immagini» as it looks, in the dark and the light theme, at 1280 and 390 px. */
async function shoot(name: string) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await atSizes(env.app.pid!, p, [[1280, 1000], [390, 900]] as const, async (width) => {
    for (const scheme of ["dark", "light"]) {
      await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await Bun.sleep(400);
      await p.evaluate(`(document.querySelector('[data-slot="settings-images"]')?.previousElementSibling ?? document.body).scrollIntoView({ block: "start" })`);
      await Bun.sleep(200);
      const shot = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(shots, `${name}-${width}-${scheme}.png`), Buffer.from(shot.result.data, "base64"));
    }
  });
  await p.send("Emulation.setEmulatedMedia", { features: [] });
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], {
    window: true,
    context: 65536,
    otherModels: ["ling"],
    imageModels: ["pic1", "pic2", "pic3"],
    imagePresent: ["pic1", "pic2"],
    files,
    args: [`${site}\\.`],
    env: { MANGO_HF_URL: base },
  });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await waitUntil(async () => (await get("state")).model.phase === "ready", "the model ready");
  // a project is open, as for any user: the models that write are the agent's for a project
  await waitUntil(async () => ((await p.evaluate(`document.body.innerText`)) as string).includes("picture-site"), "the project open", 60_000);
  await openModels();
}, 300_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
  fs.rmSync(path.dirname(site), { recursive: true, force: true });
});

test("the group lists the models that make pictures in the catalog's order, with what each one is", async () => {
  expect(await section(GROUP)).toEqual(["pic1", "pic2", "pic3"]);
  // the models that write are not in it, and it comes after them and before «Un altro modello»
  expect(await section("Sul computer")).toEqual(["fake", "ling"]);
  const order = (await p.evaluate(`[...document.querySelectorAll('[data-component="settings-models"] h3')].map((h) => h.textContent.trim())`)) as string[];
  expect(order.indexOf(GROUP)).toBeGreaterThan(order.indexOf("Sul computer"));
  expect(order.indexOf(GROUP)).toBeLessThan(order.indexOf("Un altro modello"));

  const first = await rowText("pic1");
  expect(first).toContain("Picture pic1");
  expect(first).toContain("Predefinito");
  expect(first).not.toContain("In uso");
  expect(first).toContain("Disegna pic1.");
  expect(first).toContain("Apache-2.0");
  expect(first).toMatch(/scheda|Processore/);
  // the same pieces as the others: the weight of its files; the one to download has the button with what it brings
  expect(first).toMatch(/\d[\d,.]* (B|KB)/);
  expect(await rowText("pic2")).not.toContain("Predefinito");
  const absent = await rowText("pic3");
  expect(absent).toContain("Scarica · ");
  expect(await exists(`${row("pic3")} [data-action="settings-image-download"]`)).toBe(true);
  expect(await exists(`${row("pic1")} [data-action="settings-image-download"]`)).toBe(false);

  // what the page shows is what the app tells
  const listed = await get("models");
  expect(listed.image_default).toBe("pic1");
  expect(listed.image_models.map((m: { key: string; present: boolean }) => [m.key, m.present])).toEqual([["pic1", true], ["pic2", true], ["pic3", false]]);
  expect(listed.image_models[0]).toMatchObject({ label: "Picture pic1", license: "Apache-2.0", about: "Disegna pic1.", bytes: 3000 });
  expect(listed.models.map((m: { key: string }) => m.key)).toEqual(["fake", "ling"]);
  await shoot("group");
}, 120_000);

test("«Usa come predefinito» makes another model the default for pictures, kept and read back after a reload", async () => {
  await openRow("pic2");
  expect(await exists(`${row("pic1")} [data-action="settings-image-default"]`)).toBe(false);
  await waitUntil(() => p.evaluate(`document.querySelector('${row("pic2")} [data-action="settings-image-default"]').disabled === false`) as Promise<boolean>, "the button ready");
  await mouseClick(`${row("pic2")} [data-action="settings-image-default"]`);
  await waitUntil(() => saved().image_default === "pic2", "the default saved");
  await waitUntil(async () => (await rowText("pic2")).includes("Predefinito") && !(await rowText("pic1")).includes("Predefinito"), "the labels follow");
  // a picture asked without a model is made by it; the model that writes is another choice
  expect((await get("image")).default).toBe("pic2");
  expect(saved().default).toBe("fake");
  expect((await get("state")).default_model).toBe("fake");
  expect(await exists(`${row("pic2")} [data-action="settings-image-default"]`)).toBe(false);

  await openModels();
  expect(await rowText("pic2")).toContain("Predefinito");
  expect(await section(GROUP)).toEqual(["pic1", "pic2", "pic3"]);
}, 120_000);

test("the label «In uso» is on the model whose image engine is on", async () => {
  expect((await get("state")).image_loaded).toBeNull();
  const job = await (
    await fetch(`${env.engine}/control/image/generate`, { method: "POST", body: JSON.stringify({ prompt: "a red Vespa", width: 64, height: 64, model: "pic1", stay_on: true }) })
  ).json();
  await waitUntil(async () => (await (await fetch(`${env.engine}/control/image/jobs/${job.id}`)).json()).status === "done", "the picture done", 90_000);
  await waitUntil(async () => (await get("state")).image_loaded === "pic1", "the engine on");
  await waitUntil(async () => (await rowText("pic1")).includes("In uso"), "the label");
  expect(await rowText("pic2")).not.toContain("In uso");
  await fetch(`${env.engine}/control/image/unload`, { method: "POST", body: "{}" });
  await waitUntil(async () => !(await rowText("pic1")).includes("In uso"), "the label gone with the engine");
  expect((await get("state")).image_loaded).toBeNull();
}, 150_000);

test("«Scarica» brings a model in the background: it can be paused, goes on, and arrives among the others", async () => {
  await mouseClick(`${row("pic3")} [data-action="settings-image-download"]`);
  await waitUntil(() => exists('[data-download-row="pic3"]'), "the download among those on their way");
  expect(await section("In arrivo")).toEqual(["pic3"]);
  // its row in the group says so and offers no second download
  await waitUntil(async () => (await rowText("pic3")).includes("In arrivo"), "its row says it arrives");
  expect(await exists(`${row("pic3")} [data-action="settings-image-download"]`)).toBe(false);
  // the model that writes is not touched
  expect((await get("state")).model).toMatchObject({ phase: "ready", model: "fake" });

  await clickUntil('[data-download-row="pic3"] [data-action="settings-download-pause"]', async () => (await get("state")).downloads[0]?.state === "paused", "the download paused");
  await waitUntil(async () => (await p.evaluate(`document.querySelector('[data-download-row="pic3"]').innerText`)).includes("in pausa"), "the row says so");
  const stopped = (await get("state")).downloads[0].done;
  await Bun.sleep(1200);
  expect((await get("state")).downloads[0].done).toBe(stopped);

  await clickUntil('[data-download-row="pic3"] [data-action="settings-download-resume"]', async () => (await get("state")).downloads[0]?.state === "active", "the download going on");
  await waitUntil(async () => (await get("state")).downloads.length === 0, "the model arrived", 120_000);
  for (const name of ["d.gguf", "e.gguf", "v.safetensors"]) expect(fs.statSync(path.join(env.modelsDir, `pic3-${name}`)).size).toBe(third.length);
  await waitUntil(async () => (await get("models")).image_models.find((m: { key: string }) => m.key === "pic3").present, "the model on the computer");
  await waitUntil(() => exists(`${row("pic3")} button[aria-expanded]`), "its row opens now");
  expect(await exists('[data-download-row="pic3"]')).toBe(false);
  // it arrived: no model that writes was loaded or made the default for it
  expect((await get("state")).model).toMatchObject({ phase: "ready", model: "fake" });
  expect(await section(GROUP)).toEqual(["pic1", "pic2", "pic3"]);
}, 240_000);

test("«Togli dal computer» asks in a window, and «Togli» deletes the files; the one that was the default leaves the choice", async () => {
  await openRow("pic2");
  await waitUntil(() => p.evaluate(`document.querySelector('${row("pic2")} [data-action="settings-image-remove"]').disabled === false`) as Promise<boolean>, "the button ready");
  await mouseClick(`${row("pic2")} [data-action="settings-image-remove"]`);
  await waitUntil(() => exists('[data-action="settings-model-remove-confirm"]'), "the window of the question");
  const dialog = (await p.evaluate(`document.querySelector('[data-action="settings-model-remove-confirm"]').closest('[role="dialog"]').innerText`)) as string;
  expect(dialog).toContain("Togli «Picture pic2» dal computer?");
  expect(fs.existsSync(path.join(env.modelsDir, "pic2-d.gguf"))).toBe(true);
  await mouseClick('[data-action="settings-model-remove-confirm"]');
  await waitUntil(() => !fs.existsSync(path.join(env.modelsDir, "pic2-d.gguf")), "the files deleted");
  await waitUntil(async () => (await get("models")).image_models.find((m: { key: string }) => m.key === "pic2").present === false, "the model no longer on the computer");
  await waitUntil(async () => (await rowText("pic2")).includes("Scarica · "), "its row offers the download again");
  // it was the default for pictures: the choice goes with it and the catalog's stands again
  expect(saved().image_default ?? null).toBeNull();
  expect((await get("image")).default).toBe("pic1");
  await waitUntil(async () => (await rowText("pic1")).includes("Predefinito"), "the label back on the first");
  // the other files and the models that write are untouched
  expect(fs.existsSync(path.join(env.modelsDir, "pic1-d.gguf"))).toBe(true);
  expect(await section("Sul computer")).toEqual(["fake", "ling"]);
  expect(await section(GROUP)).toEqual(["pic1", "pic2", "pic3"]);
}, 120_000);

test("the request is rewritten by default; the switch and «Chi riscrive» are kept and read back after a reload", async () => {
  const rewrite = '[data-action="settings-image-rewrite"] input';
  const rewriter = '[data-action="settings-image-rewriter"] [data-component="select-v2"]';
  const title = (name: string) => `[...document.querySelectorAll('[data-slot="settings-v2-row-title"]')].find((e) => e.textContent.trim() === ${JSON.stringify(name)})`;
  expect(await p.evaluate(`!!${title("Riscrivi la richiesta")}`)).toBe(true);
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewrite)}).checked`)).toBe(true);
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).innerText.trim()`)).toBe("Automatico");
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).hasAttribute("data-disabled")`)).toBe(false);

  // the menu: automatic first, then the models that write that the agent offers; Ling is the recommended one
  await mouseClick(rewriter);
  await waitUntil(() => exists('[data-component="menu-v2-item"]'), "the menu");
  const items = (await p.evaluate(`[...document.querySelectorAll('[data-component="menu-v2-item"]')].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`)) as string[];
  expect(items[0]).toBe("Automatico");
  expect(items).toContain("Fake model");
  expect(items).toContain("Model ling Consigliato");
  expect(items.filter((item) => item.includes("Consigliato"))).toHaveLength(1);
  await shoot("menu");
  await mouseClick('[data-component="menu-v2-item"]', "Model ling");
  await waitUntil(async () => (await kept())?.rewriter?.modelID === "ling", "the rewriter kept");
  expect((await kept()).rewriter).toEqual({ providerID: "mango", modelID: "ling" });
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).innerText.trim()`)).toBe("Model ling");

  // off: the words go as they are, and «Chi riscrive» says why it cannot be chosen
  await p.evaluate(`document.querySelector(${JSON.stringify(rewrite)}).click()`);
  await waitUntil(async () => (await kept())?.rewrite === false, "the switch kept");
  await waitUntil(() => p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).hasAttribute("data-disabled")`) as Promise<boolean>, "the menu off");
  expect(await p.evaluate(`${title("Chi riscrive")}.closest('[data-component="settings-v2-row"]').innerText`)).toContain("Si sceglie quando «Riscrivi la richiesta» è accesa.");
  // the choice of who stays while it is off
  expect((await kept()).rewriter).toEqual({ providerID: "mango", modelID: "ling" });
  await shoot("off");

  await openModels();
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewrite)}).checked`)).toBe(false);
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).innerText.trim()`)).toBe("Model ling");
  expect(await kept()).toEqual({ rewrite: false, rewriter: { providerID: "mango", modelID: "ling" } });

  // back to the defaults
  await p.evaluate(`document.querySelector(${JSON.stringify(rewrite)}).click()`);
  await waitUntil(async () => (await kept())?.rewrite === true, "on again");
  await mouseClick(rewriter);
  await waitUntil(() => exists('[data-component="menu-v2-item"]'), "the menu");
  await mouseClick('[data-component="menu-v2-item"]', "Automatico");
  await waitUntil(async () => (await kept())?.rewriter === null, "automatic kept");
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(rewriter)}).innerText.trim()`)).toBe("Automatico");
}, 120_000);

test("the search finds the group and the two rows by the words a person types, and leads to the row", async () => {
  await p.send("Page.navigate", { url: `${env.agent}/settings` });
  const field = '[data-action="settings-search"] input';
  await waitUntil(() => exists(field), "the search field");
  const type = (query: string) =>
    p.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(field)}); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(query)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const results = () => p.evaluate(`[...document.querySelectorAll('[data-slot="settings-search-title"]')].map((e) => e.textContent.trim())`) as Promise<string[]>;
  for (const [query, expected] of [["foto", "Fanno immagini"], ["disegna", "Fanno immagini"], ["riscrivi", "Riscrivi la richiesta"], ["chi riscrive", "Chi riscrive"]] as const) {
    await type(query);
    await waitUntil(async () => (await results()).includes(expected), `a result for «${query}»`);
  }
  // a result leads to its row: «Chi riscrive» comes into view in the section
  await mouseClick('[data-slot="settings-search-results"] button', "Chi riscrive");
  await waitUntil(
    () =>
      p.evaluate(`(() => { const r = document.querySelector('[data-action="settings-image-rewriter"]')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; })()`) as Promise<boolean>,
    "the row in view",
  );
}, 60_000);
