// The test environment cleans after itself: its folder (hundreds of MB while the app runs) is removed when it is
// closed and also when the start fails. Run in a temporary folder of its own, so that it sees only its own leftovers.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedChrome, start } from "./environment";

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
