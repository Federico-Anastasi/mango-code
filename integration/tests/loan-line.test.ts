// The line «Le schede video sono prestate…» above the box and the open task list above it, in the app's real window
// (WebView2 CDP): with a long list open and the cards lent they never overlap, the line is not covered, and the box
// stays under the line, at a wide and at a narrow window. Fake engine, no GPU used.
// `off-screen bun test --cwd integration loan-line`, after `cargo build -p mango-code -p engine` in app/ and the agent's
// build. `MANGO_TEST_SCREENSHOTS=<folder>` keeps the screenshots.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { MangoCode, find } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { saveScreenshot, start, type Environment } from "./environment";
import { atSizes } from "./window";

const todos = Array.from({ length: 8 }, (_, i) => ({
  content: `Task number ${i + 1} of the long list the model keeps open`,
  status: i === 0 ? "in_progress" : "pending",
  priority: "medium",
}));
// the first step writes the list, the second answers slowly enough for the turn to stay open while the test looks
const answer = "word ".repeat(400).trim();

let env: Environment;
let mc: MangoCode;
let p: Page;
let holder: ChildProcess | undefined;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const shot = async (name: string) => saveScreenshot(env, name, (await p.send("Page.captureScreenshot", { format: "png" })).result.data);

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      await shot(`failed-${what.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
      throw new Error(`waited too long for: ${what}`);
    }
    await Bun.sleep(150);
  }
}

/** The rectangles of the line, the task list and the box, and whether the line is what a click at its centre reaches. */
const layout = () =>
  p.evaluate(`(() => {
    const rect = (el) => { const r = el?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const line = document.querySelector('[data-component="mango-status"]');
    const list = document.querySelector('[data-component="session-todo-dock"]');
    const box = document.querySelector('[contenteditable="true"]');
    const l = line?.getBoundingClientRect();
    const at = l && document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
    return { line: rect(line), list: rect(list), box: rect(box), lineOnTop: !!at && line.contains(at), items: [...document.querySelectorAll('[data-component="session-todo-dock"] [data-state]')].length };
  })()`) as Promise<{ line?: Rect; list?: Rect; box?: Rect; lineOnTop: boolean; items: number }>;
type Rect = { top: number; bottom: number; left: number; right: number };

beforeAll(async () => {
  env = await start([{ tool: "todowrite", arguments: { todos } }, { text: answer }], { window: true, chunkMs: 400 });
  mc = new MangoCode((await find(env.data))!);
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 240_000);

afterAll(() => {
  holder?.kill();
  p?.close();
  env?.close();
});

test("with eight tasks open and the cards lent, the line and the list never overlap, wide and narrow", async () => {
  const id = await mc.createSession(env.project, { title: "loan line" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await waitUntil(() => exists('[contenteditable="true"]'), "the conversation");
  await Bun.sleep(1500);
  await mc.send(id, env.project, "Do the eight things", { model: "fake" });
  await waitUntil(() => exists('[data-component="session-todo-dock"]'), "the task list");
  await waitUntil(async () => (await layout()).list!.bottom - (await layout()).list!.top > 100, "the list open");
  await shot("loan-line-list-alone");
  expect((await layout()).line).toBeUndefined();

  holder = spawn("ping", ["-n", "120", "127.0.0.1"], { stdio: "ignore" });
  await fetch(`${env.engine}/engine/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: holder.pid }) });
  await waitUntil(() => exists('[data-component="mango-status"]'), "the line");
  await waitUntil(() => exists('[data-component="session-todo-dock"]'), "the list still there");

  await atSizes(env.app.pid!, p, [[1400, 900], [390, 844]], async (width) => {
    await Bun.sleep(600);
    const seen = await layout();
    await shot(`loan-line-both-${width}`);
    expect(seen.items).toBeGreaterThan(0);
    // the line is entirely under the list and above the box, and nothing covers it
    expect(seen.line!.top).toBeGreaterThanOrEqual(seen.list!.bottom);
    expect(seen.line!.bottom).toBeLessThanOrEqual(seen.box!.top);
    expect(seen.lineOnTop).toBe(true);
  });
}, 300_000);
