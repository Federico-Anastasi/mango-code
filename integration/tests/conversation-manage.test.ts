// The user keeps their conversations in order from the Home, with the real mouse and keyboard: rename one from its menu (Cancel and
// an empty name change nothing), delete one (the confirmation names it; Cancel keeps it, Delete removes it), archive one (it leaves
// the list and waits under «Archiviate», where «Ripristina» brings it back and the menu deletes it for good), and search the
// conversations by a word (the results are the ones with the word, a word nobody has says so, a result opens its conversation).
// After a restart of the app every conversation is as it was left: the new name, the deleted one gone, the archived one archived.
// Fake engine; the conversations are made through the agent's API as a preparation. `off-screen bun test --cwd integration tests/conversation-manage.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-manage-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");

setDefaultTimeout(120_000);

let env: Environment;
let p: Page;
const TITLES = ["Alpha invoices", "Beta travel", "Gamma recipes", "Delta budget"];

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const seen = await p.evaluate("document.body.innerText.slice(0, 900)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", seen, "--- console ---", ...p.console.slice(-5)].join("\n"));
    }
    await Bun.sleep(150);
  }
}
const body = () => p.evaluate("document.body.innerText") as Promise<string>;
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
/** The titles the Home lists, in order. */
const listed = () => p.evaluate(`[...document.querySelectorAll('[data-component="home-session-row"]')].map((r) => r.textContent.trim())`) as Promise<string[]>;
/** The conversations the agent holds for the project, with whether each is archived. */
async function held() {
  const all = (await (await fetch(`${env.agent}/session?directory=${encodeURIComponent(site)}`)).json()) as { title: string; time: { archived?: number } }[];
  return all.map((s) => ({ title: s.title, archived: !!s.time.archived }));
}

/** A picture of the window in the folder `MANGO_TEST_SCREENSHOTS` names, if it is set. */
async function shot(name: string) {
  const folder = process.env.MANGO_TEST_SCREENSHOTS;
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  const taken = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(taken.result.data, "base64"));
}

async function mouse(at: { x: number; y: number }, down = true) {
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  if (!down) return;
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
/** The centre of the element `find` (an expression in the page) gives, brought into view. */
const centre = (find: string) =>
  p.evaluate(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: "center" }); const q = el.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
async function click(find: string, what: string) {
  const at = await centre(find);
  if (!at) throw new Error(`not on the page: ${what}`);
  await mouse(at);
}
/** The row of a conversation: the box that holds the row and its buttons. */
const rowBox = (title: string) => `[...document.querySelectorAll('[data-component="home-session-row"]')].find((r) => r.textContent.trim() === ${JSON.stringify(title)})?.parentElement`;
/** Over the row, so that its buttons show, and the click on one of them. */
async function onRow(title: string, action: string) {
  const row = await centre(`${rowBox(title)}`);
  if (!row) throw new Error(`no row «${title}»`);
  await mouse(row, false);
  await click(`${rowBox(title)}?.querySelector('[data-action="${action}"]')`, `${action} of «${title}»`);
}
/** The menu of a row, and its item by its words. */
async function fromMenu(title: string, item: string) {
  await onRow(title, "home-session-menu");
  await waitUntil(() => exists('[role="menuitem"]'), "the menu");
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(item)}))`, `the menu item ${item}`);
}
const dialogButton = (label: string) => click(`[...document.querySelectorAll('[role="dialog"] button, [data-component="dialog-v2"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`, `the dialog button ${label}`);
const key = async (name: string, code: number, text?: string) => {
  for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: code, ...(text && type === "keyDown" ? { text } : {}) });
};

async function home() {
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(async () => (await listed()).length > 0 || (await body()).includes("Nessuna conversazione"), "the list of conversations");
}

beforeAll(async () => {
  env = await start([{ text: "Noted." }], { window: true, args: [`${site}\\.`] });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  // preparation: the conversations exist, each with a message, as the user left them
  const mc = new MangoCode((await find(env.data))!);
  for (const title of TITLES) {
    const id = await mc.createSession(site, { title });
    for await (const step of mc.turn(id, site, `Please talk about ${title.toLowerCase()}`, { model: "fake" })) void step;
  }
  await home();
  await waitUntil(async () => (await listed()).length === TITLES.length, "the four conversations listed");
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the Home lists the conversations, the newest first", async () => {
  expect(await listed()).toEqual(["Delta budget", "Gamma recipes", "Beta travel", "Alpha invoices"]);
});

test("rename: the dialog starts from the current name; Cancel and an empty name change nothing; the new name is shown and kept by the agent", async () => {
  await fromMenu("Beta travel", "Rinomina");
  await waitUntil(() => exists('input[aria-label="Rinomina conversazione"]'), "the rename dialog");
  expect(await p.evaluate(`document.querySelector('input[aria-label="Rinomina conversazione"]').value`)).toBe("Beta travel");

  // an empty name cannot be saved
  await p.evaluate(`document.querySelector('input[aria-label="Rinomina conversazione"]').select()`);
  await key("Backspace", 8);
  await waitUntil(() => p.evaluate(`document.querySelector('input[aria-label="Rinomina conversazione"]').value === ""`) as Promise<boolean>, "the box emptied");
  expect(await p.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === "Salva").disabled`)).toBe(true);

  // Cancel leaves the name
  await p.send("Input.insertText", { text: "Typed but dropped" });
  await dialogButton("Annulla");
  await waitUntil(async () => !(await exists('input[aria-label="Rinomina conversazione"]')), "the dialog closed");
  expect(await listed()).toContain("Beta travel");
  expect(await listed()).not.toContain("Typed but dropped");
  expect((await held()).map((s) => s.title)).toContain("Beta travel");

  // a new name, typed over the old one and saved with the button
  await fromMenu("Beta travel", "Rinomina");
  await waitUntil(() => exists('input[aria-label="Rinomina conversazione"]'), "the rename dialog again");
  await p.evaluate(`document.querySelector('input[aria-label="Rinomina conversazione"]').select()`);
  await p.send("Input.insertText", { text: "Beta holidays" });
  await dialogButton("Salva");
  await waitUntil(async () => (await listed()).includes("Beta holidays"), "the new name in the list");
  expect(await listed()).not.toContain("Beta travel");
  expect((await held()).map((s) => s.title).sort()).toEqual(["Alpha invoices", "Beta holidays", "Delta budget", "Gamma recipes"]);
  // the order did not change: a rename is not a new message
  expect(await listed()).toEqual(["Delta budget", "Gamma recipes", "Beta holidays", "Alpha invoices"]);
});

test("rename with the keyboard: Enter saves", async () => {
  await fromMenu("Alpha invoices", "Rinomina");
  await waitUntil(() => exists('input[aria-label="Rinomina conversazione"]'), "the rename dialog");
  await p.evaluate(`document.querySelector('input[aria-label="Rinomina conversazione"]').select()`);
  await p.send("Input.insertText", { text: "Alpha taxes" });
  await key("Enter", 13, "\r");
  await waitUntil(async () => (await listed()).includes("Alpha taxes"), "the new name in the list");
  expect((await held()).map((s) => s.title)).toContain("Alpha taxes");
});

test("delete: the confirmation names the conversation; Cancel keeps it; Elimina removes it for good", async () => {
  await fromMenu("Gamma recipes", "Elimina");
  await waitUntil(async () => (await body()).includes("Eliminare «Gamma recipes»? Non si può annullare."), "the confirmation with the name");
  await dialogButton("Annulla");
  await waitUntil(async () => !(await body()).includes("Eliminare «Gamma recipes»"), "the confirmation closed");
  expect(await listed()).toContain("Gamma recipes");
  expect((await held()).map((s) => s.title)).toContain("Gamma recipes");

  await fromMenu("Gamma recipes", "Elimina");
  await waitUntil(async () => (await body()).includes("Eliminare «Gamma recipes»?"), "the confirmation again");
  await dialogButton("Elimina");
  await waitUntil(async () => !(await listed()).includes("Gamma recipes"), "the conversation gone from the list");
  expect((await held()).map((s) => s.title)).not.toContain("Gamma recipes");
  expect(await listed()).toEqual(["Delta budget", "Beta holidays", "Alpha taxes"]);
});

test("archive: the conversation leaves the list and waits under «Archiviate»; «Ripristina» brings it back", async () => {
  await onRow("Delta budget", "home-session-archive");
  await waitUntil(async () => !(await listed()).includes("Delta budget"), "the conversation off the list");
  expect(await held()).toContainEqual({ title: "Delta budget", archived: true });
  expect(await listed()).toEqual(["Beta holidays", "Alpha taxes"]);

  await click(`document.querySelector('[data-action="home-toggle-archived"]')`, "Archiviate");
  await waitUntil(async () => (await listed()).includes("Delta budget"), "the archived list");
  expect(await listed()).toEqual(["Delta budget"]);
  expect(await exists('[data-action="home-session-restore"]')).toBe(true);
  await click(`document.querySelector('[data-action="home-session-restore"]')`, "Ripristina");
  await waitUntil(async () => !(await listed()).includes("Delta budget") && (await body()).includes("Nessuna conversazione archiviata"), "the archive empty again");
  expect(await held()).toContainEqual({ title: "Delta budget", archived: false });

  await click(`document.querySelector('[data-action="home-toggle-archived"]')`, "Torna alle conversazioni");
  const shown = await waitUntil(async () => (await listed()).includes("Delta budget"), "the conversation back in the list", 10_000).then(() => true, () => false);
  await shot("01-restored-conversation-missing-from-list");
  // the list is read again, so that the tests that follow start from the same state whatever the screen showed
  await home();
  expect(await listed()).toEqual(["Delta budget", "Beta holidays", "Alpha taxes"]);
  expect(shown, "«Torna alle conversazioni» after «Ripristina» lists the restored conversation without reloading the page").toBe(true);
});

test("search: a word lists the conversations that have it, a word nobody has says so, a result opens its conversation", async () => {
  const field = 'input[aria-label="Cerca nelle conversazioni"]';
  await click(`document.querySelector('${field}')`, "the search box");
  await p.send("Input.insertText", { text: "holidays" });
  await waitUntil(() => exists('[data-component="home-session-search-row"]'), "a result");
  const results = () => p.evaluate(`[...document.querySelectorAll('[data-component="home-session-search-row"]')].map((r) => [...r.querySelectorAll('span')].map((s) => s.textContent.trim()).find(Boolean) ?? '')`) as Promise<string[]>;
  expect(await results()).toEqual(["Beta holidays"]);

  await p.evaluate(`document.querySelector('${field}').select()`);
  await p.send("Input.insertText", { text: "qqzzxx" });
  await waitUntil(async () => (await body()).includes("Nessuna conversazione trovata per qqzzxx"), "the sentence for no result");
  expect(await exists('[data-component="home-session-search-row"]')).toBe(false);

  // a word of a title, among conversations that all talk of other things
  await p.evaluate(`document.querySelector('${field}').select()`);
  await p.send("Input.insertText", { text: "Alpha" });
  await waitUntil(async () => (await results()).includes("Alpha taxes"), "the conversation with the word in its title");
  expect(await results()).toEqual(["Alpha taxes"]);

  await click(`document.querySelector('[data-component="home-session-search-row"]')`, "the result");
  await waitUntil(() => p.evaluate(`/\\/session\\/ses_/.test(location.pathname)`) as Promise<boolean>, "the conversation opened");
  await waitUntil(async () => (await body()).includes("Please talk about alpha invoices"), "its messages shown");
  expect(await body()).toContain("Noted.");
});

test("after a restart of the app the conversations are as they were left", async () => {
  // one more state to carry over: an archived conversation
  await home();
  await onRow("Delta budget", "home-session-archive");
  await waitUntil(async () => !(await listed()).includes("Delta budget"), "the conversation archived");
  const written = () => fs.statSync(path.join(env.data, "service.json")).mtimeMs;
  const before = written();
  p.close();
  await env.restart(async () => void 0);
  await waitUntil(() => fs.existsSync(path.join(env.data, "service.json")) && written() > before, "the app started again", 120_000);
  const agent = JSON.parse(fs.readFileSync(path.join(env.data, "service.json"), "utf8")).agent as string;
  env.agent = agent;
  p = await windowPage(env.cdp!, agent, 120_000);
  await waitUntil(async () => (await listed()).length === 2, "the list after the restart", 60_000);
  expect(await listed()).toEqual(["Beta holidays", "Alpha taxes"]);
  expect((await held()).sort((a, b) => a.title.localeCompare(b.title))).toEqual([
    { title: "Alpha taxes", archived: false },
    { title: "Beta holidays", archived: false },
    { title: "Delta budget", archived: true },
  ]);
  await click(`document.querySelector('[data-action="home-toggle-archived"]')`, "Archiviate");
  await waitUntil(async () => (await listed()).includes("Delta budget"), "the archived list after the restart");
  expect(await listed()).toEqual(["Delta budget"]);
  // the archived one is deleted from its own menu, with its confirmation
  await fromMenu("Delta budget", "Elimina");
  await waitUntil(async () => (await body()).includes("Eliminare «Delta budget»?"), "the confirmation");
  await dialogButton("Elimina");
  await waitUntil(async () => (await body()).includes("Nessuna conversazione archiviata"), "the archive empty");
  expect((await held()).map((s) => s.title)).not.toContain("Delta budget");
});
