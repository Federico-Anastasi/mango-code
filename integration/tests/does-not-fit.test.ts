// A model on disk that does not fit this computer (10 TB declared), chosen in the app's web UI: the selector says so
// in its name, and the conversation shows the plan's sentence at once (what happened, what to do), without the
// retries the agent makes for transient errors. Fake engine, no GPU used.
// `bun test --cwd integration tests/does-not-fit.test.ts`, after `cargo build -p mango-code -p engine` in app/.
// The screenshot stays in %TEMP%\mango-does-not-fit.png.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

// The Italian sentence of the plan.
const SENTENCE = "non ci sta in questo computer";

let env: Environment;
let mc: MangoCode;
let p: Page;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

beforeAll(async () => {
  env = await start([{ text: "ok" }], { window: true, otherModels: ["huge"], bytes: { huge: 10 * 2 ** 40 } });
  mc = new MangoCode((await find(env.data))!);
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

test("the selector says the model does not fit", async () => {
  const response = await (await fetch(`${env.agent}/config/providers`)).json();
  const local = response.providers.find((x: { id: string }) => x.id === "mango");
  expect(local.models.fake.name).toBe("Fake model");
  expect(local.models.huge.name).toBe("Model huge");
  // the menu says it from what the agent tells (see model-menu.test.ts)
  const info = await (await fetch(`${env.agent}/mango/models/info`)).json();
  expect(info.huge).toMatchObject({ place: "none", bytes: 10 * 2 ** 40 });
}, 60_000);

test("chosen in the web UI, the conversation shows at once why it does not start and what to do", async () => {
  const id = await mc.createSession(env.project, { title: "too big" });
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${id}` });
  await Bun.sleep(4000);
  const t0 = Date.now();
  const steps = [];
  for await (const s of mc.turn(id, env.project, "Hello", { model: "huge" })) steps.push(s);
  const error = steps.find((s) => s.type === "error");
  expect(JSON.stringify(error)).toContain(`Il modello «Model huge» ${SENTENCE}`);
  expect(JSON.stringify(error)).toContain("Scegli un modello più piccolo.");
  // No empty retries: the agent only retries transient errors, with waits that reach a minute.
  expect(Date.now() - t0).toBeLessThan(15_000);
  let text = "";
  for (let i = 0; i < 20 && !text.includes("Scegli un modello più piccolo."); i++) {
    await Bun.sleep(500);
    text = await p.evaluate("document.body.innerText");
  }
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "mango-does-not-fit.png"), Buffer.from(r.result.data, "base64"));
  expect(text).toContain(`Il modello «Model huge» ${SENTENCE}`);
  expect(text).toContain("Scegli un modello più piccolo.");
  // The engine stays on the previous model, and the manager's state says why.
  const state = await (await fetch(`${env.engine}/engine`)).json();
  expect(state.model).toBe("fake");
  expect(state.error).toContain(SENTENCE);
}, 120_000);
