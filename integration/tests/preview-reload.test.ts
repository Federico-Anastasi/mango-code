// The Preview panel shows the new version of a page the model changes, with its file tools or a command of its shell,
// without «Reload», in the app's real window (WebView2 CDP for the web UI, the bridge's `preview.state()` for what the
// native panel shows). Which files reload which pages: packages/app/src/utils/preview-reload.test.ts.
// Fake engine, no GPU. Own ports (47790-47792).
// `off-screen bun test --cwd integration tests/preview-reload.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";

const [AGENT, ENGINE, DEBUG] = [47790, 47791, 47792];
const page_ = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1>`;

let env: Environment;
let mc: MangoCode;
let p: Page;
let id = "";
let file = "";

beforeAll(async () => {
  env = await start(
    ({ project }) => {
      file = path.join(project, "site", "index.html");
      return [
        { tool: "write", arguments: { filePath: file, content: page_("Second") } },
        // a moment later, so the reload of the first change is seen before this one; the same words work in Git Bash and in
        // PowerShell, whichever shell the agent has
        { tool: "bash", arguments: { command: `sleep 2; echo '${page_("Third")}' > site/index.html`, description: "Change the page" } },
        { text: "Done." },
      ];
    },
    {
      window: true,
      env: { MANGO_AGENT_PORT: String(AGENT), MANGO_ENGINE_PORT: String(ENGINE), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}` },
    },
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page_("First"));
  mc = new MangoCode((await find(env.data))!);
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  id = await mc.createSession(env.project, { title: "reload" });
  await p.send("Page.navigate", { url: `${env.agent}/${btoa(env.project).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}/session/${id}` });
  await waitFor(`document.querySelector('[data-action="titlebar-model"]')?.innerText.includes("Fake model")`, 60_000);
  await p.evaluate(`window.__MANGO_DESKTOP__.preview.go(${JSON.stringify("file:///" + file.replace(/\\/g, "/"))}).then(() => "ok")`);
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => s.visible && s.title === "First")`);
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
}, 30_000);

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition).catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

const title = async () => ((await p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`)) as { title: string }).title;

test("the model changes the page shown, with its file tools or its shell: the panel shows each new version by itself", async () => {
  const turn = (async () => {
    for await (const _ of mc.turn(id, env.project, "Make it the second page, then the third", { model: "fake" }));
  })();
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => s.title === "Second")`, 10_000);
  await waitFor(`window.__MANGO_DESKTOP__.preview.state().then((s) => s.title === "Third")`, 15_000);
  await turn;
  expect(await title()).toBe("Third");
}, 120_000);
