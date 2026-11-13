// The app's own page and the first start, in the app's real window (WebView2 CDP). The page shows the logo while the app
// starts and, when the start fails, the error with Retry, Report a problem and Open the logs: nothing else, no choice of
// models and no download (they are in the settings of the web UI). With no model on the computer the window opens on the
// Home. The tray's "Settings…" opens the settings on the Models section: asked while the app starts, the request waits in
// the bridge and the interface reads it once at its start (`pendingSettings()`); asked with the interface there, the
// window also gets the event `mango-settings`. The tests ask it with a second start of the app and
// `--test-tray-settings` (development builds only), which runs what the icon's menu runs (`tray::open_settings`).
// How the app starts with a model, and with `--service`, is in startup.test.ts.
// `bun test integration/tests/first-run.test.ts`, after `cargo build -p mango-code -p engine` in app/.
// The screenshots stay in %TEMP%\mango-first-run-*.png.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const appWindow = (t: { url: string }) => t.url.includes("tauri.localhost") || t.url.startsWith("tauri://");
const visible = (id: string) => `!document.getElementById('${id}').hidden`;
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(300);
  }
}

const screenshot = async (p: Page, name: string) => {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), `mango-first-run-${name}.png`), Buffer.from(r.result.data, "base64"));
};

// The port of the agent, taken by "another program" until the test lets it go: the start fails on it.
const busy = net.createServer();
await new Promise<void>((ok) => busy.listen(0, "127.0.0.1", ok));
const agentPort = (busy.address() as net.AddressInfo).port;

let env: Environment;
let p: Page;

beforeAll(async () => {
  // `start` returns when the service file is written: here with the reason of the failure, not with the agent.
  env = await start([{ text: "Here I am." }], { window: true, noModels: true, env: { MANGO_AGENT_PORT: String(agentPort) } });
  p = await page(env.cdp!, appWindow, 120_000);
}, 200_000);

afterAll(() => {
  p?.close();
  busy.close();
  env?.close();
});

test("a start that fails shows the app's page with the error alone: Retry, Report a problem, Open the logs", async () => {
  await waitUntil(() => p.evaluate(visible("error")), "the error page", 120_000);
  expect(readJson(path.join(env.data, "service.json")).reason).toContain(String(agentPort));
  // The page has nothing but the error: no choice of models, no download, no engine of another PC.
  expect(await p.evaluate(`[...document.querySelectorAll('section')].map((s) => s.id)`)).toEqual(["error"]);
  expect(await p.evaluate(`document.getElementById('error-sentence').innerText`)).toContain(`La porta ${agentPort} è occupata`);
  for (const [id, label] of [["retry", "Riprova"], ["report", "Segnala il problema"], ["logs", "Apri i log"]]) {
    expect(await p.evaluate(visible(id))).toBe(true);
    expect(await p.evaluate(`document.getElementById('${id}').innerText`)).toBe(label);
  }
  // The way back to this PC's engine shows only when the engine in use is another PC's.
  expect(await p.evaluate(visible("local-engine"))).toBe(false);
  // The report carries the screenshot only if the switch stays on: on by default, and said.
  expect(await p.evaluate(`document.getElementById('report-screenshot').checked`)).toBe(true);
  expect(await p.evaluate(`document.getElementById('report-screenshot-row').innerText`)).toContain("Includi una schermata della finestra");
  // The files to attach show only where the report can carry them (a build with the address of the reports).
  const attach = await p.evaluate(`(async () => (await window.__MANGO_DESKTOP__.reportInfo()).attachments)()`);
  expect(await p.evaluate(`getComputedStyle(document.getElementById('report-files-row')).display !== 'none'`)).toBe(attach);
  await screenshot(p, "1-error");
}, 150_000);

/** The tray's «Settings…»: a second start of the app hands it to this one, and exits. */
async function traySettings() {
  const second = env.launch(["--test-tray-settings"]);
  await new Promise<void>((ok) => second.once("exit", () => ok()));
}

const onModels = () =>
  p.evaluate(
    `location.pathname === "/settings" && new URLSearchParams(location.search).get("section") === "models" && !!document.querySelector('[data-component="settings-models"]')`,
  );

test("the tray's «Settings…» while the app starts again: the app's page stays, and the interface opens Models once it is there", async () => {
  await traySettings();
  // the app's own page has no settings: no event, the request waits in the bridge
  await Bun.sleep(1000);
  expect(await p.evaluate(visible("error"))).toBe(true);

  await new Promise<void>((ok) => busy.close(() => ok()));
  await p.evaluate(`document.getElementById('retry').click()`);
  // While the app starts again the service file is gone: async, so that a missing file counts as "not yet".
  await waitUntil(async () => readJson(path.join(env.data, "service.json")).agent !== undefined, "the agent started", 120_000);
  const service = readJson(path.join(env.data, "service.json"));
  env.agent = service.agent;
  env.engine = service.engine;
  p.close();
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await waitUntil(onModels, "the interface on Models, from the request kept in the bridge");
  // read, so emptied
  expect(await p.evaluate(`window.__MANGO_DESKTOP__.pendingSettings()`)).toBeNull();
  expect(await (await fetch(`${service.control}/control/state`)).json()).toMatchObject({ model: { phase: "none" }, default_model: null });
  await screenshot(p, "2-models");
}, 200_000);

test("the request is read once: the interface loaded again opens on the Home; «Settings…» with the interface there opens Models", async () => {
  await p.evaluate(`location.href = ${JSON.stringify(env.agent + "/")}`);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")} && !!document.querySelector('[data-component="mango-welcome"]')`), "the Home");
  await Bun.sleep(1500);
  expect(await p.evaluate(`location.pathname`)).toBe("/");
  await screenshot(p, "3-home");

  await traySettings();
  await waitUntil(onModels, "the settings on Models, from the event");
  expect(await p.evaluate(`window.__MANGO_DESKTOP__.pendingSettings()`)).toBeNull();
}, 90_000);
