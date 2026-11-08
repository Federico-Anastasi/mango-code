// "Apri con Mango Code" (app/src-tauri/src/folder.rs): the folder passed on the command line, as File Explorer
// launches it (`mango-code.exe "<folder>\."`), becomes the project opened in the window: at startup, from a
// second launch towards the instance already open (which closes by itself), and with a path that does not exist,
// which gives a message and changes nothing. Fake engine, no GPU; data, ports and single instance are the environment's.
// `bun test --cwd integration tests/open-folder.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { answer } from "./dialog";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mango-open-"));
const folder = (name: string) => {
  const c = path.join(base, name);
  fs.mkdirSync(c);
  fs.writeFileSync(path.join(c, "index.html"), "<h1>hello</h1>");
  return c;
};
const [first, second] = [folder("first-site"), folder("second-site")];

let env: Environment;
let p: Page;

beforeAll(async () => {
  // Like File Explorer: the folder with `\.` at the end.
  env = await start([{ text: "ok" }], { window: true, args: [`${first}\\.`] });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
});

const text = () => p.evaluate("document.body.innerText") as Promise<string>;

async function waitUntil(condition: () => Promise<boolean>, timeout = 60_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    if (await condition()) return;
    await Bun.sleep(300);
  }
}

test("started with a folder, the app opens it as a project", async () => {
  await waitUntil(async () => (await text()).includes("first-site"));
  expect(await text()).toContain("first-site");
  expect(await p.evaluate("location.search")).not.toContain("project");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 120_000);

test("a second launch with another folder hands it to the open app and exits", async () => {
  const service = fs.readFileSync(path.join(env.data, "service.json"), "utf8");
  const secondLaunch = env.launch([`${second}\\.`]);
  const code = await Promise.race([
    new Promise<number | null>((ok) => secondLaunch.on("exit", ok)),
    Bun.sleep(60_000).then(() => "still alive" as const),
  ]);
  if (code === "still alive") secondLaunch.kill();
  expect(code).toBe(0);

  await waitUntil(async () => (await text()).includes("second-site"));
  expect(await text()).toContain("second-site");
  expect(await text()).toContain("first-site"); // the first project stays in the list
  expect(fs.readFileSync(path.join(env.data, "service.json"), "utf8")).toBe(service); // the same service, not a new one
}, 180_000);

test("a path that does not exist gives a message and leaves the window as it was", async () => {
  const before = await text();
  env.launch([path.join(base, "not-there")]);
  const r = await answer(env.app.pid!);
  expect(r.code, r.output).toBe(0);
  expect(r.output).toContain("non esiste");
  expect(r.output).toContain("not-there");
  await Bun.sleep(1500);
  expect(await text()).toBe(before);
}, 120_000);
