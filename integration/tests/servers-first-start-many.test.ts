// «Use a server» on the first start with a cloud service that lists many models, in the app's real window, with the mouse
// and the keyboard: the models that cannot call tools and those with a price that is not fixed are left out, none is chosen
// behind the user's back, the Home lists the others with their price and a search, the one clicked is the model of new
// conversations, and a message typed in a new conversation goes to it. A fake cloud service in this process, no GPU.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { removeRoot, start, type Environment } from "./environment";

const SAID = "Hello from the cheap model.";
const MODELS = [
  { id: "big/expensive", supported_parameters: ["tools"], pricing: { prompt: "0.000015", completion: "0.000075" }, context_length: 200_000 },
  { id: "small/cheap", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000004" }, context_length: 65_536 },
  { id: "small/free:free", supported_parameters: ["tools"], pricing: { prompt: "0", completion: "0" }, context_length: 32_768 },
  { id: "plain/no-tools", supported_parameters: ["temperature"], pricing: { prompt: "0.0000001", completion: "0.0000001" }, context_length: 32_768 },
  { id: "router/auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" }, context_length: 32_768 },
];

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

let env: Environment;
let p: Page;
let cloud: http.Server;
let cloudPort: number;
const chats: { model: string; messages: { role: string; content: unknown }[] }[] = [];

/** An OpenAI-compatible cloud service: its list, and every chat answered with the same words, streamed. */
function serveCloud(port: number) {
  return http
    .createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: MODELS }));
      }
      if (req.url === "/api/v1/chat/completions") {
        const asked = JSON.parse(body);
        chats.push({ model: asked.model, messages: asked.messages });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: asked.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: SAID }, null));
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: asked.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    })
    .listen(port, "127.0.0.1");
}

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(300);
  }
}

const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const text = (selector: string) => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`) as Promise<string>;
/** A click with the mouse on the first element of `selector`, brought into view. */
async function click(selector: string, what: string) {
  const at = (await p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const q = el.getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!at) throw new Error(`not on the page: ${what}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const serviceWritten = () => {
  const f = path.join(env.data, "service.json");
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
};
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

beforeAll(async () => {
  cloudPort = await freePort();
  cloud = serveCloud(cloudPort);
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "my-site-"));
  env = await start([{ text: "Local." }], { window: true, noModels: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 200_000);

afterAll(async () => {
  p?.close();
  env?.close();
  cloud?.close();
  await Bun.sleep(1500);
  if (env) removeRoot(env.root);
}, 60_000);

test("a cloud service of many models at the first start: the user chooses the model, seeing its price, and the conversation goes to it", async () => {
  await waitUntil(() => exists('[data-component="mango-welcome"] [data-action="mango-server"]'), "the welcome with «Use a server»");
  // what was found on the computer comes in above the buttons and moves them down: a person clicks once it is there
  await waitUntil(() => exists('[data-component="mango-found"]'), "what was found on the computer");
  await click('[data-action="mango-server"]', "«Usa un server»");
  const address = '[data-component="mango-welcome"] input[aria-label="Indirizzo del server"]';
  await waitUntil(() => exists(address), "the server's form", 20_000);
  await click(address, "the address");
  await p.send("Input.insertText", { text: `http://127.0.0.1:${cloudPort}/api/v1` });
  const before = serviceWritten();
  await click('[data-action="mango-server-connect"]', "«Collegati»");

  await waitUntil(() => serviceWritten() > before && readJson(path.join(env.data, "service.json")).agent !== undefined, "the app started again", 120_000);
  p.close();
  p = await windowPage(env.cdp!, readJson(path.join(env.data, "service.json")).agent, 120_000);
  const saved = readJson(path.join(env.data, "servers.json"));
  expect(saved.default).toBeNull();
  expect(saved.list[0].models.map((m: { id: string }) => m.id)).toEqual(["big/expensive", "small/cheap", "small/free:free"]);
  // the check of the server cost the least it could
  expect(chats.map((c) => c.model)).toEqual(["small/cheap"]);

  // the Home asks which model, with the price of each
  await waitUntil(() => exists('[data-component="mango-server-choice"]'), "the choice of the model");
  const rows = (await p.evaluate(`[...document.querySelectorAll('[data-action="mango-server-model"]')].map((b) => b.textContent)`)) as string[];
  expect(rows).toEqual([
    "big/expensive15,00 $ letti · 75,00 $ scritti, per milione di token",
    "small/cheap0,10 $ letti · 0,40 $ scritti, per milione di token",
    "small/free:freeGratis",
  ]);
  await click('[data-component="mango-server-choice"] input', "the search");
  await p.send("Input.insertText", { text: "cheap" });
  await waitUntil(async () => ((await p.evaluate(`document.querySelectorAll('[data-action="mango-server-model"]').length`)) as number) === 1, "one model found");
  await click('[data-action="mango-server-model"][data-model="small/cheap"]', "small/cheap");

  await waitUntil(() => readJson(path.join(env.data, "servers.json")).default?.model === "small/cheap", "the model chosen saved");
  await waitUntil(async () => !(await exists('[data-component="mango-welcome"]')), "the usual Home", 60_000);

  // the project's agents and settings reach the box after it shows, as on a loaded computer: a message typed at once waits for them
  await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/agent*" }, { urlPattern: "*/config*" }] });
  p.on("Fetch.requestPaused", (e) => {
    const late = ["/agent", "/config"].includes(new URL(e.request.url).pathname);
    setTimeout(() => void p.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}), late ? 3000 : 0);
  });

  // a new conversation, typed and sent as a person does: it goes to the chosen model
  await waitUntil(() => exists('[aria-label="Nuova conversazione"]'), "the project open", 60_000);
  await click('[aria-label="Nuova conversazione"]', "«Nuova conversazione»");
  await waitUntil(() => exists('[data-component="prompt-input"]'), "the box");
  await waitUntil(async () => (await text('[data-component="prompt-input-v2"]')).includes("small/cheap"), "the box on the chosen model", 30_000);
  await click('[data-component="prompt-input"]', "the box");
  await p.send("Input.insertText", { text: "Say hello" });
  await click('[data-action="prompt-submit"]', "send");
  await waitUntil(async () => ((await p.evaluate("document.body.textContent")) as string).includes(SAID), "the answer of the cloud model");
  expect(chats.at(-1)?.model).toBe("small/cheap");
}, 400_000);
