// The requests the agent really sends to the engine, saved as the fixtures that `engine-cfg` renders with the original
// chat templates of real models (app/crates/engine-cfg/tests/templates_render.rs). Each scenario runs in its own
// environment (agent with its plugins and proxy, fake engine) and keeps the body of one request exactly as it reached
// `/v1/chat/completions`, with what belongs to this PC and this run replaced.
//
// A fixture that exists is compared and the test fails with the difference; `UPDATE_FIXTURES=1` writes them.
// Run it, after `cargo build -p mango-code -p engine`, with `off-screen bun test --cwd integration capture-requests`.

import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { FAKE_ENGINE_EXE, REPO, start } from "./environment";
import { chatRequests, type ChatBody } from "./requests";

const FIXTURES = path.join(REPO, "app", "crates", "engine-cfg", "tests", "requests");
const UPDATE = process.env.UPDATE_FIXTURES === "1";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const GREETING = "Hello from the example project";

// What the app tells the model about this PC's programs depends on what is installed: the fixtures carry the text of a
// PC that has these three and nothing else.
const PC_TOOLS = [
  "## Tools on this PC",
  "",
  "On this PC you can write and run: PowerShell; JavaScript and TypeScript with `bun` (always available, already included: `bun file.ts`); Python 3.12; Node 24; Git 2.39.",
  "Not installed: .NET, Java, Rust, Go.",
  "Microsoft Office is not installed.",
  "",
  "If a job needs something that is not in this list, don't assume it is there. Explain to the user in simple words what is needed, roughly how big it is and why, and ask whether they want to install it. Install only after their yes. For small scripts prefer what is already there (PowerShell or bun).",
  "To install: .NET: `winget install -e --id Microsoft.DotNet.SDK.10` (about 700 MB); Java: `winget install -e --id EclipseAdoptium.Temurin.21.JDK` (about 300 MB); Rust: `winget install -e --id Rustlang.Rustup` (about 1 GB plus 5 GB of Microsoft C++ tools); Go: `winget install -e --id GoLang.Go` (about 250 MB).",
  "After installing, in the same PowerShell, update the PATH: `$env:Path += ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.",
  "",
].join("\n");

type Script = Record<string, unknown>[];
type Drive = (turn: (text: string, attachments?: { mime: string; data: string; name: string }[]) => Promise<void>) => Promise<void>;

/** What the engine received that was meant for the model: a request with tools (the title has none). */
const forTheModel = (all: ChatBody[]) => all.filter((b) => (b.tools?.length ?? 0) > 0);

/** The places whose spelling gives away this PC or this run, longest first, each in the spellings a path can have. */
function localPlaces(places: [string, string][]) {
  const spellings = ([place, name]: [string, string]) => {
    const real = fs.realpathSync.native(place);
    return [place, real, place.replaceAll("\\", "/"), real.replaceAll("\\", "/")].map((p): [string, string] => [p, name]);
  };
  return places.flatMap(spellings).sort((a, b) => b[0].length - a[0].length);
}

function normalize(value: unknown, places: [string, string][]): unknown {
  if (typeof value === "string") {
    const folded = places.reduce((text, [from, to]) => text.replaceAll(from, to), value);
    return folded
      .replace(/## Tools on this PC[\s\S]*?After installing[^\n]*\n/, () => PC_TOOLS)
      .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{4}\b/g, "<DATE>")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, places));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, places)]));
  return value;
}

/** Runs one scenario in its own environment and returns the request `pick` chooses, normalized. `to`: the model the turns
 *  use and the log of the engine that receives them, when it is not this PC's fake model. */
async function capture(script: Script, options: Parameters<typeof start>[1], drive: Drive, pick: (requests: ChatBody[]) => ChatBody, to?: { model: string; log: string }) {
  const env = await start(script, options);
  try {
    const mc = new MangoCode((await find(env.data))!);
    const id = await mc.createSession(env.project);
    await drive(async (text, attachments) => {
      const steps: Step[] = [];
      for await (const step of mc.turn(id, env.project, text, { model: to?.model ?? "fake", attachments })) steps.push(step);
      expect(steps.at(-1)?.type).toBe("end");
    });
    const body = pick(forTheModel(chatRequests(to?.log ?? env.engineLog).map((r) => r.body)));
    const places = localPlaces([[env.project, "<WORKDIR>"], [env.method, "<WORKDIR>/method"], [env.root, "<TEMP>"], [os.tmpdir(), "<TEMP>"], [os.homedir(), "<HOME>"]]);
    const clean = normalize(body, places) as ChatBody;
    // Nothing of this PC may reach a file that is committed.
    for (const place of [os.homedir(), os.tmpdir()]) expect(JSON.stringify(clean).toLowerCase()).not.toContain(JSON.stringify(place).slice(1, -1).toLowerCase());
    return clean;
  } finally {
    env.close();
    Bun.sleepSync(1500);
  }
}

function check(name: string, body: ChatBody) {
  const file = path.join(FIXTURES, `${name}.json`);
  const text = JSON.stringify(body, null, 2) + "\n";
  if (UPDATE) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: UPDATE_FIXTURES=1 writes it`);
  expect(body).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
}

const echo = (text: string) => ({ tool: "echo_repeat", arguments: { text } });

test("first-turn: the first request of a conversation", async () => {
  const body = await capture([{ text: "The project keyword is TANGERINE. — end" }], {}, async (turn) => turn("How do we greet in this project?"), (all) => all[0]);
  check("first-turn", body);
}, 300_000);

test("tool-result: the request that follows a tool's result", async () => {
  const script = [echo(GREETING), { text: `The official greeting is "${GREETING}". — end` }];
  const body = await capture(script, {}, async (turn) => turn("Repeat the official greeting."), (all) => all[1]);
  check("tool-result", body);
}, 300_000);

test("long-with-reminders: a run long enough for the agent's reminders to appear", async () => {
  const script = [...Array.from({ length: 13 }, (_, i) => echo(`Step ${i + 1} of the long run.`)), { text: "The long run is over. — end" }];
  const body = await capture(script, {}, async (turn) => turn("Repeat the steps of the long run."), (all) => all[13]);
  expect(JSON.stringify(body.messages)).toContain("DISCIPLINE");
  check("long-with-reminders", body);
}, 300_000);

test("after-summary: the request that follows the summary of a conversation that filled the context", async () => {
  const script = [
    { tool: "skill", arguments: { name: "greeting" }, token: { prompt: 1000, completion: 20 } },
    { ...echo("hello"), token: { prompt: 12500, completion: 100 } },
    { text: "End of the turn.", token: { prompt: 1500, completion: 40 } },
    { if: "Create a new anchored summary", text: "FAKE SUMMARY of the conversation.", token: { prompt: 4000, completion: 50 } },
    { if: "FAKE SUMMARY", text: "Resumed after the summary.", token: { prompt: 900, completion: 30 } },
  ];
  const body = await capture(script, { context: 16384 }, async (turn) => turn("How do we greet?"), (all) => all.filter((b) => JSON.stringify(b.messages).includes("FAKE SUMMARY")).at(-1)!);
  check("after-summary", body);
}, 300_000);

test("summary-request: the request that asks for the summary, the conversation as it is with the instruction at its end", async () => {
  const script = [
    { tool: "skill", arguments: { name: "greeting" }, token: { prompt: 1000, completion: 20 } },
    { ...echo("hello"), token: { prompt: 12500, completion: 100 } },
    { text: "End of the turn.", token: { prompt: 1500, completion: 40 } },
    { if: "Create a new anchored summary", text: "FAKE SUMMARY of the conversation.", token: { prompt: 4000, completion: 50 } },
    { if: "FAKE SUMMARY", text: "Resumed after the summary.", token: { prompt: 900, completion: 30 } },
  ];
  const body = await capture(script, { context: 16384 }, async (turn) => turn("How do we greet?"), (all) => all.find((b) => JSON.stringify(b.messages.at(-1)).includes("Create a new anchored summary"))!);
  check("summary-request", body);
}, 300_000);

test("images: a picture attached to a message for a model that sees", async () => {
  const body = await capture([{ text: "A single dark pixel. — end" }], { vision: true }, async (turn) => turn("What do you see?", [{ mime: "image/png", data: PNG, name: "dot.png" }]), (all) => all[0]);
  expect(JSON.stringify(body.messages)).toContain("image_url");
  check("images", body);
}, 300_000);

test("reasoning: the thinking of earlier turns", async () => {
  const script = [
    { reasoning: "The greeting is in the project, so the tool will give it.", ...echo(GREETING) },
    { reasoning: "The tool returned the greeting, so I can answer.", text: `The official greeting is "${GREETING}". — end` },
    { if: "And then?", reasoning: "The user asks what comes next.", text: "Nothing comes next. — end" },
  ];
  const body = await capture(
    script,
    {},
    async (turn) => {
      await turn("Repeat the official greeting.");
      await turn("And then?");
    },
    (all) => all.at(-1)!,
  );
  check("reasoning", body);
}, 300_000);

test("server: the first request of a conversation on an external server's model, as the server receives it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-server-"));
  const port = await new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });
  const log = path.join(dir, "requests.jsonl");
  const script = [{ text: "The project keyword is TANGERINE. — end" }];
  fs.writeFileSync(path.join(dir, "script.json"), JSON.stringify(script));
  const server = spawn(FAKE_ENGINE_EXE, ["-m", path.join(dir, "server-model.gguf"), "--port", String(port)], {
    cwd: dir,
    env: { ...process.env, FAKE_ENGINE_LOG: log, FAKE_ENGINE_SCRIPT: path.join(dir, "script.json"), FAKE_ENGINE_CHUNK_MS: "5" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const servers = [{ url: `http://127.0.0.1:${port}/v1`, model: "server-model", ctx: 16384 }];
    const body = await capture(script, { servers }, async (turn) => turn("How do we greet in this project?"), (all) => all[0], { model: "server-1/server-model", log });
    // the server's own sampling holds: nothing of the catalog's is added on the way
    for (const field of ["temperature", "top_p", "top_k", "min_p", "chat_template_kwargs"]) expect(body).not.toHaveProperty(field);
    check("server", body);
  } finally {
    if (server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
    Bun.sleepSync(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
