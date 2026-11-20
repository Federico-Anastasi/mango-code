// A Windows folder written in two ways (letter case, slashes, a slash at the end) is one folder for the agent: a session
// made under one spelling is listed under the other, and keeps the folder's real spelling. The web UI relies on it when it
// keeps one project for the two spellings. The fake engine, no window. `bun test --cwd integration`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { start, type Environment } from "./environment";

let env: Environment;

beforeAll(async () => {
  env = await start([{ text: "Hello from the fake engine." }]);
}, 200_000);

afterAll(() => env?.close());

const sessions = async (directory: string) => {
  const reply = await fetch(`${env.agent}/session?directory=${encodeURIComponent(directory)}`);
  expect(reply.status).toBe(200);
  return (await reply.json()) as Array<{ id: string; directory: string }>;
};

test("a session made under one spelling of the folder is listed under the others and has the folder's own spelling", async () => {
  const real = env.project;
  const lower = `${real[0]!.toLowerCase()}${real.slice(1).toLowerCase()}`.replaceAll("\\", "/") + "/";
  const upper = real.toUpperCase();
  const created = await fetch(`${env.agent}/session?directory=${encodeURIComponent(lower)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(created.status).toBe(200);
  const session = (await created.json()) as { id: string; directory: string };
  expect(session.directory.toLowerCase()).toBe(real.toLowerCase());
  for (const spelling of [real, lower, upper]) {
    const listed = await sessions(spelling);
    expect(listed.map((s) => s.id)).toContain(session.id);
  }
});
