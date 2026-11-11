// The test environment cleans after itself: its folder (hundreds of MB while the app runs) is removed when it is
// closed and also when the start fails. Run in a temporary folder of its own, so that it sees only its own leftovers.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "./environment";

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
