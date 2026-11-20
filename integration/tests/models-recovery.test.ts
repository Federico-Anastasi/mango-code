// A move of the models folder that stopped half way (the app was ended by force, the computer was switched off) is finished or
// put back by the next start of the app, from the journal the move wrote before it touched a file: the choice says which.
// Fake engine, no GPU. Run under off-screen: `off-screen bun test --cwd integration tests/models-recovery.test.ts`, after
// `cargo build -p mango-code -p engine` in app/.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { start, type Environment } from "./environment";

const environments: Environment[] = [];
afterAll(() => environments.forEach((env) => env.close()));

const alive = (pid: number) => spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true }).stdout.includes(String(pid));
const sorted = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

/** An app whose move to `recovered` stopped after `fake.gguf` was renamed there, with the choice written or not, started again. */
async function interrupted(choiceWritten: boolean) {
  const env = await start([{ text: "Here I am." }], { freeModelsFolder: true, otherModels: ["second"] });
  environments.push(env);
  const service = path.join(env.data, "service.json");
  spawnSync("taskkill", ["/PID", String(env.app.pid), "/T", "/F"], { windowsHide: true });
  for (let waited = 0; alive(env.app.pid!) && waited < 20_000; waited += 200) await Bun.sleep(200);
  fs.rmSync(service, { force: true });

  const target = path.join(env.root, "recovered");
  fs.mkdirSync(target);
  fs.renameSync(path.join(env.modelsDir, "fake.gguf"), path.join(target, "fake.gguf"));
  fs.writeFileSync(path.join(env.data, "models-move.json"), JSON.stringify({ from: env.modelsDir, to: target, method: "rename", files: ["fake.gguf", "second.gguf"], made: true }));
  if (choiceWritten) fs.writeFileSync(path.join(env.data, "models-dir.txt"), target);

  env.app = env.launch();
  for (let waited = 0; !fs.existsSync(service) && waited < 180_000; waited += 300) await Bun.sleep(300);
  expect(fs.existsSync(service), "the app started again").toBe(true);
  return { env, target };
}

test("a move whose choice was written is finished: the files that had not moved yet follow", async () => {
  const { env, target } = await interrupted(true);

  expect(sorted(target)).toEqual(["fake.gguf", "second.gguf"]);
  expect(sorted(env.modelsDir)).toEqual([]);
  expect(fs.existsSync(path.join(env.data, "models-move.json")), "the journal goes once the folders agree with the choice").toBe(false);
  expect(fs.readFileSync(path.join(env.data, "models-dir.txt"), "utf8").trim(), "the choice stays").toBe(target);
}, 300_000);

test("a move whose choice was not written is put back: what had moved returns and the folder made for it goes", async () => {
  const { env, target } = await interrupted(false);

  expect(sorted(env.modelsDir)).toEqual(["fake.gguf", "second.gguf"]);
  expect(fs.existsSync(target), "the folder the move made").toBe(false);
  expect(fs.existsSync(path.join(env.data, "models-move.json"))).toBe(false);
  expect(fs.existsSync(path.join(env.data, "models-dir.txt"))).toBe(false);
}, 300_000);
