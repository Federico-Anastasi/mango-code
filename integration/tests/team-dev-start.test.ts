// The manager's `ask_dev` when the hidden dev's server swallows the first request it gets while it starts (a connection that is
// accepted and never answered, as seen on a loaded computer): the plugin asks again and the instruction reaches the dev.
// The plugin runs as the agent loads it (a module with its environment), against a fake dev server; no app, no window.

import { afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mango-team-start-"));
const TEAM = path.join(ROOT, "team");
const PROJECT = path.join(ROOT, "project");
const WORK = "ZZ-WORK-ZZ";

const requests: { method: string; path: string; body: string }[] = [];
let healthCalls = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  fs.mkdirSync(TEAM, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "harness", "shared"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "harness", "shared", "team-manager.md"), "manager");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/global/health") return ++healthCalls === 1 ? new Promise<Response>(() => {}) : Response.json({ healthy: true });
      if (url.pathname === "/session" && req.method === "POST") return Response.json({ id: "ses_dev" });
      if (url.pathname.endsWith("/prompt_async")) {
        // What the dev's own plugin does with the first message it gets.
        fs.writeFileSync(path.join(TEAM, "team-link.json"), JSON.stringify({ serverUrl: `http://127.0.0.1:${server.port}/`, sessionID: "ses_dev", directory: PROJECT }));
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    },
  });
  fs.writeFileSync(
    path.join(TEAM, "launch.json"),
    JSON.stringify({ exe: process.execPath, dev: { port: server.port, config: path.join(ROOT, "config"), xdg: path.join(ROOT, "xdg") }, agents: [] }),
  );
  Object.assign(process.env, {
    MANGO_TEAM_ROLE: "manager",
    MANGO_HOME: ROOT,
    MANGO_TEAM_DIR: TEAM,
    MANGO_TEAM_AGENT: "team",
    MANGO_TEAM_LAUNCH: path.join(TEAM, "launch.json"),
    MANGO_AGENT_MAX: "0",
  });
});

afterEach(() => {
  server.stop(true);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("the dev gets the instruction although its server never answered the first health check", async () => {
  const plugin = await import(pathToFileURL(path.resolve(import.meta.dir, "../../launcher/opencode-home/plugin/mango-team.js")).href);
  const hooks = await plugin.MangoTeam({ serverUrl: "http://127.0.0.1:1/", directory: PROJECT });
  const outcome = await Promise.race([
    hooks.tool.ask_dev.execute({ instruction: WORK }, {}),
    Bun.sleep(25_000).then(() => "ask_dev did not return in 25 s"),
  ]);
  expect(outcome).toContain("Instruction sent to the dev");
  expect(requests.filter((r) => r.path.endsWith("/prompt_async") && r.body.includes(WORK))).toHaveLength(1);
}, 40_000);
