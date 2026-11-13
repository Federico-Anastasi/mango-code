// The first X of the window (the app's real window, WebView2 CDP): the notice «Mango Code resta acceso» comes up and the
// window stays. Its own X closes it without counting it as read: the window stays, and the next X shows it again.
// «Ho capito» counts as read and the window goes to the tray at once, without a second X; after it the X
// hides the window with no notice. The X is the window's close message (WM_CLOSE), as the title bar's button sends it.
// Fake engine, no GPU. `bun test --cwd integration tests/close-notice.test.ts`, after `cargo build -p mango-code -p engine`
// in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";

let env: Environment;
let p: Page;
let hwnd = "";

const WINDOW = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@`;

function powershell(script: string) {
  const run = spawnSync("powershell", ["-NoProfile", "-Command", `${WINDOW}\n${script}`], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`powershell: ${run.stderr}`);
  return run.stdout.trim();
}

const visible = () => powershell(`[W]::IsWindowVisible([IntPtr]${hwnd})`) === "True";
/** The X of the title bar. */
const pressX = () => powershell(`[W]::PostMessage([IntPtr]${hwnd}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`);
const seen = () => fs.existsSync(path.join(env.data, "close-notice.json"));
const notice = () => p.evaluate(`document.body.innerText.includes("Mango Code resta acceso")`) as Promise<boolean>;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(150);
  }
}

/** A click with the mouse, like a person. */
async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

beforeAll(async () => {
  env = await start([{ text: "ok" }], { window: true });
  p = await page(env.cdp!, () => true, 120_000);
  await waitUntil(() => p.evaluate(`location.href === ${JSON.stringify(env.agent + "/")}`), "the window on the Home", 120_000);
  hwnd = powershell(`(Get-Process -Id ${env.app.pid}).MainWindowHandle`);
  expect(hwnd).not.toBe("0");
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
});

test("the first X shows the notice and the window stays; its X closes it without counting it as read", async () => {
  expect(seen()).toBe(false);
  pressX();
  await waitUntil(notice, "the notice");
  // the X waits a second for the page: then it is still there
  await Bun.sleep(1500);
  expect(visible()).toBe(true);
  await mouseClick('[data-slot="dialog-close-button"]');
  await waitUntil(async () => !(await notice()), "the notice closed");
  await Bun.sleep(1500);
  expect(visible()).toBe(true);
  expect(seen()).toBe(false);
}, 60_000);

test("«Ho capito» counts as read and the window goes at once, without a second X", async () => {
  pressX();
  await waitUntil(notice, "the notice again");
  await mouseClick('[data-action="close-notice-ok"]');
  await waitUntil(() => !visible(), "the window hidden");
  expect(seen()).toBe(true);
}, 60_000);

test("once read, the X hides the window with no notice", async () => {
  // Shown again as a person does it: Mango Code started again runs the tray icon's `show`. A `ShowWindow` from outside
  // would leave the app believing the window hidden, and its next hide would do nothing.
  env.launch([]);
  await waitUntil(visible, "the window shown again");
  expect(await notice()).toBe(false);
  pressX();
  await waitUntil(() => !visible(), "the window hidden by the X");
  expect(await notice()).toBe(false);
}, 60_000);
