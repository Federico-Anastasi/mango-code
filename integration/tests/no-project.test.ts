// Starting to write with no project, and the folders that cannot be projects, from the app's window (WebView2 CDP):
//  - with no project at all, "New conversation" opens a draft in the "Conversazioni" folder of the projects folder
//    (made the first time) and the conversation is found in the home under that name; a "New conversation" tab left
//    empty closes by itself when the user goes elsewhere;
//  - a folder too broad to be a project (the PC's own Desktop, and a folder the test makes pass for OneDrive) is refused
//    with a sentence and a subfolder is offered; the agent refuses the same on its own (the route and the conversation).
// The Windows picker is the real one (`selector.ps1` drives it). Fake engine, no GPU. Own ports (47650-47659).
// With `MC_PHOTOS=<folder>` it saves the screenshots (860 px and 390 px) there.
// `bun test --cwd integration`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { answer } from "./dialog";

const [AGENT, ENGINE, DEBUG] = [47650, 47651, 47652];
// A folder the test makes pass for the OneDrive folder (the agent reads the variable), and the PC's real Desktop (only read: it
// is refused, nothing is made there). The projects folder is one of the test's own, never the user's Documents.
const oneDrive = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mango-projects-"));
const desktop = path.join(os.homedir(), "Desktop");

let env: Environment;
let p: Page;
let projectsFolder = "";
let defaultFolder = "";

beforeAll(async () => {
  env = await start([{ text: "ok" }], {
    window: true,
    env: {
      MANGO_AGENT_PORT: String(AGENT),
      MANGO_ENGINE_PORT: String(ENGINE),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG}`,
      OneDrive: oneDrive,
      MANGO_PROJECTS_FOLDER: projectsRoot,
    },
  });
  p = await page(DEBUG, (t) => t.url.startsWith(env.agent));
  await Bun.sleep(3000);
  projectsFolder = await p.evaluate("window.__MANGO_DESKTOP__.projectsFolder()");
  expect(projectsFolder).toBe(projectsRoot);
  defaultFolder = path.join(projectsFolder, "Conversazioni");
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  // only what the test made: its projects folder and the fake OneDrive
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.rmSync(oneDrive, { recursive: true, force: true });
});

const text = () => p.evaluate("document.body.innerText") as Promise<string>;
const photo = async (name: string) => {
  if (!process.env.MC_PHOTOS) return;
  for (const [width, height, suffix] of [[860, 700, "860"], [390, 800, "390"]] as const) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(700);
    const r = await p.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(process.env.MC_PHOTOS, { recursive: true });
    fs.writeFileSync(path.join(process.env.MC_PHOTOS, `${name}-${suffix}.png`), Buffer.from(r.result.data, "base64"));
  }
  await p.send("Emulation.clearDeviceMetricsOverride");
};

async function click(label: string) {
  const r = await p.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(e => e.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(label)});
    if (!el) return 'not found';
    if (el.disabled) return 'disabled';
    el.click();
    return 'ok';
  })()`);
  expect(`${label}: ${r}`).toBe(`${label}: ok`);
}

async function waitUntil(condition: () => Promise<boolean>, timeout = 20_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    if (await condition()) return true;
    await Bun.sleep(300);
  }
  return false;
}

/** A click with the mouse, like a person: the tabs do not answer the DOM's `click()`. */
async function mouseClick(selector: string) {
  const at = await p.evaluate(`(() => {
    const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  return true;
}

const tabs = () => p.evaluate("document.querySelectorAll('[data-titlebar-tab]').length") as Promise<number>;

/** Types in the field of the dialog that is open. */
const typeInDialog = (value: string) =>
  p.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input, dialog input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

test("the home with no project invites to write, with one button", async () => {
  expect(await text()).toContain("Nuova conversazione");
  expect(await text()).not.toContain("crea un progetto");
  await photo("home-comincia-a-scrivere");
}, 60_000);

test("one click from the home to the first question, in a Conversazioni folder that is a project like the others", async () => {
  await click("Nuova conversazione");
  expect(await waitUntil(async () => (await p.evaluate("location.pathname")) === "/new-session")).toBe(true);
  expect(fs.existsSync(defaultFolder)).toBe(true);
  const composer = await waitUntil(async () => !!(await p.evaluate("document.querySelector('[data-component=\"prompt-input\"], [contenteditable=\"true\"]')")));
  expect(composer).toBe(true);
  expect(await tabs()).toBe(1);
  await photo("nuova-conversazione-senza-progetto");

  // the first question
  await p.evaluate(`(() => { const el = document.querySelector('[contenteditable="true"]'); el.focus(); document.execCommand('insertText', false, 'ciao'); })()`);
  await Bun.sleep(300);
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  expect(await waitUntil(async () => (await text()).includes("ok"), 60_000)).toBe(true);
}, 180_000);

test("the conversations with no project are found in the home under one name", async () => {
  await p.evaluate("document.querySelector('[data-action=\"home\"], [data-component=\"titlebar-home\"]')?.click()");
  await p.evaluate("history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate'))");
  expect(await waitUntil(async () => (await text()).includes("Conversazioni"))).toBe(true);
  await photo("home-conversazioni");
}, 60_000);

test("a New conversation tab left empty closes by itself when the user goes elsewhere", async () => {
  // the home hides the tabs: the conversation of the test is the one tab there is
  await click("Nuova conversazione");
  const opened = await waitUntil(async () => (await tabs()) === 2);
  expect(opened, `tabs: ${await tabs()} at ${await p.evaluate("location.pathname")}`).toBe(true);
  // back to the first conversation: the empty one goes away
  expect(await mouseClick("[data-titlebar-tab-link]")).toBe(true);
  expect(await waitUntil(async () => (await tabs()) === 1)).toBe(true);
  expect(await p.evaluate("location.pathname")).not.toBe("/new-session");
}, 60_000);

const get = (route: string, query: Record<string, string>) => fetch(`${env.agent}${route}?${new URLSearchParams(query)}`).then((r) => r.json());

test("the agent says which folders are too broad", async () => {
  expect(await get("/mango/folder", { directory: desktop })).toEqual({ broad: true });
  expect(await get("/mango/folder", { directory: os.homedir() })).toEqual({ broad: true });
  expect(await get("/mango/folder", { directory: path.parse(os.homedir()).root })).toEqual({ broad: true });
  expect(await get("/mango/folder", { directory: oneDrive })).toEqual({ broad: true });
  expect(await get("/mango/folder", { directory: env.project })).toEqual({ broad: false });
  expect(await get("/mango/folder", { directory: defaultFolder })).toEqual({ broad: false });
});

test("the agent makes no conversation and no repository in a folder too broad, whoever asks", async () => {
  const session = await fetch(`${env.agent}/session`, { method: "POST", headers: { "x-opencode-directory": oneDrive, "content-type": "application/json" } });
  expect(session.status).toBe(400);
  expect(fs.existsSync(path.join(oneDrive, ".git"))).toBe(false);
  const ok = await fetch(`${env.agent}/session`, { method: "POST", headers: { "x-opencode-directory": env.project, "content-type": "application/json" } });
  expect(ok.status).toBe(200);
});

async function picker(...args: string[]) {
  const r = await answer(env.app.pid!, ...args);
  expect(r.code, `${r.output}\nPage:\n${r.code ? await text() : ""}`).toBe(0);
}

test("choosing the Desktop as a project is refused, with the way out; cancelling adds nothing", async () => {
  await p.evaluate("history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate'))");
  await Bun.sleep(1000);
  await click("Apri una cartella esistente");
  await picker("-Path", desktop);
  expect(await waitUntil(async () => (await text()).includes("troppo ampia per essere un progetto: scegli o crea una sottocartella"))).toBe(true);
  await photo("cartella-troppo-ampia");
  await click("Annulla");
  await Bun.sleep(1000);
  expect(await text()).not.toContain("Desktop");
  expect(await get("/project", {}).catch(() => [])).not.toContainEqual(expect.objectContaining({ worktree: desktop }));
}, 120_000);

test("a broad folder becomes a subfolder with the name given, and that is the project", async () => {
  await click("Apri una cartella esistente");
  await picker("-Path", oneDrive);
  expect(await waitUntil(async () => (await text()).includes("troppo ampia"))).toBe(true);
  await typeInDialog("sito");
  await click("Crea e apri");
  expect(await waitUntil(async () => fs.existsSync(path.join(oneDrive, "sito")))).toBe(true);
  expect(await waitUntil(async () => (await text()).includes("sito"))).toBe(true);
  expect(await text()).not.toContain("troppo ampia");
  expect(fs.existsSync(path.join(oneDrive, ".git"))).toBe(false);
}, 120_000);

test("a name that already exists is refused in the dialog, with the reason", async () => {
  await click("Apri una cartella esistente");
  await picker("-Path", oneDrive);
  expect(await waitUntil(async () => (await text()).includes("troppo ampia"))).toBe(true);
  await typeInDialog("sito");
  await click("Crea e apri");
  expect(await waitUntil(async () => (await text()).includes("esiste già"))).toBe(true);
  await click("Annulla");
}, 120_000);
