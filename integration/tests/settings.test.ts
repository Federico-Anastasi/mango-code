// What goes into the prompt (docs/INTEGRATION.md, §5 "What goes into the prompt"): every entry (base tool, MCP server,
// skill, instruction file, plugin) is on or off, for all folders or only for the working one; an entry that is off does
// not reach the model's request, back on it returns. Attached apps add and cannot switch anything off. The weight in
// tokens of every entry is counted by the engine (the fake one: one word, one token). Fake engine, no GPU.
//
// With `MANGO_OPENCODE=<folder with web\mango-code.exe>` it tries a separate build of the agent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, REPO, type Environment } from "./environment";

let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start([{ text: "Done." }]);
  mc = new MangoCode((await find(env.data))!);
  await mc.addMcp(env.project, "animation", {
    type: "local",
    command: ["bun", path.join(env.project, "tools", "echo.mjs")],
    cwd: env.project,
  });
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const url = () => `${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}`;
const read = async () => (await fetch(url())).json();
const entry = (state: any, type: string, name: string) => state.items.find((v: any) => v.type === type && v.name === name);
/** From the settings page: the request carries `Origin`, an app's does not. */
const change = (body: object, origin: string | null = env.agent) =>
  fetch(url(), { method: "PUT", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
const FOLDER_FILE = () => path.join(env.project, ".mango", "settings.json");
const DEFAULT_FILE = () => path.join(env.data, "settings.json");
/** The default settings file: besides `prompt` it holds the language the environment starts with. */
const readDefault = () => JSON.parse(fs.readFileSync(DEFAULT_FILE(), "utf8"));

const engineRequests = () =>
  fs
    .readFileSync(env.engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    // the engine writes the log while it is being read (the measurement requests): a half line is skipped
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
const chatRequests = () => engineRequests().filter((r) => r?.route?.startsWith("/v1/chat/completions"));
/** The weights the agent keeps for the settings page (its state folder, given by the app). */
const WEIGHTS_FILE = () => path.join(env.data, "agent", "state", "opencode", "prompt-weights.json");
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error(`waited too long for: ${what}`);
    await Bun.sleep(200);
  }
}

/** Closes the app and starts it again on the same folders, until its agent answers and its model is loaded. */
async function restart() {
  const serviceFile = path.join(env.data, "service.json");
  const closed = readJson(serviceFile).pid;
  await env.restart();
  await waitUntil(() => fs.existsSync(serviceFile) && readJson(serviceFile).pid !== closed, "the service file of the new start", 180_000);
  await waitUntil(async () => (await fetch(url())).ok, "the settings of the new start");
  await waitUntil(async () => (await (await fetch(`${env.engine}/engine`)).json()).phase === "running", "the model loaded again", 180_000);
}

/** A new conversation: its first request, as it reached the engine. */
async function fresh(): Promise<{ tools: string[]; system: string; user: string }> {
  const before = chatRequests().length;
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
  const body = chatRequests()[before].body;
  const text = (m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  return {
    tools: (body.tools ?? []).map((t: any) => t.function.name).sort(),
    system: body.messages.filter((m: any) => m.role === "system").map(text).join("\n"),
    user: body.messages.filter((m: any) => m.role === "user").map(text).join("\n"),
  };
}

/** How many tokens a request has according to the engine: system prompt, message and tool definitions. */
async function requestTokens(r: { tools: string[]; system: string; user: string }) {
  const body = chatRequests().at(-1)!.body;
  const text = [r.system, r.user, JSON.stringify(body.tools)].join("\n");
  const response = await fetch(`${env.engine}/tokenize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  return (await response.json()).tokens.length as number;
}

/** One entry of each kind that is on, the app's MCP server among them. */
const ON = [["tools", "bash"], ["mcp", "echo"], ["mcp", "animation"], ["plugins", "mango-discipline"]];

/** The measurement starts with the first request and ends later: wait until `entries` have their weight. */
async function measured(entries = ON) {
  for (let i = 0; i < 60; i++) {
    const s = await read();
    if (entries.every(([type, name]) => entry(s, type, name)?.tokens != null)) return s;
    await Bun.sleep(500);
  }
  throw new Error("the entries were not measured");
}

const MANGO_MD = fs.readFileSync(path.join(REPO, "launcher", "opencode-home", "MANGO.md"), "utf8").split("\n").find((r) => r.trim().length > 30)!.trim();
const DISCIPLINE = "DISCIPLINE (local model)";

let all: Awaited<ReturnType<typeof fresh>>;
let allWeight: number;

test("with everything on, by default, every entry is on and says its weight in tokens", async () => {
  // Only the language is in the default file: nobody has written prompt settings.
  expect(readDefault().prompt).toBeUndefined();
  expect(fs.existsSync(FOLDER_FILE())).toBe(false);
  all = await fresh();
  expect(all.tools).toContain("webfetch");
  expect(all.tools).toContain("echo_repeat"); // the project's (.mcp.json)
  expect(all.tools).toContain("animation_repeat"); // added by an app
  expect(all.system).toContain("TANGERINE");
  expect(all.system).toContain(MANGO_MD);
  expect(all.system).toContain("<name>greeting</name>");
  expect(all.user).toContain(DISCIPLINE);

  const s = await measured();
  expect(s.model).toBe("fake");
  expect(s.items.filter((v: any) => v.type !== "base").every((v: any) => v.enabled && v.source === "default")).toBe(true);
  for (const [type, name] of [["tools", "webfetch"], ["mcp", "echo"], ["mcp", "animation"], ["skills", "greeting"], ["instructions", "CLAUDE.md"], ["instructions", "MANGO.md"], ["plugins", "mango-discipline"]]) {
    const v = entry(s, type, name);
    expect(v, `${type} ${name}`).toBeDefined();
    expect(v.tokens, `${type} ${name}`).toBeGreaterThan(0);
  }
  expect(entry(s, "base", "base").tokens).toBeGreaterThan(0);
  // with a new conversation every entry has its weight: none "not measured"
  expect(s.items.filter((v: any) => v.tokens === null).map((v: any) => `${v.type}:${v.name}`)).toEqual([]);
  // an MCP server weighs its definitions: echo has one, the plugin's reminder is its text
  expect(entry(s, "plugins", "mango-documents").tokens).toBe(0);
  allWeight = await requestTokens(all);
  console.log(`tokens of the first request with everything on: ${allWeight}`);
}, 180_000);

test("the measurement is in the agent's log, one line per conversation, with the total and every entry", async () => {
  const folder = path.join(env.data, "agent", "data", "opencode", "log");
  // directory="<test root>\project" (the path in the log has doubled slashes); the line arrives when the measurement is done
  let line: string | undefined;
  for (let i = 0; i < 40 && !line; i++) {
    const log = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), "utf8")).join("\n");
    line = log.split("\n").find((r) => r.includes("prompt measured") && r.includes(path.basename(env.root)));
    if (!line) await Bun.sleep(500);
  }
  expect(line).toBeDefined();
  if (!line) return;
  expect(line).toMatch(/total=\d+/);
  expect(line).toContain("tools:bash=");
  expect(line).toContain("mcp:echo=");
});

test("an entry switched off for all folders does not reach the request, and neither does its weight", async () => {
  for (const c of [
    { type: "tools", name: "webfetch" },
    { type: "mcp", name: "echo" },
    { type: "mcp", name: "animation" },
    { type: "instructions", name: "CLAUDE.md" },
    { type: "skills", name: "greeting" },
    { type: "plugins", name: "mango-discipline" },
  ]) {
    const r = await change({ ...c, enabled: false, scope: "all" });
    expect(await r.json()).toEqual({ ...c, enabled: false, source: "default" });
  }
  expect(readDefault().prompt).toEqual({ tools: { webfetch: false }, mcp: { echo: false, animation: false }, instructions: { "CLAUDE.md": false }, skills: { greeting: false }, plugins: { "mango-discipline": false } });
  // the other keys of the file stay (the language)
  expect(readDefault().language).toBe("it");
  // for all folders: nothing in the folder's file (and nobody created it)
  expect(fs.existsSync(FOLDER_FILE())).toBe(false);

  const r = await fresh();
  expect(r.tools).not.toContain("webfetch");
  expect(r.tools).not.toContain("echo_repeat");
  expect(r.tools).not.toContain("animation_repeat");
  expect(r.tools).toContain("bash");
  expect(r.system).not.toContain("TANGERINE");
  expect(r.system).not.toContain("<name>greeting</name>");
  expect(r.system).toContain(MANGO_MD); // the other instructions stay
  expect(r.user).not.toContain(DISCIPLINE);

  const s = await measured();
  const off = entry(s, "tools", "webfetch");
  expect(off.enabled).toBe(false);
  expect(off.tokens).toBeGreaterThan(0); // the weight of an entry that is off is still shown: it helps to choose whether to switch it back on
  expect(entry(s, "plugins", "mango-discipline").tokens).toBeGreaterThan(0);
  const after = await requestTokens(r);
  console.log(`tokens of the first request with 6 entries off: ${after} (with everything on: ${allWeight})`);
  expect(after).toBeLessThan(allWeight);
}, 180_000);

test("the folder's file wins over the default, and is born only from \"only this folder\"", async () => {
  expect(fs.existsSync(FOLDER_FILE())).toBe(false);
  const r = await change({ type: "tools", name: "webfetch", enabled: true, scope: "folder" });
  expect(await r.json()).toEqual({ type: "tools", name: "webfetch", enabled: true, source: "folder" });
  expect(JSON.parse(fs.readFileSync(FOLDER_FILE(), "utf8"))).toEqual({ prompt: { tools: { webfetch: true } } });

  const after = await fresh();
  expect(after.tools).toContain("webfetch");
  expect(after.tools).not.toContain("echo_repeat"); // the default holds for the rest
  const s = await read();
  expect(entry(s, "tools", "webfetch")).toMatchObject({ enabled: true, source: "folder" });
  expect(entry(s, "mcp", "echo")).toMatchObject({ enabled: false, source: "default" });
});

test("switched back on, the entries return to the request as before", async () => {
  for (const c of [
    { type: "tools", name: "webfetch" },
    { type: "mcp", name: "echo" },
    { type: "mcp", name: "animation" },
    { type: "instructions", name: "CLAUDE.md" },
    { type: "skills", name: "greeting" },
    { type: "plugins", name: "mango-discipline" },
  ]) {
    expect((await (await change({ ...c, enabled: true, scope: "all" })).json()).enabled).toBe(true);
  }
  expect(readDefault().prompt).toEqual({});
  expect(readDefault().language).toBe("it");
  const r = await fresh();
  expect(r.tools).toEqual(all.tools);
  expect(r.system).toContain("TANGERINE");
  expect(r.system).toContain("<name>greeting</name>");
  expect(r.user).toContain(DISCIPLINE);
  expect(await requestTokens(r)).toBe(allWeight);
}, 180_000);

test("apps only add: extra folders are entries that are on, and settings cannot be changed from outside the page", async () => {
  await mc.setExtraFolders(env.project, [env.method]);
  let s = await read();
  const method = s.items.find((v: any) => v.type === "instructions" && v.name.endsWith("/method/CLAUDE.md"));
  expect(method).toMatchObject({ enabled: true, source: "default" });
  expect(entry(s, "skills", "whiteboard")).toMatchObject({ enabled: true });
  expect((await fresh()).system).toContain("GINGER");

  // a client on the PC (without Origin) changes nothing; neither does a page from another address
  const without = await change({ type: "mcp", name: "echo", enabled: false, scope: "all" }, null);
  expect(without.status).toBe(403);
  const other = await change({ type: "mcp", name: "echo", enabled: false, scope: "all" }, "http://127.0.0.1:1");
  expect(other.status).toBe(403);
  expect(entry(await read(), "mcp", "echo").enabled).toBe(true);
  expect(readDefault().prompt).toEqual({});

  // from the page, what an app brought can also be switched off, only for this folder
  await change({ type: "instructions", name: method.name, enabled: false, scope: "folder" });
  expect((await fresh()).system).not.toContain("GINGER");
  await change({ type: "instructions", name: method.name, enabled: true, scope: "folder" });
  expect((await fresh()).system).toContain("GINGER");
  await mc.setExtraFolders(env.project, []);
}, 180_000);

test("the weights outlive the app; without them, a conversation taken up again measures them", async () => {
  // a conversation to take up again later
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
  const before = await measured();
  const counted = () => engineRequests().filter((r) => r?.route === "/tokenize").length;

  await restart();
  const after = await read();
  expect(after.model).toBe("fake");
  expect(after.items.filter((v: any) => v.tokens === null).map((v: any) => `${v.type}:${v.name}`)).toEqual([]);
  for (const v of after.items) expect(v.tokens, `${v.type} ${v.name}`).toBe(entry(before, v.type, v.name)?.tokens);
  // nothing is read or counted again to show them
  const tokenized = counted();
  await Bun.sleep(2000);
  expect(counted()).toBe(tokenized);

  // without the file the page has no weights, until the conversation goes on: its first request measures them
  fs.rmSync(WEIGHTS_FILE());
  await restart();
  expect((await read()).items.filter((v: any) => v.tokens !== null)).toEqual([]);
  for await (const _ of mc.turn(id, env.project, "Again", { model: "fake" }));
  // the app added its MCP server to the agent that was running: the agent started again does not have it
  const again = await measured(ON.filter(([, name]) => name !== "animation"));
  expect(entry(again, "tools", "bash").tokens).toBe(entry(before, "tools", "bash").tokens);
  expect(fs.existsSync(WEIGHTS_FILE())).toBe(true);
}, 400_000);

test("wrong requests or files that cannot be read say what is wrong", async () => {
  expect((await change({ type: "thing", name: "x", enabled: false, scope: "all" })).status).toBe(400);
  expect((await change({ type: "mcp", name: "x", enabled: "no", scope: "all" })).status).toBe(400);
  expect((await change({ type: "mcp", name: "x", enabled: false, scope: "everywhere" })).status).toBe(400);
  expect((await fetch(`${env.agent}/mango/settings`)).status).toBe(400);
  expect((await fetch(`${env.agent}/mango/settings?directory=${encodeURIComponent(env.project + "-does-not-exist")}`)).status).toBe(404);
  fs.mkdirSync(path.dirname(FOLDER_FILE()), { recursive: true });
  fs.writeFileSync(FOLDER_FILE(), "{ not json");
  const r = await fetch(url());
  expect(r.status).toBe(500);
  // the error is shown to the user: it follows the language (Italian here)
  expect((await r.json()).error).toContain("settings.json non e' JSON valido");
  // a conversation in that folder does not start, and the error names the file: switched-off entries do not silently come back on
  const id = await mc.createSession(env.project);
  const events: any[] = [];
  const stop = mc.listen(env.project, (e) => e.properties?.sessionID === id && events.push(e));
  await Bun.sleep(300);
  await mc.send(id, env.project, "Hello", { model: "fake" });
  for (let i = 0; i < 40 && !events.some((e) => e.type === "session.error"); i++) await Bun.sleep(250);
  stop();
  const error = events.find((e) => e.type === "session.error");
  expect(error, JSON.stringify(events.map((e) => e.type))).toBeDefined();
  expect(JSON.stringify(error)).toContain("settings.json");
  fs.rmSync(FOLDER_FILE());
  expect((await fetch(url())).status).toBe(200);
}, 60_000);
