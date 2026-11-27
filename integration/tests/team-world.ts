// The Team with the real app and the real agent, against a FAKE cloud provider: a second fake engine, on its own port, that
// answers like OpenRouter (`/v1/chat/completions`, with tool calls, streaming, and a log that keeps the headers). The local
// model is the usual fake engine. No network, no GPU, no real key: the key is a made-up string that the app keeps in the
// Credential Manager under the test's own service (derived from the data folder) and removes at the end.
// The Team's dev listens on port 4090 (fixed, `agent-cfg` team.rs): the tests refuse to run if it is busy.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { page, windowPage, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, start, type Environment } from "./environment";

export const KEY = "sk-or-v1-fake-test-key-0123456789";
export const CLOUD_MODEL = "fake/manager";
export const DEV_PORT = 4090;

export interface World {
  env: Environment;
  /** The window's page (the interface). */
  p: Page;
  cloud: ChildProcess;
  cloudLog: string;
  api: (route: string, init?: RequestInit) => Promise<Response>;
  bridge: (code: string) => Promise<any>;
}

const free = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

const busy = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), ok(true)));
    s.on("error", () => ok(false));
  });

export async function until<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, ms = 90_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(300);
  }
}

export const lines = (file: string): any[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
export const completions = (file: string) => lines(file).filter((r) => r.route === "/v1/chat/completions");
export const toolNames = (request: any): string[] => (request.body.tools ?? []).map((t: any) => t.function?.name);

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid the plugin wrote for the hidden `dev` or `agents/agent-N`, if there is one. */
export const hiddenPid = (world: World, name: string) => {
  try {
    return Number(fs.readFileSync(path.join(world.env.data, "team", `${name}.pid`), "utf8")) || 0;
  } catch {
    return 0;
  }
};

/**
 * `local`: the local fake engine's script (the dev's); `cloud`: the fake cloud's (the manager's and the agents'); `agents`:
 * how many agents the Team may start; `chunkMs`: how slowly the local engine speaks. The key is saved and the app has started
 * again with the Team on.
 */
export async function startWorld(local: unknown[], cloud: unknown[], options: { agents: number; chunkMs?: number }): Promise<World> {
  if (await busy(DEV_PORT)) throw new Error(`port ${DEV_PORT} (the Team's dev) is busy: close the program that uses it`);
  const env = await start(local, { window: true, chunkMs: options.chunkMs });
  const port = await free();
  const cloudLog = path.join(env.root, "cloud-requests.jsonl");
  const script = path.join(env.root, "cloud-script.json");
  fs.writeFileSync(script, JSON.stringify(cloud));
  const process_ = spawn(FAKE_ENGINE_EXE, ["-m", "cloud.gguf", "--port", String(port)], {
    cwd: env.root,
    env: { ...process.env, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_LOG: cloudLog, FAKE_ENGINE_CHUNK_MS: "20" },
    stdio: "ignore",
  });
  await until("the fake cloud", async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);

  // The catalog gets the cloud model that points at the fake provider; the app reads it when the choices are saved and at every start.
  const catalog = path.join(env.root, "dist", "mango-models.json");
  const c = JSON.parse(fs.readFileSync(catalog, "utf8"));
  c.models.cloudfake = {
    label: "Cloud fake",
    quant: "cloud",
    kind: "cloud / fake",
    ctx: 65536,
    cloud: {
      provider_key: "openrouter",
      model_id: CLOUD_MODEL,
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key_field: "OPENROUTER_API_KEY",
      cost: { input: 1, output: 2, cache_read: 0.1 },
      image: false,
    },
  };
  fs.writeFileSync(catalog, JSON.stringify(c));

  const world = { env, cloud: process_, cloudLog } as World;
  world.p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
  world.api = (route, init) => fetch(`${env.agent}${route}`, init);
  world.bridge = (code) => world.p.evaluate(`window.__MANGO_DESKTOP__.team.${code}`);
  await world.bridge(`save(${options.agents}, "cloudfake", "cloudfake")`);
  if ((await world.bridge("info()")).key) throw new Error("the environment already has a Team key");
  await world.bridge(`setKey(${JSON.stringify(KEY)})`); // the app restarts the agent with the Team on
  await until("the agent with the Team", async () => {
    const providers = await (await world.api(`/config/providers?directory=${encodeURIComponent(env.project)}`)).json();
    return providers.providers.some((x: any) => x.id === "openrouter");
  });
  await followWindow(world);
  return world;
}

/** After a restart of the agent: the window is on the agent again (its address may be new), with its bridge. */
export async function followWindow(world: World) {
  world.p.close();
  const service = () => JSON.parse(fs.readFileSync(path.join(world.env.data, "service.json"), "utf8"));
  await until("the agent's address", () => service().agent, 120_000);
  world.env.agent = service().agent;
  world.p = await windowPage(world.env.cdp!, world.env.agent, 120_000);
  await until("the bridge on the page", () => world.p.evaluate(`!!window.__MANGO_DESKTOP__?.team`), 60_000);
}

export async function stopWorld(world: World | undefined) {
  if (!world) return;
  try {
    // The key leaves the Credential Manager through the app, then the app and its processes go.
    const info = await world.bridge("info()");
    if (info.key) await world.bridge("removeKey()");
  } catch (error) {
    console.warn(`the test key may still be in the Credential Manager (service of ${world.env.data}): ${error}`);
  }
  world.p?.close();
  for (const name of ["dev", ...[1, 2, 3, 4].map((n) => `agents/agent-${n}`)]) {
    const pid = hiddenPid(world, name);
    if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  }
  if (world.cloud?.pid) spawnSync("taskkill", ["/PID", String(world.cloud.pid), "/T", "/F"]);
  world.env.close();
}

/** A click with the mouse, like a person: the menus and the switches answer to the pointer. */
export async function mouseClick(world: World, selector: string) {
  const at = await world.p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el?.scrollIntoView({ block: "center" });
    const q = el?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await world.p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/** Writes in the composer and sends with Enter, as a person does. */
export async function write(world: World, message: string) {
  await world.p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, ${JSON.stringify(message)}); })()`);
  await Bun.sleep(300);
  await world.p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await world.p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** The page's text under `selector`, read with `textContent` (`innerText` shows what the style capitalizes). */
export const textOf = (world: World, selector: string): Promise<string> =>
  world.p.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.replace(/\\s+/g, " ").trim()).join(" | ")`);
