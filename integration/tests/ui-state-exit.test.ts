// What the interface remembers is on the disk when the app is closed from the tray, even if the change was made a
// moment before: the app asks the page to send what it still holds and waits for the answer before it exits. The page's
// own timer is stopped here, so that only that request can save the change. «Quit» is the one of the tray's menu: a test
// build takes `--test-tray-quit` from a second start of the app, which reaches the same function.
// The same holds when the app starts again by itself after the models folder moved.
// Fake engine, no GPU. `off-screen bun test --cwd integration tests/ui-state-exit.test.ts`, after `cargo build -p mango-code
// -p engine` in app/ and `app\scripts\build-agent.ps1`.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mango-ui-state-exit-"));
const site = path.join(base, "quit-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<h1>hello</h1>");

let env: Environment | undefined;
let p: Page | undefined;

afterEach(() => {
  p?.close();
  env?.close();
  env = undefined;
});

const stateFile = () => path.join(env!.data, "ui-state.json");
const drafts = () => Object.values<string>(JSON.parse(fs.readFileSync(stateFile(), "utf8")).drafts);
const composer = (e: Page) => e.evaluate(`document.querySelector('[contenteditable="true"]')?.innerText ?? null`) as Promise<string | null>;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await (async () => condition())().catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(100);
  }
}

const type = (e: Page, text: string) =>
  e.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);

test("a change made a moment before «Quit» is on the disk when the app has gone, and in the window after the restart", async () => {
  env = await start([{ text: "ok" }], { window: true, noModels: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && JSON.parse(fs.readFileSync(stateFile(), "utf8")).imported === true, "the first start's mark");

  const { MangoCode, find } = await import("../client/mango-code");
  const id = await new MangoCode((await find(env.data))!).createSession(site, { title: "quit" });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(site))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
  await waitUntil(() => p!.evaluate(`!!document.querySelector('[contenteditable="true"]')`), "the composer");

  // The page's own timer, the one that sends a change a moment after it, is out of the way: what reaches the disk now
  // has to come from the app's request.
  await p.evaluate(`window.setTimeout = () => 0`);
  await type(p, "kept by the first request");
  await Bun.sleep(800);
  expect(drafts().some((d) => d.includes("kept by the first request"))).toBe(false);

  await type(p, " and by the quit");
  const e = env;
  const closed = new Promise<void>((ok) => e.app.once("exit", () => ok()));
  e.launch(["--test-tray-quit"]);
  await Promise.race([closed, Bun.sleep(60_000).then(() => Promise.reject(new Error("the app did not exit after «Quit»")))]);

  expect(drafts().some((d) => d.includes("kept by the first request and by the quit"))).toBe(true);

  p.close();
  await e.restart();
  const service = () => JSON.parse(fs.readFileSync(path.join(e.data, "service.json"), "utf8"));
  await waitUntil(() => service().pid === e.app.pid, "the new app's service file", 120_000);
  e.agent = service().agent;
  p = await windowPage(e.cdp!, e.agent);
  await p.send("Page.navigate", { url: `${e.agent}/${b64}/session/${id}` });
  await waitUntil(async () => (await composer(p!)) === "kept by the first request and by the quit", "the draft in the composer");
}, 400_000);

test("a change made a moment before the models folder moves is on the disk when the app starts again on the new folder", async () => {
  env = await start([{ text: "ok" }], { window: true, freeModelsFolder: true, args: [`${site}\.`] });
  p = await windowPage(env.cdp!, env!.agent);
  await waitUntil(() => fs.existsSync(stateFile()) && JSON.parse(fs.readFileSync(stateFile(), "utf8")).imported === true, "the first start's mark");

  const { MangoCode, find } = await import("../client/mango-code");
  const id = await new MangoCode((await find(env.data))!).createSession(site, { title: "move" });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(site))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
  await waitUntil(() => p!.evaluate(`!!document.querySelector('[contenteditable="true"]')`), "the composer");

  await p.evaluate(`window.setTimeout = () => 0`);
  await type(p, "kept by the move");
  await Bun.sleep(800);
  expect(drafts().some((d) => d.includes("kept by the move"))).toBe(false);

  const e = env;
  const closed = new Promise<void>((ok) => e.app.once("exit", () => ok()));
  // what «Sposta» calls; the page is the conversation's, with the change it still holds
  void p.evaluate(`window.__MANGO_DESKTOP__.modelsDir.move(${JSON.stringify(path.join(base, "models elsewhere"))})`).catch(() => {});
  await Promise.race([closed, Bun.sleep(120_000).then(() => Promise.reject(new Error("the app did not exit after the move")))]);

  expect(drafts().some((d) => d.includes("kept by the move"))).toBe(true);
  // the app that started again on the new folder is not the environment's: stopped by its id once it wrote its service file
  const servicePid = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(e.data, "service.json"), "utf8")).pid as number;
    } catch {
      return undefined;
    }
  };
  await waitUntil(() => (servicePid() ?? e.app.pid) !== e.app.pid, "the app started again", 120_000);
  Bun.spawnSync(["taskkill", "/PID", String(servicePid()), "/T", "/F"]);
}, 400_000);
