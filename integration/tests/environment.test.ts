// The test environment cleans after itself: its folder (hundreds of MB while the app runs) is removed when it is
// closed and also when the start fails. Run in a temporary folder of its own, so that it sees only its own leftovers.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedChrome, removeRoot, start } from "./environment";

let scratch: string;
/** What the environments left in the temporary folder (the app and its engine have temporary files of their own). */
const leftovers = () => fs.readdirSync(scratch).filter((name) => name.startsWith("mango-integration-"));
const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mango-environment-test-"));
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
});

afterAll(() => {
  process.env.TEMP = saved.TEMP;
  process.env.TMP = saved.TMP;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a start that fails leaves no folder behind", async () => {
  await expect(
    start(() => {
      throw new Error("the script cannot be made");
    }),
  ).rejects.toThrow("the script cannot be made");
  expect(leftovers()).toEqual([]);
});

test("closing the environment removes its folder", async () => {
  const env = await start([{ text: "Done." }]);
  env.close();
  expect(fs.existsSync(env.root)).toBe(false);
  expect(leftovers()).toEqual([]);
}, 240_000);

test("a folder that a process holds open fails the removal with what it could not remove, and goes once the process lets go", async () => {
  const folder = fs.mkdtempSync(path.join(scratch, "it's held-"));
  const file = path.join(folder, "held.txt");
  fs.writeFileSync(file, "x");
  // Opened for reading and sharing only reading: Windows will not delete the file, or the folder, while the process is there.
  const holder = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$f = [IO.File]::Open($env:HELD_FILE, 'Open', 'Read', 'Read'); Write-Output 'held'; Start-Sleep -Seconds 120"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, HELD_FILE: file } },
  );
  try {
    await new Promise<void>((resolve) => holder.stdout.on("data", (data) => String(data).includes("held") && resolve()));
    let failure: unknown;
    try {
      removeRoot(folder, 2);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("could not be removed");
    expect((failure as Error).cause).toMatchObject({ code: "EBUSY" });
    expect(fs.existsSync(folder)).toBe(true);

    // the holder is stopped by its own id; the removal that was waiting for it then succeeds
    const gone = new Promise((resolve) => holder.once("exit", resolve));
    process.kill(holder.pid!);
    await gone;
    removeRoot(folder);
    expect(fs.existsSync(folder)).toBe(false);
  } finally {
    if (holder.exitCode === null) process.kill(holder.pid!);
  }
}, 60_000);

test("closing the environment also stops the apps launched in it by hand", async () => {
  const env = await start([{ text: "Done." }]);
  // A start while the app runs hands over to it and exits on its own: the one that stays is the start of an app that is not running.
  const first = env.app;
  const stopped = new Promise((resolve) => first.once("exit", resolve));
  spawnSync("taskkill", ["/PID", String(first.pid), "/T", "/F"]);
  await stopped;
  const second = env.launch([]);
  await Bun.sleep(3000);
  // The start is this test's own child: its exit is read from the child, not from a process id that the system may give to another.
  expect(second.exitCode).toBeNull();
  const closed = new Promise<void>((resolve) => second.once("exit", () => resolve()));
  env.close();
  await Promise.race([closed, Bun.sleep(10_000).then(() => Promise.reject(new Error("the app launched by hand was still running 10 s after the environment closed")))]);
  expect(leftovers()).toEqual([]);
}, 240_000);

test("Chrome is found in whichever of its places Windows installed it, and missing from all the error names them", () => {
  const places = { ProgramFiles: path.join(scratch, "for-everyone"), "ProgramFiles(x86)": path.join(scratch, "32-bit"), LOCALAPPDATA: path.join(scratch, "for-the-user") };
  const before = Object.fromEntries(Object.keys(places).map((name) => [name, process.env[name]]));
  Object.assign(process.env, places);
  try {
    expect(() => installedChrome()).toThrow(places.LOCALAPPDATA);
    const exe = path.join(places["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    expect(installedChrome()).toBe(exe);
  } finally {
    Object.assign(process.env, before);
  }
});
