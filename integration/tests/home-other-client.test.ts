// A conversation made, renamed, archived, restored or deleted by another client (the phone, a program that talks to the agent's
// HTTP API) shows in the Home at once, without the page being reloaded: the line says «Nessuna conversazione ancora» until the
// conversation is there, and the list follows every change. Fake engine, the app's real window.
// `off-screen bun test --cwd integration tests/home-other-client.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

setDefaultTimeout(240_000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-other-client-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const page = await p.evaluate("document.body.innerText.slice(-900)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", page, "--- console ---", ...p.console.slice(-4)].join("\n"));
    }
    await Bun.sleep(150);
  }
}
const body = () => p.evaluate("document.body.textContent") as Promise<string>;
const rows = () => p.evaluate(`[...document.querySelectorAll('[data-component="home-session-row"]')].map((r) => r.textContent.trim())`) as Promise<string[]>;
const listed = (title: string) => async () => (await rows()).some((row) => row.includes(title));
const gone = (title: string) => async () => !(await rows()).some((row) => row.includes(title));
const url = (route = "") => `${env.agent}/session${route}?directory=${encodeURIComponent(site)}`;
const json = { "content-type": "application/json" };
const create = async (title: string) => ((await (await fetch(url(), { method: "POST", headers: json, body: JSON.stringify({ title }) })).json()) as { id: string }).id;
const patch = (id: string, change: object) => fetch(url(`/${id}`), { method: "PATCH", headers: json, body: JSON.stringify(change) });

/** A picture of the window in the folder `MANGO_TEST_SCREENSHOTS` names, if it is set. */
async function shot(name: string) {
  const folder = process.env.MANGO_TEST_SCREENSHOTS;
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  const taken = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(taken.result.data, "base64"));
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(async () => (await body()).includes("my-site"), "the project open", 60_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a conversation made, renamed, archived, restored and deleted by another client follows in the Home without a reload", async () => {
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(async () => (await body()).includes("Nessuna conversazione ancora"), "the Home with no conversation");
  await shot("01-home-empty");

  const id = await create("Made by the phone");
  await waitUntil(listed("Made by the phone"), "the conversation made by another client in the Home");
  expect(await body(), "the empty line is gone").not.toContain("Nessuna conversazione ancora");
  await shot("02-home-conversation-from-another-client");

  await patch(id, { title: "Renamed by the phone" });
  await waitUntil(listed("Renamed by the phone"), "the new name in the Home");
  expect(await listed("Made by the phone")()).toBe(false);

  await patch(id, { time: { archived: Date.now() } });
  await waitUntil(gone("Renamed by the phone"), "the archived conversation off the Home");
  await waitUntil(async () => (await body()).includes("Nessuna conversazione ancora"), "the empty line again");

  await patch(id, { time: { archived: null } });
  await waitUntil(listed("Renamed by the phone"), "the restored conversation back in the Home");

  expect((await fetch(url(`/${id}`), { method: "DELETE" })).ok).toBe(true);
  await waitUntil(gone("Renamed by the phone"), "the deleted conversation off the Home");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
});

test("the title of a conversation open in a tab follows a rename by another client", async () => {
  const id = await create("Open in a tab");
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(listed("Open in a tab"), "the conversation in the Home");
  const at = (await p.evaluate(`(() => { const r = [...document.querySelectorAll('[data-component="home-session-row"]')].find((x) => x.textContent.includes("Open in a tab")).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)) as { x: number; y: number };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  const tabTitle = (title: string) => async () => (await p.evaluate(`[...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)})`)) as boolean;
  await waitUntil(tabTitle("Open in a tab"), "the conversation open");
  await patch(id, { title: "Renamed while open" });
  await waitUntil(tabTitle("Renamed while open"), "the new title where the conversation is open");
  await shot("03-open-conversation-renamed-by-another-client");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
});
