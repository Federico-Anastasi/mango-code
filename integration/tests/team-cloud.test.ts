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
import fs from "node:fs";
import path from "node:path";
import { CLOUD_MODEL, completions, KEY, startWorld, stopWorld, toolNames, until, type World } from "./team-world";

const HELLO = "write hello.txt please";
const DEV_ANSWER = "hello.txt written by the dev";
const FINAL = "Verified: the dev wrote hello.txt.";

let world: World;
let session: string;

const q = () => `directory=${encodeURIComponent(world.env.project)}`;
const api = (route: string, init?: RequestInit) => world.api(route, init);
const messages = async (id: string): Promise<any[]> => (await api(`/session/${id}/message?${q()}`)).json();
const text = (message: any) => message.parts.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
const bridge = (code: string) => world.bridge(code);

async function newSession(): Promise<string> {
  const r = await api(`/session?${q()}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return (await r.json()).id;
}

async function send(id: string, body: object) {
  const r = await api(`/session/${id}/prompt_async?${q()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(204);
}

// The local model: first the dev's boot message (it answers "ready"), then the instruction (it calls ask_manager), then what
// follows the tool's answer. Requests without tools (titles) get a title. The numbered step 0 is the boot answer.
beforeAll(async () => {
  world = await startWorld(
    [
      { summary: "A title" },
      { if: "Message sent to the manager", text: "Sent to the manager." },
      { if: HELLO, tool: "ask_manager", arguments: { message: DEV_ANSWER } },
      { text: "ready" },
    ],
    [
      { summary: "A title" },
      { if: DEV_ANSWER, text: FINAL },
      { tool: "ask_dev", arguments: { instruction: HELLO } },
      { text: "I asked the dev." },
    ],
    { agents: 0 },
  );
  session = await newSession();
}, 300_000);

afterAll(() => stopWorld(world));

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
    expect(completions(world.cloudLog)).toHaveLength(0);
    // The manager's tools are not offered to the normal agent.
    const asked = completions(world.env.engineLog).filter((r) => (r.body.tools ?? []).length > 0);
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
    const first = completions(world.cloudLog)[0];
    expect(first.body.model).toBe(CLOUD_MODEL);
    expect(first.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(first.body.messages)).toContain("Role: MANAGER");
    expect(toolNames(first)).toContain("ask_dev");
    expect(toolNames(first)).not.toContain("launch_agent"); // zero agents
    expect(fs.existsSync(path.join(world.env.data, "team", "dev.pid"))).toBe(true);
  }, 120_000);

  test("the dev works on the local engine and its answer comes back to the manager as [DEV]", async () => {
    const final = await until("the manager's last word", async () =>
      (await messages(managerSession)).filter((m) => m.info.role === "assistant").map(text).find((t) => t.includes(FINAL)),
    );
    expect(final).toContain(FINAL);

    const requests = completions(world.cloudLog);
    const arrived = (r: any) => r.body.messages.find((m: any) => m.role === "user" && JSON.stringify(m.content).includes(DEV_ANSWER));
    const back = requests.find(arrived);
    expect(back).toBeTruthy();
    const content = arrived(back).content;
    expect(typeof content === "string" ? content : content.map((x: any) => x.text).join("")).toStartWith("[DEV]\n" + DEV_ANSWER);

    // The dev's conversation is on the local engine: its instruction is there, and no cloud key.
    const local = completions(world.env.engineLog).filter((r) => JSON.stringify(r.body.messages).includes(HELLO));
    expect(local.length).toBeGreaterThan(0);
    for (const r of completions(world.env.engineLog)) expect(String(r.headers.authorization ?? "")).not.toContain(KEY);
    // The conversation of the manager is not on the local engine.
    for (const r of completions(world.env.engineLog)) expect(JSON.stringify(r.body.messages)).not.toContain("Ask the dev to write hello.txt.");
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
            if (fs.readFileSync(f).includes(KEY)) found.push(path.relative(world.env.data, f));
          } catch {
            locked.push(path.relative(world.env.data, f)); // a file the running window keeps open
          }
        }
      }
    };
    walk(world.env.data);
    expect(found).toEqual([]);
    // Only the window's own browser data may be unreadable: it is where the page's cache lives, and the page never received the key.
    expect(locked.filter((f) => !f.includes("EBWebView"))).toEqual([]);
  }, 60_000);
});
