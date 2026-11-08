// The shared language (docs/INTEGRATION.md, §5 "Language"): `GET`/`PUT /mango/language` read and write the `language`
// key of `<data>\settings.json`, the file shared with the app, the terminal and the prompt settings. The other keys
// of the file stay; the agent's error texts follow the language. Fake engine, no GPU.
//
// With `MANGO_OPENCODE=<folder with web\mango-code.exe>` it tries a separate build of the agent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { start, type Environment } from "./environment";

let env: Environment;

beforeAll(async () => {
  env = await start([{ text: "ok" }]);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const url = () => `${env.agent}/mango/language`;
const SETTINGS = () => path.join(env.data, "settings.json");
const readFile = () => JSON.parse(fs.readFileSync(SETTINGS(), "utf8"));
const get = async () => (await fetch(url())).json();
/** A client on the PC sends no `Origin`: the language, unlike the prompt settings, can be set from an app too. */
const put = (body: unknown) => fetch(url(), { method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET gives the language of the data folder's settings.json", async () => {
  // the environment starts with Italian
  expect(await get()).toEqual({ language: "it" });
  expect(readFile()).toEqual({ language: "it" });
});

test("PUT saves the language, GET reads it back, and the other keys of the file stay", async () => {
  // a prompt setting made from the settings page (it carries an Origin) gives the file another key
  const settings = `${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}`;
  const off = await fetch(settings, { method: "PUT", headers: { "Content-Type": "application/json", Origin: env.agent }, body: JSON.stringify({ type: "tools", name: "webfetch", enabled: false, scope: "all" }) });
  expect(off.status).toBe(200);
  expect(readFile()).toEqual({ language: "it", prompt: { tools: { webfetch: false } } });

  const response = await put({ language: "en" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ language: "en" });
  expect(await get()).toEqual({ language: "en" });
  expect(readFile()).toEqual({ language: "en", prompt: { tools: { webfetch: false } } });

  // and the prompt settings do not drop the language when they write the file
  await fetch(settings, { method: "PUT", headers: { "Content-Type": "application/json", Origin: env.agent }, body: JSON.stringify({ type: "tools", name: "webfetch", enabled: true, scope: "all" }) });
  expect(readFile()).toEqual({ language: "en", prompt: {} });
});

test("the agent's error texts follow the language", async () => {
  expect((await put({ language: "it" })).status).toBe(200);
  const italian = await put({ language: "fr" });
  expect(italian.status).toBe(400);
  expect((await italian.json()).error).toContain("deve essere");

  expect((await put({ language: "en" })).status).toBe(200);
  const english = await put({ language: "fr" });
  expect(english.status).toBe(400);
  expect((await english.json()).error).toContain("must be");
});

test("null removes the choice (follow the system) and keeps the other keys", async () => {
  const response = await put({ language: null });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ language: null });
  expect(await get()).toEqual({ language: null });
  expect(readFile()).toEqual({ prompt: {} });
});

test("any other value is refused with 400 and the file does not change", async () => {
  expect((await put({ language: "it" })).status).toBe(200);
  const before = fs.readFileSync(SETTINGS(), "utf8");
  for (const body of [{ language: "fr" }, { language: "IT" }, { language: 1 }, { language: "" }, {}, [], "not json", "null"]) {
    const response = await put(body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
  }
  expect(fs.readFileSync(SETTINGS(), "utf8")).toBe(before);
  expect(await get()).toEqual({ language: "it" });
});
