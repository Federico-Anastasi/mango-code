// mango-chrome-mcp.mjs - chrome-devtools-mcp, but attached to the RIGHT browser.
//
// THE PROBLEM. Google's MCP server, launched as is, opens a Chrome of its own: with --headless you
// can't see it, with --isolated the profile is thrown away at the end of the session. Fine for the
// public web, blind to anything behind a login - which is half of the useful web. We need to drive
// the REAL browser, with the sessions already open.
//
// WHAT THIS FILE DOES. It launches nothing new: it decides WHICH Chrome to attach to and then loads Google's MCP
// server with the right flags. Every page the agent opens goes to the same place, the first that is there:
//
//   1. THE PREVIEW PANEL of the desktop app: a webview inside the window, next to the chat.
//      Its own profile, no banner, no Chrome needed. It is the agent's browser.
//
//   2. Fallback, when there is no panel: a browser of its own, started now with an empty profile (no logins).
//
// The user's own Chrome (their profile, their logins) is the exception, and the agent has to ask for it on purpose:
// `new_page` with `userChrome: true`, when the user turned on "Use my Chrome" in the app settings and Chrome has remote
// debugging on (turned on by hand in chrome://inspect; Chrome shows a banner at every connection). The page is
// always a NEW tab there, and `navigate_page` with an address only works on a tab the agent opened itself in this
// session: it never sends a tab of the user's to an address (see `route` and `prepare`). When the connection to that Chrome
// fails, or the user turns "Use my Chrome" off, the server goes back to the agent's browser.
//
// WHY A WRAPPER AND NOT FLAGS IN THE CONFIG. The flags are static, the choice is not: it depends on
// what is running at that moment. And the MCP server with --browserUrl on a dead port doesn't fall
// back, it dies - so the port must be checked BEFORE, not hoped for.
//
// NB: the main of chrome-devtools-mcp is loaded in the SAME process (parseArguments reads
// process.argv). No spawn: one process less, and no cmd.exe in between (see _why_node_not_npx in
// opencode.template.json).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(SELF, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp-main.js");
// MANGO_RUNTIME: writable folder for the profile and the logs. The desktop app sets it, because it
// installs the scripts in a program folder; without it, the runtime\ next to the script.
const RUNTIME = process.env.MANGO_RUNTIME || path.join(SELF, "runtime");
const PROFILE = path.join(RUNTIME, "chrome-profile");
const TRACE = path.join(RUNTIME, "mcp-chrome.log");
const ERRLOG = path.join(RUNTIME, "mcp-chrome.err.log");

// --- STDERR OFF THE PIPE ---------------------------------------------------------------------
// On Windows stderr too, when it is a pipe, is BLOCKING: if the client doesn't drain it, the first
// write that fills the buffer freezes the loop exactly like stdout. It is the only one of the two
// pipes we can do without - the protocol doesn't go through it - so the simplest defence is not to
// use it at all: everything goes to a file. This must be done HERE, before any other line of code
// that could write.
fs.mkdirSync(path.dirname(ERRLOG), { recursive: true });
process.stderr.write = (chunk, enc, cb) => {
  try { fs.appendFileSync(ERRLOG, typeof chunk === "string" ? chunk : Buffer.from(chunk)); } catch {}
  if (typeof enc === "function") enc(); else if (typeof cb === "function") cb();
  return true;
};

// Zero cloud, like the rest of mango-code: no Google telemetry, no network round trip for the
// update check at every server start.
process.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = "1";
process.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1";

// "Answers something" is the right test, not "answers 200". Debugging turned on from
// chrome://inspect exposes ONLY the WebSocket: /json/version returns 404 there. A 404 still means
// Chrome is on the other side; it is the lack of a connection that says nobody is there.
async function alive(port) {
  try {
    await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

// The HTTP /json routes exist only if Chrome was started with --remote-debugging-port.
async function hasHttpJson(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Chrome writes TWO lines in DevToolsActivePort when remote debugging is on: the port and the
// PATH of the browser WebSocket. Both are needed: when started from chrome://inspect, Chrome does
// NOT publish the HTTP /json routes (404), so the only possible hook is ws://host:port<path>.
function realTarget() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const f = path.join(base, "Google", "Chrome", "User Data", "DevToolsActivePort");
  try {
    const rows = fs.readFileSync(f, "utf8").split("\n");
    const port = Number(String(rows[0]).trim());
    const wsPath = String(rows[1] || "").trim();
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, wsPath };
  } catch {
    return null;
  }
}

// A browser to attach to is { browserUrl } or { wsEndpoint }; without either, the one of our own (a profile, no logins).
const flagsOf = (s) =>
  s.browserUrl ? ["--browserUrl", s.browserUrl] : s.wsEndpoint ? ["--wsEndpoint", s.wsEndpoint] : ["--userDataDir", PROFILE, "--viewport", "1280x800"];

// THE PREVIEW PANEL. In the desktop app the agent's browser is a webview inside the window (the
// preview panel): the user watches the work live, Chrome doesn't need to be installed and there is
// no banner. The app turns on remote debugging on a random port and announces it here: 0 or
// missing = no panel, and the usual cascade applies.
function panelPort() {
  const p = Number(process.env.MANGO_PANEL_CDP || 0);
  return Number.isInteger(p) && p > 0 ? p : 0;
}

// "Use my Chrome": the user's choice, in a file re-read at every server start (so changing it
// doesn't require restarting the agent).
function myChrome() {
  const f = process.env.MANGO_BROWSER_CHOICE;
  if (!f) return false;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")).myChrome === true;
  } catch {
    return false;
  }
}

// Does the browser on this port show Mango Code's own window (the app page or the web UI)? Then it is not the
// panel: a navigation there would replace the app with the page. It happened with remote debugging turned on for
// the whole app process, which gives every WebView2 of the app the same port.
async function showsMangoCode(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1500) });
    const pages = res.ok ? await res.json() : [];
    return pages.some(
      (p) =>
        p.type === "page" &&
        (/^https?:\/\/tauri\.localhost\//.test(p.url) || (p.title === "Mango Code" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(p.url))),
    );
  } catch {
    return false;
  }
}

// Where a page without userChrome goes, in the sentences the agent reads.
const AGENTS_BROWSER = "the app's panel (or the agent's own browser if there is no panel)";

// The user's Chrome, when "Use my Chrome" is on and its remote debugging answers. Otherwise `{ refusal }`: the sentence the
// agent gets back, which says what to do instead of silently opening the page somewhere else.
async function usersChrome() {
  if (!myChrome()) {
    return {
      refusal:
        'The user has not allowed the use of their Chrome ("Use my Chrome" in the settings, "Usa il mio Chrome" in Italian). Open the page without userChrome: it opens in ' +
        AGENTS_BROWSER +
        ". If the page needs the user's sign-ins, tell the user to turn that setting on.",
    };
  }
  const real = realTarget();
  if (real && (await alive(real.port))) {
    if (await hasHttpJson(real.port)) {
      return { browserUrl: "http://127.0.0.1:" + real.port, mode: "user's Chrome via HTTP (port " + real.port + ")", users: true };
    }
    if (real.wsPath) {
      return { wsEndpoint: "ws://127.0.0.1:" + real.port + real.wsPath, mode: "user's Chrome via WebSocket (port " + real.port + ")", users: true };
    }
  }
  return {
    refusal:
      "The user's Chrome does not answer: it is closed or its remote debugging is off. Tell the user to open Chrome and turn on remote debugging (chrome://inspect, \"Allow remote debugging\"), or open the page without userChrome, in " +
      AGENTS_BROWSER +
      ".",
  };
}

// The app's preview panel: it is the agent's browser.
async function thePanel() {
  const panel = panelPort();
  if (!panel || !(await alive(panel))) return null;
  if (await showsMangoCode(panel)) {
    process.stderr.write("mango-chrome-mcp | port " + panel + " shows Mango Code's own window, not the panel: not used\n");
    return null;
  }
  return { browserUrl: "http://127.0.0.1:" + panel, mode: "app preview panel (port " + panel + ")" };
}

const OWN_BROWSER = { mode: "mango-code browser, profile EMPTY (logged out)" };

// Where the agent's pages go: the panel, or a browser of its own when there is none.
async function agentsBrowser() {
  return (await thePanel()) ?? OWN_BROWSER;
}

// --- THE TIMEOUT THAT MUST LOSE FIRST --------------------------------------------------------
// chrome-devtools-mcp serializes EVERY tool on a global mutex, and puppeteer waits for a CDP answer up to
// protocolTimeout (180 s by default, no flag exposes it). The client gives the MCP 30 s. If the client gave up
// first, a hung call would keep the mutex and every later call would queue behind it and time out in turn. So the
// server must give up BEFORE the client: 20 s, above any healthy operation (a screenshot takes 130 ms, a navigate
// 3.9 s) and below the client's 30 s. Keep the two numbers in this order. Change it with MANGO_CHROME_PROTOCOL_TIMEOUT.
const PROTOCOL_TIMEOUT = Number(process.env.MANGO_CHROME_PROTOCOL_TIMEOUT || 20000);
const TP = path.join(SELF, "node_modules", "chrome-devtools-mcp", "build", "src", "third_party", "index.js");
try {
  // browser.js imports `puppeteer` from THIS module: it is the same object, so patching the two
  // methods here is enough. Our value doesn't override an explicit one, if they ever set one: the
  // caller's options win.
  const tp = await import(pathToFileURL(TP).href);
  for (const m of ["connect", "launch"]) {
    const orig = tp.puppeteer[m].bind(tp.puppeteer);
    tp.puppeteer[m] = (opts = {}) => orig({ protocolTimeout: PROTOCOL_TIMEOUT, ...opts });
  }
  // A CONNECTION THAT NEVER OPENS. The WebSocket handshake has no time limit of its own: a Chrome that holds it (its
  // "Allow remote debugging?" left unanswered, a port that accepts and never replies) would keep the call, and every call
  // queued behind it, waiting forever. It gives up after the same time; a connection that opens later is dropped at once.
  const connect = tp.puppeteer.connect;
  tp.puppeteer.connect = (opts) => {
    const opening = connect(opts);
    let timer;
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error("the connection did not open in " + PROTOCOL_TIMEOUT + " ms")), PROTOCOL_TIMEOUT);
    });
    return Promise.race([opening, late])
      .finally(() => clearTimeout(timer))
      .catch((e) => {
        opening.then((b) => b.disconnect()).catch(() => {});
        throw e;
      });
  };
  // THE PANEL IS A SINGLE SURFACE. WebView2 has no tabs: every Target.createTarget the MCP server
  // asks for (the new_page tool) becomes a WINDOW of its own, outside the app window, and the
  // panel stays empty while the user looks at an external browser that has nothing to do with it.
  // When attached to the panel, new_page reuses its page: navigation ends up where the user sees
  // it. Attached to anything else (the user's Chrome: a page of theirs would be replaced) the original behaviour applies.
  if (panelPort() > 0) {
    const origConnect = tp.puppeteer.connect;
    tp.puppeteer.connect = async (opts = {}) => {
      const browser = await origConnect(opts);
      if (opts.browserURL !== "http://127.0.0.1:" + panelPort()) return browser;
      const origNewPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const pages = await browser.pages();
        if (pages.length) return pages[0];
        return origNewPage();
      };
      return browser;
    };
  }
  process.stderr.write("mango-chrome-mcp | protocolTimeout " + PROTOCOL_TIMEOUT + " ms\n");
} catch (e) {
  process.stderr.write("mango-chrome-mcp | protocolTimeout NOT applied: " + e.message + "\n");
}

// Cut at the SOURCE, before opencode even sees them: performance (lighthouse aside), traces and
// device emulation. With a local model the cost isn't "the tool is useless", it is that its definition
// is paid in prefill at EVERY turn - and these two categories alone are worth almost 5000
// characters of schema for things that are never used here.
const CUT = ["--no-category-performance", "--no-category-emulation"];

// VISION. --experimentalVision adds ONE tool, click_at(x,y): the model clicks by looking at a screenshot instead of
// reading the accessibility tree (~8k tokens on a busy page, against 1-2k for the same screen as an image). It sits
// beside the tree, which stays the precise way to click. No --screenshotMaxWidth: resizing the image while click_at
// reasons in coordinates makes the model click off target.
const VISION = ["--experimentalVision", "--screenshotFormat", "jpeg", "--screenshotQuality", "80"];

let current = await agentsBrowser();
// A browser of its own can be returned to only if the server started with it: its profile and window size are among the flags.
const startedOwn = current === OWN_BROWSER;
const START = current;
let mode = current.mode;
const flags = [...flagsOf(current), ...CUT, ...VISION];
// Never on stdout: the MCP protocol goes there and one extra byte breaks it. And since 2026-08-26
// not on the stderr pipe either - see the redirection at the top: it ends up in mcp-chrome.err.log.
process.stderr.write("mango-chrome-mcp | " + mode + "\n");

// Every tool writes a line in runtime\mcp-chrome.log: when it starts, how long it took, and
// whether it ended badly. That way "it hung" stops being an impression and becomes the name of a
// method with a number next to it. It costs one file append per call.
const SLOW_MS = Number(process.env.MANGO_CHROME_SLOW_MS || 15000);
function trace(line) {
  try {
    fs.mkdirSync(path.dirname(TRACE), { recursive: true });
    // The pid is there because it wasn't: the lines of several servers ended up in the file
    // together (the real session and my tests) and it wasn't clear which process did what.
    fs.appendFileSync(TRACE, new Date().toISOString() + " [" + process.pid + "] " + line + "\n");
  } catch {}
}
// Which browser this server drives: without it, "the page doesn't show in the panel" can't be traced to anyone.
trace("browser: " + mode);

// --- STDOUT ON A THREAD OF ITS OWN -----------------------------------------------------------
// On Windows process.stdout connected to a PIPE is BLOCKING: when the client stops draining it, the next write never
// returns and the whole event loop freezes (no stdin reads, no timers, no replies) while the process stays alive at
// 0% CPU. setBlocking(false) does not help. The cure: fd 1 moves to a worker thread (mango-mcp-stdout.cjs), which
// blocks instead of the loop, and a guard on a third thread (mango-mcp-watchdog.cjs) kills the process if the main
// loop really stops, so the client sees EOF instead of silently collecting timeouts.
{
  const sdk = path.join(SELF, "node_modules", "chrome-devtools-mcp", "build", "src", "third_party", "index.js");
  try {
    const { StdioServerTransport } = await import(pathToFileURL(sdk).href);
    const { Worker } = await import("node:worker_threads");
    const proto = StdioServerTransport.prototype;

    // Shared memory: it is the only channel that holds when the main loop is stopped.
    // heartbeat[0] = life counter of the main thread
    // state[0]     = 1 while the writer is inside a writeSync, state[1] = when it started it
    const heartbeat = new Int32Array(new SharedArrayBuffer(4));
    const state = new Int32Array(new SharedArrayBuffer(8));

    const writer = new Worker(path.join(SELF, "mango-mcp-stdout.cjs"), { workerData: { state: state.buffer } });
    writer.unref();
    const watchdog = new Worker(path.join(SELF, "mango-mcp-watchdog.cjs"), {
      workerData: {
        alive: heartbeat.buffer,
        state: state.buffer,
        trace: TRACE,
        // 45 s: above any healthy synchronous pause (the longest measured is the serialization of
        // a screenshot, milliseconds) and below anyone's patience.
        limit: Number(process.env.MANGO_CHROME_FREEZE_MS || 45000),
      },
    });
    watchdog.unref();

    // If the writer dies, the protocol has no way out anymore: better to finish right away.
    writer.on("error", (e) => { trace("stdout writer died: " + e.message + " - the server exits"); process.exit(1); });
    writer.on("exit", (c) => { if (c !== 0) { trace("stdout writer exited with " + c + " - the server exits"); process.exit(1); } });

    // Ack from the writer: resolves the send() calls in start order (the queue is FIFO on both sides).
    const waiting = [];
    writer.on("message", () => { waiting.shift()?.(); });

    // EVERYTHING that goes to fd 1 passes through here: the protocol and any stray write.
    // A single queue, so the byte order stays the same.
    function toClient(text) {
      return new Promise((resolve) => {
        waiting.push(resolve);
        writer.postMessage(Buffer.from(text, "utf8"));
      });
    }
    process.stdout.write = (chunk, enc, cb) => {
      void toClient(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (typeof enc === "function") enc(); else if (typeof cb === "function") cb();
      return true;
    };

    // The main thread says it is alive. unref: it is not what keeps the process up.
    setInterval(() => { Atomics.add(heartbeat, 0, 1); }, 1000).unref();

    // The client leaves -> stdin goes to EOF. Without this the server would stay there forever
    // talking to nobody: that is how orphan node.exe processes pile up.
    process.stdin.on("end", () => { trace("stdin closed by the client: the server exits"); process.exit(0); });

    // --- THE TRACE: every tool call is timed at the transport, the only point every request goes through (also those
    // queued on chrome-devtools-mcp's mutex), and written to runtime\mcp-chrome.log with the pid.
    const inFlight = new Map();
    Object.defineProperty(proto, "onmessage", {
      configurable: true,
      get() { return this.__mangoOnMessage; },
      set(fn) {
        this.__mangoOnMessage = (msg) => {
          if (proto.__mangoTouch) proto.__mangoTouch();
          if (msg && msg.method === "tools/call" && msg.id !== undefined) {
            inFlight.set(msg.id, { t: Date.now(), name: msg.params?.name || "?" });
            trace("-> " + (msg.params?.name || "?") + " id=" + msg.id + " queued=" + (inFlight.size - 1));
          }
          return fn(msg);
        };
      },
    });
    proto.send = function (msg) {
      const v = msg && msg.id !== undefined ? inFlight.get(msg.id) : null;
      if (v) {
        inFlight.delete(msg.id);
        const ms = Date.now() - v.t;
        const outcome = msg.error ? "ERROR " + msg.error.message : (msg.result?.isError ? "isError" : "ok");
        trace("<- " + v.name + " id=" + msg.id + " " + ms + "ms " + outcome + (ms >= SLOW_MS ? "  *** SLOW ***" : ""));
      }
      // The original send is no longer used: it wrote to process.stdout from the main thread,
      // which is exactly the gesture that froze everything.
      if (waiting.length >= 64) trace("WARNING: " + waiting.length + " answers not written yet, the client is reading slowly");
      return toClient(JSON.stringify(msg) + "\n");
    };
    trace("=== start: " + mode + " | protocolTimeout " + PROTOCOL_TIMEOUT + "ms | stdout on a dedicated thread, watchdog active ===");

    // THE HEARTBEAT: one line a minute after 60 s without requests, checked every 15 s. It means the server runs and the
    // client sends nothing; a frozen loop is seen by the watchdog from outside.
    let lastActivity = Date.now();
    let lastBeat = 0;
    proto.__mangoTouch = () => { lastActivity = Date.now(); };
    const beat = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= 60000 && Date.now() - lastBeat >= 60000) {
        lastBeat = Date.now();
        trace("heartbeat: alive, no request for " + Math.round(idle / 1000) + "s");
      }
    }, 15000);
    beat.unref();   // doesn't keep the process up by itself
  } catch (e) {
    process.stderr.write("mango-chrome-mcp | trace not active: " + e.message + "\n");
    trace("trace NOT active: " + e.message + " - stdout stays on the main thread (freeze risk)");
  }
}

// --- THE USER'S CHROME ONLY ON REQUEST -----------------------------------------------------------------
// The server holds a single browser connection. Every `new_page` says where its page goes: the panel (or the browser of its
// own), or, with `userChrome: true`, a new tab in the user's Chrome. Switching closes the connection (the user's Chrome is
// only disconnected, never closed) and points the server's arguments at the other browser: the next call connects there.
// The tool calls run one at a time, and the choice of the browser runs inside the same turn as the call it is for: two
// `new_page` sent together can never land in the browser chosen for the other one.
// The server leaves the user's Chrome for the agent's browser when a call cannot connect to it (Chrome closed, its "Allow
// remote debugging?" denied or left unanswered) and when the user turns "Use my Chrome" off: re-read at every call.
// In the user's Chrome the agent never takes over a tab of the user's: `navigate_page` with an address works only on the
// tabs this server opened there (`agentTabs`).
{
  const MAIN_URL = pathToFileURL(MAIN).href;
  const sources = path.join(SELF, "node_modules", "chrome-devtools-mcp", "build", "src");
  const { ToolHandler } = await import(pathToFileURL(path.join(sources, "ToolHandler.js")).href);
  const { McpContext } = await import(pathToFileURL(path.join(sources, "McpContext.js")).href);
  const { closeBrowser } = await import(pathToFileURL(path.join(sources, "browser.js")).href);
  const { McpServer, Mutex, zod } = await import(pathToFileURL(TP).href);

  const PANEL_GONE = "The app's panel does not answer, so no page can be opened or used there. Tell the user the panel is not available.";
  const CHROME_LOST =
    "The connection to the user's Chrome failed: Chrome was closed, or its \"Allow remote debugging?\" request was denied or not answered. The user's tabs cannot be reached any more; pages now open in " +
    AGENTS_BROWSER +
    ". To use their Chrome again, ask the user to open it and accept the request, then open the page with new_page and userChrome: true.";
  const TURNED_OFF =
    'The user turned off "Use my Chrome": the connection to their Chrome is closed and its tabs cannot be used any more. Pages now open in ' +
    AGENTS_BROWSER +
    ": open the page there with new_page, or call list_pages.";

  // `new_page` is the only tool that gets a parameter of ours, added to the schema the model sees.
  const registerTool = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (name, config, callback) {
    if (name !== "new_page") return registerTool.call(this, name, config, callback);
    const withUserChrome = {
      ...config,
      description: config.description + " The page opens in " + AGENTS_BROWSER + ".",
      inputSchema: config.inputSchema.extend({
        userChrome: zod
          .boolean()
          .optional()
          .describe(
            "true opens the page as a new tab in the user's own Chrome, only when it needs their sign-ins (their mail, an account). Leave it out otherwise.",
          ),
      }),
    };
    return registerTool.call(this, name, withUserChrome, callback);
  };

  // The tabs this server opened in the user's Chrome. Puppeteer's target id is the same for a tab across reconnections
  // (the connection is dropped every time the agent goes to the panel and back), the page object is not.
  const agentTabs = new Set();
  const tabId = (page) => page.target()._targetId;
  const newPage = McpContext.prototype.newPage;
  McpContext.prototype.newPage = async function (...rest) {
    const page = await newPage.apply(this, rest);
    if (current.users) agentTabs.add(tabId(page.pptrPage));
    return page;
  };

  const serial = new Mutex();
  // Set when the call could not get a browser: the connection, not the tool, failed.
  let connectFailed = false;

  const handle = ToolHandler.prototype.handle;
  ToolHandler.prototype.handle = async function (params) {
    prepare(this);
    const guard = await serial.acquire();
    try {
      const turnedOff = current.users && !myChrome();
      if (turnedOff) await switchTo(await agentsPlace(), '"Use my Chrome" turned off');
      if (turnedOff && this.tool.name !== "new_page") return refuse(TURNED_OFF);
      if (this.tool.name === "new_page") {
        // our parameter, not the tool's: the tool rejects what is not in its own schema
        const wantsUserChrome = params.userChrome === true;
        delete params.userChrome;
        const refusal = await route(wantsUserChrome, params.url);
        if (refusal) return refuse(refusal);
      }
      connectFailed = false;
      const result = await handle.call(this, params);
      if (!connectFailed) return result;
      trace("no connection to " + current.mode + ": " + result.content.map((c) => c.text).join(" ").slice(0, 300));
      if (current.users) {
        await switchTo(await agentsPlace(), "the user's Chrome could not be reached");
        return refuse(CHROME_LOST);
      }
      // the panel; the browser of its own failing to start keeps the tool's own answer
      return current.browserUrl ? refuse(PANEL_GONE) : result;
    } finally {
      guard[Symbol.dispose]();
    }
  };

  // Returns the refusal (a sentence for the agent) when the page cannot go where it was asked.
  async function route(wantsUserChrome, address) {
    const wanted = wantsUserChrome ? await usersChrome() : await agentsPlace();
    if (wanted.refusal) return wanted.refusal;
    if (wanted.mode !== current.mode) await switchTo(wanted, "for " + address.slice(0, 80));
  }

  // Where the agent's own pages go: the panel, or the browser of its own if the server started with it. With no panel
  // answering and no browser of its own, still the panel: the call that tries it says the panel is not available.
  async function agentsPlace() {
    const browser = await agentsBrowser();
    return browser === OWN_BROWSER && !startedOwn ? START : browser;
  }

  async function switchTo(wanted, why) {
    const { args } = await import(MAIN_URL);
    await closeBrowser();
    args.browserUrl = wanted.browserUrl;
    args.wsEndpoint = wanted.wsEndpoint;
    trace("browser: " + wanted.mode + " (was " + current.mode + ") " + why);
    current = wanted;
  }

  function refuse(text) {
    return { content: [{ type: "text", text }], isError: true };
  }

  // Once per tool: the connection watch on its context, and the guard on `navigate_page`.
  const prepared = new WeakSet();
  function prepare(handler) {
    if (prepared.has(handler)) return;
    prepared.add(handler);
    const getContext = handler.getContext;
    handler.getContext = () =>
      getContext().catch((e) => {
        connectFailed = true;
        throw e;
      });
    if (handler.tool.name !== "navigate_page") return;
    const run = handler.tool.handler;
    handler.tool.handler = async (request, response, context) => {
      // with an address and no type the tool navigates to the address
      const toAddress = request.params.type === "url" || (!request.params.type && request.params.url);
      if (current.users && toAddress && !agentTabs.has(tabId(request.page.pptrPage))) {
        throw new Error(
          "This is one of the user's own tabs: it cannot be taken over. Open the address in a new tab with new_page and userChrome: true, or in " +
            AGENTS_BROWSER +
            " with new_page.",
        );
      }
      return run(request, response, context);
    };
  }
}

// --- A PATH WITH NO FOLDER BEFORE IT IS INSIDE THE PROJECT -----------------------------------------
// The server runs in Mango Code's own folder, so a relative path (`mail\last-run.json`) would point there and be refused
// as outside the project. A small model writes the path its instructions show and does not know the project's full
// path: the relative one is taken from the project folder, the first of the folders the agent declares (`roots`; the
// last is always the temp folder, alone when the client declares none). The check that the path stays inside comes after.
{
  const { McpContext } = await import(pathToFileURL(path.join(SELF, "node_modules", "chrome-devtools-mcp", "build", "src", "McpContext.js")).href);
  const validatePath = McpContext.prototype.validatePath;
  McpContext.prototype.validatePath = function (filePath) {
    const roots = this.roots();
    const relative = typeof filePath === "string" && !path.isAbsolute(filePath) && roots.length > 1;
    return validatePath.call(this, relative ? path.join(fileURLToPath(roots[0].uri), filePath) : filePath);
  };
}

// Arguments after "--" in the config (if ever needed) pass through untouched.
const extra = process.argv.slice(2);
process.argv = [process.argv[0], MAIN, ...flags, ...extra];

// Dynamic import() on Windows wants a file:// URL, not a "C:..." path.
await import(pathToFileURL(MAIN).href);
