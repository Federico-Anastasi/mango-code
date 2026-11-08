// mango-mcp-watchdog.cjs - the only place from which a stuck main loop can be SEEN.
//
// A heartbeat in the main thread is useless for this bug: if the loop is frozen, the heartbeat is
// frozen with it, and the log goes quiet exactly as if the process had died. On 2026-08-26 this
// ambiguity cost two wrong diagnoses.
//
// So we watch from outside: the main thread increments a counter in shared memory once a second,
// this thread reads it. If it stops growing, the loop is blocked in a syscall - and since Node
// cannot cancel anything, it will not recover. Better to die at once and loudly: the client sees
// EOF and says so, instead of collecting timeouts for an hour.
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");

// The workerData keys (alive, state, limit, trace) are set by mango-chrome-mcp.mjs.
const alive = new Int32Array(workerData.alive);
const state = new Int32Array(workerData.state);
const TRACE = workerData.trace;
const LIMIT = workerData.limit;

function trace(line) {
  try { fs.appendFileSync(TRACE, new Date().toISOString() + " [" + process.pid + "] " + line + "\n"); } catch {}
}

let last = Atomics.load(alive, 0);
let since = Date.now();

setInterval(() => {
  const v = Atomics.load(alive, 0);
  if (v !== last) { last = v; since = Date.now(); return; }
  const stuck = Date.now() - since;
  if (stuck < LIMIT) return;
  // If we are stuck INSIDE a writeSync, the culprit has a name and must be logged.
  const inWrite = Atomics.load(state, 0) === 1
    ? " (blocked writing to stdout for " + (Math.floor(Date.now() / 1000) - Atomics.load(state, 1)) + "s: the client is not draining the pipe)"
    : "";
  trace("*** MAIN LOOP FROZEN for " + Math.round(stuck / 1000) + "s" + inWrite + " - the server kills itself, the client will see EOF ***");
  process.kill(process.pid, "SIGKILL");
}, 2000);
