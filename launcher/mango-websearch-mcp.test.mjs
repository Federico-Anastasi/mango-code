// The web server of the agent's MCP, against a local site: a page refused is not asked again under another name, a
// huge page is read up to a limit, a file that is not a page is said so, and a request whose accented letter arrives
// split in two pieces keeps it. `node --test launcher/mango-websearch-mcp.test.mjs`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const seen = [];
let site;
let base;

before(async () => {
  site = http.createServer((req, res) => {
    seen.push({ url: decodeURIComponent(req.url), agent: req.headers["user-agent"] });
    if (req.url === "/refused") return res.writeHead(403).end();
    if (req.url === "/file.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.7 binary");
    if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      const piece = `<p>${"word ".repeat(2000)}</p>`;
      let sent = 0;
      const more = () => {
        while (sent < 40_000_000) {
          sent += piece.length;
          if (!res.write(piece)) return res.once("drain", more);
        }
        res.end();
      };
      return more();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<html><body><p>${"A page about a city. ".repeat(30)}</p></body></html>`);
  });
  await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${site.address().port}`;
});

after(() => site.close());

/** Starts the server, sends the lines as the given pieces of bytes, and gives back its answers by id. */
async function ask(pieces) {
  const server = spawn(process.execPath, [path.join(import.meta.dirname, "mango-websearch-mcp.js")], { stdio: ["pipe", "pipe", "inherit"] });
  const answers = new Map();
  let out = "";
  server.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const m = JSON.parse(out.slice(0, i));
      out = out.slice(i + 1);
      answers.set(m.id, m);
    }
  });
  for (const piece of pieces) {
    server.stdin.write(piece);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const wanted = pieces.join("").split("\n").filter(Boolean).length;
  for (let i = 0; i < 600 && answers.size < wanted; i++) await new Promise((ok) => setTimeout(ok, 100));
  server.kill();
  return answers;
}

const call = (id, args) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_url", arguments: args } }) + "\n";
const text = (answer) => answer.result.content[0].text;

test("a refused page is not asked again under another name", async () => {
  const answers = await ask([call(1, { url: `${base}/refused` })]);
  assert.match(text(answers.get(1)), /HTTP 403/);
  const asked = seen.filter((r) => r.url === "/refused");
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0].agent, /Googlebot/);
});

test("a huge page is read up to a limit", async () => {
  const t0 = Date.now();
  const answers = await ask([call(1, { url: `${base}/huge`, max_chars: 1000 })]);
  assert.ok(text(answers.get(1)).length < 2000);
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms: the whole page was read`);
});

test("a file that is not a page is said so", async () => {
  const answers = await ask([call(1, { url: `${base}/file.pdf` })]);
  assert.equal(answers.get(1).result.isError, true);
  assert.match(text(answers.get(1)), /application\/pdf/);
});

test("an accented letter split between two pieces is kept", async () => {
  const line = Buffer.from(call(1, { url: `${base}/città` }));
  const at = line.indexOf(Buffer.from("à")) + 1;
  await ask([line.subarray(0, at), line.subarray(at)]);
  assert.ok(seen.some((r) => r.url === "/città"), JSON.stringify(seen.map((r) => r.url)));
});
