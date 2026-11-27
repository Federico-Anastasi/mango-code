// An agent that ends by itself after the start (a crash, the memory, an antivirus) is started again by the app: the
// window does not stay on an address nobody answers, and a conversation goes on with the new agent. Fake engine, no
// GPU used. `bun test --cwd integration tests/agent-ends.test.ts`, after `cargo build` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

let env: Environment;

beforeAll(async () => {
  env = await start([{ text: "An answer." }]);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

/** The process that listens on the agent's port. */
function agentPid(agent: string) {
  const port = new URL(agent).port;
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`],
    { encoding: "utf8", windowsHide: true },
  );
  return Number(out.stdout.trim());
}

async function answer(mc: MangoCode, project: string, text: string) {
  const id = await mc.createSession(project);
  let written = "";
  for await (const p of mc.turn(id, project, text, { model: "fake" })) if (p.type === "text") written += p.delta;
  return written;
}

test("an agent that ends by itself is started again", async () => {
  const before = (await find(env.data))!;
  expect(await answer(new MangoCode(before), env.project, "Hello")).toContain("An answer");
  const service = path.join(env.data, "service.json");
  const written = fs.statSync(service).mtimeMs;

  const pid = agentPid(before.agent);
  expect(pid).toBeGreaterThan(0);
  spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });

  const t0 = Date.now();
  let after = null;
  while (Date.now() - t0 < 120_000) {
    after = fs.existsSync(service) && fs.statSync(service).mtimeMs !== written ? await find(env.data) : null;
    if (after) break;
    await Bun.sleep(300);
  }
  expect(after).not.toBeNull();
  expect(agentPid(after!.agent)).not.toBe(pid);
  expect(await answer(new MangoCode(after!), env.project, "Again")).toContain("An answer");
  expect(fs.readFileSync(path.join(env.data, "logs", "startup.log"), "utf8")).toContain("the agent ended by itself");
}, 240_000);
