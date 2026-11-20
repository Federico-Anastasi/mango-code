// A page shown on the phone reaches no listener of the app. The real app (fake engine) runs with the phone service on, a
// folder site and the engine loaded; then every port that anything in the app's process tree listens on, read from the
// system, is asked for through the phone's route. Each must be refused: a listener that nobody told the phone service
// about answers instead and fails this test by its port. A server of the user's own, outside the tree, still answers.
// `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/. Own ports: free ones.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { start, type Environment } from "./environment";

let env: Environment;
let base = "";
let cookie = "";
let phone = 0;
let preview = 0;
let user: http.Server;
let userPort = 0;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

/** Every TCP port in the listening state of `root` and its descendants, as the system reports it. */
function listening(root: number) {
  const script = [
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId",
    `$tree = @(${root}); $grew = $true`,
    "while ($grew) { $more = @($all | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $grew = $more.Count -gt 0; $tree += $more }",
    "Get-NetTCPConnection -State Listen | Where-Object { $tree -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort }",
  ].join("; ");
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`the listening ports could not be read: ${out.stderr}`);
  return [...new Set(out.stdout.split(/\s+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
}

const through = (port: number) =>
  fetch(`http://127.0.0.1:${preview}/__mango_loopback/localhost/${port}/`, { headers: { cookie } });

beforeAll(async () => {
  [phone, preview, userPort] = [await freePort(), await freePort(), await freePort()];
  env = await start([{ text: "Hello from the fake engine." }], {
    window: true,
    noDebug: true,
    env: { MANGO_PHONE_PC_ONLY: "1", MANGO_PHONE_PORT: String(phone), MANGO_PHONE_PREVIEW_PORT: String(preview), MANGO_NETWORK_PUBLIC: "1" },
  });
  // The phone service starts on if it was left on: it is written so and the app started again.
  fs.writeFileSync(path.join(env.data, "phone.json"), JSON.stringify({ enabled: true, key: "k".repeat(48), sessions: [] }));
  await env.restart();
  base = `http://127.0.0.1:${phone}`;
  for (let waited = 0; ; waited += 200) {
    const open = await fetch(`${base}/`).then(() => true, () => false);
    if (open) break;
    if (waited > 120_000) throw new Error("the phone port did not open");
    await Bun.sleep(200);
  }
  for (let waited = 0; ; waited += 200) {
    const state = await fetch(`${env.engine}/engine`).then((r) => r.json(), () => ({ phase: "down" }));
    if (state.phase === "running") break;
    if (waited > 120_000) throw new Error(`the model did not load again: ${JSON.stringify(state)}`);
    await Bun.sleep(200);
  }
  const entry = await fetch(`${base}/phone?key=${"k".repeat(48)}`, { redirect: "manual" });
  cookie = entry.headers.get("set-cookie")!.split(";")[0];
  user = http.createServer((_, res) => res.end("the user's own server")).listen(userPort, "127.0.0.1");
  const folder = path.join(env.root, "site");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "index.html"), "<h1>site</h1>");
  const opened = await fetch(`${env.engine.replace(/\/$/, "")}/control/site`, { method: "POST", body: JSON.stringify({ path: path.join(folder, "index.html") }) });
  expect(opened.status).toBe(200);
}, 300_000);

afterAll(() => {
  user?.close();
  env?.close();
});

test("every port the app listens on is refused to a page on the phone, and a server of the user's is not", async () => {
  expect((await through(userPort)).status).toBe(200);
  const ports = listening(env.app.pid!);
  // the agent, the engine's control server, the engine process, the phone's two ports, the panel's debugging, the folder site
  expect(ports.length).toBeGreaterThanOrEqual(7);
  expect(ports).toContain(phone);
  expect(ports).toContain(preview);
  const answered = await Promise.all(ports.map(async (port) => [port, (await through(port)).status] as const));
  expect(answered.filter(([, status]) => status !== 403)).toEqual([]);
}, 60_000);
