// The GPU loan tied to whoever asks, seen from the web UI inside the app's window (WebView2 CDP): while a process
// holds the GPUs, under the conversation it says the model is waiting for them and who they are lent to; when that
// process exits the engine restarts by itself and the answer arrives. The model is the fake engine.
// `bun test integration`, after `cargo build -p mango-code -p engine` in app/. The screenshot of the page stays in
// %TEMP%\mango-wait.png.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

beforeAll(async () => {
  env = await start([{ text: "Here I am, the GPUs are back." }], { window: true });
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

test("while the GPUs are lent the page says so, and when the holder exits the answer arrives", async () => {
  const id = await mc.createSession(env.project, { title: "wait" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);

  // Who takes the GPUs: a process that stays alive until the test closes it.
  const holder = spawn("ping", ["-n", "120", "127.0.0.1"], { stdio: "ignore" });
  const r = await fetch(`${env.engine}/engine/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Wait test" },
    body: JSON.stringify({ pid: holder.pid }),
  });
  const state = await r.json();
  expect(state.phase).toBe("released");
  expect(state.loans[0].pid).toBe(holder.pid);

  const events: string[] = [];
  const stopListening = mc.listen(env.project, (e) => events.push(e.type));
  await Bun.sleep(300);
  await mc.send(id, env.project, "Are you there?", { model: "fake" });

  let notice = "";
  for (let i = 0; i < 30 && !notice.includes("aspetta le schede"); i++) {
    await Bun.sleep(500);
    notice = await p.evaluate(`document.querySelector('[data-component="engine-speed"]')?.innerText ?? ''`);
  }
  expect(notice).toContain("Il modello aspetta le schede video, prestate a Wait test dalle");
  // also the turn's line in the conversation, in place of "Sto leggendo la richiesta"
  const row = await p.evaluate(`document.body.innerText`);
  expect(row.split("Il modello aspetta le schede video").length - 1).toBeGreaterThanOrEqual(2);
  expect(row).not.toContain("Sto leggendo la richiesta");
  const shot = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "mango-wait.png"), Buffer.from(shot.result.data, "base64"));
  expect(events).not.toContain("session.idle");

  // The holder exits without resuming: the manager restarts by itself and the conversation continues.
  holder.kill();
  for (let i = 0; i < 40 && !events.includes("session.idle"); i++) await Bun.sleep(500);
  stopListening();
  expect(events).toContain("session.idle");
  const messages = await mc.messages(id, env.project);
  const text = messages.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  expect(text).toContain("Here I am, the GPUs are back.");
  const log = fs.readFileSync(path.join(env.data, "logs", "manager.log"), "utf8");
  expect(log).toContain('"loan_ended"');
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 120_000);
