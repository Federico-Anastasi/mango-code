// The web page fills the window: measured on the real window (Windows) at the app's own page, the Home and a conversation,
// then after the app's zoom (Ctrl +) and after maximizing. The window's client area, the widest webview child window and the
// page's viewport (innerWidth x devicePixelRatio) must be the same width, in physical pixels: a strip that the page does not
// reach would show the window's own background. (The photos that set the viewport width through remote debugging, without
// resizing the window, do leave such a strip while they last; they are not the app.)
// Fake engine, no GPU. Own ports (47690-47692). `bun test --cwd integration tests/window-fill.test.ts`.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47690, 47691, 47692];
const envs: Environment[] = [];

async function waitFor(condition: () => Promise<boolean> | boolean, what: string, ms = 90_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(300);
  }
}
afterAll(() => {
  for (const e of envs) e.close();
  Bun.sleepSync(1500);
});

/** The window's client width and the widest child window (the webviews), in physical pixels, and what the page says. */
function native(pid: number, action = "") {
  const script = `
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public struct PT { public int X, Y; }
public class N {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  public static string Rects(IntPtr p) {
    PT o = new PT(); ClientToScreen(p, ref o);
    var list = new List<string>();
    EnumChildWindows(p, (h, l) => { RECT r; if (IsWindowVisible(h) && GetWindowRect(h, out r)) list.Add((r.L - o.X) + "," + (r.T - o.Y) + "," + (r.R - r.L) + "," + (r.B - r.T)); return true; }, IntPtr.Zero);
    return string.Join(";", list);
  }
  public static int Widest(IntPtr p) { int best = 0; EnumChildWindows(p, (h, l) => { RECT r; if (IsWindowVisible(h) && GetWindowRect(h, out r)) best = Math.Max(best, r.R - r.L); return true; }, IntPtr.Zero); return best; }
}
'@
[N]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id ${pid}).MainWindowHandle
${action}
$r = New-Object RECT
[N]::GetClientRect($h, [ref]$r) | Out-Null
"$($r.R - $r.L) $([N]::Widest($h)) $([N]::Rects($h))"`;
  const out = spawnSync("powershell", ["-NoProfile", "-Command", script]).stdout.toString().trim().split(/\s+/);
  // every visible child window: left, top, width, height in physical pixels from the client area's corner
  const rects = (out[2] ?? "").split(";").filter(Boolean).map((r) => r.split(",").map(Number));
  return { client: Number(out[0]), child: Number(out[1]), rects };
}

async function measure(env: Environment, p: Page, label: string, action = "") {
  const before = await p.evaluate("1");
  void before;
  const n = native(env.app.pid!, action);
  await Bun.sleep(1500);
  const again = native(env.app.pid!);
  const viewport = Math.round(await p.evaluate("window.innerWidth * window.devicePixelRatio"));
  console.log(`${label}: window ${again.client}  webview ${again.child}  viewport ${viewport}`);
  // a child window can be wider than the client area (WebView2 keeps an offscreen one): what matters is that none is narrower
  expect(again.child - again.client, `${label}: the webview fills the window`).toBeGreaterThanOrEqual(-2);
  expect(Math.abs(viewport - again.client), `${label}: the page fills the window`).toBeLessThanOrEqual(2);
  void n;
}

const key = (name: string) => `$s = New-Object -ComObject WScript.Shell; [N]::SetForegroundWindow($h) | Out-Null; ${name}`;

test("the app's own page, the Home and a conversation fill the window, also after zoom and maximizing", async () => {
  // The page of the app itself (not the agent's): it stays in the window when the start fails, here on a port of the agent
  // that another program holds.
  const busy = net.createServer();
  await new Promise<void>((ok) => busy.listen(0, "127.0.0.1", ok));
  const first = await start([{ text: "ok" }], {
    window: true,
    noModels: true,
    env: { MANGO_AGENT_PORT: String((busy.address() as net.AddressInfo).port), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
  });
  envs.push(first);
  let p = await page(DEBUG, (t) => t.url.includes("tauri.localhost"), 90_000);
  await waitFor(() => p.evaluate(`!document.getElementById('error').hidden`), "the error of the start");
  await measure(first, p, "the app's page");
  await measure(first, p, "the app's page, maximized", key("[N]::ShowWindow($h, 3) | Out-Null"));
  p.close();
  busy.close();
  first.close();
  envs.pop();
  await Bun.sleep(3000);

  const env = await start([{ text: "ok" }], {
    window: true,
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
  });
  envs.push(env);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent), 90_000);
  await Bun.sleep(3000);
  await measure(env, p, "home");
  await measure(env, p, "home, zoom in", key("$s.SendKeys('^{+}'); $s.SendKeys('^{+}'); $s.SendKeys('^{+}'); $s.SendKeys('^{+}')"));
  await measure(env, p, "home, maximized", key("[N]::ShowWindow($h, 3) | Out-Null"));
  const { MangoCode, find } = await import("../client/mango-code");
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "misura" });
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(env.project))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
  await Bun.sleep(4000);
  await measure(env, p, "conversation");
  await measure(env, p, "conversation, zoom out", key("$s.SendKeys('^{-}'); $s.SendKeys('^{-}'); $s.SendKeys('^{-}')"));
  p.close();
  env.close();
  envs.pop();
  await Bun.sleep(3000);
}, 400_000);

// The app's zoom (Ctrl +, Ctrl -, Ctrl 0) is the zoom of the window's webview, which `zoom.rs` keeps in `<data>/zoom.txt` and `lib.rs` applies at the
// start with the same call (`set_zoom`). The keys can't be simulated reliably, so each level is written where the app reads it and the app is started
// again: the page must still fill the window, and the native Preview panel must sit on its placeholder (the page's rectangle, in physical pixels).
for (const level of [1.25, 1.5, 1.75]) {
  test(`at ${level * 100}% the page fills the window and the Preview panel sits on its place`, async () => {
    const env = await start([{ text: "ok" }], {
      window: true,
      env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
    });
    envs.push(env);
    const { MangoCode, find } = await import("../client/mango-code");
    const mc = new MangoCode((await find(env.data))!);
    const id = await mc.createSession(env.project, { title: "zoom" });
    for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
    fs.writeFileSync(path.join(env.data, "zoom.txt"), String(level));
    await env.restart();
    const p = await page(DEBUG, (t) => t.url.startsWith(env.agent), 90_000);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(env.project))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
    await Bun.sleep(4000);
    await measure(env, p, `zoom ${level * 100}%`);
    // a page in the panel: it opens by itself, and the web page places the native panel on its placeholder
    await p.evaluate(`window.__MANGO_DESKTOP__.preview.go("data:text/html,<body style='background:%23234;color:white'>zoom")`);
    await p.evaluate(`new Promise((ok) => { const t = setInterval(() => document.querySelector('aside[aria-label="Anteprima"]') && (clearInterval(t), ok(1)), 200) })`);
    await Bun.sleep(3000);
    const ratio = (await p.evaluate("window.devicePixelRatio")) as number;
    const box = (await p.evaluate(`(() => { const r = document.querySelector('aside[aria-label="Anteprima"] [data-slot="preview-page"]').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`)) as number[];
    const expected = box.map((v) => v * ratio);
    const { rects } = native(env.app.pid!);
    console.log(`zoom ${level * 100}%: scale ${ratio}, placeholder ${expected.map(Math.round)} physical px; child windows ${JSON.stringify(rects)}`);
    expect(
      rects.find((r) => r.every((v, i) => Math.abs(v - expected[i]!) <= 3)),
      `the native panel sits on the placeholder at ${level * 100}%`,
    ).toBeDefined();
    p.close();
    env.close();
    envs.pop();
    await Bun.sleep(2500);
  }, 300_000);
}
