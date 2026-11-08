// The web UI inside the app's window, driven like a user (WebView2 CDP): the questions dialog. It opens a window for
// a few seconds; the model is the fake engine. `bun test integration`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const SCRIPT = [
  {
    tool: "question",
    arguments: {
      questions: [
        { question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cold" }] },
        { question: "Which shape?", header: "Shape", options: [{ label: "Circle", description: "round" }, { label: "Square", description: "angular" }] },
      ],
    },
  },
  { text: "Thanks, I have your answers." },
];

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

beforeAll(async () => {
  env = await start(SCRIPT, { window: true });
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

/** Click on a dialog button, found by its text. */
async function click(text: string) {
  const r = await p.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(e => e.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(text)});
    if (!el) return 'not found';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  })()`);
  expect(`${text}: ${r}`).toBe(`${text}: ok`);
  await Bun.sleep(800);
}

test("the questions are answered from the dialog and the conversation continues", async () => {
  const id = await mc.createSession(env.project, { title: "questions" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);
  const events: string[] = [];
  const stop = mc.listen(env.project, (e) => events.push(e.type));
  await Bun.sleep(300);
  await mc.send(id, env.project, "Ask me two questions", { model: "fake" });
  for (let i = 0; i < 60 && !events.includes("question.asked"); i++) await Bun.sleep(500);
  await Bun.sleep(2000);

  // the dialog's own buttons are Italian: the environment's language is "it"
  await click("Red");
  await click("Avanti");
  await click("Circle");
  await click("Invia");
  for (let i = 0; i < 40 && !events.includes("session.idle"); i++) await Bun.sleep(500);
  stop();

  expect(events).toContain("question.replied");
  expect(events).toContain("session.idle");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
  const messages = await mc.messages(id, env.project);
  const question = messages.flatMap((m) => m.parts).find((x: any) => x.type === "tool" && x.tool === "question");
  expect(question.state.status).toBe("completed");
  expect(question.state.output).toContain("Red");
  expect(question.state.output).toContain("Circle");
  expect(await p.evaluate("document.body.innerText")).toContain("Thanks, I have your answers.");
}, 120_000);
