// "Stop" must close the request to the model, not only the conversation: otherwise the engine keeps generating for
// nobody and the next conversation waits. The fake engine writes a long text in slow pieces and records when the
// client closes the connection. `bun test integration`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const LONG = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
let env: Environment;
let mc: MangoCode;

beforeAll(async () => {
  env = await start([{ text: LONG }], { chunkMs: 100 });
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const interruptions = () =>
  fs.existsSync(env.engineLog)
    ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.route === "interrupted")
    : [];

test("\"Stop\" closes the request to the model", async () => {
  const id = await mc.createSession(env.project);
  let pieces = 0;
  const turn = (async () => {
    for await (const p of mc.turn(id, env.project, "Write a lot", { model: "fake" })) if (p.type === "text") pieces++;
  })();
  for (let i = 0; i < 100 && pieces < 10; i++) await Bun.sleep(100);
  expect(pieces).toBeGreaterThanOrEqual(10);
  const t0 = Date.now();
  await mc.abort(id, env.project);
  while (interruptions().length === 0 && Date.now() - t0 < 10_000) await Bun.sleep(100);
  const waited = Date.now() - t0;
  await turn;
  expect(interruptions().length).toBe(1);
  // The engine notices at the first piece it cannot write: one piece every 100 ms.
  expect(waited).toBeLessThan(2000);
  expect(interruptions()[0].chunks).toBeLessThan(200);
}, 120_000);
