// A Mango Code instance of its own for the tests: a distribution with a single model (the fake engine of
// app/crates/engine, which answers from a script), data, ports and project in a temporary folder.
// The app runs with --service (no window), next to the real app without touching it.
// The agent is the one built from the repo, where `app\scripts\build-agent.ps1` puts it: the `opencode` folder of
// `launcher\mango-paths.json` if there is one, otherwise `launcher\opencode`. `MANGO_OPENCODE` (a folder with
// `web\mango-code.exe`) replaces it, to try a separate build.
// The data folder starts with `settings.json` set to Italian, so the Italian texts the tests check hold on any PC.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const REPO = path.resolve(import.meta.dir, "..", "..");
const LAUNCHER = path.join(REPO, "launcher");
// Where cargo puts the builds: its own CARGO_TARGET_DIR, if set.
const DEBUG = path.join(path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(REPO, "app", "target")), "debug");
export const APP_EXE = path.join(DEBUG, "mango-code.exe");
export const FAKE_ENGINE_EXE = path.join(DEBUG, "fake-engine.exe");
export const LAUNCH_EXE = path.join(DEBUG, "mango-launch.exe");

// What must not end up in the distribution: machine files, generated files, packages (linked separately).
const EXCLUDED = new Set(["node_modules", "runtime", "opencode", "mango-paths.json", "mango-secrets.json", "opencode.json"]);

export interface Environment {
  root: string;
  data: string;
  project: string;
  /** A method folder (CLAUDE.md, rule, skill) outside the project: for the extra folders of the integration. */
  method: string;
  engineLog: string;
  agent: string;
  engine: string;
  app: ChildProcess;
  /** What the app runs with (distribution, data, ports, fake engine): a program that starts it from here must give it the same. */
  appEnv: Record<string, string>;
  /** With the window: the remote debugging port of WebView2 (CDP). */
  cdp?: number;
  /** The models folder and the engines folder of this environment. */
  modelsDir: string;
  enginesDir: string;
  /** Another start of the app with the same data and these arguments: if the app is already open it hands the work over and exits. */
  launch: (args: string[]) => ChildProcess;
  /** Closes the app (only the process started here) and starts it again on the same folders: to test resumes. */
  restart: () => Promise<void>;
  close: () => void;
}

/** Stops the app with all its processes (the engine, the agent, WebView2) and waits until it is gone. */
function stopTree(app: ChildProcess) {
  spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  for (let waited = 0; waited < 10_000; waited += 100) {
    try {
      process.kill(app.pid!, 0);
    } catch {
      return;
    }
    Bun.sleepSync(100);
  }
}

/** Waits until nothing listens on the port any more: the processes of a closed app (WebView2's above all) can hold it for a few seconds, longer on a busy computer. */
async function portReleased(port: number, ms = 30_000) {
  for (let waited = 0; waited < ms; waited += 200) {
    const open = await new Promise<boolean>((ok) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), ok(true)));
      s.once("error", () => ok(false));
    });
    if (!open) return;
    await Bun.sleep(200);
  }
  throw new Error(`port ${port} is still held 30 s after the app was closed`);
}

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

/** The folder where `build-agent.ps1` puts the agent (same rule, see the top of the file). */
function builtAgent() {
  const paths = path.join(LAUNCHER, "mango-paths.json");
  const chosen = fs.existsSync(paths) ? JSON.parse(fs.readFileSync(paths, "utf8")).opencode : undefined;
  return chosen ?? path.join(LAUNCHER, "opencode");
}

function copy(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !EXCLUDED.has(path.basename(src)) });
}

/** A data folder with the language fixed to Italian: the tests check the Italian texts. */
export function writeLanguage(data: string, language = "it") {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ language }));
}

/**
 * `script`: the fake engine's steps (see fake-engine.rs), or a function that gives them knowing the folders of the
 * environment (the paths are born with the environment). `window`: the app with its window and WebView2 remote
 * debugging, to drive the web UI; without it, --service. `noDebug`: the window without that debugging. `env`: extra
 * variables for the app and what it starts. `context`: the context tokens of the fake model (default 16384).
 * `otherModels`: other catalog models after the fake one, in the given order, already on disk; `bytes` says how much
 * one of them declares to weigh (1000 bytes by default: it fits any computer); `onRequest` marks some of them `on_request`
 * (the catalog does not trust them as agents). `args`: the arguments of the first
 * start (a folder to open). `noModels`: the models folder stays empty, the engines are there: the app opens with no model. `files`: the real size and
 * hash of the file of some models, which the app can then download (from `MANGO_HF_URL`, repository `test/<model>`,
 * revision `main`).
 *
 * `start` returns when the app is in use: the agent answers (`service.json`) and, if a model is on disk, it is loaded,
 * so a test talks to it at once. `modelLoading`: it returns as soon as the agent answers, while the model still loads.
 */
type Options = { onRequest?: string[]; window?: boolean; args?: string[]; otherModels?: string[]; bytes?: Record<string, number>; chunkMs?: number; noDebug?: boolean; env?: Record<string, string>; context?: number; noModels?: boolean; modelLoading?: boolean; files?: Record<string, { size: number; sha256: string }> };

/**
 * Removes the environment's folder (hundreds of MB). Its files (WebView2's above all) stay locked for a few seconds after
 * the app exits: it retries for 30 s, then says what it could not remove instead of failing the test that is closing.
 */
function removeRoot(root: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (attempt === 60) return console.warn(`the test environment ${root} could not be removed: ${error}`);
      Bun.sleepSync(500);
    }
  }
}

export async function start(script: unknown[] | ((folders: { project: string; method: string }) => unknown[]), options: Options = {}): Promise<Environment> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-integration-"));
  try {
    return await startIn(root, script, options);
  } catch (error) {
    removeRoot(root);
    throw error;
  }
}

async function startIn(
  root: string,
  script: unknown[] | ((folders: { project: string; method: string }) => unknown[]),
  options: Options,
): Promise<Environment> {
  for (const f of [APP_EXE, FAKE_ENGINE_EXE]) if (!fs.existsSync(f)) throw new Error(`${f} is missing: cargo build -p mango-code -p engine`);
  const agent = process.env.MANGO_OPENCODE ?? builtAgent();
  if (!fs.existsSync(path.join(agent, "web", "mango-code.exe"))) throw new Error(`${path.join(agent, "web", "mango-code.exe")} is missing: app\\scripts\\build-agent.ps1`);
  const dist = path.join(root, "dist");
  copy(LAUNCHER, dist);
  for (const nm of ["node_modules", path.join("opencode-home", "node_modules")]) {
    fs.symlinkSync(path.join(LAUNCHER, nm), path.join(dist, nm), "junction");
  }
  const engines = path.join(root, "engines");
  const models = path.join(root, "models");
  fs.mkdirSync(engines, { recursive: true });
  fs.mkdirSync(models);
  // The fake general engine sits where the download puts it (`<engines>/llamacpp/<version>-<build>/`), for every
  // build: the test does not depend on the PC's GPUs.
  fs.writeFileSync(path.join(dist, "mango-engines.json"), JSON.stringify({ llamacpp: { version: "fake", build: {} } }));
  // Every build is there, so the real plan (which looks at this PC's GPUs) finds the engine whatever build it picks.
  for (const b of ["cpu", "vulkan", "cuda-12", "cuda-13"]) {
    fs.mkdirSync(path.join(engines, "llamacpp", `fake-${b}`), { recursive: true });
    fs.copyFileSync(FAKE_ENGINE_EXE, path.join(engines, "llamacpp", `fake-${b}`, "llama-server.exe"));
  }
  const others = options.otherModels ?? [];
  const empty = options.noModels === true;
  if (!empty) for (const id of ["fake", ...others]) fs.writeFileSync(path.join(models, `${id}.gguf`), "");
  const fakeModel = (gguf: string, label: string, size = 1000, onRequest = false) => {
    const id = gguf.replace(/\.gguf$/, "");
    const file = options.files?.[id];
    return {
      label,
      gguf,
      ...(file ? { repo: `test/${id}`, revision: "main" } : {}),
      files: [{ path: gguf, size: file?.size ?? size, sha256: file?.sha256 ?? "0".repeat(64) }],
      memory: { kv_kib_token: 1, state_mib: 0 },
      // the fake models reason, as most of the catalog: the reasoning chosen for them reaches the requests
      reasoning: true,
      ...(onRequest ? { on_request: true } : {}),
    };
  };
  fs.writeFileSync(
    path.join(dist, "mango-models.json"),
    JSON.stringify({
      ctx: options.context ?? 16384,
      default: "fake",
      order: ["fake", ...others],
      models: {
        fake: fakeModel("fake.gguf", "Fake model"),
        ...Object.fromEntries(others.map((id) => [id, fakeModel(`${id}.gguf`, `Model ${id}`, options.bytes?.[id], options.onRequest?.includes(id))])),
      },
    }),
  );
  fs.writeFileSync(path.join(dist, "mango-paths.json"), JSON.stringify({ llama: engines, models, opencode: agent }));

  const data = path.join(root, "data");
  writeLanguage(data);
  const project = path.join(root, "project");
  fs.cpSync(path.join(REPO, "integration", "example"), project, { recursive: true });
  const method = path.join(root, "method");
  fs.cpSync(path.join(REPO, "integration", "example-method"), method, { recursive: true });
  const scriptFile = path.join(root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(typeof script === "function" ? script({ project, method }) : script));
  const engineLog = path.join(root, "engine-requests.jsonl");
  const [agentPort, enginePort] = [await freePort(), await freePort()];
  // Remote debugging goes through an environment variable that applies to ALL the process's WebView2s, Preview
  // panel included (it replaces its port): the panel tests keep it off.
  const cdp = options.window && !options.noDebug ? await freePort() : undefined;

  const appEnv = {
    ...process.env,
    MANGO_DIST: dist,
    MANGO_DATA: data,
    MANGO_AGENT_PORT: String(agentPort),
    MANGO_ENGINE_PORT: String(enginePort),
    FAKE_ENGINE_SCRIPT: scriptFile,
    FAKE_ENGINE_LOG: engineLog,
    FAKE_ENGINE_CHUNK_MS: String(options.chunkMs ?? 20),
    // The fake models have a plan on this PC's real cards: what another program holds there must not keep them from starting.
    MANGO_ROOM_CHECK_OFF: "1",
    ...(cdp ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp}` } : {}),
    ...options.env,
  } as Record<string, string>;
  const launch = (args: string[] = []) => spawn(APP_EXE, [...(options.window ? [] : ["--service"]), ...args], { env: appEnv, stdio: "ignore" });
  const env: Environment = {
    root, data, project, method, engineLog, agent: "", engine: "", app: launch(options.args), appEnv, cdp, modelsDir: models, enginesDir: engines,
    launch,
    restart: async () => {
      // With the tree of its processes (WebView2's too): the new start takes the same debugging port again.
      stopTree(env.app);
      // A new app that finds the debugging port still taken shows no page at all.
      if (cdp) await portReleased(cdp);
      env.app = launch();
    },
    close: () => {
      stopTree(env.app);
      removeRoot(root);
    },
  };
  const serviceFile = path.join(data, "service.json");
  const t0 = Date.now();
  while (!fs.existsSync(serviceFile)) {
    if (env.app.exitCode !== null) throw new Error(`the app closed (code ${env.app.exitCode}); log in ${path.join(data, "logs")}`);
    if (Date.now() - t0 > 180_000) {
      env.close();
      throw new Error(`no service.json after 180 s; log in ${path.join(data, "logs")}`);
    }
    await Bun.sleep(300);
  }
  const service = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
  env.agent = service.agent;
  env.engine = service.engine;
  if (empty || options.modelLoading) return env;
  // The model loads after the agent answers, in the background.
  for (;;) {
    const state = await (await fetch(`${env.engine}/engine`)).json();
    if (state.phase === "running") return env;
    if (state.failed || Date.now() - t0 > 180_000) {
      env.close();
      throw new Error(`the model did not load: ${JSON.stringify(state)}; log in ${path.join(data, "logs")}`);
    }
    await Bun.sleep(200);
  }
}
