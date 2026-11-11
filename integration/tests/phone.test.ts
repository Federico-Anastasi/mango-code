// "From your phone" with the real app: off by default; turned on from the settings (the window's bridge), the link
// with the key gives the cookie and from there the web UI and the agent's routes pass through the phone port; a
// foreign page does not; turned off, the port closes. The port sits on 127.0.0.1 (`MANGO_PHONE_PC_ONLY`, only in
// development builds): the test does not make Windows ask to open it on the network. The rules one by one are the
// tests of the `phone` crate (`cargo test -p phone`); that it listens only on the addresses of the links is one of them.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let p: Page;
let port: number;
let base: string;

beforeAll(async () => {
  port = await new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });
  base = `http://127.0.0.1:${port}`;
  env = await start([{ text: "Hello from the fake engine." }], {
    window: true,
    env: { MANGO_PHONE_PC_ONLY: "1", MANGO_PHONE_PORT: String(port), MANGO_NETWORK_PUBLIC: "1" },
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

const bridge = (code: string) => p.evaluate(`window.__MANGO_DESKTOP__.phone.${code}`);
const key = () => JSON.parse(fs.readFileSync(path.join(env.data, "phone.json"), "utf8")).key as string;

test("off by default: the port is not open", async () => {
  expect((await bridge("state()")).enabled).toBe(false);
  expect(fs.existsSync(path.join(env.data, "phone.json"))).toBe(false);
  expect(await fetch(`${base}/`).then(() => "open", () => "closed")).toBe("closed");
});

test("on: with the link you get in and the web UI and the agent pass; without it, no", async () => {
  const state = await bridge("setEnabled(true)");
  expect(state.enabled).toBe(true);
  expect(state.listening).toBe(true);
  expect(state.port).toBe(port);
  // Windows calls the home network public (here by the development switch): the link says so; Tailscale's never does
  if (state.home) expect(state.home.public).toBe(true);
  if (state.away) expect(state.away.public).toBe(false);

  expect((await fetch(`${base}/`, { headers: { accept: "text/html" } })).status).toBe(401);
  expect((await fetch(`${base}/phone?key=wrong`, { redirect: "manual" })).status).toBe(401);

  const entry = await fetch(`${base}/phone?key=${key()}`, { redirect: "manual" });
  expect(entry.status).toBe(303);
  const cookie = entry.headers.get("set-cookie")!.split(";")[0];
  expect(cookie).toStartWith("mango_phone=");

  const home = await fetch(`${base}/`, { headers: { cookie, accept: "text/html" } });
  expect(home.status).toBe(200);
  expect(await home.text()).toContain('id="root"');
  const directory = encodeURIComponent(env.project);
  const sessions = await fetch(`${base}/session?directory=${directory}`, { headers: { cookie } });
  expect(sessions.status).toBe(200);
  expect(Array.isArray(await sessions.json())).toBe(true);
  // The phone's web UI sends the phone port's Origin: the agent treats it as its own.
  const fromPage = await fetch(`${base}/session?directory=${directory}`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
  expect(fromPage.status).toBe(200);

  const foreign = await fetch(`${base}/session?directory=${directory}`, { method: "POST", headers: { cookie, origin: "https://foreign-site.example", "content-type": "application/json" }, body: "{}" });
  expect(foreign.status).toBe(403);
  expect((await fetch(`${base}/mango/warmup?directory=${directory}`, { method: "POST", headers: { cookie } })).status).toBe(403);
  // The log does not have the key.
  expect(fs.readFileSync(path.join(env.data, "logs", "phone.log"), "utf8")).not.toContain(key());
}, 60_000);

test("off: the port closes and the link is no longer valid", async () => {
  const old = key();
  expect((await bridge("setEnabled(false)")).enabled).toBe(false);
  expect(await fetch(`${base}/`).then(() => "open", () => "closed")).toBe("closed");
  await bridge("setEnabled(true)");
  expect((await fetch(`${base}/phone?key=${old}`, { redirect: "manual" })).status).toBe(401);
  await bridge("setEnabled(false)");
});
