// The terminal (launcher/mango-engine.ps1) chooses the engine like the app: the plan is computed by mango-launch.exe, the
// same logic as the app, and the terminal starts the process the plan describes. Here a PC with no profile (no
// profile, neither the bundled nor the user's, for the test models): the start command is the plan's, engine and
// models are where the app looks for them, the conversation is saved and reloaded, the user's models are listed,
// and with the app open the engine is the one of its manager.
// The engine is the fake engine of app/crates/engine: no GPU is used. Data (`MANGO_DATA`) and ports belong to this
// test, never to the real ones. `bun test --cwd integration tests/terminal.test.ts`, after `cargo build -p engine` in app/.
// The data folder holds `settings.json` with the language set to Italian: the terminal's texts checked here are Italian.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FAKE_ENGINE_EXE, REPO, writeLanguage } from "./environment";

const LAUNCHER = path.join(REPO, "launcher");
const LAUNCH_EXE = path.join(REPO, "app", "target", "debug", "mango-launch.exe");
for (const f of [LAUNCH_EXE, FAKE_ENGINE_EXE]) if (!fs.existsSync(f)) throw new Error(`${f} is missing: cargo build -p engine (in app/)`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-terminal-"));
const dist = path.join(root, "launcher");
const data = path.join(root, "data");
const log = path.join(root, "engine-requests.jsonl");

function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
    s.on("error", ko);
  });
}
const port = await freePort();

const entry = (gguf: string, label: string) => ({ label, gguf, files: [{ path: gguf, size: 1000, sha256: "0".repeat(64) }], memory: { kv_kib_token: 1, state_mib: 0 } });

beforeAll(() => {
  fs.mkdirSync(dist, { recursive: true });
  writeLanguage(data);
  for (const f of ["mango-engine.ps1", "mango-catalog.ps1"]) fs.copyFileSync(path.join(LAUNCHER, f), path.join(dist, f));
  fs.writeFileSync(
    path.join(dist, "mango-models.json"),
    JSON.stringify({
      ctx: 16384,
      default: "fake",
      order: ["fake", "second", "no-weights"],
      models: { fake: entry("fake.gguf", "Fake model"), second: entry("second.gguf", "Second"), "no-weights": entry("no-weights.gguf", "No weights") },
    }),
  );
  fs.writeFileSync(path.join(dist, "mango-engines.json"), JSON.stringify({ llamacpp: { version: "fake", build: {} } }));
  // The general engine is where the app's download puts it, for every build: the test does not depend on the GPUs.
  for (const b of ["cpu", "vulkan", "cuda-12", "cuda-13"]) {
    fs.mkdirSync(path.join(data, "engine", "llamacpp", `fake-${b}`), { recursive: true });
    fs.copyFileSync(FAKE_ENGINE_EXE, path.join(data, "engine", "llamacpp", `fake-${b}`, "llama-server.exe"));
  }
  fs.mkdirSync(path.join(data, "models"), { recursive: true });
  for (const g of ["fake.gguf", "second.gguf", "mine.gguf"]) fs.writeFileSync(path.join(data, "models", g), "");
  fs.writeFileSync(path.join(data, "user-models.json"), JSON.stringify({ models: { mine: entry("mine.gguf", "My model") } }));
});

afterAll(() => {
  const f = path.join(dist, "runtime", "engine.json");
  if (fs.existsSync(f)) {
    try {
      process.kill(JSON.parse(fs.readFileSync(f, "utf8")).pid);
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const environment = (extra: Record<string, string> = {}) => ({
  ...process.env,
  MANGO_DATA: data,
  MANGO_LAUNCH: LAUNCH_EXE,
  MANGO_ENGINE_PORT: String(port),
  FAKE_ENGINE_LOG: log,
  ...extra,
});

/** Runs a shell with the output on a file and not on a pipe: the engine it starts would inherit the pipe, and
 *  whoever reads it would not finish while the engine stays on. */
function shellToFile(shell: string, command: string) {
  const f = path.join(root, "output.txt");
  const fd = fs.openSync(f, "w");
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], { env: environment(), stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  return { code: r.status, output: fs.readFileSync(f, "utf8") };
}

/** Runs mango-engine.ps1 with the given shell and returns the model's card (the object on the pipeline) and the output. */
function engine(shell: string, args: string[]) {
  const card = path.join(root, "card.json");
  fs.rmSync(card, { force: true });
  const command = `$o = & '${path.join(dist, "mango-engine.ps1")}' ${args.join(" ")} -Quiet; if ($o) { $o | ConvertTo-Json -Compress | Set-Content '${card}' }`;
  return { ...shellToFile(shell, command), card: fs.existsSync(card) ? JSON.parse(fs.readFileSync(card, "utf8")) : null };
}

function plan(args: string[]) {
  const r = spawnSync(LAUNCH_EXE, args, { env: { ...environment(), MANGO_DIST: dist }, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

function quoted(a: string) {
  return /[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a;
}

function commandLine(pid: number): string {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" });
  return r.stdout.trim();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((r) => JSON.parse(r)) : []);

for (const shell of ["powershell", "pwsh"]) {
  test(`${shell}: the terminal starts the engine with the app's plan, and changes model saving the conversation`, () => {
    // 1. start: the start command is the plan's, the context too
    const p = plan(["plan", "--model", "fake", "--port", String(port)]);
    const a = engine(shell, ["-Model", "fake"]);
    expect(a.code, a.output).toBe(0);
    expect(a.card).toMatchObject({ Key: "fake", Label: "Fake model", Ctx: p.context, Url: `http://127.0.0.1:${port}` });
    const state = JSON.parse(fs.readFileSync(path.join(dist, "runtime", "engine.json"), "utf8"));
    expect(state.model).toBe("fake");
    const line = commandLine(state.pid);
    expect(line).toContain(p.args.map(quoted).join(" "));
    expect(line).toContain(p.executable);
    expect(p.executable.startsWith(path.join(data, "engine", "llamacpp"))).toBe(true);
    // memory and slots are where the app keeps them
    expect(p.args).toContain(path.join(data, "slots"));
    expect(fs.existsSync(path.join(data, "slots"))).toBe(true);

    // 2. the same model: the engine already on is reused
    const b = engine(shell, ["-Model", "fake"]);
    expect(b.card.Engine).toBe("warm engine");
    expect(b.card.Pid).toBe(state.pid);

    // 3. another model: the first saves the conversation and stops, the second starts
    const c = engine(shell, ["-Model", "second"]);
    expect(c.code, c.output).toBe(0);
    expect(c.card.Key, c.output).toBe("second");
    expect(c.card.Pid, c.output).not.toBe(state.pid);
    expect(alive(state.pid)).toBe(false);
    expect(fs.existsSync(path.join(data, "slots", "fake.bin"))).toBe(true);
    expect(requests().some((r) => r.route.includes("action=save"))).toBe(true);

    // 4. the first comes back: the saved conversation is reloaded
    const d = engine(shell, ["-Model", "fake"]);
    expect(d.code, d.output).toBe(0);
    expect(requests().some((r) => r.route.includes("action=restore"))).toBe(true);
    // cleanup: the engine stops (by PID, it is ours) and the next shell starts from zero
    process.kill(d.card.Pid);
    for (let i = 0; i < 50 && alive(d.card.Pid); i++) Bun.sleepSync(100);
    for (const f of ["engine.json", "active-model.txt", "engine-bind.txt"]) fs.rmSync(path.join(dist, "runtime", f), { force: true });
    fs.rmSync(path.join(data, "slots"), { recursive: true, force: true });
    fs.rmSync(log, { force: true });
  }, 120_000);
}

test("-Models lists the models with the plan's context, the user's ones and why one is not ready", () => {
  const r = shellToFile("powershell", `& '${path.join(dist, "mango-engine.ps1")}' -Models`);
  expect(r.code, r.output).toBe(0);
  const ctx = plan(["models"]).models.find((m: { model: string }) => m.model === "fake").context / 1024;
  expect(r.output).toMatch(new RegExp(`fake\\s+Fake model\\s.*${ctx}k ctx`));
  expect(r.output).toMatch(/mine\s+My model.*\[tuo\]/);
  expect(r.output).toMatch(/no-weights\s+No weights.*\[non pronto: manca .*no-weights\.gguf\]/);
}, 60_000);

test("a model that cannot be started leaves the engine as it was and says what to do", () => {
  const r = engine("powershell", ["-Model", "no-weights"]);
  expect(r.code).toBe(1);
  expect(r.output).toContain("non è sul disco");
  expect(r.output).toContain("mango-code -Model no-weights -Install");
}, 60_000);

test("with the app open the engine is the one of its manager: it asks it, without starting anything", async () => {
  const calls: string[] = [];
  let on = "fake";
  const state = () => ({ phase: "running", model: on, name: on === "fake" ? "Fake model" : "Second", context: 12288, gpus: [{ index: 0 }, { index: 1 }] });
  const manager = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url} ${body}`);
      if (req.method === "POST" && req.url === "/engine/model") on = JSON.parse(body).model;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/engine") res.end(JSON.stringify(state()));
      else if (req.url === "/engine/model") res.end(JSON.stringify(state()));
      else res.writeHead(404).end("{}");
    });
  });
  const managerPort = await freePort();
  await new Promise<void>((ok) => manager.listen(managerPort, "127.0.0.1", ok));
  try {
    const card = path.join(root, "manager-card.json");
    const command = (args: string) => `$o = & '${path.join(dist, "mango-engine.ps1")}' ${args} -Quiet; $o | ConvertTo-Json -Compress | Set-Content '${card}'`;
    // Asynchronous: the fake manager is in this process and must be able to answer while the terminal queries it.
    const run = (args: string) =>
      new Promise<{ status: number | null; output: string }>((ok) => {
        const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command(args)], { env: environment({ MANGO_ENGINE_PORT: String(managerPort) }) });
        let output = "";
        p.stdout.on("data", (c) => (output += c));
        p.stderr.on("data", (c) => (output += c));
        p.on("close", (status) => ok({ status, output }));
      });

    // without -Model: the model is the one the app turned on, and its context and its GPUs
    let r = await run("");
    expect(r.status, r.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(card, "utf8"))).toMatchObject({ Key: "fake", Ctx: 12288, Gpus: 2, Label: "Fake model", Manager: true });
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);

    // another model: it asks the manager
    r = await run("-Model second");
    expect(r.status, r.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(card, "utf8"))).toMatchObject({ Key: "second", Label: "Second" });
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(['POST /engine/model {"model":"second"}']);
    // no terminal process: the engine is not its own
    expect(fs.existsSync(path.join(dist, "runtime", "engine.json"))).toBe(false);
  } finally {
    manager.close();
  }
}, 60_000);

for (const shell of ["powershell", "pwsh"]) {
  test(`${shell}: whoever reads the terminal's output on a pipe reaches the end even if the engine stays on`, () => {
    // The engine outlives the terminal: if it inherited an output pipe, whoever reads it would wait for it to stop.
    const command = `& '${path.join(dist, "mango-engine.ps1")}' -Model fake -Quiet | Out-Null; 'end'`;
    const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], { env: environment(), encoding: "utf8", timeout: 40_000 });
    const pid = JSON.parse(fs.readFileSync(path.join(dist, "runtime", "engine.json"), "utf8")).pid;
    try {
      expect(r.error?.message).toBeUndefined();
      expect(r.stdout.trim()).toBe("end");
      expect(alive(pid)).toBe(true);
    } finally {
      process.kill(pid);
      for (let i = 0; i < 50 && alive(pid); i++) Bun.sleepSync(100);
      for (const f of ["engine.json", "active-model.txt", "engine-bind.txt"]) fs.rmSync(path.join(dist, "runtime", f), { force: true });
    }
  }, 60_000);
}
