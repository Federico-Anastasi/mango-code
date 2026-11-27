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
/** The manager's environment in the app: its agent and the file that says how to start dev and agents. */
const MINIMAL_LAUNCH = path.join(ROOT, "launch-minimal.json");
const MANAGER = { MANGO_TEAM_ROLE: "manager", MANGO_TEAM_AGENT: "team", MANGO_TEAM_LAUNCH: MINIMAL_LAUNCH };

const VARIABLES = ["MANGO_TEAM_ROLE", "MANGO_TEAM_AGENT", "MANGO_TEAM_DIR", "MANGO_TEAM_LAUNCH", "MANGO_AGENT_MAX", "MANGO_AGENT_DIR", "MANGO_AGENT_ID", "MANGO_HOME", "MANGO_OPENROUTER_KEY", "MANGO_APP_RUN"];
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
  fs.writeFileSync(MINIMAL_LAUNCH, JSON.stringify({ exe: FAKE, dev: { port: 1, config: "", xdg: "" }, agents: [] }));
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
    const p = await plugin(MANAGER);
    const model = { providerID: "openrouter", modelID: "deepseek/x" };

    await p["chat.message"]({ sessionID: "normal", agent: "build", model: { providerID: "mango", modelID: "toq" } });
    expect(fs.existsSync(path.join(TEAM, "team-link-manager.json"))).toBe(false);

    await p["chat.message"]({ sessionID: "of-the-team", agent: "team", model });
    expect(link("team-link-manager.json")).toEqual({ serverUrl: "http://127.0.0.1:1", sessionID: "of-the-team", directory: PROJECT, agent: "team", model });

    // the manager's instructions enter only the team's conversation
    const manager = fs.readFileSync(path.join(LAUNCHER, "harness", "shared", "team-manager.md"), "utf8");
    const team = { system: ["base"] };
    await p["experimental.chat.system.transform"]({ sessionID: "of-the-team" }, team);
    expect(team.system).toEqual(["base", manager]);
    const other = { system: ["base"] };
    await p["experimental.chat.system.transform"]({ sessionID: "normal" }, other);
    expect(other.system).toEqual(["base"]);
  });

  test("the manager does not start without its agent and the launch file, and nobody starts without the Team's folder", async () => {
    await expect(plugin({ MANGO_TEAM_ROLE: "manager" })).rejects.toThrow("MANGO_TEAM_AGENT");
    await expect(plugin({ MANGO_TEAM_ROLE: "manager", MANGO_TEAM_AGENT: "team" })).rejects.toThrow("MANGO_TEAM_LAUNCH");
    for (const role of ["manager", "dev", "agent"]) {
      await expect(plugin({ ...MANAGER, MANGO_TEAM_ROLE: role, MANGO_TEAM_DIR: "" })).rejects.toThrow("MANGO_TEAM_DIR");
    }
  });

  test("the number of agents decides which tools the manager has", async () => {
    const base = ["ask_dev", "read_todos"];
    const agents = ["launch_agent", "ask_agent", "list_agents", "close_agent"];
    const names = async (env: Record<string, string>) => Object.keys((await plugin({ ...MANAGER, ...env })).tool).sort();
    expect(await names({ MANGO_AGENT_MAX: "0" })).toEqual([...base].sort());
    expect(await names({ MANGO_AGENT_MAX: "2" })).toEqual([...base, ...agents].sort());
    expect(await names({})).toEqual([...base, ...agents].sort());
  });

  /** The manager's server: what reaches the manager's conversation, and the link that points at it. */
  async function managerServer() {
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
    const model = { providerID: "openrouter", modelID: "deepseek/x" };
    fs.writeFileSync(
      path.join(TEAM, "team-link-manager.json"),
      JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}`, sessionID: "ses_m", directory: PROJECT, agent: "team", model }),
    );
    return { received, model, server };
  }

  test("the dev's answer reaches the manager with its agent, its model and its project, marked as the Team's and not the user's", async () => {
    const { received, model, server } = await managerServer();
    try {
      const dev = await plugin({ MANGO_TEAM_ROLE: "dev" });
      const outcome = await dev.tool.ask_manager.execute({ message: "done" }, {});
      expect(outcome).toContain("Message sent to the manager");
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("ses_m");
      expect(decodeURIComponent(received[0].folder!)).toBe(PROJECT);
      expect(received[0].body).toEqual({ parts: [{ type: "text", text: "[DEV]\ndone", metadata: { team: { kind: "report" } } }], agent: "team", model });
    } finally {
      server.stop(true);
    }
  });

  test("an agent's message and the automatic notice of a turn that ended without one carry the Team's mark and who wrote them", async () => {
    const { received, server } = await managerServer();
    try {
      const agent = await plugin({ MANGO_TEAM_ROLE: "agent", MANGO_AGENT_ID: "2" });
      await agent.tool.ask_manager.execute({ message: "prices checked" }, {});
      expect(received[0].body.parts).toEqual([{ type: "text", text: "[AGENT 2]\nprices checked", metadata: { team: { kind: "report", agent: "2" } } }]);

      const dev = await plugin({ MANGO_TEAM_ROLE: "dev" });
      await dev["chat.message"]({ sessionID: "ses_dev" }, { parts: [{ type: "text", text: "work" }] });
      const idle = { event: { type: "session.idle", properties: { sessionID: "ses_dev" } } };
      await dev.event(idle); // the reminder to the dev itself
      await dev.event(idle);
      const notice = received[received.length - 1].body.parts[0];
      expect(notice.text).toStartWith("[DEV] (automatic: turn ended without ask_manager)");
      expect(notice.metadata).toEqual({ team: { kind: "automatic" } });
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
      MANGO_APP_RUN: "run-x",
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
    expect(start.env.MANGO_TEAM_HIDDEN).toBe("run-x"); // what the app stops when it restarts the agent
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

describe("the Team ends", () => {
  const registry = () => (globalThis as Record<symbol, any>)[Symbol.for("mango.team")];
  const pidOf = (file: string) => Number(fs.readFileSync(path.join(TEAM, file), "utf8"));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killAll = () => {
    for (const f of ["dev.pid", "mango-agents/agent-1.pid"]) {
      try {
        spawnSync("taskkill", ["/PID", String(pidOf(f)), "/T", "/F"]);
      } catch {}
    }
  };
  const until = async (what: string, check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(100);
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  };

  // The conversation's server: what the plugin asks of it (stop an answer, write a line in the conversation).
  let calls: { path: string; body: any }[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let manager: Record<string, any>;
  let devPid = 0;
  let agentPid = 0;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = req.method === "POST" ? await req.json().catch(() => null) : null;
        calls.push({ path: new URL(req.url).pathname, body });
        return Response.json(new URL(req.url).pathname.endsWith("/abort") ? true : { info: {}, parts: [] });
      },
    });
  });
  afterAll(() => {
    killAll();
    server.stop(true);
  });

  /** A Team with the dev and agent 1 started; `instruction`: whether the dev was given work (the agent only said it was ready). */
  async function team(instruction: boolean) {
    killAll();
    calls = [];
    fs.rmSync(TEAM, { recursive: true, force: true });
    fs.mkdirSync(TEAM, { recursive: true });
    const spec = async (name: string) => ({ port: await freePort(), config: path.join(TEAM, `${name}-home`), xdg: path.join(TEAM, name) });
    const launchFile = path.join(TEAM, "launch.json");
    fs.writeFileSync(launchFile, JSON.stringify({ exe: FAKE, dev: await spec("dev"), agents: [{ id: 1, ...(await spec("agent-1")) }] }));
    manager = await plugin(
      { MANGO_TEAM_ROLE: "manager", MANGO_TEAM_AGENT: "team", MANGO_TEAM_LAUNCH: launchFile, MANGO_AGENT_MAX: "1", MANGO_AGENT_DIR: path.join(TEAM, "mango-agents") },
      `http://127.0.0.1:${server.port}`,
    );
    await manager["chat.message"]({ sessionID: "ses_m", agent: "team" });
    expect(await manager.tool.ask_dev.execute({ instruction: instruction ? "work on it" : "[START] wait" }, {})).toContain("Instruction sent");
    expect(await manager.tool.launch_agent.execute({ agent: "1" }, {})).toContain("started and connected");
    devPid = pidOf("dev.pid");
    agentPid = pidOf("mango-agents/agent-1.pid");
    expect(alive(devPid) && alive(agentPid)).toBe(true);
  }

  const answering = (sessionID: string) => manager.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
  const ended = async () => {
    await until("the dev and the agent to end", () => !alive(devPid) && !alive(agentPid));
    for (const f of ["dev.pid", "team-link.json", "mango-agents/agent-1.pid", "team-link-agent-1.json"]) expect(fs.existsSync(path.join(TEAM, f))).toBe(false);
  };
  const notices = () => calls.filter((c) => c.path === "/session/ses_m/message");

  test("turning it off in a working conversation ends the dev and the agents, cuts the manager's answer and says so", async () => {
    await team(true);
    await answering("ses_m");

    expect(await registry().stop("ses_m")).toEqual({ working: true, failed: [] });

    await ended();
    expect(calls.filter((c) => c.path === "/session/ses_m/abort")).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    const part = notices()[0].body.parts[0];
    expect(notices()[0].body.noReply).toBe(true);
    expect(part.metadata).toEqual({ team: { kind: "stopped" } });
    expect(part.text).toContain("stopped");
  }, 60_000);

  test("with nothing working the Team ends and the conversation says nothing", async () => {
    await team(false);
    expect(await registry().stop("ses_m")).toEqual({ working: false, failed: [] });
    await ended();
    expect(calls).toEqual([]);
  }, 60_000);

  test("a Team without a conversation answering but with the dev at work is stopped and the line goes to its conversation", async () => {
    await team(true);
    expect(await registry().stop()).toEqual({ working: true, failed: [] });
    await ended();
    expect(calls.filter((c) => c.path.endsWith("/abort"))).toEqual([]);
    expect(notices()).toHaveLength(1);
  }, 60_000);

  test("deleting or archiving the conversation ends its Team, silently", async () => {
    await team(true);
    await manager.event({ event: { type: "session.updated", properties: { info: { id: "ses_m", time: { created: 1, updated: 2 } } } } });
    expect(alive(devPid)).toBe(true);
    await manager.event({ event: { type: "session.updated", properties: { info: { id: "ses_m", time: { created: 1, updated: 2, archived: 3 } } } } });
    await ended();

    await team(true);
    await manager.event({ event: { type: "session.deleted", properties: { info: { id: "ses_m" } } } });
    await ended();
    expect(calls).toEqual([]);
  }, 120_000);

  test("another conversation of the Team going away leaves this one's Team running", async () => {
    await team(true);
    await manager["chat.message"]({ sessionID: "ses_other", agent: "team" });
    await manager["chat.message"]({ sessionID: "ses_m", agent: "team" });
    await manager.event({ event: { type: "session.deleted", properties: { info: { id: "ses_other" } } } });
    await Bun.sleep(500);
    expect(alive(devPid) && alive(agentPid)).toBe(true);
  }, 60_000);
});
