// A skill put in the project's folder while the app is open reaches the model without restarting: a new conversation
// lists it, a conversation already open is told about it in its next message (its system prompt unchanged), and it is
// in the «/» menu and on the settings page.
// Scripted fake engine, no GPU.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const SCRIPT = [{ tool: "skill", arguments: { name: "kettle" } }, { text: "Done — end" }];

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start(SCRIPT);
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const chatRequests = () =>
  fs
    .readFileSync(env.engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.route.startsWith("/v1/chat/completions") && r.body.tools?.length);

const systemText = (body: any): string =>
  body.messages.filter((m: any) => m.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

const lastUserText = (body: any): string => {
  const user = body.messages.filter((m: any) => m.role === "user").at(-1);
  return typeof user.content === "string" ? user.content : JSON.stringify(user.content);
};

async function runTurn(id: string, text: string) {
  const steps = [];
  for await (const p of mc.turn(id, env.project, text, { model: "fake" })) steps.push(p);
  return steps;
}

const get = async (route: string) => {
  const r = await fetch(`${mc.service.agent}${route}?directory=${encodeURIComponent(env.project)}`);
  expect(r.ok).toBe(true);
  return r.json();
};
const commandNames = async () => ((await get("/command")) as { name: string }[]).map((c) => c.name);
const settingsSkills = async () =>
  ((await get("/mango/settings")).items as { type: string; name: string }[]).filter((i) => i.type === "skills").map((i) => i.name);

const loaded = (steps: any[]) => steps.find((p) => p.type === "tool" && p.name === "skill" && p.status === "completed");

let open: string;
let systemBefore: string;

test("a skill that is not there yet is neither listed nor loaded", async () => {
  open = await mc.createSession(env.project);
  const steps = await runTurn(open, "How do you descale the kettle?");
  expect(loaded(steps)).toBeUndefined();
  systemBefore = systemText(chatRequests().at(-1)!.body);
  expect(systemBefore).not.toContain("kettle");
  expect(await commandNames()).not.toContain("kettle");
  expect(await settingsSkills()).not.toContain("kettle");
}, 120_000);

test("a skill added while the app is open is in the «/» menu and on the settings page at once", async () => {
  const dir = path.join(env.project, ".claude", "skills", "kettle");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: kettle\ndescription: How to descale a kettle.\n---\n\nUse white vinegar.\n");

  expect(await commandNames()).toContain("kettle");
  expect(await settingsSkills()).toContain("kettle");
}, 60_000);

test("the conversation already open is told about the skill added meanwhile, once, and its system prompt does not change", async () => {
  await runTurn(open, "And now?");
  const body = chatRequests().at(-1)!.body;
  expect(systemText(body)).toBe(systemBefore);
  expect(lastUserText(body)).toContain("How to descale a kettle.");

  await runTurn(open, "Thanks.");
  const next = chatRequests().at(-1)!.body;
  expect(systemText(next)).toBe(systemBefore);
  expect(lastUserText(next)).not.toContain("kettle");
}, 120_000);

test("a new conversation lists the skill added while the app was open and loads it", async () => {
  const steps = await runTurn(await mc.createSession(env.project), "How do you descale the kettle?");
  expect(loaded(steps)?.output).toContain("white vinegar");
  expect(systemText(chatRequests().at(-1)!.body)).toContain("How to descale a kettle.");
}, 120_000);
