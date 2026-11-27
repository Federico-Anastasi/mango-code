// «Use a server» as the user meets it, in the app's real window with real mouse and keyboard events, against fake servers
// that answer like llama-server (the model's file as its name), like a service that asks for a key, and like LM Studio with
// nothing loaded or with loading on request. Errors of adding say what is wrong in the app's own words; a server's models are
// read by their names, never by a file path; the card names the models and keeps its buttons on one line; the default model
// of new conversations is what the title bar says, with the same models as the menu under the chat; «Refresh the list» tells
// what it changed; «Remove» asks first. The photos go to the folder `MANGO_TEST_SCREENSHOTS` names, else to the environment's.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { removeRoot, saveScreenshot, start, type Environment } from "./environment";

setDefaultTimeout(300_000);

const KEY = "sk-test-server-key-0123456789";
const SHORT = "D:\\models\\Qwen3.5-4B-Q4_K_M.gguf";
const SHORT_NAME = "Qwen3.5-4B-Q4_K_M";
const LONG = "D:\\models\\unsloth\\Qwen3.5-35B-A3B-Instruct-Extra-Long-Name-For-The-Wrap-Check-UD-Q4_K_XL.gguf";
const LONG_NAME = "Qwen3.5-35B-A3B-Instruct-Extra-Long-Name-For-The-Wrap-Check-UD-Q4_K_XL";
const OTHER = "/srv/models/gemma-4-12b-it-Q4_K_M.gguf";
const OTHER_NAME = "gemma-4-12b-it-Q4_K_M";
const CARD = '[data-link-card="servers"]';

type Listed = { id: string; name?: string; context_length?: number; pricing?: { prompt: string; completion: string } };
type Settings = { models: Listed[]; ctx: number | null; key?: string; downloaded?: unknown };

/** An OpenAI-compatible server whose answers the test changes while it runs. */
function listen(port: number, set: Settings) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const sent = req.headers.get("authorization");
      if (set.key && sent !== `Bearer ${set.key}` && url.pathname.startsWith("/v1"))
        return json(401, { error: { message: sent ? "Invalid API key" : "Missing Authentication header" } });
      if (url.pathname === "/v1/models") return json(200, { object: "list", data: set.models.map((m) => ({ object: "model", ...m })) });
      if (url.pathname === "/props" && set.ctx) return json(200, { default_generation_settings: { n_ctx: set.ctx } });
      if (url.pathname === "/api/v0/models" && set.downloaded) return json(200, set.downloaded);
      if (url.pathname === "/v1/chat/completions") return json(200, { choices: [{ message: { role: "assistant", content: "H" } }] });
      return json(404, {});
    },
  });
}

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
const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

let env: Environment;
let p: Page;
const stoppers: (() => void)[] = [];
const llama: Settings = { models: [{ id: SHORT }, { id: LONG }], ctx: 32768 };
const keyed: Settings = { models: [{ id: "service/model-a", name: "Model A" }], ctx: null, key: KEY };
const lmStudio: Settings = {
  models: [{ id: "text-embedding-nomic-embed-text-v1.5" }],
  ctx: null,
  downloaded: { object: "list", data: [{ id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" }, { id: "qwen/qwen3-4b", type: "llm", state: "not-loaded" }] },
};
const FREE = { prompt: "0", completion: "0" };
const CHEAP = { prompt: "0.0000001", completion: "0.0000004" };
const cloud: Settings = {
  ctx: null,
  models: [
    { id: "qwen/qwen3-235b-a22b-thinking", name: "Qwen3 235B A22B Thinking", context_length: 131072, pricing: CHEAP },
    { id: "qwen/qwen3-coder", name: "Qwen3 Coder", context_length: 4095, pricing: FREE },
    ...Array.from({ length: 38 }, (_, i) => ({
      id: `vendor/model-${String(i + 1).padStart(2, "0")}`,
      name: `Vendor model ${i + 1}`,
      context_length: 65536,
      pricing: { prompt: "0.0000003", completion: "0.0000012" },
    })),
  ],
};
let llamaPort: number;
let keyedPort: number;
let lmPort: number;
let cloudPort: number;

const service = () => readJson(path.join(env.data, "service.json"));
const serversFile = () => path.join(env.data, "servers.json");
const serviceWritten = () => {
  const f = path.join(env.data, "service.json");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
};
const shot = async (name: string) => saveScreenshot(env, name, (await p.send("Page.captureScreenshot", { format: "png" })).result.data);

async function startedAgain(before: number) {
  await waitUntil(() => serviceWritten() > before && readJson(path.join(env.data, "service.json")).agent !== undefined, "the app started again", 120_000);
  p.close();
  p = await windowPage(env.cdp!, service().agent, 120_000);
  await waitUntil(() => p.evaluate(`!!window.__MANGO_DESKTOP__?.servers`), "the bridge on the new page", 60_000);
}

const at = async (selector: string) => {
  await p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
  const point = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  if (!point) throw new Error(`not on the page: ${selector}`);
  return point as { x: number; y: number };
};
/** A click with the mouse, like a person: menus open on the pointer, not on a click event alone. */
async function mouseClick(selector: string) {
  const point = await at(selector);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
}
/** Types in a field as a person does: a click in it, what was there selected, then the text as the keyboard gives it. */
async function typeInto(selector: string, text: string) {
  await mouseClick(selector);
  await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  if (text) await p.send("Input.insertText", { text });
  else await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
}
const enter = async () => {
  for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
};
const exists = (selector: string): Promise<boolean> => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const text = (selector: string): Promise<string> => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

async function openConnections() {
  await p.send("Page.navigate", { url: `${service().agent}/settings?section=links` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="settings-servers-open"]')`), "the card", 60_000);
  if (!(await p.evaluate(`!!document.querySelector('${CARD} [data-action="settings-servers-form"]')`))) await mouseClick('[data-action="settings-servers-open"]');
  await waitUntil(() => p.evaluate(`!!document.querySelector('${CARD} [data-action="settings-servers-form"]')`), "the form", 20_000);
}

/** Types an address and a key in the card and submits with the keyboard; the sentence the card ends with. */
async function tryAdding(address: string, key: string) {
  await typeInto(`${CARD} input[aria-label="Indirizzo del server"]`, address);
  await typeInto(`${CARD} input[aria-label="Chiave del server"]`, key);
  await enter();
  await waitUntil(() => p.evaluate(`!!document.querySelector('${CARD} .settings-page-error')`), "the sentence", 90_000);
  return text(`${CARD} .settings-page-error`);
}

beforeAll(async () => {
  [llamaPort, keyedPort, lmPort, cloudPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  for (const [port, set] of [[llamaPort, llama], [keyedPort, keyed], [lmPort, lmStudio], [cloudPort, cloud]] as const) {
    const server = listen(port, set);
    stoppers.push(() => server.stop(true));
  }
  env = await start([{ text: "Local." }], { window: true });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 200_000);

afterAll(async () => {
  p?.close();
  env?.close();
  stoppers.forEach((stop) => stop());
  await Bun.sleep(1500);
  if (env) removeRoot(env.root);
}, 60_000);

test("a server that asks for a key, a wrong key, nothing listening and LM Studio with nothing loaded each say what is wrong", async () => {
  await openConnections();
  const missing = await tryAdding(`127.0.0.1:${keyedPort}`, "");
  expect(missing).toContain("chiede una chiave");
  expect(missing).not.toContain("lasciala vuota");
  await shot("01-add-key-missing");
  const wrong = await tryAdding(`127.0.0.1:${keyedPort}`, "sk-wrong");
  expect(wrong).toContain("rifiuta la chiave");
  expect(wrong).not.toContain("chiede una chiave");
  await shot("02-add-key-wrong");
  const silent = await tryAdding(`127.0.0.1:${await freePort()}`, "");
  expect(silent).toContain("non risponde");
  expect(silent).not.toMatch(/os error|\(io|10061|Impossibile|\(dettaglio/i);
  await shot("03-add-nothing-listens");
  const none = await tryAdding(`127.0.0.1:${lmPort}`, "");
  expect(none).toContain("LM Studio");
  expect(none).toContain("Just-In-Time");
  expect(none).not.toContain("nessun modello caricato");
  await shot("04-add-lm-studio-nothing-loaded");
  expect(fs.existsSync(serversFile())).toBe(false);
});

test("LM Studio that loads on request lists its models: they are offered, named as it names them", async () => {
  lmStudio.models = [{ id: "qwen/qwen3-4b" }, { id: "text-embedding-nomic-embed-text-v1.5" }];
  const before = serviceWritten();
  await typeInto(`${CARD} input[aria-label="Indirizzo del server"]`, `127.0.0.1:${lmPort}`);
  await enter();
  // LM Studio does not say the context: the card asks, proposing a number
  await waitUntil(() => p.evaluate(`document.querySelector('${CARD} input[aria-label="Contesto dei modelli, in token"]')?.value === "32768"`), "the context proposed", 60_000);
  expect(await text(`${CARD} [data-slot="settings-servers-status"]`)).toContain("non dice quanto contesto");
  await mouseClick(`${CARD} [data-action="settings-servers-form"] button[type="submit"]`);
  await startedAgain(before);
  expect(readJson(serversFile()).list[0].models.map((m: { id: string }) => m.id)).toEqual(["qwen/qwen3-4b"]);
  await openConnections();
  expect(await text(`${CARD} [data-slot="settings-server-models"]`)).toBe("qwen/qwen3-4b");
  await shot("05-lm-studio-added");
  const id = readJson(serversFile()).list[0].id;
  const before2 = serviceWritten();
  await mouseClick(`${CARD} [data-server="127.0.0.1:${lmPort}"] [data-action="settings-server-remove"]`);
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="settings-server-remove-confirm"]')`), "the confirmation", 20_000);
  await mouseClick('[data-action="settings-server-remove-confirm"]');
  await startedAgain(before2);
  expect(readJson(serversFile()).list.some((s: { id: string }) => s.id === id)).toBe(false);
});

test("a llama-server's models are named without folder and extension, the card says which it offers, its buttons stay on one line", async () => {
  await openConnections();
  const before = serviceWritten();
  await typeInto(`${CARD} input[aria-label="Indirizzo del server"]`, `127.0.0.1:${llamaPort}`);
  await enter();
  await startedAgain(before);
  await openConnections();
  const card = `${CARD} [data-server="127.0.0.1:${llamaPort}"]`;
  expect(await text(`${card} [data-slot="settings-server-models"]`)).toBe(`${SHORT_NAME}, ${LONG_NAME}`);
  expect(await text(`${card} [data-action="settings-server-default"]`)).toBe("Non predefinito");
  await shot("06-card-llama-server");
  // a server of two models lists them with no search; with the long name chosen the card's buttons stay on its line
  expect(await exists(`${card} [data-slot="settings-server-small"]`)).toBe(false);
  await mouseClick(`${card} [data-action="settings-server-default"]`);
  const list = `${card} [data-component="server-model-list"]`;
  await waitUntil(() => exists(list), "the models", 20_000);
  expect(await exists(`${list} input`)).toBe(false);
  const options: string[] = await p.evaluate(`[...document.querySelectorAll('${list} button')].map((o) => o.textContent)`);
  expect(options).toEqual(["Non predefinito", SHORT_NAME, LONG_NAME]);
  await p.evaluate(`[...document.querySelectorAll('${list} button')].find((o) => o.textContent === ${JSON.stringify(LONG_NAME)}).setAttribute("data-test-pick", "")`);
  await mouseClick(`[data-test-pick]`);
  await waitUntil(async () => (await text(`${card} [data-action="settings-server-default"]`)) === LONG_NAME, "the long name chosen", 20_000);
  expect(await exists(list)).toBe(false);
  const tops: number[] = await p.evaluate(
    `['[data-action="settings-server-default"]', '[data-action="settings-server-refresh"]', '[data-action="settings-server-remove"]'].map((s) => Math.round(document.querySelector('${card} ' + s).getBoundingClientRect().top))`,
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(6);
  const heights: number[] = await p.evaluate(`['[data-action="settings-server-refresh"]', '[data-action="settings-server-remove"]'].map((s) => Math.round(document.querySelector('${card} ' + s).getBoundingClientRect().height))`);
  expect(Math.max(...heights)).toBeLessThan(40);
  // the bar names the model new conversations use now, at once, though the local model stays loaded
  await waitUntil(async () => (await text('[data-action="titlebar-model"]')).includes(LONG_NAME), "the bar names the new default", 3_000);
  await shot("07-card-long-default");
});

test("with the default on the server the title bar names it, and its menu offers what the menu under the chat offers", async () => {
  expect(readJson(serversFile()).default).toEqual({ server: "server-2", model: LONG });
  const before = serviceWritten();
  await env.restart();
  await startedAgain(before);
  const bar = '[data-action="titlebar-model"]';
  await waitUntil(async () => (await text(bar)).includes(LONG_NAME), "the bar names the default", 60_000);
  expect(await text(bar)).not.toContain("Nessun modello");
  await mouseClick(bar);
  await waitUntil(() => p.evaluate(`!!document.querySelector('[role="menu"] [data-option-key^="server-"]')`), "the server's models in the bar menu", 20_000);
  const menu = async (root: string) =>
    p.evaluate(`(() => {
      const rows = [...document.querySelectorAll('${root} [data-option-key^="server-"]')];

      return { rows: rows.map((r) => r.textContent.replace(/Predefinito|In uso/g, "").trim()), whole: document.querySelector('${root}')?.textContent ?? "" };
    })()`);
  const inBar = await menu('[role="menu"]');
  expect(inBar.rows).toEqual([LONG_NAME, SHORT_NAME]);
  expect(inBar.whole).toContain("Questo PC");
  expect(inBar.whole).toContain(`127.0.0.1:${llamaPort}`);
  expect(inBar.whole.split("Predefinito").length - 1).toBe(1);
  await shot("08-titlebar-menu-server-default");
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // the menu under the chat, in a conversation of the project
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "names" });
  await p.send("Page.navigate", { url: `${service().agent}/${b64(env.project)}/session/${id}` });
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="prompt-model"]')`), "the model button", 60_000);
  await Bun.sleep(1500);
  await mouseClick('[data-action="prompt-model"]');
  await waitUntil(() => p.evaluate(`!!document.querySelector('[role="menu"] [data-option-key^="server-"]')`), "the server's models under the chat", 20_000);
  const underChat = await menu('[role="menu"]');
  expect(underChat.rows).toEqual(inBar.rows);
  expect(underChat.whole).toContain("Questo PC");
  expect(underChat.whole).toContain(`127.0.0.1:${llamaPort}`);
  await shot("09-menu-under-the-chat");
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  // a new conversation says the same model as the bar, by its name
  await waitUntil(async () => (await text('[data-action="prompt-model"]')).includes(LONG_NAME) || (await text('[data-action="prompt-model"]')).includes(SHORT_NAME), "the button names a model", 20_000);
  expect(await text('[data-action="prompt-model"]')).not.toMatch(/D:|\.gguf|\\/);
});

test("«Refresh the list» says in one line what it changed: the default model gone and what new conversations use, the context", async () => {
  await openConnections();
  const card = `${CARD} [data-server="127.0.0.1:${llamaPort}"]`;
  llama.models = [{ id: OTHER }];
  llama.ctx = 16384;
  await mouseClick(`${card} [data-action="settings-server-refresh"]`);
  await waitUntil(() => p.evaluate(`!!document.querySelector('${card} [data-slot="settings-server-notice"]')`), "the notice", 60_000);
  const notices: string[] = await p.evaluate(`[...document.querySelectorAll('${card} [data-slot="settings-server-notice"]')].map((n) => n.textContent)`);
  expect(notices).toEqual([
    `Il modello «${LONG_NAME}» non c'è più su questo server: le conversazioni nuove usano Fake model.`,
    "Il contesto dei modelli è passato da 32.768 a 16.384 token.",
  ]);
  expect(readJson(serversFile()).default).toBe(null);
  expect(await text(`${card} [data-slot="settings-server-models"]`)).toBe(OTHER_NAME);
  // the server has one model and it is small: the line names it
  expect(await text(`${card} [data-slot="settings-server-small"]`)).toStartWith(`«${OTHER_NAME}» ha 16.384 token di contesto`);
  // the bar does not keep naming the model that is gone
  await waitUntil(async () => (await text('[data-action="titlebar-model"]')).includes("Fake model"), "the bar names the local model", 3_000);
  await shot("10-refresh-says-what-changed");
});

test("«Remove» asks first: cancelling keeps the server, confirming removes it", async () => {
  const card = `${CARD} [data-server="127.0.0.1:${llamaPort}"]`;
  await mouseClick(`${card} [data-action="settings-server-remove"]`);
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="settings-server-remove-confirm"]')`), "the confirmation", 20_000);
  expect(await p.evaluate(`document.querySelector('[role="dialog"]')?.textContent ?? ""`)).toContain(`Togli «127.0.0.1:${llamaPort}»?`);
  await shot("11-remove-asks-first");
  expect(readJson(serversFile()).list.length).toBe(1);
  const cancel = await p.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].findIndex((b) => b.textContent.trim() === "Annulla")`);
  expect(cancel).toBeGreaterThanOrEqual(0);
  await p.evaluate(`document.querySelectorAll('[role="dialog"] button')[${cancel}].click()`);
  await waitUntil(() => p.evaluate(`!document.querySelector('[data-action="settings-server-remove-confirm"]')`), "the dialog closed", 20_000);
  expect(readJson(serversFile()).list.length).toBe(1);
  const before = serviceWritten();
  await mouseClick(`${card} [data-action="settings-server-remove"]`);
  await waitUntil(() => p.evaluate(`!!document.querySelector('[data-action="settings-server-remove-confirm"]')`), "the confirmation again", 20_000);
  await mouseClick('[data-action="settings-server-remove-confirm"]');
  await startedAgain(before);
  expect(readJson(serversFile()).list).toEqual([]);
});

test("a service of many models: the default is chosen from a list with a search and the prices, only when a model is picked; the small-context line is about the model in use", async () => {
  await openConnections();
  const before = serviceWritten();
  await typeInto(`${CARD} input[aria-label="Indirizzo del server"]`, `127.0.0.1:${cloudPort}`);
  await enter();
  await startedAgain(before);
  await openConnections();
  const card = `${CARD} [data-server="127.0.0.1:${cloudPort}"]`;
  const button = `${card} [data-action="settings-server-default"]`;
  const list = `${card} [data-component="server-model-list"]`;
  const small = `${card} [data-slot="settings-server-small"]`;
  const rows = (): Promise<string[]> => p.evaluate(`[...document.querySelectorAll('${list} [data-action="mango-server-model"]')].map((r) => r.textContent)`);
  // one model of the forty has a small context, but it is not the one in use: the card says nothing
  expect(readJson(serversFile()).default).toBeNull();
  expect(await text(button)).toBe("Non predefinito");
  expect(await exists(small)).toBe(false);

  await mouseClick(button);
  await waitUntil(() => exists(list), "the list of the models", 20_000);
  expect(await exists(`${list} input[aria-label="Cerca un modello"]`)).toBe(true);
  expect(await rows()).toHaveLength(40);
  expect((await rows())[0]).toBe("Qwen3 235B A22B Thinking0,10 $ letti · 0,40 $ scritti, per milione di token");
  expect((await rows())[1]).toBe("Qwen3 CoderGratis");
  expect((await rows())[2]).toBe("Vendor model 10,30 $ letti · 1,20 $ scritti, per milione di token");
  await shot("12-card-list-with-prices");

  // typing to find a model chooses nothing: the default stays as it is and the agent is not started again
  const written = serviceWritten();
  await mouseClick(`${list} input`);
  for (const char of "qwen3 235") {
    await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
  }
  await waitUntil(async () => (await rows()).length === 1, "one model found", 20_000);
  expect(await text(`${list} [data-action="mango-server-model"]`)).toStartWith("Qwen3 235B A22B Thinking");
  await Bun.sleep(1500);
  expect(readJson(serversFile()).default).toBeNull();
  expect(serviceWritten()).toBe(written);
  expect(await text(button)).toBe("Non predefinito");

  // a click on the model chooses it
  await mouseClick(`${list} [data-action="mango-server-model"]`);
  await waitUntil(() => readJson(serversFile()).default?.model === "qwen/qwen3-235b-a22b-thinking", "the default saved", 30_000);
  expect(readJson(serversFile()).default).toEqual({ server: readJson(serversFile()).list[0].id, model: "qwen/qwen3-235b-a22b-thinking" });
  await openConnections();
  expect(await text(button)).toBe("Qwen3 235B A22B Thinking");
  expect(await exists(list)).toBe(false);
  expect(await exists(small)).toBe(false);

  // a default with a small context: the line names it
  await mouseClick(button);
  await waitUntil(() => exists(list), "the list again", 20_000);
  await mouseClick(`${list} input`);
  await p.send("Input.insertText", { text: "coder" });
  await waitUntil(async () => (await rows()).length === 1, "the coder found", 20_000);
  await shot("13-card-search-one-model");
  await mouseClick(`${list} [data-action="mango-server-model"]`);
  await waitUntil(() => readJson(serversFile()).default?.model === "qwen/qwen3-coder", "the coder saved", 30_000);
  await openConnections();
  expect(await text(button)).toBe("Qwen3 Coder");
  expect(await text(small)).toStartWith("«Qwen3 Coder» ha 4095 token di contesto");
  await shot("14-card-default-small-context");

  // «Not the default» is a row of its own, reached and chosen with the keyboard
  await mouseClick(button);
  await waitUntil(() => exists(list), "the list a third time", 20_000);
  await p.evaluate(`document.querySelector('${list} [data-action="mango-server-model-none"]').focus()`);
  await enter();
  await waitUntil(() => readJson(serversFile()).default === null, "the default removed", 30_000);
  await openConnections();
  expect(await text(button)).toBe("Non predefinito");
  expect(await exists(small)).toBe(false);
});
