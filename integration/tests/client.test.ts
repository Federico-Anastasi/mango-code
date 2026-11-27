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

// --- pictures: the client against a fake control server, which draws for two requests and then is done.

function fakeControl(ending: "done" | "failed" = "done") {
  const log: string[] = [];
  const bodies: unknown[] = [];
  let asked = 0;
  const job = (status: string, step: number) => ({ id: "image-7", status, model: "z-image-turbo", prompt: "a cat", width: 512, height: 512, seed: status === "done" ? 9 : null, step, steps: 8, seconds: 1, error: status === "failed" ? "No room on the card." : null, detail: null, file: null, preview: status === "drawing" ? "cHJldmlldw==" : null });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      log.push(`${req.method} ${path}`);
      const text = await req.text();
      if (text) bodies.push(JSON.parse(text));
      if (path === "/control/image") return Response.json({ models: [{ key: "z-image-turbo", label: "Z-Image Turbo", license: "Apache-2.0", bytes: 1, ready: true }], default: "z-image-turbo", loaded: null, jobs: [] });
      if (path === "/control/image/generate") return Response.json(job("waiting", 0), { status: 202 });
      if (path === "/control/image/jobs/image-7/picture") return Response.json({ png: "UE5H" });
      if (path === "/control/image/jobs/image-7/cancel") return Response.json(job("cancelled", 0));
      if (path === "/control/image/unload") return Response.json({ models: [], default: null, loaded: null, jobs: [] });
      asked++;
      return Response.json(asked < 3 ? job("drawing", asked) : job(ending, 8));
    },
  });
  servers.push(server);
  const control = `http://127.0.0.1:${server.port}`;
  return { mc: new MangoCode({ version: 1, pid: process.pid, agent: control, engine: control, control, window: false }), log, bodies };
}

test("a picture is asked, followed step by step and fetched", async () => {
  const { mc, log, bodies } = fakeControl();
  expect((await mc.images()).default).toBe("z-image-turbo");
  const heard: string[] = [];
  const job = await mc.picture({ prompt: "a cat", width: 512, height: 512, file: "C:\\out\\cat.png" }, (j) => heard.push(`${j.status} ${j.step}${j.preview ? " preview" : ""}`));
  expect(job).toMatchObject({ id: "image-7", status: "done", seed: 9 });
  expect(heard).toEqual(["drawing 1 preview", "drawing 2 preview", "done 8"]);
  expect(bodies[0]).toEqual({ prompt: "a cat", width: 512, height: 512, file: "C:\\out\\cat.png" });
  expect(new TextDecoder().decode(await mc.pictureBytes(job.id))).toBe("PNG");
  expect(log).toEqual(["GET /control/image", "POST /control/image/generate", "GET /control/image/jobs/image-7", "GET /control/image/jobs/image-7", "GET /control/image/jobs/image-7", "GET /control/image/jobs/image-7/picture"]);
});

test("a picture that fails comes back as its job, with the sentence; a picture is cancelled and the image engine stopped", async () => {
  const { mc, log } = fakeControl("failed");
  const job = await mc.picture({ prompt: "a cat", width: 512, height: 512 });
  expect(job).toMatchObject({ status: "failed", error: "No room on the card." });
  expect((await mc.cancelPicture("image-7")).status).toBe("cancelled");
  expect((await mc.unloadImages()).loaded).toBeNull();
  expect(log.slice(-2)).toEqual(["POST /control/image/jobs/image-7/cancel", "POST /control/image/unload"]);
});

test("a picture as a turn of the session is asked on the session's route, with the folder, and comes back as the message", async () => {
  const seen: { path: string; directory: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, directory: url.searchParams.get("directory"), body: await req.json() });
      return Response.json({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "image_generate", state: { status: "completed" } }] });
    },
  });
  servers.push(server);
  const agent = `http://127.0.0.1:${server.port}`;
  const mc = new MangoCode({ version: 1, pid: process.pid, agent, engine: null, control: agent, window: false });
  const message = await mc.pictureTurn("ses_1", "C:\\Projects\\film", { request: "a red scooter", format: "landscape", rewrite: false, seed: 3 });
  expect(message.parts[0].state.status).toBe("completed");
  expect(seen).toEqual([{ path: "/session/ses_1/image", directory: "C:\\Projects\\film", body: { request: "a red scooter", format: "landscape", rewrite: false, seed: 3 } }]);
});
