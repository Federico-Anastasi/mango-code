// "Share the engine with my PCs" with the real app and the fake engine, from the side of another PC: it only has a code
// (`mango://ip:port/key`) and `fetch`. Off by default: the port is closed; on: the right code gets the models the PC offers and a
// reply that arrives in pieces; a wrong or missing key gets 401; the GPUs' routes are refused; turned off, the port closes and the
// old code does not come back. Everything goes through the bridge, as the settings use it; the PC that uses the code is in
// engine-remote.test.ts. The port is on 127.0.0.1 (`MANGO_SHARE_PC_ONLY`, only in development builds): the test does not make
// Windows ask to open it on the network, and the firewall is not tried.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let p: Page;
let port: number;

beforeAll(async () => {
  port = await new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });
  env = await start([{ text: "Hello from the fake engine." }], {
    window: true,
    env: { MANGO_SHARE_PC_ONLY: "1", MANGO_SHARE_PORT: String(port) },
  });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const bridge = (code: string) => p.evaluate(`window.__MANGO_DESKTOP__.engineShare.${code}`);

/** What the other PC does with a code: address and key apart, the key as a bearer. */
function client(code: string) {
  const m = code.match(/^mango:\/\/(\d+\.\d+\.\d+\.\d+:\d+)\/([0-9a-f]{48})$/);
  if (!m) throw new Error(`not a code: ${code}`);
  const [, address, key] = m;
  return {
    address,
    key,
    get: (route: string, k = key) => fetch(`http://${address}${route}`, { headers: { authorization: `Bearer ${k}` } }),
    post: (route: string, body: object, k = key) =>
      fetch(`http://${address}${route}`, { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

test("off by default: the port is closed and no file was written", async () => {
  const state = await bridge("state()");
  expect(state).toMatchObject({ enabled: false, listening: false, home: null, away: null, port });
  expect(fs.existsSync(path.join(env.data, "engine-share.json"))).toBe(false);
  expect(await fetch(`http://127.0.0.1:${port}/mango/models`).then(() => "open", () => "closed")).toBe("closed");
});

let code = "";

test("on: the code gives the models and a reply in pieces; a wrong or missing key gets 401", async () => {
  const state = await bridge("setEnabled(true)");
  expect(state).toMatchObject({ enabled: true, listening: true, error: null, port, away: null });
  code = state.home.code;
  expect(state.home.address).toBe(`127.0.0.1:${port}`);
  const c = client(code);

  // what the other PC reads first: the models this PC offers
  const models = await (await c.get("/mango/models")).json();
  expect(models.models).toEqual([{ key: "fake", label: "Fake model", context: 16384, images: false }]);

  // …and the conversation: the reply comes in several pieces, like the engine's own
  const reply = await c.post("/v1/chat/completions", { model: "fake", stream: true, messages: [{ role: "user", content: "Hello" }] });
  expect(reply.status).toBe(200);
  expect(reply.headers.get("content-type")).toContain("text/event-stream");
  const reader = reply.body!.getReader();
  let text = "";
  let reads = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    text += new TextDecoder().decode(r.value);
    reads++;
  }
  expect(reads).toBeGreaterThan(1);
  expect(text).toContain("[DONE]");
  const said = [...text.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "").join("");
  expect(said).toBe("Hello from the fake engine.");
  // the engine says which model is running, and the key is not in what the engine received
  expect((await (await c.get("/mango/models")).json()).running).toBe("fake");
  expect(fs.readFileSync(env.engineLog, "utf8")).not.toContain(c.key);

  // wrong key, no key, a key almost right
  const wrong = await c.get("/mango/models", "0".repeat(48));
  expect(wrong.status).toBe(401);
  expect((await wrong.json()).error.message).toContain("chiave");
  expect((await fetch(`http://${c.address}/mango/models`)).status).toBe(401);
  expect((await c.get("/v1/models", c.key.slice(0, 47) + "0")).status).toBe(401);
});

test("the GPUs' routes and the engine's writes stay on the PC", async () => {
  const c = client(code);
  for (const route of ["/engine/release", "/engine/resume", "/engine/model", "/slots/0?action=erase", "/props"]) {
    expect((await c.post(route, {})).status).toBe(403);
  }
  expect((await c.get("/v1/../engine/release")).status).toBe(403);
  // a web page, even with the key
  const page = await fetch(`http://${c.address}/mango/models`, { headers: { authorization: `Bearer ${c.key}`, origin: "https://evil.example" } });
  expect(page.status).toBe(403);
  expect((await (await fetch(`${env.engine}/engine`)).json()).loans).toEqual([]);
  // the manager's log has the refusals and never the key
  const log = fs.readFileSync(path.join(env.data, "logs", "manager.log"), "utf8");
  expect(log).toContain("share refused");
  expect(log).not.toContain(c.key);
});

test("a new key drops the old code; off closes the port and the old code never comes back", async () => {
  const old = client(code);
  const renewed = await bridge("newKey()");
  expect(renewed.home.code).not.toBe(code);
  expect((await old.get("/mango/models")).status).toBe(401);
  const current = client(renewed.home.code);
  expect((await current.get("/mango/models")).status).toBe(200);

  const off = await bridge("setEnabled(false)");
  expect(off).toMatchObject({ enabled: false, listening: false, home: null });
  expect(await fetch(`http://${current.address}/mango/models`).then(() => "open", () => "closed")).toBe("closed");
  expect(fs.readFileSync(path.join(env.data, "engine-share.json"), "utf8")).not.toContain(current.key);

  const again = client((await bridge("setEnabled(true)")).home.code);
  expect(again.key).not.toBe(current.key);
  expect((await current.get("/mango/models")).status).toBe(401);
  expect((await again.get("/mango/models")).status).toBe(200);
  await bridge("setEnabled(false)");
});
