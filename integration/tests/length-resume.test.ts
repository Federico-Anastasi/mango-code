// An answer cut by the length limit goes on once by itself, in the app's real window: the conversation shows the first
// half, the line that says it is taken up, the second half, and the answers of the turns after it. The message the agent
// writes to take up the answer is not one of the user's: it is no point where the conversation stops being shown.
// Fake engine, no GPU. `bun test --cwd integration tests/length-resume.test.ts`, after `cargo build -p mango-code -p
// engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const text = () => p.evaluate("document.body.innerText") as Promise<string>;

async function waitFor(what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await text()).includes(what)) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for «${what}»; the page: ${(await text()).slice(-800)}`);
    await Bun.sleep(250);
  }
}

beforeAll(async () => {
  // The steps outside the numbering are tried in order: the later question first, then the request that takes the cut
  // answer up (it carries the agent's text about the length limit).
  env = await start(
    [
      { if: "What comes next?", text: "Third answer here." },
      { if: "reached the length limit", text: "Second half here." },
      { text: "First half here,", finish: "length" },
    ],
    { window: true },
  );
  mc = new MangoCode((await find(env.data))!);
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the cut answer, its taking up and the next turn are all in the conversation", async () => {
  const id = await mc.createSession(env.project, { title: "long" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(3000);
  for await (const _ of mc.turn(id, env.project, "Write a long answer.")) void _;
  await waitFor("Second half here.");
  expect(await text()).toContain("First half here,");
  expect(await text()).toContain("La risposta era troppo lunga: riprendo da dove si è fermata.");
  expect(await text()).not.toContain("Continua");

  for await (const _ of mc.turn(id, env.project, "What comes next?")) void _;
  await waitFor("Third answer here.");
  const page = await text();
  expect(page).toContain("Second half here.");
  expect(page).toContain("What comes next?");
  // the message that took the answer up is the agent's, not shown as one of the user's
  expect(page).not.toContain("Your answer was cut");
}, 180_000);
