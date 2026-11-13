// "Use my Chrome": with the choice on and Chrome's remote debugging active, a `new_page` that asks for it (`userChrome: true`)
// opens a new tab in that Chrome and not in the panel, through the whole chain: app, agent, tool definition, browser server.
// In place of the user's Chrome, a windowless Chrome with a temporary profile and its `DevToolsActivePort` in a fake
// LOCALAPPDATA. Without the request every page goes to the panel, and the tabs the user has are never taken over:
// `browser-mcp.test.ts` checks that.
// What remains to be seen on screen (the debugging turned on from chrome://inspect, Chrome's notice at every connection)
// is checked by hand.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const CHROME = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");

let env: Environment;
let mc: MangoCode;
let chrome: ChildProcess;
let port: number;
let fakeRoot: string;
const SITE = 48243;
const TEST_URL = `http://myapp.test:${SITE}/`;
let site: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!fs.existsSync(CHROME)) throw new Error(`${CHROME} is missing`);
  fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mango-my-chrome-"));
  const profile = path.join(fakeRoot, "profile");
  site = Bun.serve({ port: SITE, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>my-chrome</title>MY CHROME", { headers: { "content-type": "text/html" } }) });
  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--host-resolver-rules=MAP myapp.test 127.0.0.1", "about:blank"], { stdio: "ignore" });
  // With port 0 Chrome picks one and writes it in the profile's DevToolsActivePort: the same file Chrome
  // writes in the default profile when debugging is turned on from chrome://inspect.
  const active = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await Bun.sleep(100);
  const lines = fs.readFileSync(active, "utf8");
  port = Number(lines.split("\n")[0]);
  const userData = path.join(fakeRoot, "local", "Google", "Chrome", "User Data");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "DevToolsActivePort"), lines);

  env = await start([{ tool: "chrome-devtools_new_page", arguments: { url: TEST_URL, userChrome: true } }, { text: "Opened." }], {
    env: { LOCALAPPDATA: path.join(fakeRoot, "local") },
  });
  fs.writeFileSync(path.join(env.data, "browser.json"), JSON.stringify({ myChrome: true }));
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  site?.stop(true);
  try {
    chrome?.kill();
  } catch {}
  Bun.sleepSync(1500);
  for (const d of [env?.root, fakeRoot]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("with \"Use my Chrome\" the agent opens a page in the user's Chrome when it asks for it", async () => {
  const id = await mc.createSession(env.project);
  const steps = [];
  for await (const p of mc.turn(id, env.project, "Open the page", { model: "fake" })) steps.push(p);
  const tool: any = steps.find((p: any) => p.type === "tool" && p.status === "completed");
  expect(tool?.name).toBe("chrome-devtools_new_page");

  const trace = fs.readFileSync(path.join(env.data, "mcp", "mcp-chrome.log"), "utf8");
  expect(trace).toContain(`browser: user's Chrome via HTTP (port ${port})`);
  const pages: any[] = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  expect(pages.map((p) => p.title)).toContain("my-chrome");
}, 120_000);
