// `off-screen` (app/crates/engine/src/bin/off-screen.rs) runs a command on a desktop nobody sees: the command is
// there and not on the screen's desktop, its output and exit code come back, and what it started ends with it.
// `bun test --cwd integration tests/off-screen.test.ts`, after `cargo build -p engine` in app/.

import { expect, test } from "bun:test";
import path from "node:path";
import { OFF_SCREEN_EXE } from "./environment";

const NAME = ["powershell", "-NoProfile", "-File", path.join(import.meta.dir, "desktop-name.ps1")];

async function run(command: string[]) {
  const r = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(r.stdout).text(), await new Response(r.stderr).text()];
  return { code: await r.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

test("the command runs on a desktop of its own, and its output and exit code come back", async () => {
  // the desktop of this test: the one on the screen, or another `off-screen` when the whole suite runs under it
  const here = await run(NAME);
  expect(here.code).toBe(0);
  const off = await run([OFF_SCREEN_EXE, ...NAME, "-ExitCode", "7"]);
  expect(off.stdout).toMatch(/^mango-off-screen-\d+$/);
  expect(off.stdout).not.toBe(here.stdout);
  expect(off.code).toBe(7);
}, 60_000);

test("what the command started ends with it when it is stopped halfway", async () => {
  const r = Bun.spawn([OFF_SCREEN_EXE, "powershell", "-NoProfile", "-Command", "$PID; Start-Sleep 120"], { stdout: "pipe", stderr: "ignore" });
  const reader = r.stdout.getReader();
  const child = Number(new TextDecoder().decode((await reader.read()).value).trim());
  expect(child).toBeGreaterThan(0);
  expect(() => process.kill(child, 0)).not.toThrow();

  r.kill();
  await r.exited;
  let alive = true;
  for (let waited = 0; alive && waited < 10_000; waited += 100) {
    try {
      process.kill(child, 0);
      await Bun.sleep(100);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
}, 60_000);

test("a command that cannot be started says so", async () => {
  const missing = await run([OFF_SCREEN_EXE, "no-such-program-here"]);
  expect(missing.code).toBe(3);
  expect(missing.stderr).toContain("no-such-program-here");
  expect((await run([OFF_SCREEN_EXE])).code).toBe(2);
}, 60_000);
