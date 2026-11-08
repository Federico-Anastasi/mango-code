// The same wrong call repeated: the model (scripted fake engine) calls an MCP tool twice with the same wrong input.
// The first reaches the server and fails; the second does not reach the server, and the model receives the earlier
// error with the request to change the input.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const WRONG = { text: { frame: 1 } };
const SCRIPT = [
  { tool: "echo_repeat", arguments: WRONG },
  { tool: "echo_repeat", arguments: WRONG },
  { text: "Understood, I change the input." },
];

let env: Environment;
let mc: MangoCode;
let callsFile: string;

beforeAll(async () => {
  env = await start(SCRIPT);
  mc = new MangoCode((await find(env.data))!);
  callsFile = path.join(env.root, "echo-calls.txt");
  await mc.addMcp(env.project, "echo", {
    type: "local",
    command: ["bun", path.join(env.project, "tools", "echo.mjs")],
    cwd: env.project,
    environment: { ECHO_CALLS: callsFile },
  });
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the second call identical to a wrong one is not run and the model knows why", async () => {
  const id = await mc.createSession(env.project, { title: "repeated" });
  const errors: string[] = [];
  for await (const p of mc.turn(id, env.project, "Repeat the frame", { model: "fake" })) {
    if (p.type === "tool" && p.status === "error") errors.push(p.error ?? "");
  }
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("text: expected a string, received an object");
  expect(errors[1]).toContain("same call");
  expect(errors[1]).toContain("text: expected a string, received an object");
  expect(errors[1]).toContain("change the input");
  // only the first reached the server
  expect(fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
}, 120_000);
