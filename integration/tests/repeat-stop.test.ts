// An answer in which the model writes the same text again and again is cut, in the app's real window: the conversation
// shows the text once, the line that says why, and the answer that follows. The message the agent writes to ask the
// model to go on is not one of the user's. Fake engine, no GPU. `bun test --cwd integration tests/repeat-stop.test.ts`,
// after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find } from "../client/mango-code";
import { saveScreenshot, start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const text = () => p.evaluate("document.body.innerText") as Promise<string>;
const LINE = "I will open the page and check the title again. ";

async function waitFor(what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await text()).includes(what)) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for «${what}»; the page: ${(await text()).slice(-800)}`);
    await Bun.sleep(250);
  }
}

beforeAll(async () => {
  // the fake engine says a word every few milliseconds: the loop is long
  process.env.FAKE_ENGINE_CHUNK_MS = "1";
  env = await start(
    [
      { if: "What comes next?", text: "Third answer here." },
      { if: "kept repeating", text: "Second answer here." },
      { text: `Start of the answer. ${LINE.repeat(260)}` },
    ],
    { window: true },
  );
  mc = new MangoCode((await find(env.data))!);
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  delete process.env.FAKE_ENGINE_CHUNK_MS;
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the repeated text is shown once, with the line that says why, and the turn goes on", async () => {
  const id = await mc.createSession(env.project, { title: "loop" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(3000);
  for await (const _ of mc.turn(id, env.project, "Check the page.")) void _;
  await waitFor("Second answer here.");
  const shown = await text();
  expect(shown).toContain("Start of the answer.");
  expect(shown.split(LINE.trim()).length - 1).toBe(1);
  expect(shown).toContain("Risposta fermata: ripeteva lo stesso testo.");
  // the message that asks the model to go on is the agent's, not shown as one of the user's
  expect(shown).not.toContain("Your answer stopped");
  saveScreenshot(env, "mango-repeat-stop", (await p.send("Page.captureScreenshot", { format: "png" })).result.data);

  for await (const _ of mc.turn(id, env.project, "What comes next?")) void _;
  await waitFor("Third answer here.");
  const after = await text();
  expect(after).toContain("Second answer here.");
  expect(after).toContain("What comes next?");
}, 180_000);
