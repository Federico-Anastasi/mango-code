// The first start, in the app's real window (WebView2 CDP), on a computer with no model: the Home welcomes with
// what it found and the model it recommends; the list chooses more than one; one button downloads it and the app is in
// use meanwhile (the model's name and the download in the top bar); before that, with no model and none coming, the
// composer does not send and its line leads to Models; a message written while it downloads waits in the
// conversation and leaves by itself when the model is ready, with the model the box names, also
// when the model becomes ready while the message's conversation is being made.
// The file is a real download from a local server standing in for Hugging Face (`MANGO_HF_URL`), served slowly.
// Fake engine, no GPU. `bun test --cwd integration tests/first-start.test.ts`, after `cargo build -p mango-code -p engine`
// in app/. With `MC_PHOTOS=<folder>` it saves a screenshot per step there.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { answer } from "./dialog";
import { start, type Environment } from "./environment";
import { atSizes } from "./window";

const MIB = 1024 * 1024;
const content = (seed: number, size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const models: Record<string, Uint8Array> = { fake: content(1, 6 * MIB), second: content(2, 2 * MIB) };
const files = Object.fromEntries(Object.entries(models).map(([id, bytes]) => [id, { size: bytes.length, sha256: sha256(bytes) }]));

// About 0.4 MiB a second: the download lasts about fifteen seconds, enough to write while it runs also on a busy
// computer, where the window reads the app's state late. The second half of the fake model waits for `released`, one
// byte a second meanwhile so that the download never stops: the model is still on its way until the test says so.
let released = false;
const server = http.createServer((req, res) => {
  const id = /^\/test\/(\w+)\/resolve\/main\/\1\.gguf$/.exec(req.url ?? "")?.[1];
  const bytes = id ? models[id] : undefined;
  if (!bytes) return void res.writeHead(404).end("not there");
  res.writeHead(200, { "Content-Length": bytes.length });
  (async () => {
    for (let i = 0; i < bytes.length && !res.destroyed; ) {
      const held = id === "fake" && !released && i >= bytes.length / 2;
      const size = held ? 1 : 64 * 1024;
      res.write(bytes.subarray(i, i + size));
      i += size;
      await Bun.sleep(held ? 1000 : 150);
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
const composerText = () => p.evaluate(`(document.querySelector('[data-action="prompt-model"]')?.innerText ?? "").replace(/\\s+/g, " ").trim()`) as Promise<string>;

/** A click with the mouse, like a person: menus and tabs do not answer the DOM's `click()`. */
async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function photo(name: string) {
  if (!process.env.MC_PHOTOS) return;
  fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(process.env.MC_PHOTOS, `primo-avvio-${name}.png`), Buffer.from(shot.result.data, "base64"));
}

async function write(message: string) {
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, ${JSON.stringify(message)}); })()`);
  await Bun.sleep(300);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** Closes WebView2 in the window (its browser, through remote debugging) the way it closes when the app quits. */
async function closeWindowBrowser() {
  const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${env.cdp}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((ok, ko) => ((ws.onopen = ok), (ws.onerror = ko)));
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
}

/** The window's storage (WebView2's, in the app data) has `key` on the disk. */
function onDisk(key: string) {
  const dir = path.join(env.data, "finestra", "EBWebView", "Default", "Local Storage", "leveldb");
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(log|ldb)$/.test(f) && fs.readFileSync(path.join(dir, f)).includes(key));
}

const chats = () =>
  (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter(
    (r: { route: string }) => r.route.startsWith("/v1/chat/completions"),
  );

beforeAll(async () => {
  env = await start([{ text: "Eccomi." }], {
    window: true,
    noModels: true,
    // as many models as the catalog lists on the Home, so that the list is longer than a laptop's window
    otherModels: ["second", "huge", "extra1", "extra2", "extra3", "extra4"],
    bytes: { huge: 10 * 2 ** 40 },
    files,
    env: { MANGO_HF_URL: base, MANGO_DICTATION_FAKE: "50" },
  });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home");
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  server.close();
});

test("the Home welcomes with what it found and the model it recommends; nothing is in use", async () => {
  await waitUntil(() => exists('[data-component="mango-welcome"]'), "the welcome");
  await waitUntil(async () => (await text()).includes("Cosa ho trovato"), "what it found");
  const page = await text();
  expect(page).toContain("Benvenuto in Mango Code");
  expect(page).toContain("Il modello che ti consiglio");
  expect(page).toContain("Fake model");
  expect(page).toMatch(/Scarica e comincia · 6 MB/);
  // before any model the top bar has the language
  expect(await barText()).toBe("");
  expect(await exists('[data-slot="titlebar-v2"] [data-action="mango-home-language"]')).toBe(true);
  // «Cosa ho trovato» is this computer, as the control server reads it
  const computer = await (await fetch(`${env.engine}/control/computer`)).json();
  const found = (await p.evaluate(`document.querySelector('[data-component="mango-found"]').innerText`)) as string;
  for (const gpu of computer.gpus) expect(found).toContain(gpu.name);
  expect(found).toContain(`${computer.cpu} · ${computer.cores} core`);
  expect(found).toMatch(new RegExp(`Spazio libero\\s+\\S+ \\S+ su ${path.parse(env.modelsDir).root.slice(0, 2)}`));
  await photo("1-benvenuto");
}, 60_000);

test("the language at the top right changes the Home and is the app's choice; the other one brings it back", async () => {
  const saved = async () => (await (await fetch(`${env.agent}/mango/language`)).json()).language;
  const pick = async (label: string) => {
    await mouseClick('[data-action="mango-home-language"]');
    await waitUntil(() => exists('[role="option"]'), "the languages");
    await p.evaluate(`[...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === ${JSON.stringify(label)}).click()`);
  };
  await pick("English");
  await waitUntil(async () => (await text()).includes("Welcome to Mango Code"), "the Home in English");
  expect(await text()).toContain("What I found");
  expect(await text()).toMatch(/Download and start · 6 MB/);
  expect(await saved()).toBe("en");
  await photo("1b-english");
  await pick("Italiano");
  await waitUntil(async () => (await text()).includes("Benvenuto in Mango Code"), "the Home in Italian again");
  expect(await saved()).toBe("it");
}, 60_000);

test("the list chooses more than one model, with their weight together", async () => {
  await mouseClick('[data-action="mango-choose"]');
  await waitUntil(() => exists('[data-component="mango-choose-list"]'), "the list");
  expect(await exists('[data-option-key="fake"] input:checked')).toBe(true);
  await mouseClick('[data-option-key="second"] input');
  await waitUntil(async () => (await text()).includes("Scarica e comincia · 2 modelli, 8 MB"), "two models chosen");
  await photo("2-elenco");
  // a model that does not fit is there to read, not to take: its box is off and the row says why
  expect(await p.evaluate(`document.querySelector('[data-option-key="huge"] input').disabled`)).toBe(true);
  expect(await p.evaluate(`document.querySelector('[data-option-key="huge"]').innerText`)).toContain("non ci sta");
}, 60_000);

test("«Indietro» and «Scarica e comincia» stay in view at the bottom of the list, at every width the window can have", async () => {
  try {
    // The Home's list is longer than these windows (the catalog has ten models): without the fixed buttons they would be
    // below the fold. 1100 is a laptop's screen, 900 the narrowest window at the app's own size.
    await atSizes(env.app.pid!, p, [[1100, 600], [900, 600]], async (width) => {
      const scroller = `(() => {
        let el = document.querySelector('[data-component="mango-choose-list"]');
        while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        return el;
      })()`;
      expect(await p.evaluate(`${scroller}.scrollHeight - ${scroller}.clientHeight`), `${width}: the list is longer than the window`).toBeGreaterThan(40);
      await p.evaluate(`${scroller}.scrollTop = 0`);
      for (const action of ["mango-choose-back", "mango-start-chosen"]) {
        const box = await p.evaluate(`(() => { const r = document.querySelector('[data-action="${action}"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
        expect(box.top, `${width}: ${action}`).toBeGreaterThanOrEqual(0);
        expect(box.bottom, `${width}: ${action} is in view, window ${await p.evaluate("innerHeight")} high`).toBeLessThanOrEqual(await p.evaluate("innerHeight"));
      }
    });
  } finally {
    await mouseClick('[data-action="mango-choose-back"]');
    await waitUntil(() => exists('[data-component="mango-recommended"]'), "back to the welcome");
  }
}, 60_000);

test("with no model on the computer and none coming the composer does not send, and its line leads to Models", async () => {
  await mouseClick('[aria-label="Nuova conversazione"]');
  await waitUntil(() => exists('[contenteditable="true"]'), "the composer of a new conversation");
  await waitUntil(() => exists('[data-component="mango-status"][data-kind="empty"]'), "the line that says no model is there");
  expect(await text()).toContain("Sul computer non c'è nessun modello: per scrivere ne serve uno.");
  const before = chats().length;
  await write("Riordina le fatture di settembre");
  await Bun.sleep(1500);
  // the text stays in the box: nothing waits, nothing reached the agent, the button is off
  expect(await p.evaluate(`document.querySelector('[contenteditable="true"]').innerText.trim()`)).toBe("Riordina le fatture di settembre");
  expect(await p.evaluate(`document.querySelector('[data-action="prompt-submit"]').disabled`)).toBe(true);
  expect(await exists('[data-slot="mango-pending-item"]')).toBe(false);
  expect(await p.evaluate("location.pathname")).toMatch(/\/new-session$/);
  expect(chats().length).toBe(before);
  await photo("2b-senza-modelli");
  await p.evaluate(`(() => { document.querySelector('[contenteditable="true"]').focus(); document.execCommand('selectAll'); document.execCommand('delete'); })()`);
  await mouseClick('[data-action="mango-choose-model"]');
  await waitUntil(() => p.evaluate(`location.pathname === "/settings" && !!document.querySelector('[data-component="settings-models"]')`) as Promise<boolean>, "Models in the settings");
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => exists('[data-component="mango-recommended"]'), "back to the welcome");
}, 60_000);

test("one button downloads the model and the app is in use meanwhile", async () => {
  await mouseClick('[data-action="mango-start"]');
  await waitUntil(() => exists('[data-component="mango-downloading"]'), "the download on the Home");
  await waitUntil(async () => /Fake model · scarico \d+%/.test(await barText()), "the download in the top bar");
  expect(await text()).toContain("Intanto, il primo progetto");
  await photo("3-scarico");
}, 60_000);

test("while it downloads the theme, the dictation, the model's settings and the first project are in reach", async () => {
  // theme: the app was dark; another choice changes it at once, and the system's brings it back
  const scheme = () => p.evaluate("document.documentElement.dataset.colorScheme") as Promise<string>;
  const before = await scheme();
  const choose = async (label: string) => {
    await mouseClick('[data-action="mango-home-theme"]');
    await waitUntil(() => exists('[role="option"]'), "the themes");
    await p.evaluate(`[...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === ${JSON.stringify(label)}).click()`);
  };
  await choose(before === "light" ? "Scuro" : "Chiaro");
  await waitUntil(async () => (await scheme()) !== before, "the theme changed");
  await choose("Sistema");
  await waitUntil(() => p.evaluate(`document.querySelector('[data-action="mango-home-theme"]').innerText.includes('Sistema')`) as Promise<boolean>, "the theme back to the system's");

  // dictation: off until the user says so; on, it downloads next to the model and says when it is ready
  const dictation = () => p.evaluate("window.__MANGO_DESKTOP__.dictation.state()") as Promise<{ enabled: boolean; status: string }>;
  expect(await dictation()).toMatchObject({ enabled: false, status: "off" });
  await p.evaluate(`document.querySelector('[data-action="settings-dictation"] input').click()`);
  await waitUntil(async () => (await dictation()).status === "ready", "the dictation ready");
  await waitUntil(async () => (await p.evaluate(`document.querySelector('[data-slot="settings-dictation-state"]')?.innerText ?? ""`)).length > 0, "the row says it is ready");
  expect(await p.evaluate(`document.querySelector('[data-action="settings-dictation"] input').checked`)).toBe(true);
  // the model that is arriving is not touched: still on its way
  expect(await barText()).toMatch(/^Fake model · scarico \d+%$/);

  // the first project: an existing folder, chosen in the Windows dialog, joins the projects
  const folder = path.join(env.root, "mio-progetto");
  fs.mkdirSync(folder);
  await mouseClick('[data-action="mango-open-folder"]');
  const picked = await answer(env.app.pid!, "-Path", folder);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(async () => (await text()).includes("mio-progetto"), "the project in the list");

  // «Cambia modello» is Models in the settings, with the download among the models, and the way back is the Home
  await mouseClick('[data-action="mango-change-model"]');
  await waitUntil(() => p.evaluate(`location.pathname === "/settings" && !!document.querySelector('[data-component="settings-models"] [data-download-row]')`) as Promise<boolean>, "Models with the download");
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => exists('[data-component="mango-downloading"]'), "the download on the Home again");
}, 120_000);

test("a message written while it downloads waits, then leaves by itself when the model is ready", async () => {
  await mouseClick('[aria-label="Nuova conversazione"]');
  await waitUntil(() => exists('[contenteditable="true"]'), "the composer of a new conversation");
  const before = chats().length;
  // Under the box the model that is coming, as the bar says it. With no model on the computer the agent offers the
  // whole catalog and its own default is «second» (it takes the last name in alphabetical order): the button must not name it.
  // waited for as it reads, not for any words: a download whose size is not known yet leaves «Nessun modello in uso»
  await waitUntil(async () => /^Fake model · (scarico \d+%|carico)$/.test(await composerText()), "the model under the box");
  expect(await p.evaluate(`document.body.innerHTML.includes("Scrivi pure: il messaggio parte quando il modello è pronto")`)).toBe(true);
  await write("Riordina le fatture di ottobre");
  await waitUntil(() => exists('[data-slot="mango-pending-item"]'), "the waiting message");
  expect(await text()).toContain("In attesa: parte da sola appena il modello è pronto");
  expect(chats().length).toBe(before);
  await photo("4-in-attesa");
  // its X puts it back in the box, and nothing waits any more; written again, it waits again
  await mouseClick('[data-action="mango-pending-restore"]');
  await waitUntil(async () => !(await exists('[data-slot="mango-pending-item"]')), "nothing waiting after the X");
  expect(await p.evaluate(`document.querySelector('[contenteditable="true"]').innerText.trim()`)).toBe("Riordina le fatture di ottobre");
  await p.evaluate(`document.querySelector('[contenteditable="true"]').focus()`);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitUntil(() => exists('[data-slot="mango-pending-item"]'), "the message waiting again");
  expect(chats().length).toBe(before);
  // A second conversation, its message sent while the model is still on its way, and the conversation made on the
  // server only once the model is ready (the request is held here): the message leaves with the model the box names,
  // never with the agent's own pick, «second», which is not on the computer.
  const second = "Prepara il riepilogo di novembre";
  const sent: unknown[] = [];
  p.on("Network.requestWillBeSent", (e) => {
    if (/\/prompt_async/.test(e.request.url) && e.request.postData?.includes(second)) sent.push(JSON.parse(e.request.postData).model);
  });
  await p.send("Network.enable");
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/session?directory=*", requestStage: "Request" }] });
  const creation = new Promise<string>((ok) =>
    p.on("Fetch.requestPaused", (e) => (e.request.method === "POST" ? ok(e.requestId) : void p.send("Fetch.continueRequest", { requestId: e.requestId }))),
  );
  await mouseClick('[aria-label="Nuova conversazione"]');
  await waitUntil(async () => (await p.evaluate("location.pathname")).endsWith("/new-session") && (await exists('[contenteditable="true"]')), "the composer of a second conversation");
  await waitUntil(async () => /^Fake model · (scarico \d+%|carico)$/.test(await composerText()), "the model under the second box");
  await write(second);
  const held = await creation;
  released = true;
  await waitUntil(async () => (await (await fetch(`${env.engine}/control/state`)).json()).model.phase === "ready", "the model ready", 120_000);
  // the window too knows it is ready: the box names it without a state
  await waitUntil(async () => (await composerText()) === "Fake model", "the model ready under the second box");
  await p.send("Fetch.continueRequest", { requestId: held });
  await p.send("Fetch.disable");
  await waitUntil(() => sent.length > 0, "the second message sent");
  await p.send("Network.disable");
  expect(sent).toEqual([{ providerID: "mango", modelID: "fake" }]);
  await waitUntil(() => chats().some((r: { body: unknown }) => JSON.stringify(r.body).includes(second)), "the second message at the engine");
  await waitUntil(() => chats().some((r: { body: unknown }) => JSON.stringify(r.body).includes("Riordina le fatture di ottobre")), "the message at the engine");
  await waitUntil(async () => !(await exists('[data-slot="mango-pending-item"]')), "the waiting message gone");
  await waitUntil(async () => (await text()).includes("Eccomi."), "the answer");
  expect(await barText()).toBe("Fake model");
  await photo("5-pronto");
}, 180_000);

test("«è pronto» is the explanation of the first time: after «Ho capito» it does not come back, not after a restart", async () => {
  const ready = '[data-component="mango-status"][data-kind="ready"]';
  await waitUntil(() => exists(ready), "the model ready, said once");
  expect(await text()).toContain("Fake model è pronto");
  await mouseClick('[data-action="mango-ready-dismiss"]');
  await waitUntil(async () => !(await exists(ready)), "the line closed");
  const conversation = (await p.evaluate("location.href")) as string;
  // The restart here kills the app, and the window keeps the last changes of its storage in memory for a while: it is
  // closed first as «Quit» closes it, which writes them to the disk.
  await closeWindowBrowser();
  await waitUntil(() => onDisk("mango.readyHint.seen"), "«Ho capito» kept by the window", 10_000);
  p.close();
  await env.restart();
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home", 60_000);
  await p.send("Page.navigate", { url: conversation });
  await waitUntil(() => exists('[contenteditable="true"]'), "the conversation again");
  await waitUntil(async () => (await (await fetch(`${env.engine}/control/state`)).json()).model.phase === "ready", "the model ready again", 120_000);
  await waitUntil(async () => (await barText()) === "Fake model", "the model in the bar");
  await Bun.sleep(2000);
  expect(await exists(ready)).toBe(false);
}, 240_000);
