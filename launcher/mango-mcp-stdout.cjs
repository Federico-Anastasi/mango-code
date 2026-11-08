// mango-mcp-stdout.cjs - the thread that owns fd 1, and that blocks INSTEAD OF the loop.
//
// WHY IT EXISTS. On Windows, process.stdout connected to a PIPE is BLOCKING (documented by
// Node: "Pipes: synchronous on Windows and Linux"). If the client stops draining the pipe, the
// NEXT write freezes the WHOLE event loop of the server: no timers, no stdin reads, no
// heartbeat, no replies - and the process stays ALIVE at 0% CPU forever. Measured on 2026-08-26
// on pid 10100: stuck for 15+ minutes, CPU delta 0 s over 5 s.
// setBlocking(false) does NOT help: tried, it freezes all the same.
//
// The cure is to move the write to a thread of its own. If the pipe fills up, THIS worker
// blocks, and the main thread keeps running: it reads stdin, replies, beats.
// Measured: without the worker 4 heartbeats and then the freeze; with the worker 28 heartbeats
// and the write goes through to the end.
const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");

// The workerData key (state) is set by mango-chrome-mcp.mjs.
const state = new Int32Array(require("node:worker_threads").workerData.state);
// state[0] = 1 while we are inside a writeSync (that is, while the pipe is holding us still)
// state[1] = epoch seconds at which the current write started

parentPort.on("message", (buf) => {
  if (buf === null) return process.exit(0);
  Atomics.store(state, 1, Math.floor(Date.now() / 1000));
  Atomics.store(state, 0, 1);
  try {
    // writeSync may write PARTIALLY: loop, otherwise the protocol is cut in the middle of a
    // message and the client waits forever for a line that never comes.
    let off = 0;
    while (off < buf.length) off += fs.writeSync(1, buf, off, buf.length - off);
  } catch (e) {
    // Broken pipe: the client is gone. Nothing left to deliver.
    if (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") process.exit(0);
  } finally {
    Atomics.store(state, 0, 0);
  }
  parentPort.postMessage(buf.length);   // ack: unblocks the promise of send() in the main thread
});
