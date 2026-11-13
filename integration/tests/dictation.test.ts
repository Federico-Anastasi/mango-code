// Dictation (the microphone in the chat) with the real app: it is off until the user turns it on and nothing is downloaded
// before; turned on it downloads in the background and the state follows; turned off, even halfway, the models go. The
// app's own download is replaced by one that only takes the time (`MANGO_DICTATION_FAKE`, development builds): no
// network and no model. The rules one by one are the tests of `app/src-tauri/src/dictation.rs`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let p: Page;

beforeAll(async () => {
  // 50 MiB per second: about ten seconds for the whole download
  env = await start([{ text: "Hello." }], { window: true, env: { MANGO_DICTATION_FAKE: "50" } });
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

const dictation = (code: string) => p.evaluate(`window.__MANGO_DESKTOP__.dictation.${code}`);
const models = () => path.join(env.modelsDir, "whisper");
const status = async () => (await dictation("state()")).status as string;
async function until(wanted: string) {
  for (let i = 0; i < 100 && (await status()) !== wanted; i++) await Bun.sleep(200);
  expect(await status()).toBe(wanted);
}

test("off at the start: the app is ready without downloading anything", async () => {
  const state = await dictation("state()");
  expect(state).toMatchObject({ enabled: false, status: "off", sizeMb: 465 });
  expect(fs.existsSync(models())).toBe(false);
  expect(fs.existsSync(path.join(env.data, "dictation.json"))).toBe(false);
});

test("turned on it downloads in the background, tells the progress, and is ready", async () => {
  await p.evaluate(`window.__events = []; addEventListener("mango-dictation", (e) => window.__events.push(e.detail))`);
  expect(await dictation("setEnabled(true)")).toMatchObject({ enabled: true });
  await until("downloading");
  await until("ready");

  const events: { status: string; doneMb: number }[] = await p.evaluate("window.__events");
  expect(events.some((e) => e.status === "downloading" && e.doneMb > 0 && e.doneMb < 465)).toBe(true);
  expect(events.at(-1)?.status).toBe("ready");
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "dictation.json"), "utf8"))).toEqual({ enabled: true });
}, 60_000);

test("turned off it stops and the space comes back, also halfway through a download", async () => {
  expect((await dictation("setEnabled(false)")).status).toBe("off");
  for (let i = 0; i < 50 && fs.existsSync(models()); i++) await Bun.sleep(100);
  expect(fs.existsSync(models())).toBe(false);

  await dictation("setEnabled(true)");
  await until("downloading");
  expect((await dictation("setEnabled(false)")).status).toBe("off");
  for (let i = 0; i < 50 && fs.existsSync(models()); i++) await Bun.sleep(100);
  expect(fs.existsSync(models())).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "dictation.json"), "utf8"))).toEqual({ enabled: false });
}, 60_000);

test("who updates from a version that already had the models finds it on, without downloading", async () => {
  fs.mkdirSync(models(), { recursive: true });
  fs.writeFileSync(path.join(models(), "done"), "");
  fs.rmSync(path.join(env.data, "dictation.json"));
  p.close();
  await env.restart();
  await Bun.sleep(2000);
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  let state: { enabled: boolean; status: string } | undefined;
  for (let i = 0; i < 100 && state?.status !== "ready"; i++) {
    state = await dictation("state()").catch(() => undefined);
    await Bun.sleep(300);
  }
  expect(state).toMatchObject({ enabled: true, status: "ready" });
}, 120_000);

test("the row of Settings › General is the switch of the same thing: it tells the progress and when the microphone is ready", async () => {
  // after the restart above the dictation is on and ready
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=general` });
  const row = `document.querySelector('[data-action="settings-dictation"] input')`;
  const said = () => p.evaluate(`document.querySelector('[data-slot="settings-dictation-state"]')?.innerText ?? ""`) as Promise<string>;
  const waitFor = async (what: string, condition: () => Promise<boolean>) => {
    for (let i = 0; i < 150 && !(await condition().catch(() => false)); i++) await Bun.sleep(200);
    expect(await condition(), what).toBe(true);
  };
  await waitFor("the row on and ready", async () => (await p.evaluate(`${row}?.checked`)) === true && (await said()).includes("Pronta"));

  // off: the space comes back and the row says nothing more
  await p.evaluate(`${row}.click()`);
  await waitFor("the row off", async () => (await p.evaluate(`${row}.checked`)) === false);
  await until("off");
  expect(await said()).toBe("");
  expect(fs.existsSync(models())).toBe(false);

  // on: it tells how far the download is, then that the microphone is in the chat
  await p.evaluate(`${row}.click()`);
  await waitFor("the progress", async () => /^Scarico la dettatura: \d+ di 465 MB$/.test(await said()));
  await waitFor("ready", async () => (await said()).startsWith("Pronta"));
  await until("ready");
  expect(await p.evaluate(`${row}.checked`)).toBe(true);
}, 90_000);
