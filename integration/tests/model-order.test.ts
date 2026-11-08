// The local models come from the agent server (GET /config/providers) in the catalog order, not in alphabetical
// order: the web UI shows them like that in the selector. Fake engine, no GPU.
// `bun test --cwd integration tests/model-order.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { start, type Environment } from "./environment";

let env: Environment;

beforeAll(async () => {
  // Alphabetically they would be alpha, beta, fake.
  env = await start([{ text: "ok" }], { otherModels: ["beta", "alpha"] });
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the server lists the local models in the catalog order", async () => {
  const response = await (await fetch(`${env.agent}/config/providers`)).json();
  const local = response.providers.find((p: { id: string }) => p.id === "mango");
  expect(Object.keys(local.models)).toEqual(["fake", "beta", "alpha"]);
}, 60_000);
