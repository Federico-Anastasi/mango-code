// The app's window at the narrowest it goes: what the screen says matches what the screen shows. A new conversation names the
// model under the box (the hint points there), and the search box of the Home never loses a word half way. The real window
// is sized as a user does (`resizeWindow`), under the hidden desktop. `off-screen bun test --cwd integration tests/narrow-width.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { saveScreenshot, start, type Environment } from "./environment";
import { resizeWindow } from "./window";

setDefaultTimeout(180_000);

let env: Environment;
let p: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-narrow-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitUntil(condition: () => Promise<boolean>, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await condition().catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}\n${await p.evaluate("document.body.innerText.slice(-600)")}`);
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const shot = async (name: string) => saveScreenshot(env, name, (await p.send("Page.captureScreenshot", { format: "png" })).result.data);

const NAME = '[data-action="prompt-model"] .truncate';

test("a new conversation shows the model's name under the box at every width, wherever the hint says it is", async () => {
  await resizeWindow(env.app.pid!, p, 1100, 800);
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => p.evaluate(`document.body.innerText.includes("my-site")`) as Promise<boolean>, "the project");
  await p.evaluate(`document.querySelector('[aria-label="Nuova conversazione"]').click()`);
  await waitUntil(async () => ((await p.evaluate("location.pathname")) as string).endsWith("/new-session") && (await exists(NAME)), "the new conversation with its model");
  for (const width of [1100, 767, 600, 420, 360, 300]) {
    await resizeWindow(env.app.pid!, p, width, 900);
    await Bun.sleep(400);
    const seen = (await p.evaluate(`(() => {
      const name = document.querySelector(${JSON.stringify(NAME)});
      const box = document.querySelector('[data-component="prompt-input"]').getBoundingClientRect();
      const r = name.getBoundingClientRect();
      return { text: name.textContent, width: r.width, inside: r.left >= box.left - 1 && r.right <= box.right + 1 };
    })()`)) as { text: string; width: number; inside: boolean };
    expect(seen.text.length, `${width}px: the name`).toBeGreaterThan(0);
    expect(seen.width, `${width}px: the name is there to read, not a sliver (${seen.text})`).toBeGreaterThan(48);
    expect(seen.inside, `${width}px: the name is inside the box`).toBe(true);
    if (width === 300 || width === 420) await shot(`01-new-conversation-${width}px`);
  }
});

test("the model can be changed from its name at 300 px, as the hint says", async () => {
  await resizeWindow(env.app.pid!, p, 300, 900);
  await Bun.sleep(400);
  const at = (await p.evaluate(`(() => { const r = document.querySelector('[data-action="prompt-model"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)) as { x: number; y: number };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  await waitUntil(() => exists('[role="menu"], [role="listbox"], [data-component="model-selector-popover"]'), "the models menu");
  await shot("02-model-menu-300px");
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
});

test("the search box of the Home at 300 px: a placeholder that does not fit ends in an ellipsis, not half a word", async () => {
  await resizeWindow(env.app.pid!, p, 300, 900);
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(() => exists('input[type="search"]'), "the search box");
  const box = (await p.evaluate(`(() => {
    const input = document.querySelector('input[type="search"]');
    const style = getComputedStyle(input);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = style.font;
    return { text: input.placeholder, needs: canvas.measureText(input.placeholder).width, has: input.clientWidth, overflow: style.textOverflow };
  })()`)) as { text: string; needs: number; has: number; overflow: string };
  await shot("03-home-300px");
  if (box.needs > box.has) expect(box.overflow, `«${box.text}» needs ${box.needs}px and has ${box.has}px`).toBe("ellipsis");
});
