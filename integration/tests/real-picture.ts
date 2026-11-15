// A real picture, asked in the box of a conversation of the development app, with the real engines and models on this
// computer's cards: the model that writes rewrites the request, the image engine takes the card and draws, the model
// that writes comes back. It prints what happens with the seconds, and saves a photo of the window and the picture.
// It holds a GPU for a few minutes and opens the app's window: it is not part of `bun test`.
//
// Usage: bun integration/tests/real-picture.ts <data folder> <folder for the photo and the picture> ["request"]
// The data folder has the models in `models` and the engines in `engine`, as an installed app keeps them. The app is
// the one built from this repository (`cargo build -p mango-code -p engine -p images` in app/, then
// `app\scripts\build-agent.ps1`), with its distribution in `launcher/`.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { page, type Page } from "./cdp";
import { APP_EXE, REPO, writeLanguage } from "./environment";

const [data, out, request = "Una pizza margherita su un tavolo di legno, vista dall'alto"] = process.argv.slice(2);
if (!data || !out) throw new Error('usage: bun integration/tests/real-picture.ts <data folder> <folder for the photo and the picture> ["request"]');
for (const folder of ["models", "engine"]) {
  if (!fs.existsSync(path.join(data, folder))) throw new Error(`${path.join(data, folder)} is missing`);
}
const LIMIT_MS = 15 * 60_000;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

const t0 = Date.now();
const said = new Map<string, string>();
/** One line with the seconds since the start; what is watched (`topic`) is told only when it changes. */
function tell(what: string, topic?: string) {
  if (topic && said.get(topic) === what) return;
  if (topic) said.set(topic, what);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${what}`);
}

async function waitUntil(condition: () => Promise<boolean>, what: string, ms = 60_000) {
  for (const begun = Date.now(); !(await condition().catch(() => false)); await Bun.sleep(300)) {
    if (Date.now() - begun > ms) throw new Error(`waited too long for: ${what}`);
  }
}

writeLanguage(data);
fs.mkdirSync(out, { recursive: true });
const project = fs.mkdtempSync(path.join(os.tmpdir(), "mango-real-picture-"));
const cdp = await freePort();
const app = spawn(APP_EXE, [`${project}\\.`], {
  env: {
    ...process.env,
    MANGO_DIST: path.join(REPO, "launcher"),
    MANGO_DATA: data,
    MANGO_AGENT_PORT: String(await freePort()),
    MANGO_ENGINE_PORT: String(await freePort()),
    MANGO_WINDOW_CDP: String(cdp),
  },
  stdio: "ignore",
});
let p: Page | undefined;
try {
  const serviceFile = path.join(data, "service.json");
  await waitUntil(async () => {
    if (app.exitCode !== null) throw new Error(`the app closed; log in ${path.join(data, "logs")}`);
    return fs.existsSync(serviceFile);
  }, "the app ready", 300_000);
  const service = JSON.parse(fs.readFileSync(serviceFile, "utf8")) as { agent: string; engine: string };
  tell("the app is ready");
  const control = async (route: string) => (await fetch(`${service.engine}/control/${route}`)).json();
  const window = (p = await page(cdp, (t) => t.url.startsWith(service.agent), 120_000));
  const exists = (selector: string) => window.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
  /** A click with the mouse on the first element of `selector` whose text starts with `label`. */
  const click = async (selector: string, label = "") => {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.innerText ?? "").trim().startsWith(${JSON.stringify(label)}))`;
    await window.evaluate(`${find}?.scrollIntoView({ block: "center" })`);
    await Bun.sleep(250);
    const at = await window.evaluate(`(() => { const q = (${find})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
    if (!at) throw new Error(`not on the page: ${selector} ${label}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await window.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  };

  // What the app says of the model that writes and of the image engine, told when it changes.
  const watch = async () => {
    const state = await control("state");
    tell(`model that writes: ${state.model.phase}${state.model.model ? ` (${state.model.model})` : ""}; image engine: ${state.image_loaded ?? "off"}`, "engines");
    return state;
  };
  await waitUntil(async () => (await watch()).model.phase === "ready", "the model that writes ready", 300_000);

  await waitUntil(() => exists("button"), "the page");
  await click("button", "Nuova conversazione");
  await waitUntil(() => exists('[data-component="prompt-input"]'), "the box to write in");
  await click('[data-mode="picture"]');
  await click('[data-component="prompt-input"]');
  await window.send("Input.insertText", { text: request });
  await waitUntil(() => window.evaluate(`document.querySelector('[data-action="prompt-submit"]')?.disabled === false`), "the send button on");
  await click('[data-action="prompt-submit"]');
  tell(`asked: ${request}`);
  const asked = Date.now();

  type Job = { status: string; step: number; steps: number; file: string | null; error: string | null; prompt?: string; seed: number | null; model: string };
  let job: Job | undefined;
  await waitUntil(async () => {
    const row = (await window.evaluate(`[...document.querySelectorAll('[data-component="picture-tool"]')].at(-1)?.innerText.split("\\n").filter(Boolean).slice(0, 3).join(" | ") ?? ""`)) as string;
    if (row) tell(`the row: ${row}`, "row");
    await watch();
    job = ((await control("image")).jobs as Job[]).at(-1);
    if (job) tell(`the job: ${job.status} ${job.step}/${job.steps}`, "job");
    return !!job && ["done", "failed", "cancelled"].includes(job.status);
  }, "the picture", LIMIT_MS);
  if (job?.status !== "done" || !job.file) throw new Error(`the picture was not made: ${JSON.stringify(job)}`);
  tell(`the picture is made in ${((Date.now() - asked) / 1000).toFixed(1)} s from the request: ${job.file} (${fs.statSync(job.file).size} bytes, model ${job.model}, seed ${job.seed})`);

  await waitUntil(() => exists('[data-component="picture-tool"] [data-slot="picture-image"]'), "the picture in the conversation");
  const description = (await window.evaluate(`(async () => { const all = document.querySelectorAll('[data-action="picture-description"]'); all[all.length - 1]?.click(); await new Promise((ok) => setTimeout(ok, 400)); return [...document.querySelectorAll('[data-component="picture-tool"] textarea')].at(-1)?.value ?? ""; })()`)) as string;
  tell(`the description the image model got: ${description}`);
  await Bun.sleep(600);
  const shot = await window.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, "window.png"), Buffer.from(shot.result.data, "base64"));
  fs.copyFileSync(job.file, path.join(out, path.basename(job.file)));

  // Leaving pictures puts the image engine away, and the model that writes has its card again.
  await click('[data-mode="text"]');
  const left = Date.now();
  await waitUntil(async () => (await watch()).image_loaded === null, "the image engine put away", 60_000);
  await waitUntil(async () => (await watch()).model.phase === "ready", "the model that writes back", 300_000);
  tell(`the card is the model's again ${((Date.now() - left) / 1000).toFixed(1)} s after leaving pictures`);
} catch (error) {
  const seen = await p?.evaluate("document.body.innerText.slice(-600)").catch(() => "");
  console.error(`FAILED: ${error}\n--- the page ---\n${seen}\n--- logs: ${path.join(data, "logs")}`);
  process.exitCode = 1;
} finally {
  p?.close();
  // with the tree of its processes: the engines and WebView2 go with the app
  spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  fs.rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
