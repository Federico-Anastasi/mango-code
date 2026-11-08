// The token contract (docs/INTEGRATION.md, "Context used"): when the tokens of an answer arrive, what the summary
// message carries, which event says the conversation was summarized. The fake engine declares the tokens of every
// step (`token` in the script, see fake-engine.rs) and the model's context is small, so the summary really
// triggers. Run it with `bun test integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find, type AgentEvent } from "../client/mango-code";
import { start, type Environment } from "./environment";

const CONTEXT = 16384;
const LONG_TEXT = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");

/** The events of a conversation, in the order they arrive. */
function record(mc: MangoCode, folder: string, id: string) {
  const events: AgentEvent[] = [];
  const stop = mc.listen(folder, (e) => {
    if (!e.properties?.sessionID || e.properties.sessionID === id) events.push(e);
  });
  return { events, stop };
}

async function waitFor(what: string, ready: () => boolean, ms = 60_000) {
  const t0 = Date.now();
  while (!ready()) {
    if (Date.now() - t0 > ms) throw new Error(`did not arrive: ${what}`);
    await Bun.sleep(50);
  }
}

const idle = (events: AgentEvent[]) => events.findIndex((e) => e.type === "session.idle");
const assistant = (e: AgentEvent) => e.type === "message.updated" && e.properties.info.role === "assistant";
const zeroed = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/** The assistant's messages in the order they are born, with all the updates of each. */
function byMessage(events: AgentEvent[]) {
  const m = new Map<string, { info: any; positions: number[]; updates: any[] }>();
  events.forEach((e, i) => {
    if (!assistant(e)) return;
    const info = e.properties.info;
    const v = m.get(info.id) ?? { info, positions: [], updates: [] };
    v.info = info;
    v.positions.push(i);
    v.updates.push(info);
    m.set(info.id, v);
  });
  return [...m.values()];
}

const nonZero = (t: any) => t.input + t.output + t.reasoning + t.cache.read + t.cache.write > 0;

describe("the tokens of an answer", () => {
  const SCRIPT = [
    { tool: "skill", arguments: { name: "greeting" }, token: { prompt: 1000, completion: 20 } },
    { tool: "echo_repeat", arguments: { text: "hello" }, token: { prompt: 1200, completion: 100, cache: 800, reasoning: 60 } },
    { text: LONG_TEXT, token: { prompt: 1500, completion: 40, cache: 1200 } },
  ];
  let env: Environment;
  let mc: MangoCode;

  beforeAll(async () => {
    env = await start(SCRIPT, { context: CONTEXT });
    mc = new MangoCode((await find(env.data))!);
  }, 200_000);

  afterAll(() => {
    env?.close();
    Bun.sleepSync(1500);
    try {
      fs.rmSync(env.root, { recursive: true, force: true });
    } catch {}
  });

  test("they arrive at the end of every step, all together, and after session.idle they no longer change", async () => {
    const id = await mc.createSession(env.project);
    const { events, stop } = record(mc, env.project, id);
    await Bun.sleep(300);
    await mc.send(id, env.project, "How do we greet?", { model: "fake" });
    await waitFor("session.idle", () => idle(events) >= 0);
    // After the first session.idle nothing more should arrive from the assistant: wait, then look.
    const end = idle(events);
    await Bun.sleep(1500);
    stop();

    // One assistant message per step (two with a tool, one that closes).
    const msg = byMessage(events);
    expect(msg.map((m) => m.info.finish)).toEqual(["tool-calls", "tool-calls", "stop"]);
    const expected = [
      { total: 1020, input: 1000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      { total: 1300, input: 400, output: 40, reasoning: 60, cache: { read: 800, write: 0 } },
      { total: 1540, input: 300, output: 40, reasoning: 0, cache: { read: 1200, write: 0 } },
    ];
    msg.forEach((m, i) => {
      // At birth the message is at zero and has not finished.
      expect(m.updates[0].tokens).toEqual(zeroed);
      expect(m.updates[0].finish).toBeUndefined();
      // The tokens appear only with the end of the step (finish and time.completed together), always the same.
      const withTokens = m.updates.filter((a) => nonZero(a.tokens));
      expect(withTokens.length).toBeGreaterThan(0);
      for (const a of withTokens) {
        expect(a.tokens).toEqual(expected[i]);
        expect(a.finish).toBeDefined();
        expect(a.time.completed).toBeDefined();
      }
      // The context used by the step is the sum of all the entries.
      const t = expected[i];
      expect(t.input + t.cache.read + t.cache.write + t.output + t.reasoning).toBe(t.total);
      // The tokens of a step arrive before the next step's message is born.
      const firstWithTokens = m.positions[m.updates.findIndex((a) => nonZero(a.tokens))];
      if (msg[i + 1]) expect(firstWithTokens).toBeLessThan(msg[i + 1].positions[0]);
      expect(firstWithTokens).toBeLessThan(end);
    });

    // After session.idle: no update of the assistant's messages, and no summary in the whole turn.
    expect(events.slice(end + 1).some(assistant)).toBe(false);
    expect(events.some((e) => e.type === "session.compacted")).toBe(false);

    // Reading the messages gives the same numbers.
    const read = (await mc.messages(id, env.project)).filter((m) => m.info.role === "assistant");
    expect(read.map((m) => m.info.tokens)).toEqual(expected);
  }, 120_000);

  test("a turn stopped mid-step leaves that message at zero", async () => {
    const id = await mc.createSession(env.project);
    const { events, stop } = record(mc, env.project, id);
    await Bun.sleep(300);
    await mc.send(id, env.project, "How do we greet?", { model: "fake" });
    // The third step is a long text: stop as soon as it starts.
    await waitFor("the text of the third step", () => events.some((e) => e.type === "message.part.delta" && e.properties.delta.includes("word")));
    await mc.abort(id, env.project);
    await waitFor("session.idle", () => idle(events) >= 0);
    await Bun.sleep(1500);
    stop();

    const msg = byMessage(events);
    expect(msg.length).toBe(3);
    // The first two steps had finished and have their tokens; the third never had them.
    expect(msg[0].info.tokens.total).toBe(1020);
    expect(msg[1].info.tokens.total).toBe(1300);
    expect(msg[2].updates.every((a) => !nonZero(a.tokens))).toBe(true);
    expect(msg[2].info.finish).toBeUndefined();
    expect(msg[2].info.error).toBeDefined();
  }, 120_000);
});

describe("the conversation summary", () => {
  // The second step reads 12500 tokens: with 16384 of context and a 4096 answer cap the agent summarizes after
  // 12288 (context minus cap). The summary is the engine's answer to requests without tools.
  const SCRIPT = [
    { tool: "skill", arguments: { name: "greeting" }, token: { prompt: 1000, completion: 20 } },
    { tool: "echo_repeat", arguments: { text: "hello" }, token: { prompt: 12500, completion: 100 } },
    { text: "End of the turn.", token: { prompt: 1500, completion: 40 } },
    { summary: "FAKE SUMMARY of the conversation.", token: { prompt: 4000, completion: 50 } },
    { if: "FAKE SUMMARY", text: "Resumed after the summary.", token: { prompt: 900, completion: 30 } },
  ];
  let env: Environment;
  let mc: MangoCode;

  beforeAll(async () => {
    env = await start(SCRIPT, { context: CONTEXT });
    mc = new MangoCode((await find(env.data))!);
  }, 200_000);

  afterAll(() => {
    env?.close();
    Bun.sleepSync(1500);
    try {
      fs.rmSync(env.root, { recursive: true, force: true });
    } catch {}
  });

  test("session.compacted says it happened; the summary message carries the tokens of its request, not the new context", async () => {
    // The measure a connected app reads: the model's context and answer cap.
    const providers = await fetch(`${mc.service.agent}/config/providers?directory=${encodeURIComponent(env.project)}`).then((r) => r.json());
    const limit = providers.providers.find((p: any) => p.id === "mango").models.fake.limit;
    expect(limit).toEqual({ context: CONTEXT, output: 4096 });
    const threshold = limit.context - limit.output;

    const id = await mc.createSession(env.project);
    const { events, stop } = record(mc, env.project, id);
    await Bun.sleep(300);
    await mc.send(id, env.project, "How do we greet?", { model: "fake" });
    await waitFor("session.idle", () => idle(events) >= 0);
    await Bun.sleep(1000);
    stop();

    const msg = byMessage(events);
    expect(msg.map((m) => [m.info.mode, m.info.summary === true, m.info.tokens.total])).toEqual([
      ["build", false, 1020],
      ["build", false, 12600], // the step that exceeds the threshold
      ["compaction", true, 4050], // the summary: the request that produces it, not the context after
      ["build", false, 930], // the context after the summary is told by the next step
    ]);
    expect(msg[1].info.tokens.total).toBeGreaterThanOrEqual(threshold);
    expect(msg[0].info.tokens.total).toBeLessThan(threshold);

    // The summary message is born at zero and carries the tokens only when the summary is done.
    const summary = msg[2];
    expect(summary.updates[0].tokens).toEqual(zeroed);
    expect(summary.info.tokens).toEqual({ total: 4050, input: 4000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } });

    // The start: a "compaction" part (`auto`: chosen by the agent, not by the user) right before the summary message.
    const compactionStart = events.findIndex((e) => e.type === "message.part.updated" && e.properties.part.type === "compaction");
    expect(events[compactionStart].properties.part.auto).toBe(true);
    expect(compactionStart).toBeGreaterThan(Math.max(...msg[1].positions));
    expect(compactionStart).toBeLessThan(summary.positions[0]);

    // The event: just one, with the conversation and nothing else, after the end of the summary and before the step that resumes.
    const compacted = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === "session.compacted");
    expect(compacted.length).toBe(1);
    const [event, pos] = compacted[0];
    expect(event.properties).toEqual({ sessionID: id });
    const lastSummary = Math.max(...summary.positions);
    expect(pos).toBeGreaterThan(lastSummary);
    expect(pos).toBeLessThan(msg[3].positions[0]);
    // Has the following step already exceeded the threshold? No: the context has dropped.
    expect(msg[3].info.tokens.total).toBeLessThan(threshold);
    expect(idle(events)).toBeGreaterThan(Math.max(...msg[3].positions));
  }, 120_000);
});
