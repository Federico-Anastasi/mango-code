// A conversation on an external OpenAI-compatible server (a server of the test, standing in for a cloud service) that fails, in the
// app's real window, with the real mouse and keyboard: it answers 402 (no credit), 429 (too many requests) or 500, or it stops in
// the middle of the answer. What the conversation says to the user must be a sentence of its own (the status, what the server
// said), never an empty card or a raw dump; the conversation must not hang (the box goes back to «Invia», the agent is idle, no
// request goes on by itself for ever), and once the server answers again the next message is answered. The same for the
// local model's engine closed in the middle of an answer: the conversation says so and the answer is made again with the
// engine back. Fake engine and a server in the test. `off-screen bun test --cwd integration tests/server-errors.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

setDefaultTimeout(240_000);

const MODEL = "server-model";
const SAID = "The server is fine now.";

type Mode = "ok" | "402" | "429" | "500" | "cut";
let mode: Mode = "ok";
/** The chat requests the server got, with the mode it was in when each came. */
const seen: { mode: Mode; stream: boolean }[] = [];
let server: http.Server;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

const chunk = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });

function listen(port: number) {
  const server = http.createServer(async (req, res) => {
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/models") return json(200, { object: "list", data: [{ id: MODEL, object: "model" }] });
    if (req.url === "/props") return json(200, { default_generation_settings: { n_ctx: 16384 } });
    if (req.url !== "/v1/chat/completions") return json(404, {});
    const text = await new Promise<string>((ok) => {
      let all = "";
      req.on("data", (d) => (all += d));
      req.on("end", () => ok(all));
    });
    seen.push({ mode, stream: JSON.parse(text).stream === true });
    const fail = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { error: { message, type: "error", code: status } }, headers);
    if (mode === "402") return fail(402, "Insufficient credits. Add more at the account page.");
    if (mode === "429") return fail(429, "Rate limit reached: too many requests", { "retry-after-ms": "300" });
    if (mode === "500") return fail(500, "The upstream provider crashed");
    const words = SAID.split(" ").map((w, i, all) => chunk(i < all.length - 1 ? `${w} ` : w));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = mode === "cut" ? words.slice(0, 2) : [...words, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      await Bun.sleep(40);
    }
    // the connection drops, as a server that goes away does
    if (mode === "cut") return void req.socket.destroy();
    res.end("data: [DONE]\n\n");
  });
  server.listen(port, "127.0.0.1");
  return server;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-errors-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

let env: Environment;
let p: Page;
let port: number;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const page = await p.evaluate("document.body.innerText.slice(-900)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", page, "--- console ---", ...p.console.slice(-4)].join("\n"));
    }
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const body = () => p.evaluate("document.body.innerText") as Promise<string>;
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

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
async function click(find: string, what: string) {
  const at = await centre(find);
  if (!at) throw new Error(`not on the page: ${what}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const sendLabel = () => p.evaluate(`${q('[data-action="prompt-submit"]')}?.getAttribute("aria-label")`) as Promise<string>;
const modelName = () => p.evaluate(`(${q('[data-action="prompt-model"]')}?.innerText ?? "").trim()`) as Promise<string>;

async function freshBox() {
  const before = (await p.evaluate("location.href")) as string;
  await click(q('[aria-label="Nuova conversazione"]'), "Nuova conversazione");
  await waitUntil(async () => (await p.evaluate("location.href")) !== before && ((await p.evaluate("location.pathname")) as string).endsWith("/new-session") && (await exists('[data-component="prompt-input"]')), "the box of a new conversation");
  await Bun.sleep(500);
}
/** The model under the box is the server's: chosen from its menu, with the mouse. */
async function chooseServer() {
  await waitUntil(() => exists('[data-action="prompt-model"]'), "the model button");
  if ((await modelName()).includes(MODEL)) return;
  await click(q('[data-action="prompt-model"]'), "the model button");
  await waitUntil(() => exists('[role="menu"] [data-option-key="server-1:server-model"]'), "the server's model in the menu");
  await click(q('[role="menu"] [data-option-key="server-1:server-model"]'), "the server's model");
  await waitUntil(async () => (await modelName()).includes(MODEL), "the server's model chosen");
}
async function ask(words: string) {
  await click(q('[data-component="prompt-input"]'), "the box");
  await p.send("Input.insertText", { text: words });
  await click(q('[data-action="prompt-submit"]'), "the send button");
}
/** The conversation is quiet: the box offers «Invia» and the agent says every conversation is idle. */
async function quiet(ms = 120_000) {
  await waitUntil(async () => (await sendLabel()) === "Invia", "the box back to «Invia»", ms);
  await waitUntil(async () => Object.keys(await (await fetch(`${env.agent}/session/status?directory=${encodeURIComponent(site)}`)).json()).length === 0, "the agent idle", 30_000);
}
const errorCard = () => p.evaluate(`[...document.querySelectorAll('.error-card, [data-component="card"][data-variant="error"]')].map((c) => c.textContent.trim())`) as Promise<string[]>;

beforeAll(async () => {
  port = await freePort();
  server = listen(port);
  env = await start([{ text: "Local answer." }], { window: true, args: [`${site}\\.`], servers: [{ url: `http://127.0.0.1:${port}/v1`, model: MODEL, ctx: 16384 }] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(async () => (await body()).includes("my-site"), "the project open", 60_000);
}, 240_000);

afterAll(() => {
  p?.close();
  server?.close();
  env?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a conversation on the server answers", async () => {
  await freshBox();
  await chooseServer();
  await ask("Hello server");
  await waitUntil(async () => (await body()).includes(SAID), "the server's answer", 60_000);
  await quiet();
  expect(seen.some((r) => r.mode === "ok" && r.stream)).toBe(true);
});

test("402: the conversation says the service wants credit, with what the server said; nothing hangs; the next message works once the server does", async () => {
  mode = "402";
  const before = seen.length;
  await freshBox();
  await ask("Question after the credit ran out");
  await waitUntil(async () => (await errorCard()).length > 0, "an error card", 60_000);
  const cards = await errorCard();
  await shot("09-server-402");
  expect(cards.join("\n")).toContain("Insufficient credits");
  await quiet();
  // not retried for ever: a payment error does not get better by asking again
  expect(seen.length - before).toBeLessThanOrEqual(2);
  mode = "ok";
  await ask("Now it is paid");
  await waitUntil(async () => (await body()).includes(SAID), "the answer once the server works");
  await quiet();
});

test("429: the conversation says the server refuses for too many requests; the agent tries again by itself a few times and then stops; nothing hangs", async () => {
  mode = "429";
  const before = seen.length;
  await freshBox();
  await ask("Question during the limit");
  await waitUntil(async () => (await errorCard()).length > 0, "an error card", 120_000);
  await shot("10-server-429");
  expect((await errorCard()).join("\n")).toMatch(/Rate limit|too many requests|429/i);
  await quiet();
  const tries = seen.length - before;
  expect(tries).toBeGreaterThan(1);
  expect(tries).toBeLessThanOrEqual(8);
  // nothing goes on in the background: no request arrives once the conversation is quiet
  const after = seen.length;
  await Bun.sleep(4000);
  expect(seen.length).toBe(after);
  mode = "ok";
  await ask("The limit is over");
  await waitUntil(async () => (await body()).includes(SAID), "the answer once the limit is over");
  await quiet();
});

test("500: while the agent tries again the box can stop it; the conversation is then quiet and the next message works", async () => {
  mode = "500";
  const before = seen.length;
  await freshBox();
  await ask("Question while the provider crashes");
  // it tries again: the conversation is busy and the box offers «Interrompi»
  await waitUntil(() => (seen.length - before >= 2 ? true : false), "a second try", 60_000);
  expect(await sendLabel()).toBe("Interrompi");
  await waitUntil(async () => /The upstream provider crashed|500/.test(await body()), "the conversation says why it is trying again", 20_000).catch(() => {});
  const text = await body();
  // the wait is said to the user: something about trying again, and the cause
  await shot("12-server-500-retrying");
  expect(text, "the conversation says it is trying again and why").toMatch(/The upstream provider crashed|500/);
  await click(q('[data-action="prompt-submit"]'), "the stop button");
  await quiet(30_000);
  const after = seen.length;
  await Bun.sleep(5000);
  expect(seen.length, "a request left after the stop").toBe(after);
  mode = "ok";
  await ask("The provider is back");
  await waitUntil(async () => (await body()).includes(SAID), "the answer once the provider is back");
  await quiet();
});

test("500 left alone: after its tries the conversation shows the error and is quiet", async () => {
  mode = "500";
  const before = seen.length;
  await freshBox();
  await ask("Question while the provider stays down");
  const retryLine = () => p.evaluate(`document.querySelector('[data-slot="session-turn-retry"]')?.textContent ?? ""`) as Promise<string>;
  await waitUntil(async () => (await retryLine()) !== "", "the line of the next try", 60_000);
  expect(await retryLine()).toMatch(/Il server risponde con un errore \(500\)/);
  expect(await retryLine()).not.toMatch(/riprova quando funziona|The upstream/);
  await waitUntil(async () => (await errorCard()).length > 0 && (await retryLine()) === "", "the error once the tries are over", 180_000);
  await shot("11-server-500-after-retries");
  expect((await errorCard()).join("\n")).toContain("The upstream provider crashed");
  await quiet();
  expect(seen.length - before).toBeGreaterThan(1);
  mode = "ok";
});

test("the server stops in the middle of the answer: the words that came stay, the conversation says it was cut and is quiet, and the next message works", async () => {
  mode = "cut";
  await freshBox();
  await ask("Question while the connection drops");
  await waitUntil(async () => (await body()).includes("The server"), "the first words", 60_000);
  mode = "ok";
  await quiet(180_000);
  const text = await body();
  expect(text).toContain("The server");
  // either the retry finished the answer, or the conversation shows why it stopped: it never stays silent about it
  const finished = text.includes(SAID);
  const explained = (await errorCard()).length > 0;
  expect(finished || explained, "the answer finished by a retry, or an error card says what happened").toBe(true);
  await ask("Again please");
  await waitUntil(async () => (await body()).split(SAID).length > 1 + (finished ? 1 : 0), "the next answer", 60_000);
  await quiet();
});

test("the local engine closed in the middle of an answer: the conversation says so while the agent loads it again, and the answer comes to its end by itself", async () => {
  // a model of this PC: its own engine, a long answer in slow pieces, then the engine goes away
  p.close();
  env.close();
  server.close();
  env = await start([{ text: Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ") }], { window: true, args: [`${site}\\.`], chunkMs: 100 });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(async () => (await body()).includes("my-site"), "the project open", 60_000);
  await freshBox();
  await ask("Write a very long answer");
  await waitUntil(async () => (await body()).includes("word10 "), "the answer under way", 60_000);
  const port = Number(env.appEnv.MANGO_ENGINE_PORT);
  await fetch(`http://127.0.0.1:${port}/test/crash`, { method: "POST" }).catch(() => {});
  await waitUntil(async () => (await body()).includes("Il modello si è chiuso a metà risposta"), "the conversation says the model closed", 60_000);
  await waitUntil(async () => (await body()).includes("word119"), "the answer after the retry", 180_000);
  await quiet();
});
