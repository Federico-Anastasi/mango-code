// An MCP server added under a name that already exists (as an app does with every conversation it starts): with the
// same configuration nothing is touched and the calls in progress finish; with a different one the tool is replaced
// and conversations use the new one. Scripted fake engine, no GPU.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find, type Step, type McpServer } from "../client/mango-code";
import { start, type Environment } from "./environment";

const SCRIPT = [
  { tool: "echo_repeat", arguments: { text: "one", wait_ms: 6000 } },
  { tool: "echo_repeat", arguments: { text: "two" } },
  { text: "Done." },
];

let env: Environment;
let mc: MangoCode;
let startsFile: string;
let config: McpServer;

const configWith = (environment: Record<string, string>): McpServer => ({
  type: "local",
  command: ["bun", path.join(env.project, "tools", "echo.mjs")],
  cwd: env.project,
  environment: { ECHO_STARTS: startsFile, ...environment },
});
const startsDone = () => (fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").split("\n").filter(Boolean).length : 0);

beforeAll(async () => {
  env = await start(SCRIPT, { chunkMs: 100 });
  mc = new MangoCode((await find(env.data))!);
  startsFile = path.join(env.root, "echo-starts.txt");
  config = configWith({});
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

/** A turn that calls the tool twice; `whenStarted` runs as soon as the first call is in progress. */
async function runTurn(id: string, whenStarted?: () => Promise<void>) {
  const steps: Step[] = [];
  let started = false;
  for await (const p of mc.turn(id, env.project, "use the tool", { model: "fake" })) {
    steps.push(p);
    if (whenStarted && !started && p.type === "tool" && p.status === "running") {
      started = true;
      await whenStarted();
    }
  }
  return steps.filter((p): p is Extract<Step, { type: "tool" }> => p.type === "tool" && (p.status === "completed" || p.status === "error")).map((p) => [p.status, p.output ?? p.error]);
}

test("the same server added again with the same configuration does not restart and stays usable", async () => {
  await Promise.all([mc.addMcp(env.project, "echo", config), mc.addMcp(env.project, "echo", config)]);
  await mc.addMcp(env.project, "echo", config);
  expect((await mc.mcpStatus(env.project)).echo.status).toBe("connected");
  expect(startsDone()).toBe(1);
  expect(await runTurn(await mc.createSession(env.project))).toEqual([["completed", "echo: one"], ["completed", "echo: two"]]);
}, 120_000);

test("added again while a conversation is using it, the call in progress finishes", async () => {
  const done = await runTurn(await mc.createSession(env.project), () => mc.addMcp(env.project, "echo", config));
  expect(done).toEqual([["completed", "echo: one"], ["completed", "echo: two"]]);
  expect(startsDone()).toBe(1);
}, 120_000);

test("with a different configuration the tool is replaced: the conversation opened before uses the new one", async () => {
  const id = await mc.createSession(env.project);
  await mc.addMcp(env.project, "echo", configWith({ ECHO_PREFIX: "new" }));
  expect(startsDone()).toBe(2);
  expect((await mc.mcpStatus(env.project)).echo.status).toBe("connected");
  expect(await runTurn(id)).toEqual([["completed", "new: one"], ["completed", "new: two"]]);
}, 120_000);
