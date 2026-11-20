// The «/» menu of the composer, in the app's real window (WebView2 CDP), offers a skill put in the project's folder while
// the app is open: the list is asked again when the user comes back to the window and when a turn ends.
// Fake engine, no GPU. Own ports (47795-47797).
// `off-screen bun test --cwd integration tests/skills-menu.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47795, 47796, 47797];

let env: Environment;
let mc: MangoCode;
let p: Page;
let id = "";

beforeAll(async () => {
  env = await start([{ text: "ok" }], {
    window: true,
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
  });
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(env.project, { title: "menu" });
  await p.send("Page.navigate", { url: `${env.agent}/${btoa(env.project).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}/session/${id}` });
  await waitFor(`document.querySelector('[data-action="titlebar-model"]')?.innerText.includes("Fake model")`, 60_000);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
}, 30_000);

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition).catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

function addSkill(name: string) {
  const dir = path.join(env.project, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: A skill added while the app is open.\n---\n\nBody.\n`);
}

/** Types «/» in an empty composer and tells whether the menu offers `name`; the composer is emptied again. */
async function menuOffers(name: string) {
  await waitFor(`!!document.querySelector('[contenteditable="true"]')`);
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); })()`);
  await p.send("Input.insertText", { text: "/" });
  try {
    await waitFor(`document.body.textContent.includes("/${name}")`, 5_000);
    return true;
  } catch {
    return false;
  } finally {
    await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); document.execCommand('selectAll'); document.execCommand('delete'); el.blur(); })()`);
  }
}

test("a skill added while the window was in the background is in the menu when the user comes back to it", async () => {
  expect(await menuOffers("descale")).toBe(false);
  addSkill("descale");
  await p.evaluate(`window.dispatchEvent(new Event("focus"))`);
  expect(await menuOffers("descale")).toBe(true);
}, 60_000);

test("a skill added during a turn, as the model may do, is in the menu when the turn ends", async () => {
  addSkill("polish");
  for await (const _ of mc.turn(id, env.project, "Ciao", { model: "fake" }));
  expect(await menuOffers("polish")).toBe(true);
}, 60_000);
