// The Team plugin (`launcher/opencode-home/plugin/mango-team.js`) as the app uses it: the manager is the `team` agent
// of the server, dev and agents are hidden processes started by the plugin. The agent server is fake
// (`fake-opencode.ts`, compiled into an executable): no model, no network, no GPU.
// The texts the plugin returns to the model are checked as they are written in the plugin.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./environment";

const LAUNCHER = path.join(REPO, "launcher");
const PLUGIN = path.join(LAUNCHER, "opencode-home", "plugin", "mango-team.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mango-team-test-"));
const TEAM = path.join(ROOT, "team");
const PROJECT = path.join(ROOT, "project");
const FAKE = path.join(ROOT, "opencode-fake.exe");
const KEY = "sk-or-v1-test-key";

const VARIABLES = ["MANGO_TEAM_ROLE", "MANGO_TEAM_AGENT", "MANGO_TEAM_DIR", "MANGO_TEAM_LAUNCH", "MANGO_AGENT_MAX", "MANGO_AGENT_DIR", "MANGO_AGENT_ID", "MANGO_HOME", "MANGO_OPENROUTER_KEY"];
let loads = 0;
const copies: string[] = [];

/** Loads the plugin with an environment of its own: the plugin's constants are read at import, so a new copy every time. */
async function plugin(env: Record<string, string>, serverUrl = "http://127.0.0.1:1", directory = PROJECT) {
  for (const k of VARIABLES) delete process.env[k];
  Object.assign(process.env, { MANGO_HOME: LAUNCHER, MANGO_TEAM_DIR: TEAM, ...env });
  // Bun keeps a single module per file, even with another query: a copy next to the test, with a new name.
  const copy = path.join(import.meta.dir, `.mango-team-${process.pid}-${++loads}.mjs`);
  fs.copyFileSync(PLUGIN, copy);
  copies.push(copy);
  const module = await import(pathToFileURL(copy).href);
  return (await module.MangoTeam({ serverUrl, directory })) as Record<string, any>;
}

const link = (name: string) => JSON.parse(fs.readFileSync(path.join(TEAM, name), "utf8"));
const log = (name: string) =>
  fs.readFileSync(path.join(TEAM, `fake-${name}.jsonl`), "utf8").trim().split("\n").map((r) => JSON.parse(r));

async function freePort() {
  return await new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}

beforeAll(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  const r = spawnSync("bun", ["build", "--compile", path.join(import.meta.dir, "fake-opencode.ts"), "--outfile", FAKE], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`the fake opencode does not compile: ${r.stderr}`);
});

afterAll(() => {
  // Only the processes started by these tests, by pid.
  for (const f of ["dev.pid", ...[1, 2].map((i) => `mango-agents/agent-${i}.pid`)]) {
    try {
      const pid = Number(fs.readFileSync(path.join(TEAM, f), "utf8"));
      if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {}
  }
  for (const copy of copies) fs.rmSync(copy, { force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the manager is an agent of the app's server", () => {
  test("only the conversations of the team agent belong to the team", async () => {
    const p = await plugin({ MANGO_TEAM_ROLE: "manager", MANGO_TEAM_AGENT: "team" });
    const model = { providerID: "openrouter", modelID: "deepseek/x" };

    await p["chat.message"]({ sessionID: "normal", agent: "build", model: { providerID: "mango", modelID: "toq" } });
    expect(fs.existsSync(path.join(TEAM, "team-link-manager.json"))).toBe(false);

    await p["chat.message"]({ sessionID: "of-the-team", agent: "team", model });
    expect(link("team-link-manager.json")).toEqual({ serverUrl: "http://127.0.0.1:1", sessionID: "of-the-team", directory: PROJECT, agent: "team", model });

    // the manager's instructions enter only the team's conversation
    const manager = fs.readFileSync(path.join(LAUNCHER, "opencode-home", "MANGO-manager.md"), "utf8");
    const team = { system: ["base"] };
    await p["experimental.chat.system.transform"]({ sessionID: "of-the-team" }, team);
    expect(team.system).toEqual(["base", manager]);
    const other = { system: ["base"] };
    await p["experimental.chat.system.transform"]({ sessionID: "normal" }, other);
    expect(other.system).toEqual(["base"]);
  });

  test("without a team agent (the terminal) every conversation is the manager's and the instructions come from instructions", async () => {
    fs.rmSync(path.join(TEAM, "team-link-manager.json"), { force: true });
    const p = await plugin({ MANGO_TEAM_ROLE: "manager" });
    await p["chat.message"]({ sessionID: "only", agent: "build" });
    expect(link("team-link-manager.json").sessionID).toBe("only");
    const out = { system: ["base"] };
    await p["experimental.chat.system.transform"]({ sessionID: "only" }, out);
    expect(out.system).toEqual(["base"]);
  });

  test("the number of agents decides which tools the manager has", async () => {
    const base = ["ask_dev", "read_todos"];
    const agents = ["launch_agent", "ask_agent", "list_agents", "close_agent"];
    const names = async (env: Record<string, string>) => Object.keys((await plugin({ MANGO_TEAM_ROLE: "manager", ...env })).tool).sort();
    expect(await names({ MANGO_AGENT_MAX: "0" })).toEqual([...base].sort());
    expect(await names({ MANGO_AGENT_MAX: "2" })).toEqual([...base, ...agents].sort());
    expect(await names({})).toEqual([...base, ...agents].sort());
  });

  test("the dev's answer reaches the manager with its agent, its model and its project", async () => {
    const received: { id: string; folder: string | null; body: any }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const m = new URL(req.url).pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
        if (!m) return new Response("no", { status: 404 });
        received.push({ id: m[1], folder: req.headers.get("x-opencode-directory"), body: await req.json() });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const model = { providerID: "openrouter", modelID: "deepseek/x" };
      fs.writeFileSync(
        path.join(TEAM, "team-link-manager.json"),
        JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, sessionID: "ses_m", directory: PROJECT, agent: "team", model }),
      );
      const dev = await plugin({ MANGO_TEAM_ROLE: "dev" });
      const outcome = await dev.tool.ask_manager.execute({ message: "done" }, {});
      expect(outcome).toContain("Message sent to the manager");
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("ses_m");
      expect(decodeURIComponent(received[0].folder!)).toBe(PROJECT);
      expect(received[0].body).toEqual({ parts: [{ type: "text", text: "[DEV]\ndone" }], agent: "team", model });
    } finally {
      server.stop(true);
    }
  });
});

describe("hidden dev and agents", () => {
  const spec = async (name: string, port?: number) => ({
    port: port ?? (await freePort()),
    config: path.join(TEAM, `${name}-home`),
    xdg: path.join(TEAM, name),
  });
  let manager: Record<string, any>;

  beforeAll(async () => {
    fs.rmSync(TEAM, { recursive: true, force: true });
    fs.mkdirSync(TEAM, { recursive: true });
    const launchFile = path.join(TEAM, "launch.json");
    fs.writeFileSync(launchFile, JSON.stringify({ exe: FAKE, dev: await spec("dev"), agents: [{ id: 1, ...(await spec("agent-1")) }, { id: 2, ...(await spec("agent-2")) }] }));
    manager = await plugin({
      MANGO_TEAM_ROLE: "manager",
      MANGO_TEAM_AGENT: "team",
      MANGO_TEAM_LAUNCH: launchFile,
      MANGO_AGENT_MAX: "2",
      MANGO_AGENT_DIR: path.join(TEAM, "mango-agents"),
      MANGO_OPENROUTER_KEY: KEY,
    });
    // the manager already has a conversation: it has its link
    await manager["chat.message"]({ sessionID: "ses_m", agent: "team" });
  });

  test("the first instruction starts the dev in the project, with its role, and delivers it", async () => {
    const outcome = await manager.tool.ask_dev.execute({ instruction: "read the README" }, {});
    expect(outcome).toContain("Instruction sent to the dev");

    const entries = log("dev");
    const start = entries.find((v) => v.type === "start");
    expect(start.argv.slice(0, 2)).toEqual(["serve", "--hostname"]);
    expect(start.cwd.toLowerCase()).toBe(PROJECT.toLowerCase());
    expect(start.env.MANGO_TEAM_ROLE).toBe("dev");
    expect(start.env.MANGO_TEAM_AGENT).toBeNull();
    expect(start.env.MANGO_TEAM_LAUNCH).toBeNull();
    expect(start.env.OPENCODE_CONFIG_DIR).toBe(path.join(TEAM, "dev-home"));
    expect(start.env.XDG_DATA_HOME).toBe(path.join(TEAM, "dev", "data"));
    expect(start.env.MANGO_OPENROUTER_KEY).toBe(KEY); // inherited from the server, not from a file
    const texts = entries.filter((v) => v.type === "message").map((v) => v.text);
    expect(texts[0]).toStartWith("[START] You are the DEV");
    expect(texts[1]).toBe("read the README");
    expect(Number(fs.readFileSync(path.join(TEAM, "dev.pid"), "utf8"))).toBeGreaterThan(0);

    // the second instruction finds the dev already ready: it does not restart it
    await manager.tool.ask_dev.execute({ instruction: "and then the tests" }, {});
    expect(log("dev").filter((v) => v.type === "start")).toHaveLength(1);
    expect(log("dev").filter((v) => v.type === "message").map((v) => v.text).at(-1)).toBe("and then the tests");
  }, 60_000);

  test("an agent starts with its number, is recognized, is closed", async () => {
    const opened = await manager.tool.launch_agent.execute({ agent: "1" }, {});
    expect(opened).toContain("Agent 1 started and connected");
    const start = log("agent-1").find((v) => v.type === "start");
    expect(start.env.MANGO_TEAM_ROLE).toBe("agent");
    expect(start.env.MANGO_AGENT_ID).toBe("1");
    expect(start.env.OPENCODE_CONFIG_DIR).toBe(path.join(TEAM, "agent-1-home"));
    expect(log("agent-1").find((v) => v.type === "message").text).toContain("You are AGENT 1");

    expect(await manager.tool.launch_agent.execute({ agent: "1" }, {})).toContain("already open");
    expect(await manager.tool.launch_agent.execute({ agent: "3" }, {})).toContain("Invalid agent number");
    expect(await manager.tool.ask_agent.execute({ agent: "1", instruction: "do X" }, {})).toContain("Instruction sent to agent 1");
    expect(log("agent-1").filter((v) => v.type === "message").at(-1).text).toBe("[MANAGER]\ndo X");
    expect(await manager.tool.list_agents.execute({}, {})).toContain("agent 1: connected");

    expect(await manager.tool.close_agent.execute({ agent: "1" }, {})).toContain("Agent 1 closed");
    expect(await manager.tool.list_agents.execute({}, {})).toContain("agent 1: not started");
  }, 60_000);
});
