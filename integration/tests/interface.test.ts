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

test("the search in the conversation: the lens and Ctrl+F open the bar, it counts and moves between the results, and Esc closes it", async () => {
  // the conversation of the test before: the user's message and the model's answer
  const bar = '[data-component="conversation-find"]';
  const input = `${bar} [data-slot="conversation-find-input"]`;
  const count = () => p.evaluate(`document.querySelector('${bar} [data-slot="conversation-find-count"]')?.innerText.trim() ?? ""`) as Promise<string>;
  const current = () => p.evaluate(`[...(CSS.highlights.get("conversation-find-current") ?? [])].map((r) => r.toString())`) as Promise<string[]>;
  const until = async (what: string, condition: () => Promise<boolean>) => {
    for (let i = 0; i < 60 && !(await condition().catch(() => false)); i++) await Bun.sleep(150);
    expect(await condition(), what).toBe(true);
  };
  const mouse = async (selector: string) => {
    const at = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
    expect(at, selector).toBeTruthy();
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  };
  const typeIn = async (value: string) => {
    await p.evaluate(`(() => { const el = document.querySelector('${input}'); el.focus(); el.select(); })()`);
    await p.send("Input.insertText", { text: value });
  };
  expect(await p.evaluate(`!!document.querySelector('${bar}')`)).toBe(false);

  await mouse('[data-action="conversation-find"]');
  await until("the bar", async () => (await p.evaluate(`!!document.querySelector('${input}')`)) as boolean);
  await until("the box focused", async () => (await p.evaluate(`document.activeElement === document.querySelector('${input}')`)) as boolean);

  // one result: the word is in the model's answer only, and it is the one marked
  await typeIn("answers");
  await until("one result", async () => (await count()) === "1 di 1");
  await until("the result marked", async () => (await current()).join() === "answers");

  // many results: the next and the previous move through them
  await typeIn("s");
  await until("several results", async () => /^1 di (\d+)$/.test(await count()) && Number(/di (\d+)$/.exec(await count())![1]) > 2);
  const total = Number(/di (\d+)$/.exec(await count())![1]);
  await mouse('[data-component="conversation-find"] button[aria-label="Risultato successivo"]');
  await until("the second result", async () => (await count()) === `2 di ${total}`);
  await mouse('[data-component="conversation-find"] button[aria-label="Risultato precedente"]');
  await until("the first result again", async () => (await count()) === `1 di ${total}`);
  await mouse('[data-component="conversation-find"] button[aria-label="Risultato precedente"]');
  await until("the last result, after the first", async () => (await count()) === `${total} di ${total}`);

  // nothing found says so
  await typeIn("zzzzqq");
  await until("no result", async () => (await count()) === "Nessun risultato");
  expect(await current()).toEqual([]);

  // Esc closes it and the marks go; Ctrl+F opens it again
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("the bar closed", async () => !(await p.evaluate(`!!document.querySelector('${bar}')`)));
  expect(await p.evaluate(`CSS.highlights.has("conversation-find")`)).toBe(false);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
  await until("the bar opened by Ctrl+F", async () => (await p.evaluate(`!!document.querySelector('${input}')`)) as boolean);
}, 90_000);
