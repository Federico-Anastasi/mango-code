// The agent (Bun) and the servers it starts read only HTTP_PROXY / HTTPS_PROXY / NO_PROXY, never Windows' proxy: the app passes them when Windows has
// a proxy and the user has not named one. The proof, with a fake office proxy (a program that records the first line of every request):
//  - the agent reaches the engine on this computer without the proxy (a conversation works, the proxy sees nothing of the engine);
//  - an address outside the network does go through the proxy (the agent's web fetch arrives at the proxy).
// The Windows proxy is given by `MANGO_WINDOWS_PROXY` (debug builds only). Fake engine, no GPU, own ports (47764-47767).
// `bun test --cwd integration tests/agent-proxy.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const [AGENT, ENGINE, PROXY] = [47764, 47765, 47766];

let env: Environment;
let proxy: net.Server;
const seen: string[] = [];

beforeAll(async () => {
  proxy = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      seen.push(String(data).split("\r\n")[0]!);
      const body = "<!doctype html><title>From the proxy</title><p>reached through the proxy</p>";
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((ok) => proxy.listen(PROXY, "127.0.0.1", ok));
  env = await start([{ tool: "webfetch", arguments: { url: "http://fetch.example.test/page", format: "text" } }, { text: "Fatto." }], {
    env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), MANGO_WINDOWS_PROXY: `http://127.0.0.1:${PROXY}` },
  });
}, 200_000);

afterAll(() => {
  env?.close();
  proxy?.close();
  Bun.sleepSync(1500);
});

test("the agent reaches the engine directly and the web through the proxy", async () => {
  const mc = new MangoCode((await find(env.data))!);
  const id = await mc.createSession(env.project, { title: "proxy" });
  const steps: any[] = [];
  const turn = (async () => { for await (const step of mc.turn(id, env.project, "Leggi la pagina", { model: "fake" })) steps.push(step); })();
  // a turn that does not end says what it did and what the proxy saw, instead of timing out without a word
  const late = new Promise<never>((_, no) => setTimeout(() => no(new Error(`the turn did not end; steps ${JSON.stringify(steps)}; the proxy saw ${JSON.stringify(seen)}`)), 60_000));
  await Promise.race([turn, late]);
  const tool = steps.find((s) => s.type === "tool" && s.status === "completed");
  expect(tool?.name, JSON.stringify(steps)).toBe("webfetch");
  expect(seen.some((line) => line.startsWith("GET http://fetch.example.test/page"))).toBe(true);
  // the engine (127.0.0.1) and the app's own agent never went to the proxy
  expect(seen.filter((line) => line.includes("127.0.0.1") || line.includes(`:${ENGINE}`) || line.includes(`:${AGENT}`))).toEqual([]);
}, 120_000);
