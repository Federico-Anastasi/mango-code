// The agent's browser is the app's Preview panel: when the agent opens a page, the page ends up there and not in
// a window outside the app. Real window, without the test's remote debugging (it applies to all the process's
// WebView2s and would replace the panel's port); the model is the fake engine. `bun test integration`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

let env: Environment;
let mc: MangoCode;
let url: string;

beforeAll(async () => {
  env = await start([{ text: "placeholder" }], { window: true, noDebug: true });
  mc = new MangoCode((await find(env.data))!);
  // The page's path is only known now: the script is rewritten and the fake engine restarted, which
  // rereads it at startup.
  const file = path.join(env.project, "panel.html");
  fs.writeFileSync(file, "<!doctype html><title>Panel test</title><h1>PANEL PAGE</h1>");
  url = "file:///" + file.replace(/\\/g, "/");
  fs.writeFileSync(path.join(env.root, "script.json"), JSON.stringify([{ tool: "chrome-devtools_new_page", arguments: { url } }, { text: "Opened." }]));
  await mc.release();
  await mc.resume();
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the page the agent opens ends up in the Preview panel", async () => {
  const id = await mc.createSession(env.project);
  const steps = [];
  for await (const p of mc.turn(id, env.project, "Open the project's page", { model: "fake" })) steps.push(p);
  const tool: any = steps.find((p: any) => p.type === "tool" && p.status === "completed");
  expect(tool?.name).toBe("chrome-devtools_new_page");

  const trace = fs.readFileSync(path.join(env.data, "mcp", "mcp-chrome.log"), "utf8");
  const chosen = trace.match(/browser: app preview panel \(port (\d+)\)/);
  expect(chosen, trace).not.toBeNull();
  const pages: any[] = await (await fetch(`http://127.0.0.1:${chosen![1]}/json`)).json();
  expect(pages.filter((p) => p.type === "page").map((p) => decodeURI(p.url))).toContain(url);
}, 120_000);
