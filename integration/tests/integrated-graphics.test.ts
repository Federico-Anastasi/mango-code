// Settings › Computer on a laptop with only the processor's graphics (`MANGO_HARDWARE`, development builds only): the row
// of the integrated graphics shows the memory it may borrow, shared with the RAM, with its switch off; turned on, the
// choice is saved and the model in use loads again on it. Fake engine. `bun test --cwd integration`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeRoot, saveScreenshot, start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { resizeWindow } from "./window";

const RADEON = "AMD Radeon(TM) Graphics";

let env: Environment;
let p: Page;
let hardware: string;

beforeAll(async () => {
  hardware = fs.mkdtempSync(path.join(os.tmpdir(), "mango-hardware-"));
  const file = path.join(hardware, "hardware.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      gpus: [{ index: 0, name: RADEON, vendor: "amd", memory_mib: 512, shared_mib: 7700, cuda_driver: null, cc: null }],
      cpu: { name: "AMD Ryzen 7 5825U", cores: 8, avx2: true, avx512: false },
      ram_mib: 15700,
    }),
  );
  env = await start([{ text: "Done." }], { window: true, env: { MANGO_HARDWARE: file } });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
  await resizeWindow(env.app.pid!, p, 1280, 900);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  if (env) removeRoot(env.root);
  fs.rmSync(hardware, { recursive: true, force: true });
});

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

async function until(what: string, done: () => Promise<boolean> | boolean, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${what}`);
}

const choices = () => {
  const file = path.join(env.data, "choices.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};

const engineGpus = async (): Promise<string[]> =>
  ((await (await fetch(`${env.engine}/engine`)).json()).gpus as { name: string }[]).map((g) => g.name);

test("Computer: the integrated graphics is off at first, shows the memory it may borrow, and once on the model runs there", async () => {
  expect(await engineGpus()).toEqual([]);
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=computer` });
  const row = `document.querySelector('[data-component="settings-computer"] [data-action="settings-gpu-used"][data-gpu=${JSON.stringify(RADEON)}]')`;
  await waitFor(`!!${row}`, 30_000);
  const toggle = `${row}.querySelector('input')`;
  const text: string = await p.evaluate(`document.querySelector('[data-component="settings-computer"]').textContent`);
  expect(text).toContain(`${RADEON} · `);
  expect(text).toContain("(condivisi con la RAM)");
  // one card alone: nothing to choose between one card and all the cards
  const smallModels = `!!document.querySelector('[data-action="settings-small-models"]')`;
  expect(await p.evaluate(smallModels)).toBe(false);
  expect(await p.evaluate(`${toggle}.checked`)).toBe(false);
  expect(await p.evaluate(`${toggle}.disabled`)).toBe(false);

  await p.evaluate(`${toggle}.click()`);
  await until("the choice saved", () => choices().computer?.integrated === true);
  await waitFor(`${toggle}.checked === true`);
  await until("the model on the integrated graphics", async () => (await engineGpus()).includes(RADEON), 60_000);
  expect(await p.evaluate(smallModels)).toBe(false);
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot(env, "mango-settings-integrated-graphics", r.result.data);

  await p.evaluate(`${toggle}.click()`);
  await until("the choice off", () => choices().computer?.integrated === false);
  await until("the model back on the processor", async () => (await engineGpus()).length === 0, 60_000);
}, 180_000);
