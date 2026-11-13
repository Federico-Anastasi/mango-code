// The zoom is the browser's, on the page it is used on. Ctrl+wheel on the chat zooms the chat, and the window opens with that
// zoom at the next start; on the page in the Preview panel it zooms that page and leaves the chat alone. Real window and
// Windows' own wheel (the test moves the pointer); each webview is read through its remote debugging (the window's is
// `MANGO_WINDOW_CDP`, the panel keeps its own port). Fake engine, no GPU. Own port (47700).
// `bun test --cwd integration tests/zoom.test.ts`.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const DEBUG = 47700;
let env: Environment | undefined;
afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
});

const scale = (p: Page) => p.evaluate("devicePixelRatio") as Promise<number>;

/**
 * Ctrl + `notches` of the wheel (up zooms in) with the pointer at `at` (a point of the chat's page, in its CSS pixels), then the
 * scale of `p`. It is Windows' own wheel on the real window: WebView2 does not zoom for a wheel that comes from the remote
 * debugging. Two causes made it fail now and then: Windows refuses the foreground to a process that did not send the last
 * input (then Ctrl goes to another window and the wheel scrolls), and a notch that arrives while WebView2 is still applying
 * the one before can be lost. So the window is brought to the foreground until it is, and each notch waits for the zoom of
 * the one before, and is sent again once if WebView2 did not take it.
 */
async function wheel(chat: Page, at: number[], p: Page, notches: number) {
  for (let n = 0; n < Math.abs(notches); n++) {
    const before = await scale(p);
    // a notch WebView2 did not take (rarely, on the panel) is sent again once: the zoom is WebView2's, not the app's
    if (!(await notch(chat, at, p, Math.sign(notches)))) await notch(chat, at, p, Math.sign(notches));
    if ((await scale(p)) === before) break;
  }
  return scale(p);
}

async function notch(chat: Page, at: number[], p: Page, direction: number) {
  const before = await scale(p);
  const ratio = await scale(chat);
  const script = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public struct PT { public int X, Y; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
'@
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id ${env!.app.pid}).MainWindowHandle
# a Shift pressed and released makes this process the one of the last input, which Windows lets take the foreground
for ($i = 0; $i -lt 20 -and [W]::GetForegroundWindow() -ne $h; $i++) {
  [W]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
  [W]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 100
}
if ([W]::GetForegroundWindow() -ne $h) { Write-Output "the window could not be brought to the foreground" }
$p = New-Object PT; $p.X = ${Math.round(at[0]! * ratio)}; $p.Y = ${Math.round(at[1]! * ratio)}
[W]::ClientToScreen($h, [ref]$p) | Out-Null
[W]::SetCursorPos($p.X, $p.Y) | Out-Null
Start-Sleep -Milliseconds 300
[W]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[W]::mouse_event(0x0800, 0, 0, ${direction * 120}, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[W]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)`;
  const said = spawnSync("powershell", ["-NoProfile", "-Command", script]).stdout.toString().trim();
  if (said) throw new Error(said);
  for (let t = 0; t < 30; t++) {
    if ((await scale(p)) !== before) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** The remote debugging port of the Preview panel: the one of the WebView2 that keeps its data in `<data>\preview`. */
function panelPort(data: string) {
  const out = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object CommandLine"]).stdout.toString();
  const line = out.split(/\r?\n/).find((l) => l.includes(path.join(data, "preview")) && l.includes("--remote-debugging-port="));
  return Number(line?.match(/--remote-debugging-port=(\d+)/)?.[1]);
}

const savedZoom = (data: string) => (fs.existsSync(path.join(data, "zoom.txt")) ? Number(fs.readFileSync(path.join(data, "zoom.txt"), "utf8")) : 1);

test("the chat and the Preview panel zoom by themselves, and the window opens with the zoom it was left at", async () => {
  env = await start([{ text: "ok" }], { window: true, noDebug: true, env: { MANGO_WINDOW_CDP: String(DEBUG) } });
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "zoom" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  const conversation = `${env.agent}/${btoa(String.fromCharCode(...new TextEncoder().encode(env.project))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}/session/${id}`;
  let p = await page(DEBUG, (t) => t.url.startsWith(env!.agent), 90_000);
  await p.send("Page.navigate", { url: conversation });
  await Bun.sleep(4000);

  // the chat: two notches in, and the file holds the zoom itself, whatever the screen's scale and Windows' text size are
  const plain = await scale(p);
  const zoomed = (await wheel(p, [200, 300], p, 2)) / plain;
  expect(zoomed, "Ctrl+wheel zooms the chat").toBeGreaterThan(1.05);
  await Bun.sleep(500);
  expect(savedZoom(env.data), "the file holds the chat's zoom").toBeCloseTo(zoomed, 2);

  // the panel: its page zooms, the chat and the saved zoom stay
  await p.evaluate(`window.__MANGO_DESKTOP__.preview.go("data:text/html,<body style='background:%23234;color:white'>zoom")`);
  await p.evaluate(`new Promise((ok) => { const t = setInterval(() => document.querySelector('aside[aria-label="Anteprima"]') && (clearInterval(t), ok(1)), 200) })`);
  await Bun.sleep(3000);
  const inPanel = await page(panelPort(env.data), (t) => t.url.startsWith("data:"), 20_000);
  const middle = (await p.evaluate(`(() => { const r = document.querySelector('aside[aria-label="Anteprima"] [data-slot="preview-page"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`)) as number[];
  const panelPlain = await scale(inPanel);
  const chatBefore = await scale(p);
  const panelZoomed = (await wheel(p, middle, inPanel, 2)) / panelPlain;
  expect(panelZoomed, "Ctrl+wheel zooms the page in the panel").toBeGreaterThan(1.05);
  await Bun.sleep(500);
  expect(await scale(p), "the chat keeps its zoom").toBe(chatBefore);
  expect(savedZoom(env.data), "the saved zoom is still the chat's").toBeCloseTo(zoomed, 2);
  expect((await wheel(p, middle, inPanel, -2)) / panelPlain, "and back out").toBeCloseTo(1, 2);
  inPanel.close();
  p.close();

  // the next start: the chat at the zoom it was left at, not at another one
  await env.restart();
  p = await page(DEBUG, (t) => t.url.startsWith(env!.agent), 90_000);
  await Bun.sleep(3000);
  expect((await scale(p)) / plain, "the window opens with the zoom of the last time").toBeCloseTo(zoomed, 2);
  expect(savedZoom(env.data), "and the file still says so").toBeCloseTo(zoomed, 2);
  p.close();
}, 400_000);
