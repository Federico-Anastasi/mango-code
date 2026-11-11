// The Team with the real app and the real agent, against a FAKE cloud provider: a second fake engine, on its own port,
// that answers like OpenRouter (`/v1/chat/completions`, with tool calls, streaming, and a log that keeps the headers).
// The local model is the usual fake engine. No network, no GPU, no real key: the key is a made-up string that the app
// keeps in the Credential Manager under the test's own service (derived from the data folder) and removes at the end.
//
// What it proves:
//  - with the key saved the cloud model exists for the agent, and the key is in no answer of the agent and no file;
//  - a normal conversation with the local model sends NOTHING to the cloud, even with the key saved (this is what keeps
//    "nothing leaves this PC" true until someone chooses a cloud model);
//  - the manager (the cloud model, agent `team`) starts the hidden dev (the local model) with `ask_dev`, the dev answers
//    with `ask_manager`, and that answer comes back to the manager as a "[DEV]" message;
//  - the key goes to the cloud and to nobody else (the local engine never sees it).
//
// The Team's dev listens on port 4090 (fixed, `agent-cfg` team.rs): the test refuses to run if it is busy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { page, type Page } from "./cdp";
import { FAKE_ENGINE_EXE, start, type Environment } from "./environment";

const KEY = "sk-or-v1-fake-test-key-0123456789";
const CLOUD_MODEL = "fake/manager";
const DEV_PORT = 4090;
const HELLO = "write hello.txt please";
const DEV_ANSWER = "hello.txt written by the dev";
const FINAL = "Verified: the dev wrote hello.txt.";

let env: Environment;
let p: Page;
let cloud: ChildProcess;
let cloudLog: string;
let session: string;

const free = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

const busy = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), ok(true)));
    s.on("error", () => ok(false));
  });

async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(300);
  }
}

const lines = (file: string): any[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const completions = (file: string) => lines(file).filter((r) => r.route === "/v1/chat/completions");
const toolNames = (request: any): string[] => (request.body.tools ?? []).map((t: any) => t.function?.name);

const api = (route: string, init?: RequestInit) => fetch(`${env.agent}${route}`, init);
const q = () => `directory=${encodeURIComponent(env.project)}`;
const messages = async (id: string): Promise<any[]> => (await api(`/session/${id}/message?${q()}`)).json();
const text = (message: any) => message.parts.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
const bridge = (code: string) => p.evaluate(`window.__MANGO_DESKTOP__.team.${code}`);

async function newSession(): Promise<string> {
  const r = await api(`/session?${q()}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await r.json()).id;
}

async function send(id: string, body: object) {
  const r = await api(`/session/${id}/prompt_async?${q()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(204);
}

beforeAll(async () => {
  if (await busy(DEV_PORT)) throw new Error(`port ${DEV_PORT} (the Team's dev) is busy: close the program that uses it`);
  // The local model: first the dev's boot message (it answers "ready"), then the instruction (it calls ask_manager), then what
  // follows the tool's answer. Requests without tools (titles) get a title. The numbered step 0 is the boot answer.
  env = await start(
    [
      { summary: "A title" },
      { if: "Message sent to the manager", text: "Sent to the manager." },
      { if: HELLO, tool: "ask_manager", arguments: { message: DEV_ANSWER } },
      { text: "ready" },
    ],
    { window: true },
  );
  const port = await free();
  cloudLog = path.join(env.root, "cloud-requests.jsonl");
  const script = path.join(env.root, "cloud-script.json");
  fs.writeFileSync(
    script,
    JSON.stringify([
      { summary: "A title" },
      { if: DEV_ANSWER, text: FINAL },
      { tool: "ask_dev", arguments: { instruction: HELLO } },
      { text: "I asked the dev." },
    ]),
  );
  cloud = spawn(FAKE_ENGINE_EXE, ["-m", "cloud.gguf", "--port", String(port)], {
    cwd: env.root,
    env: { ...process.env, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_LOG: cloudLog, FAKE_ENGINE_CHUNK_MS: "20" },
    stdio: "ignore",
  });
  await until("the fake cloud", async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);

  // The catalog gets the cloud model that points at the fake provider; the app reads it when the choices are saved and at every start.
  const catalog = path.join(env.root, "dist", "mango-models.json");
  const c = JSON.parse(fs.readFileSync(catalog, "utf8"));
  c.models.cloudfake = {
    label: "Cloud fake",
    quant: "cloud",
    kind: "cloud / fake",
    ctx: 65536,
    cloud: {
      provider_key: "openrouter",
      model_id: CLOUD_MODEL,
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key_field: "OPENROUTER_API_KEY",
      cost: { input: 1, output: 2, cache_read: 0.1 },
      image: false,
    },
  };
  fs.writeFileSync(catalog, JSON.stringify(c));

  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
  await bridge(`save(0, "cloudfake", "cloudfake")`);
  expect((await bridge("info()")).key).toBe(false);
  await bridge(`setKey(${JSON.stringify(KEY)})`); // the app restarts the agent with the Team on
  await until("the agent with the Team", async () => {
    const providers = await (await api(`/config/providers?${q()}`)).json();
    return providers.providers.some((x: any) => x.id === "openrouter");
  });
  session = await newSession();
}, 300_000);

afterAll(async () => {
  try {
    // The key leaves the Credential Manager through the app, then the app and its processes go.
    p?.close();
    const again = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 20_000);
    await again.evaluate("window.__MANGO_DESKTOP__.team.removeKey()");
    again.close();
  } catch (error) {
    console.warn(`the test key may still be in the Credential Manager (service of ${env?.data}): ${error}`);
  }
  try {
    const pid = Number(fs.readFileSync(path.join(env.data, "team", "dev.pid"), "utf8"));
    if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
  if (cloud?.pid) spawnSync("taskkill", ["/PID", String(cloud.pid), "/T", "/F"]);
  env?.close();
});

describe("the key is saved: the cloud model exists, the cloud stays quiet", () => {
  test("the agent offers the cloud model and its answers never carry the key", async () => {
    for (const route of ["/config/providers", "/provider"]) {
      const body = await (await api(`${route}?${q()}`)).text();
      expect(body).toContain(CLOUD_MODEL);
      expect(body).not.toContain(KEY);
    }
    const info = await bridge("info()");
    expect(info.key).toBe(true);
    expect(JSON.stringify(info)).not.toContain(KEY);
    expect(info.models.map((m: any) => m.key)).toContain("cloudfake");
  });

  test("a conversation with the local model sends nothing to the cloud", async () => {
    await send(session, { parts: [{ type: "text", text: "Say something, local model." }], model: { providerID: "mango", modelID: "fake" } });
    const answer = await until("the local answer", async () => (await messages(session)).find((m) => m.info.role === "assistant" && m.info.time?.completed));
    expect(answer.info.providerID).toBe("mango");
    await Bun.sleep(1500); // a title or a summary would be asked for by now
    expect(completions(cloudLog)).toHaveLength(0);
    // The manager's tools are not offered to the normal agent.
    const asked = completions(env.engineLog).filter((r) => (r.body.tools ?? []).length > 0);
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) expect(toolNames(r)).not.toContain("ask_dev");
  }, 120_000);
});

describe("the manager (cloud) and the dev (local)", () => {
  let managerSession: string;

  test("the manager starts the hidden dev with its instruction", async () => {
    managerSession = await newSession();
    await send(managerSession, { agent: "team", parts: [{ type: "text", text: "Ask the dev to write hello.txt." }] });
    const done = await until("the manager's tool call", async () => {
      const list = await messages(managerSession);
      return list.flatMap((m) => m.parts).find((x: any) => x.type === "tool" && x.tool === "ask_dev" && x.state?.status === "completed");
    });
    expect(done.state.output).toContain("Instruction sent to the dev");

    // The manager spoke to the cloud with its model, its instructions and its tools; the cloud saw the key.
    const first = completions(cloudLog)[0];
    expect(first.body.model).toBe(CLOUD_MODEL);
    expect(first.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(first.body.messages)).toContain("Role: MANAGER");
    expect(toolNames(first)).toContain("ask_dev");
    expect(toolNames(first)).not.toContain("launch_agent"); // zero agents
    expect(fs.existsSync(path.join(env.data, "team", "dev.pid"))).toBe(true);
  }, 120_000);

  test("the dev works on the local engine and its answer comes back to the manager as [DEV]", async () => {
    const final = await until("the manager's last word", async () =>
      (await messages(managerSession)).filter((m) => m.info.role === "assistant").map(text).find((t) => t.includes(FINAL)),
    );
    expect(final).toContain(FINAL);

    const requests = completions(cloudLog);
    const arrived = (r: any) => r.body.messages.find((m: any) => m.role === "user" && JSON.stringify(m.content).includes(DEV_ANSWER));
    const back = requests.find(arrived);
    expect(back).toBeTruthy();
    const content = arrived(back).content;
    expect(typeof content === "string" ? content : content.map((x: any) => x.text).join("")).toStartWith("[DEV]\n" + DEV_ANSWER);

    // The dev's conversation is on the local engine: its instruction is there, and no cloud key.
    const local = completions(env.engineLog).filter((r) => JSON.stringify(r.body.messages).includes(HELLO));
    expect(local.length).toBeGreaterThan(0);
    for (const r of completions(env.engineLog)) expect(String(r.headers.authorization ?? "")).not.toContain(KEY);
    // The conversation of the manager is not on the local engine.
    for (const r of completions(env.engineLog)) expect(JSON.stringify(r.body.messages)).not.toContain("Ask the dev to write hello.txt.");
  }, 120_000);

  test("the key is in no file of the app's data", () => {
    const found: string[] = [];
    const locked: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) {
          try {
            if (fs.readFileSync(f).includes(KEY)) found.push(path.relative(env.data, f));
          } catch {
            locked.push(path.relative(env.data, f)); // a file the running window keeps open
          }
        }
      }
    };
    walk(env.data);
    expect(found).toEqual([]);
    // Only the window's own browser data may be unreadable: it is where the page's cache lives, and the page never received the key.
    expect(locked.filter((f) => !f.includes("EBWebView"))).toEqual([]);
  });
});
