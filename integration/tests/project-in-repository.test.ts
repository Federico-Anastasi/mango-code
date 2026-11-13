// A project that is a folder inside a larger git repository (a space and an accent in its name, like a folder made by
// "New project" under a parent that is itself a repository), in the app's real window (WebView2 CDP):
//  - the file the model wrote shows once under the answer, named from the project, with Open and without "no longer
//    in the folder";
//  - the Git changes name it from the project too, with its lines of text.
// Fake engine, no GPU. Own ports (47710-47712). `bun test --cwd integration`, after `cargo build -p mango-code -p engine`
// in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47710, 47711, 47712];
const FOLDER = "Contabilità prova B";
const TEXT = "| Fattura | Totale |\n| 1 | €1.464,00 |\n| 2 | €4.270,00 àè |\n";

let env: Environment;
let mc: MangoCode;
let p: Page;
let project = "";
let id = "";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const git = (...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd: env.project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

beforeAll(async () => {
  env = await start(
    ({ project }) => [
      { tool: "write", arguments: { filePath: path.join(project, FOLDER, "fatture.md"), content: TEXT } },
      { text: "Fatto." },
    ],
    { window: true, env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` } },
  );
  // the repository is the folder around the project, with a commit
  project = path.join(env.project, FOLDER);
  fs.mkdirSync(project, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "start");
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(project, { title: "fatture" });
  for await (const _ of mc.turn(id, project, "Crea fatture.md", { model: "fake" }));
  await p.send("Page.navigate", { url: `${env.agent}/${b64(project)}/session/${id}` });
  await waitFor(`document.querySelector('[data-slot="session-turn-diffs"]') !== null`, 60_000);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
});

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

test("the turn's changes name the file from the project", async () => {
  const user = (await mc.messages(id, project)).find((m) => m.info.role === "user");
  expect(user.info.summary.diffs.map((d: { file: string }) => d.file)).toEqual(["fatture.md"]);
}, 30_000);

test("the file shows once under the answer, from the project, with Open and not as gone", async () => {
  const diffs = `document.querySelector('[data-slot="session-turn-diffs"]')`;
  expect(await p.evaluate(`${diffs}.querySelector('[data-slot="session-turn-diffs-label"]').innerText`)).toBe("1 file modificato");
  const rows = await p.evaluate(
    `[...${diffs}.querySelectorAll('[data-slot="session-turn-diff-trigger"], [data-slot="session-turn-file-card"]')].map((row) => row.innerText)`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("fatture.md");
  expect(rows[0]).not.toContain(FOLDER);
  expect(rows[0]).toContain("Apri");
  expect(rows[0]).not.toContain("non c'è più");
}, 30_000);

test("the Git changes name the file from the project, with its lines of text", async () => {
  const r = await fetch(`${env.agent}/vcs/diff?directory=${encodeURIComponent(project)}&mode=git`);
  const changes = (await r.json()) as { file: string; additions: number; patch: string }[];
  expect(changes.map((c) => c.file)).toEqual(["fatture.md"]);
  expect(changes[0].additions).toBe(3);
  expect(changes[0].patch).toContain("+| 2 | €4.270,00 àè |");
}, 30_000);
