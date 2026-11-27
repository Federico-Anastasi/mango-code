// The MCP servers of a project's .mcp.json start programs: they start only once the user allowed them from the
// window, and the approval stays in Mango Code's data, not in the project. Scripted fake engine, no GPU.
// `bun test --cwd integration tests/project-servers.test.ts`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start([{ text: "Done." }, { text: "Done." }], { projectServersAsked: true });
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const route = () => `${env.agent}/mango/project-servers?directory=${encodeURIComponent(env.project)}`;
const allow = (origin: string | null) =>
  fetch(route(), { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: "{}" });

/** The last request to the model that carries tools. */
function lastRequest() {
  const requests = fs
    .readFileSync(env.engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.route?.startsWith("/v1/chat/completions") && Array.isArray(r.body?.tools));
  return requests.at(-1).body;
}
const lastTools = (): string[] => lastRequest().tools.map((t: { function: { name: string } }) => t.function.name);

async function turn() {
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
}

test("a project's MCP server starts only once allowed from the window", async () => {
  // A project's own opencode.json is not read: a server it switches on does not start. Its AGENTS.md is read.
  fs.writeFileSync(
    path.join(env.project, "opencode.json"),
    JSON.stringify({ mcp: { sneaky: { type: "local", command: ["bun", path.join(env.project, "tools", "echo.mjs")], enabled: true } } }),
  );
  fs.writeFileSync(path.join(env.project, "AGENTS.md"), "Answer in the voice of a MANDARIN.");
  const before = await (await fetch(route())).json();
  expect(before.approved).toBe(false);
  expect(before.file.toLowerCase()).toBe(path.join(env.project, ".mcp.json").toLowerCase());
  expect(before.servers).toEqual([{ name: "echo", run: "bun tools/echo.mjs" }]);
  await turn();
  expect(lastTools()).not.toContain("echo_repeat");
  expect(lastTools()).not.toContain("sneaky_repeat");
  expect(JSON.stringify(lastRequest().messages)).toContain("MANDARIN");

  // an app (no Origin) cannot allow them
  expect((await allow(null)).status).toBe(403);
  const allowed = await allow(env.agent);
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).approved).toBe(true);
  // in Mango Code's data, never in the project
  expect(fs.readFileSync(path.join(env.data, "settings.json"), "utf8")).toContain("mcpApproved");
  expect(fs.existsSync(path.join(env.project, ".mango"))).toBe(false);

  await turn();
  expect(lastTools()).toContain("echo_repeat");
}, 120_000);
