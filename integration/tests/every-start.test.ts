// Every start, in the app's real window (WebView2 CDP), on a computer with its models: the Home opens (never
// the last conversation) with the model's name and state in the top bar; the model changes from the bar without waiting;
// a message written while the model cannot answer (the cards lent) waits in the conversation, the X puts it back in the
// box, and when the model is ready the waiting messages leave together; in a long conversation the waiting message is
// in view, and who scrolled up is not brought down by a new one; a start that fails says why on the Home, with Retry
// and the settings; after an update of the app that brings a new engine, the engine arrives by itself and the app says
// so, never the welcome of the first start, Computer's «Aggiorna il motore» asks it, the old version goes once the new
// one is there, and an update that failed says why in Computer with «Riprova». Fake
// engine, no GPU used.
// `bun test --cwd integration tests/every-start.test.ts`, after `cargo build -p mango-code -p engine` in app/. With
// `MC_PHOTOS=<folder>` it saves a screenshot per step there.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { page, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, start, type Environment } from "./environment";

let env: Environment;
let mc: MangoCode;
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
const count = (selector: string) => p.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`) as Promise<number>;
const barText = () => p.evaluate(`(document.querySelector('[data-action="titlebar-model"]')?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;
const control = async () => (await fetch(`${env.engine}/control/state`)).json();
const chats = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter(
    (r: { route: string }) => r.route.startsWith("/v1/chat/completions"),
  );

async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function write(message: string) {
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, ${JSON.stringify(message)}); })()`);
  await Bun.sleep(300);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const computerText = () =>
  p.evaluate(`document.querySelector('[data-component="settings-computer"]')?.innerText ?? ""`) as Promise<string>;

/** Settings › Computer, as the tray's «Settings…» opens a section. */
async function openComputer() {
  await p.evaluate(`window.dispatchEvent(new CustomEvent("mango-settings", { detail: { section: "computer" } }))`);
  await waitUntil(async () => (await computerText()).includes("Motore"), "Settings › Computer");
}

/** The fake engine in a zip, as the catalog of the engines serves it. */
function engineZip(name: string) {
  const work = path.join(env.root, name);
  fs.mkdirSync(work, { recursive: true });
  fs.copyFileSync(FAKE_ENGINE_EXE, path.join(work, "llama-server.exe"));
  const zipFile = path.join(env.root, `${name}.zip`);
  const zipped = spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(work, "llama-server.exe")}' -DestinationPath '${zipFile}'`]);
  expect(zipped.status).toBe(0);
  return new Uint8Array(fs.readFileSync(zipFile));
}

/** The catalog of the engines with `version`, every build served at `url`. */
function engineCatalog(version: string, url: string, zip: Uint8Array) {
  const file = { url, size: zip.length, sha256: new Bun.CryptoHasher("sha256").update(zip).digest("hex") };
  const builds = Object.fromEntries(["cpu", "vulkan", "cuda-12", "cuda-13"].map((b) => [b, file]));
  fs.writeFileSync(path.join(env.root, "dist", "mango-engines.json"), JSON.stringify({ llamacpp: { version, gpu_check: false, build: builds } }));
}

async function photo(name: string) {
  if (!process.env.MC_PHOTOS) return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(process.env.MC_PHOTOS, `ogni-avvio-${name}.png`), Buffer.from(shot.result.data, "base64"));
}

beforeAll(async () => {
  env = await start([{ text: "Eccomi." }, { text: "Fatto." }], { window: true, otherModels: ["second", "huge"], bytes: { huge: 10 * 2 ** 40 } });
  mc = new MangoCode((await find(env.data))!);
  // a conversation of an earlier day: the app does not open it
  await mc.createSession(env.project, { title: "Fatture di ottobre" });
  p = await page(env.cdp!, () => true, 120_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
});

test("the Home opens, never the last conversation, with the model's name in the top bar", async () => {
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home");
  await waitUntil(async () => (await barText()).startsWith("Fake model"), "the model in the bar");
  await photo("1-home");
}, 60_000);

test("the model changes from the bar without waiting, and the bar says what it is doing", async () => {
  await mouseClick('[data-action="titlebar-model"]');
  await waitUntil(() => exists('[role="menu"] [data-option-key="second"]'), "the bar's menu");
  await photo("2-menu");
  await mouseClick('[role="menu"] [data-option-key="second"]');
  await waitUntil(async () => (await control()).model.model === "second", "the second model chosen");
  await waitUntil(async () => (await barText()) === "Model second", "the second model in the bar", 120_000);
  await photo("3-cambiato");
}, 180_000);

test("a message written while the cards are lent waits; the X puts one back; when the model is ready they leave together", async () => {
  await mouseClick('[aria-label="Nuova conversazione"]');
  await waitUntil(() => exists('[contenteditable="true"]'), "the composer of a new conversation");
  // another program takes the cards until it exits
  const holder = spawn("ping", ["-n", "120", "127.0.0.1"], { stdio: "ignore" });
  await fetch(`${env.engine}/engine/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: holder.pid }) });
  await waitUntil(async () => (await control()).model.phase === "lent", "the cards lent");
  await waitUntil(async () => (await barText()).includes("schede prestate"), "the bar says the cards are lent");

  const before = chats().length;
  await write("Riordina le fatture di ottobre");
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 1, "the first waiting message");
  await write("Poi quelle di novembre");
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 2, "the second waiting message");
  await write("Questo lo rimetto nella casella");
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 3, "the third waiting message");
  expect(await text()).toContain("In attesa: parte da sola appena il modello è pronto");
  expect(await text()).toContain("Le schede video sono prestate a un altro programma");
  await photo("4-in-attesa");
  // the X of the last one: back in the box, out of the waiting list
  await p.evaluate(`[...document.querySelectorAll('[data-action="mango-pending-restore"]')].at(-1).click()`);
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 2, "two waiting");
  expect(await p.evaluate(`document.querySelector('[contenteditable="true"]').innerText`)).toContain("Questo lo rimetto nella casella");
  expect(chats().length).toBe(before);

  holder.kill();
  await waitUntil(() => chats().some((r: { body: unknown }) => JSON.stringify(r.body).includes("Poi quelle di novembre")), "the messages at the engine", 120_000);
  const sent = chats().filter((r: { body: unknown }) => JSON.stringify(r.body).includes("Riordina le fatture di ottobre"));
  // one message with both, in order
  expect(JSON.stringify(sent.at(-1).body)).toMatch(/Riordina le fatture di ottobre\\n\\nPoi quelle di novembre/);
  expect(JSON.stringify(sent.at(-1).body)).not.toContain("Questo lo rimetto nella casella");
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 0, "nothing waiting");
  await photo("5-partiti");
}, 240_000);

test("in a long conversation the waiting message comes into view, with the line under it", async () => {
  // a conversation longer than the window, each message answered before the next
  const session = (await p.evaluate(`location.pathname.split("/").at(-1)`)) as string;
  const turns = async () => {
    const messages = await mc.messages(session, env.project);
    const asked = messages.filter((m) => m.info.role === "user").length;
    return { asked, answered: messages.filter((m) => m.info.role === "assistant" && m.info.time?.completed).length };
  };
  const long = "Una riga lunga per riempire la conversazione, con abbastanza parole da andare a capo più volte. ".repeat(8);
  for (let i = 0; i < 6; i++) {
    const before = (await turns()).asked;
    await write(`${i + 1}. ${long}`);
    await waitUntil(async () => {
      const t = await turns();
      return t.asked > before && t.answered >= t.asked;
    }, `the answer ${i + 1}`, 60_000);
  }
  const holder = spawn("ping", ["-n", "120", "127.0.0.1"], { stdio: "ignore" });
  try {
    await fetch(`${env.engine}/engine/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: holder.pid }) });
    await waitUntil(async () => (await control()).model.phase === "lent", "the cards lent");
    await waitUntil(async () => (await barText()).includes("schede prestate"), "the interface knows the cards are lent");
    await write("Questo aspetta in fondo alla conversazione");
    await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 1, "the waiting message");
    // what is at the centre of the bubble and of its line is them: in view, not under the box
    const seen = (selector: string) => `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!at && el.contains(at);
    })()`;
    await waitUntil(() => p.evaluate(seen('[data-slot="mango-pending-item"]')), "the waiting message in view", 10_000);
    expect(await p.evaluate(seen('[data-slot="mango-pending-note"]'))).toBe(true);
    await photo("5b-in-attesa-lunga");

    // who scrolled up to read stays where they are when another message comes to wait
    const scroller = `(() => {
      let el = document.querySelector('[data-component="mango-pending"]');
      while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el;
    })()`;
    const middle = await p.evaluate(`(() => { const r = ${scroller}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (let i = 0; i < 4; i++) {
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: middle.x, y: middle.y, deltaX: 0, deltaY: -600 });
      await Bun.sleep(100);
    }
    await waitUntil(async () => !(await p.evaluate(seen('[data-slot="mango-pending-item"]'))), "the conversation scrolled up", 10_000);
    await Bun.sleep(500);
    const top = (await p.evaluate(`${scroller}.scrollTop`)) as number;
    await write("Questo arriva mentre leggo più su");
    await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 2, "the second waiting message");
    await Bun.sleep(1500);
    expect(Math.abs(((await p.evaluate(`${scroller}.scrollTop`)) as number) - top)).toBeLessThan(4);
    expect(await p.evaluate(seen('[data-slot="mango-pending-item"]'))).toBe(false);
  } finally {
    holder.kill();
  }
  await waitUntil(async () => (await count('[data-slot="mango-pending-item"]')) === 0, "the message left", 120_000);
}, 300_000);

test("a start that fails says why on the Home, with Retry and the settings", async () => {
  await fetch(`${env.engine}/control/model/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "huge" }) });
  await waitUntil(async () => (await control()).model.phase === "failed", "the failed start", 120_000);
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => exists('[data-component="mango-failed"]'), "the box of the failed start");
  const page = await text();
  expect(page).toContain("Model huge non parte");
  expect(page).toContain("non ci sta in questo computer");
  expect(await exists('[data-action="mango-failed-retry"]')).toBe(true);
  expect(await exists('[data-action="mango-failed-settings"]')).toBe(true);
  // nothing is in use; the Home and the line above the box say why
  expect(await barText()).toBe("Nessun modello in uso");
  await photo("6-non-parte");
}, 180_000);

test("«Parti con …» starts the model that fits for this time only, and «Riprova» tries the one that did not start again", async () => {
  // the box of the test before: huge did not start, and the app proposes a model that fits
  const proposal = (await control()).model.proposal;
  expect(typeof proposal?.model).toBe("string");
  expect(typeof proposal?.label).toBe("string");
  expect(await text()).toContain(`Parti con ${proposal.label}`);
  const defaultModel = (await control()).default_model;
  await mouseClick('[data-action="mango-failed-proposal"]');
  await waitUntil(async () => (await control()).model.phase === "ready" && (await control()).model.model === proposal.model, "the proposed model ready", 120_000);
  await waitUntil(async () => (await barText()) === proposal.label, "the proposed model in the bar");
  expect(await exists('[data-component="mango-failed"]')).toBe(false);
  // for this time only: the default is the same and nothing was saved
  expect((await control()).default_model).toBe(defaultModel);
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "choices.json"), "utf8")).default).toBe(defaultModel);

  // a model whose file is missing does not start; with the file back, «Riprova» on the Home loads it
  const weights = path.join(env.modelsDir, "second.gguf");
  fs.renameSync(weights, `${weights}.away`);
  try {
    await fetch(`${env.engine}/control/model/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "second" }) });
    await waitUntil(async () => (await control()).model.phase === "failed", "the failed start");
    await p.send("Page.navigate", { url: `${env.agent}/` });
    await waitUntil(() => exists('[data-component="mango-failed"]'), "the box of the failed start");
    expect(await text()).toContain("Model second non parte");
  } finally {
    fs.renameSync(`${weights}.away`, weights);
  }
  await mouseClick('[data-action="mango-failed-retry"]');
  await waitUntil(async () => (await control()).model.phase === "ready" && (await control()).model.model === "second", "the model loaded at the second try", 120_000);
  await waitUntil(async () => (await barText()) === "Model second", "the model in the bar");
  await waitUntil(async () => !(await exists('[data-component="mango-failed"]')), "the box gone");
  await photo("6b-riprova");
}, 300_000);

test("after an update of the app that brings a new engine, it arrives by itself: the bar, the Home and the line say so, never the welcome", async () => {
  // The new engine: the fake engine in a zip, served half at once and half when the test says so.
  const zip = engineZip("new-engine");
  let release = () => {};
  const released = new Promise<void>((ok) => (release = ok));
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/engine.zip") return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": zip.length });
    res.write(zip.subarray(0, zip.length >> 1));
    await released;
    res.end(zip.subarray(zip.length >> 1));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    engineCatalog("new", `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/engine.zip`, zip);

    // the app updated: it starts again with the models on the disk and their engine at the old version
    p.close();
    await env.restart();
    await waitUntil(async () => (await control()).downloads?.some((d: { engine_only: boolean }) => d.engine_only), "the engine queued at the start", 180_000);
    p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
    await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home", 60_000);
    await waitUntil(async () => (await barText()).startsWith("Aggiorno il motore"), "the bar says the engine is updating");
    await waitUntil(() => exists('[data-component="mango-download"][data-engine]'), "the Home says the engine is arriving");
    expect(await exists('[data-component="mango-welcome"]')).toBe(false);
    // the bar's name and its state are two pieces (the name gives way in a narrow window): read as the bar is read aloud
    expect(await barText()).toMatch(/^Aggiorno il motore · \d+%$/);
    expect((await (await fetch(`${env.engine}/control/computer`)).json()).engine.update).toBe(true);
    await photo("7-aggiorno-il-motore");

    // Models: one row brings the engine, named after it; the models that wait for it stay in their rows, with
    // «Aspetta il motore nuovo», none among those to download
    await p.evaluate(`window.dispatchEvent(new CustomEvent("mango-settings", { detail: { section: "models" } }))`);
    await waitUntil(() => exists('[data-component="settings-models"] [data-download-row]'), "Settings › Models");
    expect(await count("[data-download-row]")).toBe(1);
    expect(await p.evaluate(`document.querySelector('[data-download-row]').innerText`)).toContain("llama.cpp");
    for (const key of ["fake", "second"]) {
      expect(await count(`[data-model-row="${key}"]`)).toBe(1);
      expect(await p.evaluate(`document.querySelector('[data-model-row="${key}"]').innerText`)).toContain("Aspetta il motore nuovo");
    }
    // a model on the computer that does not fit says so with its row closed
    expect(await count('[data-model-row="huge"] [data-slot="settings-model-no-fit"]')).toBe(1);
    expect(await count('[data-model-row="fake"] [data-slot="settings-model-no-fit"]')).toBe(0);
    await photo("7b-modelli-aspettano");

    // Computer: «Aggiorna il motore», and its answer under the engine's line
    await openComputer();
    expect(await p.evaluate(`document.querySelector('[data-action="settings-computer-update-engine"]').innerText`)).toBe("Aggiorna il motore");
    expect(await computerText()).toContain("questa versione di Mango Code ne porta uno nuovo");
    await mouseClick('[data-action="settings-computer-update-engine"]');
    await waitUntil(async () => (await computerText()).includes("Scarico la versione nuova del motore"), "the answer of «Aggiorna il motore»");

    release();
    await waitUntil(async () => (await control()).model.phase === "ready", "the model loads with the new engine", 120_000);
    await waitUntil(async () => (await barText()) === "Fake model", "the model in the bar");
    await waitUntil(async () => (await computerText()).includes("è quello di questa versione di Mango Code"), "Computer: the engine is this version's");
    expect(await exists('[data-action="settings-computer-update-engine"]')).toBe(false);
    expect((await (await fetch(`${env.engine}/control/computer`)).json()).engine.update).toBe(false);
    // the old version is gone, every build of it; the new one stays
    const left = fs.readdirSync(path.join(env.enginesDir, "llamacpp"));
    expect(left.some((name) => name.startsWith("new-"))).toBe(true);
    expect(left.filter((name) => name.startsWith("fake-"))).toEqual([]);
  } finally {
    release();
    server.close();
  }
}, 420_000);

test("an update of the engine that failed says why in Computer, with «Riprova» that brings it", async () => {
  // the server refuses until the test lets it give the engine
  const zip = engineZip("newer-engine");
  let open = false;
  const server = http.createServer((req, res) => {
    if (req.url !== "/engine.zip" || !open) return void res.writeHead(503).end();
    res.writeHead(200, { "Content-Length": zip.length }).end(zip);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    engineCatalog("newer", `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/engine.zip`, zip);
    p.close();
    await env.restart();
    await waitUntil(
      async () => (await control()).downloads?.some((d: { engine_only: boolean; state: string }) => d.engine_only && d.state === "failed"),
      "the update of the engine failed",
      180_000,
    );
    p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
    await openComputer();
    await waitUntil(async () => (await computerText()).includes("L'aggiornamento del motore non è riuscito"), "Computer says why");
    expect(await computerText()).not.toContain("Scarico la versione nuova");
    // the sentence names the engine, not the model that brought it
    expect(await computerText()).toContain("Il server non dà i file di «llama.cpp");
    expect(await computerText()).not.toContain("Fake model");
    expect(await p.evaluate(`document.querySelector('[data-action="settings-computer-update-engine"]').innerText`)).toBe("Riprova");
    await photo("8-motore-non-riuscito");

    open = true;
    await mouseClick('[data-action="settings-computer-update-engine"]');
    await waitUntil(async () => (await control()).model.phase === "ready", "the model loads with the newer engine", 120_000);
    await waitUntil(async () => (await computerText()).includes("è quello di questa versione di Mango Code"), "Computer: the engine is this version's");
    expect(await computerText()).not.toContain("non è riuscito");
    const left = fs.readdirSync(path.join(env.enginesDir, "llamacpp"));
    expect(left.some((name) => name.startsWith("newer-"))).toBe(true);
    expect(left.filter((name) => name.startsWith("new-"))).toEqual([]);
  } finally {
    server.close();
  }
}, 420_000);
