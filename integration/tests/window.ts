// Sizes the real window of the app, as a user would, instead of making the page believe it has another size.

import { spawnSync } from "node:child_process";
import type { Page } from "./cdp";

/**
 * Sizes the app's window so that its page is `width` x `height` CSS pixels, and waits until the page says so. If the page
 * does not get there it throws, with the size the page got.
 */
export async function resizeWindow(pid: number, p: Page, width: number, height: number) {
  const ratio: number = await p.evaluate("devicePixelRatio");
  const script = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
}
'@
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id ${pid}).MainWindowHandle
$win = New-Object RECT; $client = New-Object RECT
[W]::GetWindowRect($h, [ref]$win) | Out-Null
[W]::GetClientRect($h, [ref]$client) | Out-Null
$w = [int](${width} * ${ratio}) + ($win.R - $win.L) - ($client.R - $client.L)
$hh = [int](${height} * ${ratio}) + ($win.B - $win.T) - ($client.B - $client.T)
[W]::SetWindowPos($h, [IntPtr]::Zero, $win.L, $win.T, $w, $hh, 0x14) | Out-Null`;
  const run = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`the window could not be sized: ${run.stderr}`);
  let size: number[] = [];
  for (let t = 0; t < 50; t++) {
    size = await p.evaluate("[innerWidth, innerHeight]");
    // the window is sized in whole physical pixels: a CSS pixel more or less is the rounding
    if (Math.abs(size[0]! - width) <= 1 && Math.abs(size[1]! - height) <= 1) return;
    await Bun.sleep(100);
  }
  throw new Error(`the window did not get to ${width}x${height} CSS pixels: the page is ${size.join("x")}`);
}

/** Runs `take` with the window at each of the sizes (CSS pixels), then gives the window back the size it had. */
export async function atSizes(pid: number, p: Page, sizes: readonly (readonly [number, number])[], take: (width: number) => Promise<void>) {
  const [width, height]: number[] = await p.evaluate("[innerWidth, innerHeight]");
  try {
    for (const size of sizes) {
      await resizeWindow(pid, p, size[0], size[1]);
      await take(size[0]);
    }
  } finally {
    await resizeWindow(pid, p, width!, height!);
  }
}
