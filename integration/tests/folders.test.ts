// The integration's extra folders (docs/INTEGRATION.md, §5): an app's method lives outside the working folder,
// and that folder's CLAUDE.md, rules and skills reach the model like the project's. Scripted fake engine,
// no GPU.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const SCRIPT = [{ tool: "skill", arguments: { name: "whiteboard" } }, { text: "Done — end" }];

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
    .filter((r) => r.route.startsWith("/v1/chat/completions"));

const systemText = (body: any): string =>
  body.messages.filter((m: any) => m.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

async function runTurn(id: string) {
  const steps = [];
  for await (const p of mc.turn(id, env.project, "How do you wipe the whiteboard?", { model: "fake" })) steps.push(p);
  return steps;
}

test("without extra folders the method is not there", async () => {
  const id = await mc.createSession(env.project);
  await runTurn(id);
  const system = systemText(chatRequests().at(-2)!.body);
  expect(system).toContain("TANGERINE");
  expect(system).not.toContain("GINGER");
}, 120_000);

test("extra folders give instructions, rules and skills, and declaring them again does nothing", async () => {
  expect(await mc.setExtraFolders(env.project, [env.method])).toEqual({ folders: [env.method], changed: true });
  expect(await mc.setExtraFolders(env.project, [env.method])).toEqual({ folders: [env.method], changed: false });

  const id = await mc.createSession(env.project);
  const steps = await runTurn(id);
  const skill = steps.find((p) => p.type === "tool" && p.name === "skill" && p.status === "completed") as any;
  expect(skill.output).toContain("green rag");

  const system = systemText(chatRequests().at(-2)!.body);
  expect(system).toContain("TANGERINE"); // the working folder stays
  expect(system).toContain("GINGER"); // the method's CLAUDE.md
  expect(system).toContain("always cite the method keyword"); // the method's .claude/rules/tone.md
  expect(system).toContain("whiteboard"); // the method's skill is announced
  const from = [...system.matchAll(/^Instructions from: (.*)$/gm)].map((m) => m[1]);
  expect(from.every((p) => p.startsWith(env.root))).toBe(true);
  expect(from.some((p) => p.startsWith(env.method))).toBe(true);
}, 120_000);

test("an empty list removes the extra folders; a path that is not a folder is refused", async () => {
  await expect(mc.setExtraFolders(env.project, [env.method + "-that-does-not-exist"])).rejects.toThrow(/400/);
  expect((await mc.setExtraFolders(env.project, [])).changed).toBe(true);
  await runTurn(await mc.createSession(env.project));
  expect(systemText(chatRequests().at(-2)!.body)).not.toContain("GINGER");
}, 120_000);
