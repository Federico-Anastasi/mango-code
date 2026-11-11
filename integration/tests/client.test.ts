// The attach client against a fake agent server (no Mango Code, no window): how `turn()` behaves when the event
// stream is late, repeats a `session.idle`, answers with an error or drops in the middle of the turn.

import { afterEach, expect, test } from "bun:test";
import { MangoCode, type Step } from "../client/mango-code";

type Stream = { send: (e: object) => void; raw: (text: string) => void; close: () => void };

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop(true)));

/** A fake agent: `/event` hands the stream to `events`, `prompt_async` to `prompt`, in the order they happen. */
function fakeAgent(opts: { event?: Response; events?: (s: Stream) => void; prompt: (s: Stream | undefined) => void }) {
  const log: string[] = [];
  let stream: Stream | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/event") {
        if (opts.event) return opts.event;
        return new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              stream = {
                send: (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
                raw: (text) => c.enqueue(enc.encode(text)),
                close: () => c.close(),
              };
              opts.events?.(stream);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname.endsWith("/prompt_async")) {
        log.push("prompt");
        opts.prompt(stream);
        return new Response(null, { status: 204 });
      }
      return new Response("not expected", { status: 404 });
    },
  });
  servers.push(server);
  const mc = new MangoCode({ version: 1, pid: process.pid, agent: `http://127.0.0.1:${server.port}`, engine: "", window: false });
  return { mc, log };
}

const connected = { type: "server.connected", properties: {} };
const busy = { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } };
const idle = { type: "session.idle", properties: { sessionID: "s" } };
const part = { type: "message.part.updated", properties: { sessionID: "s", part: { id: "p", type: "text" } } };
const delta = (text: string) => ({ type: "message.part.delta", properties: { sessionID: "s", partID: "p", field: "text", delta: text } });

async function steps(mc: MangoCode) {
  const out: Step[] = [];
  for await (const s of mc.turn("s", "C:\\project", "hi")) out.push(s);
  return out;
}

test("a turn goes from the first piece to the idle", async () => {
  const { mc } = fakeAgent({
    events: (s) => s.send(connected),
    prompt: (s) => {
      s!.send(busy);
      s!.send(part);
      s!.send(delta("Hello"));
      s!.send(idle);
    },
  });
  expect(await steps(mc)).toEqual([{ type: "text", delta: "Hello", part: "p" }, { type: "end" }]);
});

test("the message goes out only when the stream says it is connected, however long that takes", async () => {
  const { mc, log } = fakeAgent({
    events: (s) =>
      void setTimeout(() => {
        log.push("connected");
        s.send(connected);
      }, 700),
    prompt: (s) => {
      s!.send(busy);
      s!.send(idle);
    },
  });
  expect(await steps(mc)).toEqual([{ type: "end" }]);
  expect(log).toEqual(["connected", "prompt"]);
});

test("a session.idle that was already on its way does not close the turn", async () => {
  const { mc } = fakeAgent({
    events: (s) => {
      s.send(connected);
      s.send(idle);
    },
    prompt: (s) => {
      s!.send(busy);
      s!.send(part);
      s!.send(delta("answer"));
      s!.send(idle);
    },
  });
  expect(await steps(mc)).toEqual([{ type: "text", delta: "answer", part: "p" }, { type: "end" }]);
});

test("the stream dropping in the middle of the turn ends it with an error", async () => {
  const { mc } = fakeAgent({
    events: (s) => s.send(connected),
    prompt: (s) => {
      s!.send(busy);
      s!.send(part);
      s!.send(delta("half"));
      s!.close();
    },
  });
  const out = await steps(mc);
  expect(out.map((s) => s.type)).toEqual(["text", "error", "end"]);
  expect(out[1]).toEqual({ type: "error", error: "the event stream closed" });
});

test("a stream the server refuses ends the turn with an error and sends nothing", async () => {
  const { mc, log } = fakeAgent({ event: new Response("engine starting", { status: 503 }), prompt: () => {} });
  expect(await steps(mc)).toEqual([{ type: "error", error: "GET /event: 503 engine starting" }, { type: "end" }]);
  expect(log).toEqual([]);
});

test("an event that is not JSON ends the turn with an error", async () => {
  const { mc } = fakeAgent({
    events: (s) => s.send(connected),
    prompt: (s) => s!.raw("data: not json\n\n"),
  });
  const out = await steps(mc);
  expect(out.map((s) => s.type)).toEqual(["error", "end"]);
});
