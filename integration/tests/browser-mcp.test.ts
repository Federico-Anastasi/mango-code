// The agent's browser server (`launcher/mango-chrome-mcp.mjs`), launched as the app launches it: the agent's own runtime
// (`mango-code.exe` with BUN_BE_BUN=1), speaking MCP over stdin/stdout. Two windowless Chromes stand in for the Preview panel
// and for the user's Chrome (its `DevToolsActivePort` in a fake LOCALAPPDATA). Both resolve `myapp.test` to the local site, so a
// page "of the internet" loads in either one and its title says where it landed. No app, no model, no GPU.
// The agent: `MANGO_OPENCODE` (a folder with `web\mango-code.exe`) or `launcher\opencode`. Own ports: 48240-48242, 48245-48246.
// `bun test --cwd integration tests/browser-mcp.test.ts`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./environment";

const CHROME = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
const RUNTIME_EXE = path.join(process.env.MANGO_OPENCODE ?? path.join(REPO, "launcher", "opencode"), "web", "mango-code.exe");
const SERVER = path.join(REPO, "launcher", "mango-chrome-mcp.mjs");
const [PANEL, USER, SITE, PANEL_TO_CLOSE, USER_TO_CLOSE] = [48240, 48241, 48242, 48245, 48246];
const RESOLVE = "--host-resolver-rules=MAP myapp.test 127.0.0.1";

let root: string;
let site: ReturnType<typeof Bun.serve>;
const servers: Server[] = [];

/** A windowless Chrome with remote debugging on a port of ours; `active` is what Chrome writes in `DevToolsActivePort` when started from chrome://inspect: the port and the WebSocket path. */
async function chrome(port: number) {
  const profile = path.join(root, `profile-${port}`);
  const child = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", RESOLVE, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const version: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { child, active: `${port}\n${new URL(version.webSocketDebuggerUrl).pathname}\n` };
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Chrome does not answer on ${port}`);
}

/** Closes a Chrome of this test while it is surely alive (its pid cannot belong to anything else yet), with its helpers. */
async function quit(child: ChildProcess) {
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  await Bun.sleep(1000);
}

/** A fake LOCALAPPDATA whose Chrome `DevToolsActivePort` holds `active`: the "user's Chrome" a server finds. */
function localAppData(name: string, active: string) {
  const userData = path.join(root, name, "Google", "Chrome", "User Data");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "DevToolsActivePort"), active);
  return path.join(root, name);
}

/** A port nothing listens on: opened and closed here. */
function freePort() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/**
 * A port that answers like a Chrome whose debugging was turned on from chrome://inspect (no /json routes) and never lets
 * the WebSocket in: `deny` answers 403, as when the user denies "Allow remote debugging?"; otherwise it never answers, as
 * when the question is left on screen. `attempts` counts the connections tried.
 */
function fakeChrome(deny: boolean) {
  const fake = {
    attempts: 0,
    server: Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/json/version") return new Response("", { status: 404 });
        fake.attempts++;
        return deny ? new Response("", { status: 403 }) : new Promise<Response>(() => {});
      },
    }),
  };
  return fake;
}

const pages = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).filter((p) => p.type === "page");
const titles = async (port: number) => (await pages(port)).map((p) => p.title as string);
/** Every tab of a browser with its address: what a test checks at the end to see that nobody took a tab over. */
const addresses = async (port: number) => Object.fromEntries((await pages(port)).map((p) => [p.id as string, p.url as string]));
/** A tab the user has open in "their" Chrome; resolves once it has loaded. */
async function userTab(url: string, title: string) {
  await fetch(`http://127.0.0.1:${USER}/json/new?${url}`, { method: "PUT" });
  for (let i = 0; i < 50 && !(await titles(USER)).includes(title); i++) await Bun.sleep(100);
  expect(await titles(USER)).toContain(title);
}

beforeAll(async () => {
  for (const f of [CHROME, RUNTIME_EXE]) if (!fs.existsSync(f)) throw new Error(`${f} is missing`);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-browser-mcp-"));
  site = Bun.serve({
    port: SITE,
    hostname: "127.0.0.1",
    fetch: (req) => new Response(`<!doctype html><title>site ${new URL(req.url).pathname}</title>SITE`, { headers: { "content-type": "text/html" } }),
  });
  await chrome(PANEL);
  localAppData("local", (await chrome(USER)).active);
}, 60_000);

afterAll(() => {
  for (const s of servers) s.close();
  // Every Chrome of this file, with its helpers, by the test's own folder in its command line: never by name or by a pid
  // that could belong to another program by now. The agent's own browser, started by a server, is one of them.
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${root}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);
  site?.stop(true);
  Bun.sleepSync(1500);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}, 60_000);

/**
 * The browser server, as the agent runs it. `myChrome` is the app's choice, written where the server reads it. Options:
 * `reading` false: nothing drains its stdout pipe until `listen()`; `project`: the folder the client gives as its root, the
 * way the agent gives the project's; `localAppData`: where it finds the user's Chrome; `panel`: the panel's port, 0 for
 * none; `env` and `args`: more for the server.
 */
class Server {
  private child: ChildProcess;
  private pending = new Map<number, (v: any) => void>();
  private n = 0;
  private buffer = "";
  /** What the server has written that this client has read. */
  bytes = 0;
  readonly runtime: string;
  readonly trace: string;
  readonly project?: string;
  private readonly choice: string;

  constructor(
    readonly name: string,
    myChrome: boolean,
    options: { reading?: boolean; project?: string; localAppData?: string; panel?: number; env?: Record<string, string>; args?: string[] } = {},
  ) {
    this.runtime = path.join(root, `runtime-${name}`);
    this.trace = path.join(this.runtime, "mcp-chrome.log");
    this.project = options.project;
    this.choice = path.join(root, `browser-${name}.json`);
    this.choose(myChrome);
    this.child = spawn(RUNTIME_EXE, [SERVER, ...(options.args ?? [])], {
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
        MANGO_RUNTIME: this.runtime,
        MANGO_PANEL_CDP: String(options.panel ?? PANEL),
        MANGO_BROWSER_CHOICE: this.choice,
        LOCALAPPDATA: options.localAppData ?? path.join(root, "local"),
        ...options.env,
      },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    if (options.reading ?? true) this.listen();
    servers.push(this);
  }

  /** The user flips "Use my Chrome" in the app. */
  choose(myChrome: boolean) {
    fs.writeFileSync(this.choice, JSON.stringify({ myChrome }));
  }

  /** Starts draining the server's stdout. */
  listen() {
    this.child.stdout!.on("data", (d) => {
      this.bytes += d.length;
      this.buffer += d;
      for (let nl; (nl = this.buffer.indexOf("\n")) >= 0; ) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const msg = JSON.parse(line);
        if (msg.method === "roots/list") {
          this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: pathToFileURL(this.project!).href }] } }) + "\n");
          continue;
        }
        if (msg.method) continue;
        this.pending.get(msg.id)?.(msg);
      }
    });
  }

  request(method: string, params: object, ms = 30_000) {
    const id = ++this.n;
    return new Promise<any>((ok, ko) => {
      const timer = setTimeout(() => ko(new Error(`${method}: no answer in ${ms} ms`)), ms);
      this.pending.set(id, (v) => (clearTimeout(timer), ok(v)));
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async start() {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: this.project ? { roots: {} } : {}, clientInfo: { name: "test", version: "1" } });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return this;
  }

  async call(tool: string, args: object = {}) {
    const answer = await this.request("tools/call", { name: tool, arguments: args });
    expect(answer.error, JSON.stringify(answer)).toBeUndefined();
    return answer.result as { isError?: boolean; content: { type: string; text?: string }[] };
  }

  log() {
    return fs.existsSync(this.trace) ? fs.readFileSync(this.trace, "utf8") : "";
  }

  close() {
    this.child.kill();
  }

  /** Ends the server as the agent does, closing its stdin: a browser it started is closed with it. */
  async end() {
    const exited = new Promise((ok) => this.child.once("exit", ok));
    this.child.stdin!.end();
    await exited;
  }
}

const text = (answer: { content: { text?: string }[] }) => answer.content.map((c) => c.text ?? "").join("\n");

test("with \"Use my Chrome\" on, every page the agent opens goes to the panel, sites of the internet included", async () => {
  const server = await new Server("local", true).start();
  const file = path.join(root, "made-by-agent.html");
  fs.writeFileSync(file, "<!doctype html><title>made by the agent</title>FILE");
  // a tab the user has open: its address must be the same at the end
  await userTab(`http://myapp.test:${SITE}/theirs`, "site /theirs");
  const userBefore = await addresses(USER);

  const opened = [
    ["file:///" + file.replace(/\\/g, "/"), "made by the agent"],
    [`http://127.0.0.1:${SITE}/served`, "site /served"],
    [`http://localhost:${SITE}/localhost`, "site /localhost"],
    [`http://myapp.test:${SITE}/internet`, "site /internet"],
  ];
  for (const [url, title] of opened) {
    expect((await server.call("new_page", { url })).isError, url).toBeFalsy();
    expect(await titles(PANEL), `${url}
${server.log()}`).toContain(title);
    expect(await addresses(USER), url).toEqual(userBefore);
  }
  expect(server.log()).not.toContain("browser: user's Chrome");
  server.close();
}, 90_000);

test("userChrome opens a new tab in the user's Chrome and never takes a tab of the user's over; the agent's own tabs can be navigated", async () => {
  const server = await new Server("both", true).start();
  await userTab(`http://myapp.test:${SITE}/theirs`, "site /theirs");
  const userBefore = await addresses(USER);
  const panelBefore = await titles(PANEL);

  // the page that needs the user's sign-ins: a new tab next to theirs, nothing in the panel
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/mail`, userChrome: true })).isError).toBeFalsy();
  expect(await titles(PANEL)).toEqual(panelBefore);
  const afterOpen = await addresses(USER);
  expect(Object.keys(afterOpen)).toHaveLength(Object.keys(userBefore).length + 1);
  expect(Object.values(afterOpen)).toContain(`http://myapp.test:${SITE}/mail`);

  // the server is now in the user's Chrome: their tab is listed, and it cannot be navigated, with or without `type`
  const listed = (await server.call("list_pages")).content[0].text!;
  const theirs = Number(listed.match(/(\d+): .*\/theirs/)![1]);
  const mine = Number(listed.match(/(\d+): .*\/mail/)![1]);
  for (const args of [
    { type: "url", url: `http://myapp.test:${SITE}/taken`, pageId: theirs },
    { url: `http://myapp.test:${SITE}/taken`, pageId: theirs },
  ]) {
    const refused = await server.call("navigate_page", args);
    expect(refused.isError, JSON.stringify(args)).toBe(true);
    expect(refused.content[0].text).toContain("one of the user's own tabs");
  }
  expect(await addresses(USER)).toEqual(afterOpen);

  // the agent's own tab is its to navigate
  expect((await server.call("navigate_page", { type: "url", url: `http://myapp.test:${SITE}/mail2`, pageId: mine })).isError).toBeFalsy();
  expect(await titles(USER)).toContain("site /mail2");

  // an ordinary page goes back to the panel; the ids belong to the browser that was left, and the answer says so
  const back = await server.call("new_page", { url: `http://myapp.test:${SITE}/plain` });
  expect(await titles(PANEL)).toContain("site /plain");
  expect(back.content[0].text).toContain("Call list_pages");

  // a second tab in the user's Chrome; the first one is still the agent's after the connection went away and came back
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/mail3`, userChrome: true })).isError).toBeFalsy();
  const again = (await server.call("list_pages")).content[0].text!;
  const first = Number(again.match(/(\d+): .*\/mail2/)![1]);
  expect((await server.call("navigate_page", { type: "url", url: `http://myapp.test:${SITE}/mail4`, pageId: first })).isError).toBeFalsy();
  expect(await titles(USER)).toContain("site /mail4");

  // at the end every tab the user had is where it was
  const userAfter = await addresses(USER);
  for (const [id, url] of Object.entries(userBefore)) expect(userAfter[id], id).toBe(url);
  expect(Object.keys(userAfter)).toHaveLength(Object.keys(userBefore).length + 2);
  server.close();
}, 90_000);

test("userChrome is refused with a sentence when the user did not allow it or Chrome does not answer, and the page is not opened elsewhere", async () => {
  const userBefore = await addresses(USER);
  const panelBefore = await titles(PANEL);
  const url = `http://myapp.test:${SITE}/refused`;

  const off = await new Server("off", false).start();
  const notAllowed = await off.call("new_page", { url, userChrome: true });
  expect(notAllowed.isError).toBe(true);
  expect(notAllowed.content[0].text).toContain("has not allowed");

  // allowed, but the Chrome the file points at is not there
  const gone = localAppData("gone", `${freePort()}\n/devtools/browser/none\n`);
  const down = await new Server("down", true, { localAppData: gone }).start();
  const unreachable = await down.call("new_page", { url, userChrome: true });
  expect(unreachable.isError).toBe(true);
  expect(unreachable.content[0].text).toContain("remote debugging");
  down.close();

  expect(await addresses(USER)).toEqual(userBefore);
  expect(await titles(PANEL)).toEqual(panelBefore);

  // with the setting off, a page without userChrome opens as always, in the panel
  expect((await off.call("new_page", { url: `http://myapp.test:${SITE}/off-plain` })).isError).toBeFalsy();
  expect(await titles(PANEL)).toContain("site /off-plain");
  expect(await addresses(USER)).toEqual(userBefore);
  off.close();
}, 90_000);

test("a failed connection to the user's Chrome, denied or never answered, puts the server back in the panel and says how to get out", async () => {
  for (const deny of [true, false]) {
    const fake = fakeChrome(deny);
    const server = await new Server(`failed-${deny}`, true, {
      localAppData: localAppData(`failed-${deny}`, `${fake.server.port}\n/devtools/browser/fake\n`),
      // the question left on screen: the connection gives up after this time, not never
      env: { MANGO_CHROME_PROTOCOL_TIMEOUT: "3000" },
    }).start();
    const failed = await server.call("new_page", { url: `http://myapp.test:${SITE}/mail-${deny}`, userChrome: true });
    expect(failed.isError, text(failed)).toBe(true);
    expect(text(failed)).toContain("connection to the user's Chrome failed");
    expect(text(failed)).toContain("userChrome: true");
    expect(fake.attempts).toBe(1);

    // the next calls work in the panel and do not knock on Chrome again
    expect((await server.call("list_pages")).isError).toBeFalsy();
    expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/after-${deny}` })).isError).toBeFalsy();
    expect(await titles(PANEL)).toContain(`site /after-${deny}`);
    expect(fake.attempts).toBe(1);
    expect(server.log()).toContain("browser: app preview panel");
    server.close();
    fake.server.stop(true);
  }
}, 90_000);

test("the user's Chrome closed while connected, or \"Use my Chrome\" turned off, sends the server back to the panel", async () => {
  // their Chrome closes: the next call says so and the one after works in the panel
  const closing = await chrome(USER_TO_CLOSE);
  const server = await new Server("closed", true, { localAppData: localAppData("closed", closing.active) }).start();
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/closed-mail`, userChrome: true })).isError).toBeFalsy();
  expect(await titles(USER_TO_CLOSE)).toContain("site /closed-mail");
  await quit(closing.child);
  const lost = await server.call("list_pages");
  expect(lost.isError, text(lost)).toBe(true);
  expect(text(lost)).toContain("connection to the user's Chrome failed");
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/closed-after` })).isError).toBeFalsy();
  expect(await titles(PANEL)).toContain("site /closed-after");
  server.close();

  // the user turns the setting off while the agent is in their Chrome: the connection is dropped at the next call
  const switching = await new Server("switch", true).start();
  expect((await switching.call("new_page", { url: `http://myapp.test:${SITE}/switch-mail`, userChrome: true })).isError).toBeFalsy();
  const userBefore = await addresses(USER);
  switching.choose(false);
  const off = await switching.call("list_pages");
  expect(off.isError, text(off)).toBe(true);
  expect(text(off)).toContain('turned off "Use my Chrome"');
  expect(switching.log()).toContain('"Use my Chrome" turned off');
  expect((await switching.call("new_page", { url: `http://myapp.test:${SITE}/switch-after` })).isError).toBeFalsy();
  expect(await titles(PANEL)).toContain("site /switch-after");
  expect(await addresses(USER)).toEqual(userBefore);
  switching.close();
}, 90_000);

test("two new_page sent together, one with userChrome and one without, each go where they asked", async () => {
  const server = await new Server("race", true).start();
  // a call that keeps the server busy for 3 s, as a slow page does: both new_page wait behind it, the userChrome one first
  const slow = server.call("evaluate_script", { pageId: 1, function: "() => new Promise((ok) => setTimeout(ok, 3000))" });
  await Bun.sleep(300);
  const mine = server.call("new_page", { url: `http://myapp.test:${SITE}/race-mail`, userChrome: true });
  await Bun.sleep(500);
  const plain = server.call("new_page", { url: `http://myapp.test:${SITE}/race-plain` });
  for (const answer of await Promise.all([slow, mine, plain])) expect(answer.isError, text(answer)).toBeFalsy();
  expect(await titles(USER)).toContain("site /race-mail");
  expect(await titles(USER)).not.toContain("site /race-plain");
  expect(await titles(PANEL)).toContain("site /race-plain");
  server.close();
}, 90_000);

test("with no panel the agent's pages go to a browser of its own, and come back there after the user's Chrome", async () => {
  // windowless, so nothing shows on screen; site addresses by IP, since that browser does not know myapp.test
  const server = await new Server("own", true, { panel: 0, args: ["--headless"] }).start();
  const newPage = (await server.request("tools/list", {})).result.tools.find((t: any) => t.name === "new_page");
  expect(newPage.description).toContain("own browser if there is no panel");
  const panelBefore = await titles(PANEL);

  const first = await server.call("new_page", { url: `http://127.0.0.1:${SITE}/own-1` });
  expect(first.isError, text(first)).toBeFalsy();
  expect(text(first)).toContain("/own-1");
  expect(server.log()).toContain("browser: mango-code browser, profile EMPTY");

  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/own-mail`, userChrome: true })).isError).toBeFalsy();
  expect(await titles(USER)).toContain("site /own-mail");

  const back = await server.call("new_page", { url: `http://127.0.0.1:${SITE}/own-2` });
  expect(back.isError, text(back)).toBeFalsy();
  expect(text(back)).toContain("/own-2");
  expect(server.log()).toMatch(/browser: mango-code browser, profile EMPTY \(logged out\) \(was user's Chrome/);
  expect(await titles(USER)).not.toContain("site /own-2");
  expect(await titles(PANEL)).toEqual(panelBefore);
  await server.end();
}, 90_000);

test("a panel that stops answering is named in the answer, and a page without userChrome never goes to the user's Chrome instead", async () => {
  const panel = await chrome(PANEL_TO_CLOSE);
  const server = await new Server("dead-panel", true, { panel: PANEL_TO_CLOSE }).start();
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/dead-before` })).isError).toBeFalsy();
  expect(await titles(PANEL_TO_CLOSE)).toContain("site /dead-before");
  await quit(panel.child);

  const gone = await server.call("new_page", { url: `http://myapp.test:${SITE}/dead-after` });
  expect(gone.isError, text(gone)).toBe(true);
  expect(text(gone)).toContain("Tell the user the panel is not available");

  // in the user's Chrome on request, then a plain page: refused with the same sentence, not opened there
  expect((await server.call("new_page", { url: `http://myapp.test:${SITE}/dead-mail`, userChrome: true })).isError).toBeFalsy();
  const userBefore = await addresses(USER);
  const plain = await server.call("new_page", { url: `http://myapp.test:${SITE}/dead-plain` });
  expect(plain.isError, text(plain)).toBe(true);
  expect(text(plain)).toContain("Tell the user the panel is not available");
  expect(await addresses(USER)).toEqual(userBefore);
  server.close();
}, 90_000);

test("the agent reads about userChrome in the definition of new_page", async () => {
  const server = await new Server("tools", false).start();
  const listed = await server.request("tools/list", {});
  const newPage = listed.result.tools.find((t: any) => t.name === "new_page");
  expect(newPage.description).toContain("panel");
  expect(newPage.inputSchema.properties.userChrome.type).toBe("boolean");
  expect(newPage.inputSchema.properties.userChrome.description).toContain("sign-ins");
  expect(newPage.inputSchema.required).not.toContain("userChrome");
  server.close();
}, 60_000);

test("a file path with no folder before it is inside the project, not where the server runs", async () => {
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "mail"), { recursive: true });
  const server = await new Server("relative", false, { project }).start();

  // a small model writes the path the skill shows, `mail\last-run.json`, and does not know the project's full path
  const saved = await server.call("evaluate_script", { pageId: 1, function: "() => ({ rows: 3 })", filePath: "mail\\last-run.json" });
  expect(saved.isError, JSON.stringify(saved)).toBeFalsy();
  expect(JSON.parse(fs.readFileSync(path.join(project, "mail", "last-run.json"), "utf8"))).toEqual({ rows: 3 });

  // a path that climbs out of the project and of the temp folder (always allowed) is still refused
  const outside = path.join(os.tmpdir(), "..", `mango-outside-${process.pid}.json`);
  const refused = await server.call("evaluate_script", { pageId: 1, function: "() => 1", filePath: path.relative(project, outside) });
  const written = fs.existsSync(outside);
  fs.rmSync(outside, { force: true });
  expect(refused.isError).toBe(true);
  expect(written).toBe(false);
  server.close();
}, 90_000);

test("a client that stops reading does not freeze the server: its loop keeps working while the writer thread waits on the full pipe", async () => {
  const server = new Server("flood", false, { reading: false });
  // nothing reads the server's stdout from the start: the first big answer fills the pipe, the next ones queue behind it
  const size = 2_000_000;
  const answers = [server.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 120_000)];
  for (let i = 0; i < 8; i++) {
    answers.push(server.request("tools/call", { name: "evaluate_script", arguments: { pageId: 1, function: `() => "x".repeat(${size})` } }, 120_000));
  }

  // all eight calls are answered by the server (traced when the answer is handed to the writer) with nobody reading
  for (let i = 0; i < 300 && (server.log().match(/<- evaluate_script/g) ?? []).length < 8; i++) await Bun.sleep(200);
  expect(server.log().match(/<- evaluate_script/g) ?? []).toHaveLength(8);
  expect(server.bytes).toBe(0);
  // Worker, SharedArrayBuffer and the replaced process.stdout.write all work under this runtime: the protection is on
  expect(server.log()).toContain("stdout on a dedicated thread, watchdog active");
  expect(server.log()).not.toContain("NOT active");
  expect(server.log()).not.toContain("FROZEN");

  // the client comes back: every answer arrives whole
  server.listen();
  const received = await Promise.all(answers);
  for (const answer of received.slice(1)) {
    expect(answer.result?.isError, JSON.stringify(answer).slice(0, 300)).toBeFalsy();
    expect(JSON.stringify(answer).length).toBeGreaterThan(size);
  }
  server.close();
}, 180_000);

test("the guard ends a server whose main loop is really stuck", async () => {
  // The server's own wiring (heartbeat every second, the guard in a worker), with the loop blocked by hand after 3 s.
  const trace = path.join(root, "freeze.log");
  const script = path.join(root, "freeze.mjs");
  fs.writeFileSync(
    script,
    `import { Worker } from "node:worker_threads";
const heartbeat = new Int32Array(new SharedArrayBuffer(4));
const state = new Int32Array(new SharedArrayBuffer(8));
new Worker(${JSON.stringify(path.join(REPO, "launcher", "mango-mcp-watchdog.cjs"))}, { workerData: { alive: heartbeat.buffer, state: state.buffer, trace: ${JSON.stringify(trace)}, limit: 2000 } }).unref();
setInterval(() => Atomics.add(heartbeat, 0, 1), 200).unref();
setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000), 3000);
`,
  );
  const child = spawn(RUNTIME_EXE, [script], { env: { ...process.env, BUN_BE_BUN: "1" }, stdio: "ignore", windowsHide: true });
  const started = Date.now();
  const exited = await new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  const lasted = Date.now() - started;

  // it lived while the heartbeat ran (3 s) and was killed soon after the limit (2 s), not after the 60 s of the block
  expect(lasted).toBeGreaterThan(3500);
  expect(lasted).toBeLessThan(15_000);
  expect(exited).not.toBe(0);
  expect(fs.readFileSync(trace, "utf8")).toContain("MAIN LOOP FROZEN");
}, 60_000);
