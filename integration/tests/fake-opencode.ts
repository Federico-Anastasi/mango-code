// A fake `opencode serve` for the Team tests: it answers the health check, opens sessions and receives messages as
// the real one would, and writes to MANGO_TEAM_DIR/fake-<name>.jsonl what reached it (arguments, folder, environment,
// messages). At the end of a session's first message it writes the link of its role, like the `chat.message` hook of
// the real plugin. It is built with `bun build --compile` into an executable, because the plugin starts it with
// `serve --hostname … --port …` like the real agent.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const role = process.env.MANGO_TEAM_ROLE ?? "";
const id = process.env.MANGO_AGENT_ID ?? "";
const dir = process.env.MANGO_TEAM_DIR!;
const name = role === "agent" ? `agent-${id}` : role;
const logFile = path.join(dir, `fake-${name}.jsonl`);
const link = path.join(dir, role === "agent" ? `team-link-agent-${id}.json` : "team-link.json");
const write = (entry: object) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");

write({
  type: "start",
  argv,
  cwd: process.cwd(),
  env: Object.fromEntries(
    ["OPENCODE_CONFIG_DIR", "MANGO_TEAM_ROLE", "MANGO_TEAM_AGENT", "MANGO_TEAM_LAUNCH", "MANGO_AGENT_ID", "XDG_DATA_HOME", "MANGO_OPENROUTER_KEY"].map((k) => [k, process.env[k] ?? null]),
  ),
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/global/health") return Response.json({ healthy: true });
    if (req.method === "POST" && url.pathname === "/session") return Response.json({ id: `ses_${name}`, title: "x" });
    const m = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === "POST" && m) {
      const body = (await req.json()) as { parts: { text: string }[] };
      const raw = req.headers.get("x-opencode-directory") ?? url.searchParams.get("directory");
      const folder = raw && decodeURIComponent(raw); // the SDK encodes it in the header
      write({ type: "message", session: m[1], folder, text: body.parts.map((p) => p.text).join("\n") });
      fs.writeFileSync(link, JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, sessionID: m[1], directory: folder }));
      return new Response(null, { status: 204 });
    }
    return new Response("not expected", { status: 404 });
  },
});
