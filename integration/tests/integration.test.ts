// The integration test (docs/INTEGRATION.md), without a window and without GPUs: Mango Code started with
// --service on an example folder (CLAUDE.md, a rule, a skill, a stdio MCP server); the model is the fake engine
// answering from a script. Run it with `bun test integration`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { start, type Environment } from "./environment";

const GREETING = "Hello from the example project";
// Every conversation goes through the script from the start: the fake engine answers step N, where N is the
// number of tool results already in the conversation.
const SCRIPT = [
  { tool: "skill", arguments: { name: "greeting" } },
  { tool: "echo_repeat", arguments: { text: GREETING } },
  { text: `The official greeting is "${GREETING}". — end` },
];

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start(SCRIPT);
  const s = await find(env.data);
  if (!s) throw new Error("service.json is there but Mango Code does not answer");
  mc = new MangoCode(s);
}, 200_000);

afterAll(() => {
  env?.close();
  // The app closes in a moment; the files stay locked until it has exited.
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

async function runTurn(id: string, text: string, options: Parameters<MangoCode["turn"]>[3] = {}, on?: (p: Step) => Promise<void>) {
  const steps: Step[] = [];
  for await (const p of mc.turn(id, env.project, text, options)) {
    steps.push(p);
    if (on) await on(p);
  }
  return steps;
}

function chatRequests(): any[] {
  return fs
    .readFileSync(env.engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.route.startsWith("/v1/chat/completions"));
}

test("a request that needs a skill and a tool: the skill is read, the tool is called, the text arrives in pieces", async () => {
  const id = await mc.createSession(env.project, { title: "test" });
  const steps = await runTurn(id, "How do we greet in this project?", { model: "fake", system: "App instruction: answer briefly." });

  const tools = steps.filter((p) => p.type === "tool" && p.status === "completed") as Extract<Step, { type: "tool" }>[];
  expect(tools.map((s) => s.name)).toEqual(["skill", "echo_repeat"]);
  expect(tools[0].output).toContain(GREETING);
  expect(tools[1].output).toBe(`echo: ${GREETING}`);
  const pieces = steps.filter((p) => p.type === "text") as Extract<Step, { type: "text" }>[];
  expect(pieces.length).toBeGreaterThan(3);
  expect(pieces.map((p) => p.delta).join("")).toBe(SCRIPT[2].text);
  expect(steps.at(-1)?.type).toBe("end");

  // What reached the model: the project context, the app instruction, the MCP tool.
  const first = chatRequests().at(-3)!.body;
  expect(first.model).toBe("fake");
  const system = first.messages.filter((m: any) => m.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  expect(system).toContain("TANGERINE"); // CLAUDE.md
  expect(system).toContain("End every answer"); // .claude/rules/style.md
  expect(system).toContain("App instruction: answer briefly.");
  expect(system).toContain("greeting"); // the project's skill is announced
  // Nothing from the PC: only the context of the product and of the project.
  const from = [...system.matchAll(/^Instructions from: (.*)$/gm)].map((m) => m[1]);
  expect(from.every((p) => p.startsWith(env.root))).toBe(true);
  expect(system).not.toContain(`${os.homedir()}\\.claude`);
  expect(first.tools.map((t: any) => t.function.name)).toContain("echo_repeat");
}, 120_000);

test("the permissions the conversation asks for arrive as an event and can be answered", async () => {
  const id = await mc.createSession(env.project, { permissions: [{ permission: "skill", pattern: "*", action: "ask" }] });
  const seen: string[] = [];
  const steps = await runTurn(id, "How do we greet?", { model: "fake" }, async (p) => {
    if (p.type === "permission") {
      seen.push(p.request.permission);
      await mc.replyPermission(env.project, p.id, "once");
    }
  });
  expect(seen).toEqual(["skill"]);
  expect(steps.some((p) => p.type === "tool" && p.name === "skill" && p.status === "completed")).toBe(true);
  expect(steps.at(-1)?.type).toBe("end");
}, 120_000);

test("conversations stay and can be resumed", async () => {
  const list = await mc.sessions(env.project);
  expect(list.length).toBeGreaterThanOrEqual(2);
  const id = list.find((s) => s.title === "test")!.id;
  const messages = await mc.messages(id, env.project);
  expect(messages.some((m) => m.info.role === "assistant")).toBe(true);
  // Another message in the same conversation: the model gets the whole history of the first turn.
  const steps = await runTurn(id, "And then?", { model: "fake" });
  expect(steps.at(-1)?.type).toBe("end");
  const last = chatRequests().at(-1)!.body.messages;
  const user = last.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content));
  expect(user.some((t: string) => t.includes("How do we greet in this project?"))).toBe(true);
  expect(user.some((t: string) => t.includes("And then?"))).toBe(true);
  expect(last.filter((m: any) => m.role === "tool").length).toBe(2);
}, 120_000);

test("an image sent to a model without vision does not reach it as an image", async () => {
  // A 1x1 pixel PNG.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const id = await mc.createSession(env.project);
  await runTurn(id, "What do you see?", { model: "fake", attachments: [{ mime: "image/png", data: png, name: "dot.png" }] });
  const user = chatRequests().at(-3)!.body.messages.filter((m: any) => m.role === "user");
  const parts = user.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]));
  expect(parts.some((p: any) => p.type === "image_url")).toBe(false);
  expect(JSON.stringify(parts)).toContain("dot.png");
}, 120_000);

test("offered models", async () => {
  const m = await mc.models(env.project);
  expect(m).toEqual([{ key: "fake", name: "Fake model", context: 16384, images: false }]);
}, 30_000);

test("the GPUs are released and resumed, and the conversation continues", async () => {
  expect((await mc.engine()).phase).toBe("running");
  const released = await mc.release();
  expect(released.phase).toBe("released");
  expect(released.all_released).toBe(true);
  // A message while the GPUs belong to another job waits, then the answer arrives.
  const id = await mc.createSession(env.project);
  const t0 = Date.now();
  const answer = runTurn(id, "How do we greet?", { model: "fake" });
  await Bun.sleep(1500);
  expect((await mc.engine()).phase).toBe("released");
  const resumed = await mc.resume();
  expect(resumed.phase).toBe("running");
  const steps = await answer;
  expect(Date.now() - t0).toBeGreaterThan(1500);
  expect(steps.filter((p) => p.type === "text").map((p: any) => p.delta).join("")).toBe(SCRIPT[2].text);

  // The manager logged who called what (docs/INTEGRATION.md, §6).
  const log = fs.readFileSync(path.join(env.data, "logs", "manager.log"), "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
  const calls = log.filter((r) => r.route);
  expect(calls.map((r) => [r.route, r.status])).toEqual([["/engine/release", 200], ["/engine/resume", 200]]);
  expect(calls.every((r) => r.address.startsWith("127.0.0.1:") && r.user_agent.length > 0)).toBe(true);
  // Before releasing, the conversation is saved; on resume it is reloaded (on-disk memory events).
  const events = log.filter((r) => r.event).map((r) => r.event);
  expect(events.slice(-2)).toEqual(["save", "restore"]);
}, 120_000);
