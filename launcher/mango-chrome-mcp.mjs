// mango-chrome-mcp.mjs - chrome-devtools-mcp, but attached to the RIGHT browser.
//
// THE PROBLEM. Google's MCP server, launched as is, opens a Chrome of its own: with --headless you
// can't see it, with --isolated the profile is thrown away at the end of the session. Fine for the
// public web, blind to anything behind a login - which is half of the useful web. We need to drive
// the REAL browser, with the sessions already open.
//
// WHAT THIS FILE DOES. It launches nothing new: it decides WHICH Chrome to attach to, in a
// cascade, and then loads Google's MCP server with the right flags. The levels, best first:
//
//   0. "Use my Chrome", if the user chose it in the app settings: their profile, their logins.
//      It needs remote debugging turned on by hand (chrome://inspect), and Chrome shows a banner
//      at every connection.
//
//   1. THE PREVIEW PANEL of the desktop app: a webview inside the window, next to the chat.
//      Its own profile, no banner, no Chrome needed. It is the agent's default browser.
//
//   2. Fallback, when neither is there: a browser of its own, started now with an empty profile (no logins).
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

const MINE = () => ({
  flags: ["--userDataDir", PROFILE, "--viewport", "1280x800"],
  mode: "mango-code browser, profile EMPTY (logged out)",
});

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

async function decide() {
  // 0. "Use my Chrome": the user's explicit choice beats the panel. If Chrome's remote debugging
  //    no longer answers (Chrome restarted without it), fall back to the panel: a browser is
  //    better than none.
  if (myChrome()) {
    const real = realTarget();
    if (real && (await alive(real.port))) {
      if (await hasHttpJson(real.port)) {
        return { flags: ["--browserUrl", "http://127.0.0.1:" + real.port], mode: "user's Chrome via HTTP (port " + real.port + ")" };
      }
      if (real.wsPath) {
        return {
          flags: ["--wsEndpoint", "ws://127.0.0.1:" + real.port + real.wsPath],
          mode: "user's Chrome via WebSocket (port " + real.port + ")",
        };
      }
    }
    process.stderr.write("mango-chrome-mcp | \"Use my Chrome\" is on but remote debugging doesn't answer: using the panel\n");
  }

  // 1. the app's preview panel: it is the agent's browser.
  const panel = panelPort();
  if (panel && (await alive(panel))) {
    if (!(await showsMangoCode(panel))) {
      return { flags: ["--browserUrl", "http://127.0.0.1:" + panel], mode: "app preview panel (port " + panel + ")" };
    }
    process.stderr.write("mango-chrome-mcp | port " + panel + " shows Mango Code's own window, not the panel: not used\n");
  }

  // 2. fallback.
  fs.mkdirSync(PROFILE, { recursive: true });
  return MINE();
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
  // THE PANEL IS A SINGLE SURFACE. WebView2 has no tabs: every Target.createTarget the MCP server
  // asks for (the new_page tool) becomes a WINDOW of its own, outside the app window, and the
  // panel stays empty while the user looks at an external browser that has nothing to do with it.
  // When attached to the panel, new_page reuses its page: navigation ends up where the user sees
  // it. Without a panel the original behaviour applies.
  if (Number(process.env.MANGO_PANEL_CDP || 0) > 0) {
    const origConnect = tp.puppeteer.connect;
    tp.puppeteer.connect = async (opts = {}) => {
      const browser = await origConnect(opts);
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

const { flags: picked, mode } = await decide();
const flags = [...picked, ...CUT, ...VISION];
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

// Arguments after "--" in the config (if ever needed) pass through untouched.
const extra = process.argv.slice(2);
process.argv = [process.argv[0], MAIN, ...flags, ...extra];

// Dynamic import() on Windows wants a file:// URL, not a "C:..." path.
await import(pathToFileURL(MAIN).href);
