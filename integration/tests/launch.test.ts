// `mango-launch -p "request"`: Mango Code used from a script. The real app and agent with the fake engine answering from
// a script. Run it with `bun test --cwd integration tests/launch.test.ts`, after `cargo build -p mango-code -p engine` in
// app/. One environment; the last test closes its app and has the program start it again.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { APP_EXE, REPO, start, type Environment } from "./environment";

const LAUNCH_EXE = path.join(REPO, "app", "target", "debug", "mango-launch.exe");
if (!fs.existsSync(LAUNCH_EXE)) throw new Error(`${LAUNCH_EXE} is missing: cargo build -p engine (in app/)`);
if (!fs.existsSync(APP_EXE)) throw new Error(`${APP_EXE} is missing: cargo build -p mango-code (in app/)`);

const started: number[] = [];
afterAll(() => {
  // An app started by mango-launch is not the environment's own process: it is stopped here by its pid.
  for (const pid of started) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  Bun.sleepSync(1500);
  requests?.close();
});

/** Runs `mango-launch.exe` against the environment's app and data. */
function launch(e: Environment, args: string[]) {
  const r = spawnSync(LAUNCH_EXE, args, { cwd: e.project, env: e.appEnv, encoding: "utf8", timeout: 240_000 });
  return { code: r.status, out: r.stdout, error: r.stderr };
}

let requests: Environment;
const answer = "The answer of the fake engine";

test("the request is answered on stdout by the app that is already open, and the conversation is saved", async () => {
  requests = await start([{ text: answer }]);
  const r = launch(requests, ["-p", "Say something"]);
  expect(r.out).toContain(answer);
  expect(r.code).toBe(0);
  // It reached the model as the user's message, and it is one of the folder's sessions.
  const log = fs.readFileSync(requests.engineLog, "utf8");
  expect(log).toContain("Say something");
  const mc = new MangoCode((await find(requests.data))!);
  expect((await mc.sessions(requests.project)).length).toBe(1);
}, 300_000);

test("a request that starts with a dash is still the request", () => {
  const r = launch(requests, ["-p", "-5 is a number"]);
  expect(r.out).toContain(answer);
  expect(r.code).toBe(0);
  expect(fs.readFileSync(requests.engineLog, "utf8")).toContain("-5 is a number");
});

test("a model that is not there is a failure with the agent's code 1, not a silent success", () => {
  const r = launch(requests, ["-p", "hello", "--model", "does-not-exist"]);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain(answer);
});

test("with the app closed, it is started without a window and the request is answered", () => {
  const service = path.join(requests.data, "service.json");
  spawnSync("taskkill", ["/PID", String(JSON.parse(fs.readFileSync(service, "utf8")).pid), "/T", "/F"]);
  // A closed app leaves its file behind when it is killed: the program must not believe it.
  for (let waited = 0; waited < 20_000; waited += 200) {
    try {
      process.kill(JSON.parse(fs.readFileSync(service, "utf8")).pid, 0);
    } catch {
      break;
    }
    Bun.sleepSync(200);
  }
  const r = launch(requests, ["-p", "Say something again"]);
  started.push(JSON.parse(fs.readFileSync(service, "utf8")).pid);
  expect(r.out).toContain(answer);
  expect(r.code).toBe(0);
}, 400_000);
