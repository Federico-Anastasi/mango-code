// The system prompt of a new conversation, read once and kept on disk (app/crates/engine, prefix.rs), through the real agent
// and the fake engine: what each conversation makes the engine read, in the tokens of the fake engine (one per word).
// Run it with `off-screen bun test --cwd integration disk-cache`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, removeRoot, type Environment } from "./environment";

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start([{ text: "Hello." }]);
  const s = await find(env.data);
  if (!s) throw new Error("service.json is there but Mango Code does not answer");
  mc = new MangoCode(s);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    removeRoot(env.root);
  } catch {}
});

const lines = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
/** What the engine read, in order: `{ route, reread, prompt_tokens }`. */
const reads = () => lines(`${env.engineLog}.reads`);
const prefixEvents = () => lines(path.join(env.data, "logs", "manager.log")).filter((r) => r.event === "prefix");

/** A conversation of one question in `folder`; what the engine read for it: its own request (the biggest) and the primings. */
async function conversation(folder: string, question: string) {
  const before = reads().length;
  const id = await mc.createSession(folder);
  for await (const _ of mc.turn(id, folder, question, { model: "fake" }));
  const mine = reads().slice(before);
  const main = mine.filter((r) => r.route === "/v1/chat/completions").reduce((a, b) => (b.prompt_tokens > a.prompt_tokens ? b : a));
  return { main, primed: mine.filter((r) => r.route === "/completion").length };
}

test("a new conversation, in another folder and after a restart, reads only what is its own", async () => {
  // Folders without instructions of their own: the project's own files are part of its system prompt, and a prompt with other
  // files is another prompt.
  const folder = (name: string) => {
    const dir = path.join(env.root, name);
    fs.mkdirSync(dir);
    return dir;
  };
  const [first, other] = [folder("first-project"), folder("other-project")];

  const a = await conversation(first, "Say hello.");
  const prefix = prefixEvents().find((e) => e.action === "read");
  expect(prefix, "the agent says where its system prompt ends, and the engine reads it once").toBeDefined();
  expect(a.primed).toBe(1);
  expect(prefix.token).toBeGreaterThan(512);
  expect(a.main.reread, "after the priming the conversation reads the rest").toBeLessThanOrEqual(a.main.prompt_tokens - prefix.token + 100);
  expect(fs.readdirSync(path.join(env.data, "slots")).filter((f) => f.includes(".prefix-"))).toHaveLength(1);

  const b = await conversation(other, "Say hello again.");
  expect(b.primed, "another folder: the same system prompt").toBe(0);
  expect(b.main.reread).toBeLessThanOrEqual(b.main.prompt_tokens - prefix.token + 100);

  await env.restart();
  for (let t0 = Date.now(); ; await Bun.sleep(300)) {
    if (Date.now() - t0 > 120_000) throw new Error("the model did not come back");
    const state = await fetch(`${env.engine}/engine`).then((r) => r.json(), () => undefined);
    if (state?.phase === "running") break;
  }
  const c = await conversation(first, "Say hello once more.");
  expect(c.primed, "after the restart the prompt comes from its file").toBe(0);
  expect(prefixEvents().some((e) => e.action === "restored")).toBe(true);
  expect(c.main.reread).toBeLessThanOrEqual(c.main.prompt_tokens - prefix.token + 100);
}, 240_000);
