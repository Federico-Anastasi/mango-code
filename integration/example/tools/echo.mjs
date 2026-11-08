// A dependency-free stdio MCP server, for the integration tests: one tool, `repeat`, which returns the text it
// receives (after `wait_ms`, if given). JSON-RPC messages, one per line.
// A `text` that is not a string gives a tool error (`isError`).
// Environment variables for the tests: ECHO_PREFIX (default "echo") opens the answer; ECHO_STARTS is a file to which
// every server start appends a line; ECHO_CALLS a file to which every call appends a line.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.ECHO_STARTS) appendFileSync(process.env.ECHO_STARTS, `${process.pid}\n`);

const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const tool = {
  name: "repeat",
  description: "Returns the text it receives.",
  inputSchema: { type: "object", properties: { text: { type: "string" }, wait_ms: { type: "number" } }, required: ["text"] },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id === undefined) return; // notifications
  if (m.method === "initialize") {
    respond(m.id, { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } });
  } else if (m.method === "tools/list") {
    respond(m.id, { tools: [tool] });
  } else if (m.method === "tools/call") {
    const { text = "", wait_ms: wait = 0 } = m.params?.arguments ?? {};
    if (process.env.ECHO_CALLS) appendFileSync(process.env.ECHO_CALLS, `${JSON.stringify(m.params?.arguments ?? {})}\n`);
    if (typeof text !== "string") {
      respond(m.id, { isError: true, content: [{ type: "text", text: `text: expected a string, received ${typeof text === "object" ? "an object" : typeof text}` }] });
      return;
    }
    setTimeout(() => respond(m.id, { content: [{ type: "text", text: `${process.env.ECHO_PREFIX ?? "echo"}: ${text}` }] }), wait);
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method: ${m.method}` } }) + "\n");
  }
});
