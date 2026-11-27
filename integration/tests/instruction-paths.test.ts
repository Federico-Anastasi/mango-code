// The request names no file of the app: what the app tells the model (its own instructions, the programs of this PC) is
// part of the prompt, and only the project's own instruction files are named, by their place from the working folder.
// A model that is shown where the app keeps its instructions reads them again and writes into them. Scripted fake
// engine, no GPU.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { REPO, start, type Environment } from "./environment";
import { chatRequests, systemMessages } from "./requests";

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start([{ text: "Done — end" }], { strict: true });
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

async function systemOfATurn() {
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Say hello.", { model: "fake" }));
  const requests = chatRequests(env.engineLog).filter((r) => (r.body.tools?.length ?? 0) > 0);
  return systemMessages(requests.at(-1)!.body)[0];
}

const lines = (system: string) => [...system.matchAll(/^Instructions from: (.*)$/gm)].map((m) => m[1]);

test("the request names no file of the app, and still carries the app's instructions and the programs of the PC", async () => {
  const system = await systemOfATurn();
  const from = lines(system);
  expect(from).toEqual(["CLAUDE.md", ".claude/rules/style.md"]);
  for (const place of [env.data, "opencode-home", "MANGO.md", "MANGO-pc.md"]) expect(system).not.toContain(place);

  const prompt = fs.readFileSync(path.join(REPO, "launcher", "harness", "mango-harness-1", "prompt.md"), "utf8");
  const own = prompt.slice(prompt.indexOf("# mango-code"), prompt.indexOf("## Reading files"));
  expect(own.length).toBeGreaterThan(500);
  expect(system).toContain(own);
  expect(system).toContain("## Tools on this PC");
}, 200_000);

test("the instruction files of an extra folder are named by their place from the project", async () => {
  await mc.setExtraFolders(env.project, [env.method]);
  const system = await systemOfATurn();
  const from = lines(system);
  expect(from).toContain("../method/CLAUDE.md");
  expect(from).toContain("../method/.claude/rules/tone.md");
  for (const name of from) expect(name).not.toMatch(/^[a-z]:|\\|opencode-home/i);
}, 200_000);

test("a settings file that still has entries for files that no longer exist breaks nothing: they are no items and the prompt is whole", async () => {
  const file = path.join(env.data, "settings.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...saved, prompt: { instructions: { "MANGO.md": false, "MANGO-pc.md": false } } }));
  try {
    const system = await systemOfATurn();
    expect(system).toContain("# mango-code");
    expect(system).toContain("## Tools on this PC");
    const response = await fetch(`${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}`);
    expect(response.ok).toBe(true);
    const items = (await response.json()).items.filter((item: { type: string }) => item.type === "instructions").map((item: { name: string }) => item.name);
    expect(items).toContain("CLAUDE.md");
    expect(items.filter((name: string) => /^MANGO/.test(name))).toEqual([]);
  } finally {
    fs.writeFileSync(file, JSON.stringify(saved));
  }
}, 200_000);

const locations = (system: string) => [...system.matchAll(/<location>(.*)<\/location>/g)].map((m) => m[1]);

test("the skills of the app are listed by name and description, with no place; the project's own keep theirs", async () => {
  const system = await systemOfATurn();
  for (const name of ["debugging", "excel", "frontend-design", "pdf", "powerpoint", "test-first", "verify-before-done", "word", "greeting"])
    expect(system).toContain(`<name>${name}</name>`);
  expect(system).not.toContain("mango-plugin");
  const places = locations(system);
  expect(places).toContain(path.join(env.project, ".claude", "skills", "greeting", "SKILL.md"));
  for (const place of places) expect(place.startsWith(env.project) || place.startsWith(env.method)).toBe(true);
}, 200_000);

test("opening a skill of the app gives its text and no folder", async () => {
  const own = await start([{ tool: "skill", arguments: { name: "word" } }, { text: "Done — end" }], { strict: true });
  try {
    const client = new MangoCode((await find(own.data))!);
    const id = await client.createSession(own.project);
    for await (const _ of client.turn(id, own.project, "Open the word skill.", { model: "fake" }));
    const last = chatRequests(own.engineLog).filter((r) => (r.body.tools?.length ?? 0) > 0).at(-1)!;
    const result = last.body.messages.map((m) => JSON.stringify(m.content)).find((text) => text.includes('<skill_content name=\\"word\\">'))!;
    expect(result).toContain("# Skill: word");
    for (const place of ["Base directory", "skill_files", own.root, "mango-plugin", "SKILL.md"]) expect(result).not.toContain(place.replaceAll("\\", "\\\\"));
  } finally {
    own.close();
    Bun.sleepSync(1500);
    try {
      fs.rmSync(own.root, { recursive: true, force: true });
    } catch {}
  }
}, 200_000);
