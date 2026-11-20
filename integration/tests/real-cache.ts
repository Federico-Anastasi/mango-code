// The system prompt kept on disk, with a real model on the processor and official llama.cpp's processor-only build: a
// conversation A, a new one B in another folder, a restart, and a new one C. For each, how many tokens the engine read
// ("prompt eval time" in its log) and how long the answer took: A reads the whole prompt once, B and C only what is theirs.
// It uses no graphics card (the model is set to the processor, the engine does not see a card) and runs at below-normal
// priority, but it holds the processor for several minutes: it is not part of `bun test`.
//
// Usage: bun integration/tests/real-cache.ts <model> <engine folder>
//   model: `3.5-4b` (a hybrid model, from the catalog) or `qwen3-4b` (a user's model: Qwen3-4B, not hybrid)
//   engine folder: the official llama.cpp processor-only build (the folder with llama-server.exe)
// The models are read from %LOCALAPPDATA%\MangoCode\models through hard links in the test's own folder: nothing is written there.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { APP_EXE, REPO, writeLanguage } from "./environment";

const [model = "3.5-4b", engineFolder] = process.argv.slice(2);
if (!engineFolder || !fs.existsSync(path.join(engineFolder, "llama-server.exe"))) throw new Error("usage: bun integration/tests/real-cache.ts <3.5-4b|qwen3-4b> <folder with llama-server.exe>");
const USER_MODELS = path.join(process.env.LOCALAPPDATA!, "MangoCode", "models");
const FILES: Record<string, { key: string; files: string[] }> = {
  "3.5-4b": { key: "3.5-4b", files: ["Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf", "Qwen3.5-4B-GGUF/mmproj-F16.gguf"] },
  "qwen3-4b": { key: "qwen3-4b", files: ["Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf"] },
};
const chosen = FILES[model];
if (!chosen) throw new Error(`unknown model ${model}`);

const port = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-cache-"));
const [data, dist, engines, models, agent] = ["data", "dist", "engines", "models", "agent"].map((d) => path.join(root, d));
writeLanguage(data);
const copy = (from: string, to: string, skip: string[] = []) => fs.cpSync(from, to, { recursive: true, filter: (s) => !skip.includes(path.basename(s)) });
copy(path.join(REPO, "launcher"), dist, ["node_modules", "runtime", "opencode", "mango-paths.json", "mango-secrets.json", "opencode.json"]);
for (const nm of ["node_modules", path.join("opencode-home", "node_modules")]) fs.symlinkSync(path.join(REPO, "launcher", nm), path.join(dist, nm), "junction");
fs.writeFileSync(path.join(dist, "mango-engines.json"), JSON.stringify({ llamacpp: { version: "b12110", build: {} } }));
copy(engineFolder, path.join(engines, "llamacpp", "b12110-cpu"));
for (const f of chosen.files) {
  fs.mkdirSync(path.dirname(path.join(models, f)), { recursive: true });
  fs.linkSync(path.join(USER_MODELS, f), path.join(models, f));
}
// The agent is the repo's build, linked: it is large.
fs.mkdirSync(path.join(agent, "web"), { recursive: true });
fs.linkSync(path.join(REPO, "launcher", "opencode", "web", "mango-code.exe"), path.join(agent, "web", "mango-code.exe"));
fs.writeFileSync(path.join(dist, "mango-paths.json"), JSON.stringify({ llama: engines, models, opencode: agent }));
// The model on the processor, with the smallest context the agent works with: the cache of a larger one is of no use here.
const choices: Record<string, unknown> = { models: { [chosen.key]: { where: "cpu", context: 32768 } }, default: chosen.key };
fs.writeFileSync(path.join(data, "choices.json"), JSON.stringify(choices));
if (model === "qwen3-4b") {
  const file = path.join(models, chosen.files[0]);
  const entry = { label: "Qwen3-4B", kind: "File on this computer", gguf: file, origin: "local", ctx: 32768, files: [{ path: file, size: fs.statSync(file).size }], memory: { kv_kib_token: 144, state_mib: 0 } };
  fs.writeFileSync(path.join(data, "user-models.json"), JSON.stringify({ models: { "qwen3-4b": entry } }));
}
const folders = ["first-project", "second-project"].map((name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
});

const env = { ...process.env, CUDA_VISIBLE_DEVICES: "-1", MANGO_DIST: dist, MANGO_DATA: data, MANGO_AGENT_PORT: String(await port()), MANGO_ENGINE_PORT: String(await port()) };
let app = spawn(APP_EXE, ["--service"], { env, stdio: "ignore" });
const launch = () => {
  app = spawn(APP_EXE, ["--service"], { env, stdio: "ignore" });
  // The engine and the agent are born after this: they inherit the priority.
  os.setPriority(app.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
};
os.setPriority(app.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
const logs = path.join(data, "logs");
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

const report: string[] = [];
async function conversation(label: string, folder: string, mc: MangoCode) {
  const engineLines = lines(path.join(logs, "engine.log")).length;
  const t0 = Date.now();
  const id = await mc.createSession(folder);
  let answer = "";
  for await (const p of mc.turn(id, folder, "Answer with one word: what colour is the sky on a clear day?", { model: chosen.key })) if (p.type === "text") answer += p.delta;
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  const read = lines(path.join(logs, "engine.log")).slice(engineLines).filter((l) => /prompt eval time/.test(l));
  report.push(`${label}: ${seconds} s, answer ${JSON.stringify(answer.trim().slice(0, 40))}`, ...read.map((l) => `   ${l.trim().slice(0, 150)}`));
}

async function ready() {
  let s = await find(data);
  for (let t0 = Date.now(); !s; s = await find(data)) {
    if (Date.now() - t0 > 300_000) throw new Error("app not ready");
    await Bun.sleep(1000);
  }
  const mc = new MangoCode(s);
  for (let t0 = Date.now(); ; await Bun.sleep(1000)) {
    const state = await fetch(`${s.engine}/engine`).then((r) => r.json(), () => undefined);
    if (state?.phase === "running") return mc;
    if (state?.failed || Date.now() - t0 > 600_000) throw new Error(`the model did not load: ${JSON.stringify(state)}`);
  }
}

try {
  let mc = await ready();
  await conversation("A (first conversation)", folders[0], mc);
  await conversation("B (new conversation, another folder)", folders[1], mc);
  spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  await Bun.sleep(5000);
  launch();
  mc = await ready();
  await conversation("C (after a restart, new conversation)", folders[0], mc);
} finally {
  spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  await Bun.sleep(4000);
  console.log(report.join("\n"));
  console.log("prefix events:");
  for (const l of lines(path.join(logs, "manager.log")).filter((l) => /"event":"(prefix|save|restore)"/.test(l))) console.log(`   ${l.slice(0, 230)}`);
  console.log("slot files:", fs.existsSync(path.join(data, "slots")) ? fs.readdirSync(path.join(data, "slots")).map((f) => `${f} ${(fs.statSync(path.join(data, "slots", f)).size / 1e6).toFixed(0)} MB`) : []);
  // The folder holds hard links to the user's models and links to the repo: they are removed one by one, never recursively through them.
  for (const f of chosen.files) fs.rmSync(path.join(models, f), { force: true });
  for (const j of ["node_modules", path.join("opencode-home", "node_modules")]) spawnSync("cmd", ["/c", "rmdir", path.join(dist, j)]);
  fs.rmSync(path.join(agent, "web", "mango-code.exe"), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
