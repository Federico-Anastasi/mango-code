// The settings page inside the app's window (WebView2 CDP): a whole page in a tab of its own, next to the conversation,
// with six sections and a search. Agent: the weight of a conversation, a row for tools, MCP servers, skills and
// instructions that opens on its entries with their weight in tokens, the switch that turns each one off for all
// projects, the "only this project" choice. General and Help: the alerts, and the switch of the automatic update.
// Models: the model on the computer with its choices, and «Gestisci i modelli…» of the model menu that opens the
// section. Fake engine. The screenshots stay in
// %TEMP%\mango-settings*.png. `bun test integration`, after `cargo build -p mango-code -p engine` in app/;
// `MANGO_OPENCODE=<folder with web\mango-code.exe>` tries a separate build of the agent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { resizeWindow } from "./window";

let env: Environment;
let mc: MangoCode;
let p: Page;
let session: string;

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const url = () => `${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}`;
const read = async () => (await fetch(url())).json();
const entry = (s: any, type: string, name: string) => s.items.find((v: any) => v.type === type && v.name === name);
const shot = async (name: string) => {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), `${name}.png`), Buffer.from(r.result.data, "base64"));
};

beforeAll(async () => {
  env = await start([{ text: "Done." }, { text: "Done." }], { window: true });
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

/** Click on an element of the page, by selector and text. */
const click = (selector: string, text = "") =>
  p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** Click with the mouse, like a person, where the element has stopped (same position in two readings). */
async function mouseClick(selector: string) {
  const center = () =>
    p.evaluate(`(() => {
      const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    })()`);
  let before = await center();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100);
    const now = await center();
    if (before && now && before.x === now.x && before.y === now.y) break;
    before = now;
  }
  const r = before;
  if (!r) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  return true;
}

/** Writes in a field as typing does: the page listens to `input`. */
const type = (selector: string, text: string) =>
  p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

const pane = (section: string) => `document.querySelector('[data-component="settings-page"] [data-pane="${section}"]')`;

test("the gear opens the settings as a page in a tab of its own, and the conversation keeps its tab", async () => {
  session = await mc.createSession(env.project, { title: "prompt" });
  for await (const _ of mc.turn(session, env.project, "Hello", { model: "fake" }));
  await resizeWindow(env.app.pid!, p, 1280, 900);
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${session}` });
  await Bun.sleep(4000);

  expect(await mouseClick('[data-action="titlebar-settings"]')).toBe(true);
  await waitFor(`document.querySelector('[data-component="settings-page"]') !== null`);
  expect(await p.evaluate(`location.pathname`)).toBe("/settings");
  // no dialog: the page is the content of the window
  expect(await p.evaluate(`document.querySelector('[data-component="dialog-v2"]')`)).toBeNull();
  const strip = await p.evaluate(`document.querySelector('[data-slot="titlebar-tabs"]').innerText`);
  expect(strip).toContain("Impostazioni");
  expect(strip).toContain("prompt");
  const sections = await p.evaluate(`[...document.querySelectorAll('[data-component="settings-page"] [data-section]')].map((b) => b.innerText.trim())`);
  expect(sections).toEqual(["Modelli", "Computer", "Agente", "Collegamenti", "Generale", "Aiuto"]);
  await shot("mango-settings-page");
}, 180_000);

test("Agent: a row for each kind of entry, with its weight, and the switches change what the model reads", async () => {
  for (let i = 0; i < 60 && entry(await read(), "tools", "bash")?.tokens == null; i++) await Bun.sleep(500);
  expect(await mouseClick('[data-component="settings-page"] [data-section="agent"]')).toBe(true);
  await waitFor(`document.querySelector('[data-component="settings-prompt"] [data-slot="prompt-total"]') !== null`);

  // the page text is Italian: the environment's language is "it"; the entries are in the rows, closed
  const closed = await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').innerText`);
  expect(closed).toContain("Ogni conversazione parte con");
  expect(closed).toContain("Strumenti");
  expect(closed).toContain("Server MCP");
  expect(closed).toContain("Skill");
  expect(closed).toContain("Istruzioni e plugin");
  expect(closed).toContain("Tutti i progetti");
  expect(closed).toMatch(/\d+ accesi su \d+/);
  expect(await p.evaluate(`document.querySelectorAll('[data-action="prompt-switch"]').length`)).toBe(0);
  // the tools row opens on its entries, each with its weight and one switch
  expect(await click('[data-component="settings-prompt"] [data-kind="tools"] button')).toBe(true);
  await waitFor(`document.querySelectorAll('[data-component="settings-prompt"] [data-action="prompt-switch"]').length > 5`);
  const text = await p.evaluate(`document.querySelector('[data-component="settings-prompt"]').innerText`);
  expect(text).toMatch(/webfetch/);
  expect(text).toMatch(/\d+ token/);
  await shot("mango-settings");

  // switches "webfetch" off for all folders
  const toggle = (name: string) => `document.querySelector('[data-action="prompt-switch"][data-name="${name}"] input')`;
  expect(await p.evaluate(`${toggle("webfetch")}.checked`)).toBe(true);
  await p.evaluate(`${toggle("webfetch")}.click()`);
  await waitFor(`${toggle("webfetch")}.checked === false`);
  expect(entry(await read(), "tools", "webfetch")).toMatchObject({ enabled: false, source: "default" });
  // the default file also holds the language: compare the prompt key
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "settings.json"), "utf8")).prompt).toEqual({ tools: { webfetch: false } });
  expect(fs.existsSync(path.join(env.project, ".mango", "settings.json"))).toBe(false);

  // "only this project": switches "skill" (the entry) off only here, and the folder's file is born
  expect(await click('[data-component="settings-prompt"] button', "Solo «project»")).toBe(true);
  await p.evaluate(`${toggle("skill")}.click()`);
  await waitFor(`${toggle("skill")}.checked === false`);
  expect(JSON.parse(fs.readFileSync(path.join(env.project, ".mango", "settings.json"), "utf8"))).toEqual({ prompt: { tools: { skill: false } } });
  await waitFor(`document.querySelector('[data-component="settings-prompt"]').innerText.includes('Cambiata solo per questa cartella')`);
  await p.evaluate(`${pane("agent")}.scrollTop = 1e6`);
  await Bun.sleep(300);
  await shot("mango-settings-bottom");

  // the next message no longer carries the two tools
  const before = fs.readFileSync(env.engineLog, "utf8").split("\n").filter((l) => l.includes('"/v1/chat/completions"')).length;
  const id2 = await mc.createSession(env.project);
  for await (const _ of mc.turn(id2, env.project, "Again", { model: "fake" }));
  const requests = fs.readFileSync(env.engineLog, "utf8").split("\n").filter((l) => l.includes('"/v1/chat/completions"')).map((l) => JSON.parse(l));
  const tools = requests[before].body.tools.map((t: any) => t.function.name);
  expect(tools).not.toContain("webfetch");
  expect(tools).not.toContain("skill");
  expect(tools).toContain("bash");

  // Mango Code's own MCP servers go by the name the user knows; the project's server keeps its own
  // the open row, not the piece of the weight bar that has the same kind
  const servers = `document.querySelector('[data-component="settings-prompt"] [data-kind="mcp"][data-open]')?.innerText ?? ""`;
  expect(await click('[data-component="settings-prompt"] [data-kind="mcp"] button')).toBe(true);
  await waitFor(`${servers}.includes("Documenti")`);
  const names = await p.evaluate(servers);
  for (const name of ["Browser", "Documenti", "Ricerca"]) expect(names).toContain(name);
  for (const raw of ["chrome-devtools", "documents", "web-search"]) expect(names).not.toContain(raw);
  expect(names).toContain("echo");
}, 180_000);

test("General: the three alerts have a notification and a sound each, saved by the page", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="general"]')).toBe(true);
  await waitFor(`${pane("general")} !== null`);
  const text = await p.evaluate(`${pane("general")}.innerText`);
  for (const row of ["Lingua", "Tema", "Grandezza", "Dettatura", "Mostra il ragionamento nella chat", "Avvisi", "Risposta pronta", "Serve un tuo permesso", "Errore"]) expect(text, row).toContain(row);
  // the row has two switches: the notification, then the sound
  const sound = `document.querySelectorAll('[data-action="settings-alert-errors"] input')[1]`;
  const before = await p.evaluate(`${sound}.checked`);
  await p.evaluate(`${sound}.click()`);
  await waitFor(`${sound}.checked === ${!before}`);
  await p.evaluate(`${sound}.click()`);
  await waitFor(`${sound}.checked === ${before}`);
}, 60_000);

test("General: «Grandezza» changes the window's zoom by the browser's steps, and follows a zoom changed elsewhere", async () => {
  const value = `document.querySelector('[data-slot="settings-zoom-value"]').innerText`;
  const zoom = () => p.evaluate(`window.__MANGO_DESKTOP__.zoom.get()`);
  await waitFor(`${value} === "100%"`);
  expect(await click('[data-action="settings-zoom"] button', "+")).toBe(true);
  await waitFor(`${value} === "110%"`);
  expect(await zoom()).toBeCloseTo(1.1, 2);
  // a zoom changed elsewhere (the keys Ctrl+ and Ctrl-, here the bridge itself): WebView2 tells it and the row follows
  await p.evaluate(`window.__MANGO_DESKTOP__.zoom.set(1)`);
  await waitFor(`${value} === "100%"`);
  expect(await zoom()).toBeCloseTo(1, 2);
}, 60_000);

test("General: the language and the theme change the page at once and are kept", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="general"]')).toBe(true);
  await waitFor(`${pane("general")} !== null`);
  // the language: the page reads in English, the app's choice (the agent's file) is English, and Italian brings it back
  const language = async () => (await (await fetch(`${env.agent}/mango/language`)).json()).language;
  expect(await mouseClick('[data-action="settings-language"] [data-slot="select-v2-value"]')).toBe(true);
  await waitFor(`!!document.querySelector('[role="option"]')`);
  expect(await click('[role="option"]', "English")).toBe(true);
  await waitFor(`${pane("general")}.innerText.includes("Language")`);
  expect(await language()).toBe("en");
  expect(await p.evaluate(`document.querySelector('[data-component="settings-page"] [data-section="models"]').innerText.trim()`)).toBe("Models");
  expect(await mouseClick('[data-action="settings-language"] [data-slot="select-v2-value"]')).toBe(true);
  await waitFor(`!!document.querySelector('[role="option"]')`);
  expect(await click('[role="option"]', "Italiano")).toBe(true);
  await waitFor(`${pane("general")}.innerText.includes("Lingua")`);
  expect(await language()).toBe("it");

  // the theme: three choices, the window follows the one chosen
  const mode = () => p.evaluate(`document.documentElement.dataset.colorScheme`) as Promise<string>;
  const choose = (label: string) => click('[data-action="settings-color-scheme"] [role="radio"], [data-action="settings-color-scheme"] button', label);
  const items = await p.evaluate(`[...document.querySelectorAll('[data-action="settings-color-scheme"] [role="radio"], [data-action="settings-color-scheme"] button')].map((e) => e.innerText.trim())`);
  expect(items).toEqual(["Sistema", "Chiaro", "Scuro"]);
  expect(await choose("Chiaro")).toBe(true);
  await waitFor(`document.documentElement.dataset.colorScheme === "light"`);
  expect(await choose("Scuro")).toBe(true);
  await waitFor(`document.documentElement.dataset.colorScheme === "dark"`);
  expect(await mode()).toBe("dark");
  // the choice outlives the page
  await p.send("Page.reload");
  await waitFor(`!!document.querySelector('[data-action="settings-color-scheme"]')`, 30_000);
  expect(await mode()).toBe("dark");
  expect(await choose("Sistema")).toBe(true);
  await waitFor(`document.querySelector('[data-action="settings-color-scheme"] [aria-checked="true"], [data-action="settings-color-scheme"] [aria-pressed="true"], [data-action="settings-color-scheme"] [data-checked]')?.innerText.includes("Sistema")`);
}, 90_000);

test("Help: the automatic update is a switch, and the choice is the app's", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="help"]')).toBe(true);
  await waitFor(`${pane("help")} !== null`);
  const text = await p.evaluate(`${pane("help")}.innerText`);
  for (const row of ["Aggiorna da solo", "Come si usa", "Registri"]) expect(text, row).toContain(row);
  const automatic = `document.querySelector('[data-action="settings-update-automatic"] input')`;
  const state = () => p.evaluate(`window.__MANGO_DESKTOP__.updates.state()`);
  expect((await state()).automatic).toBe(true);
  expect(await p.evaluate(`${automatic}.checked`)).toBe(true);
  await p.evaluate(`${automatic}.click()`);
  await waitFor(`${automatic}.checked === false`);
  expect((await state()).automatic).toBe(false);
  // the choice is in the app's file, not in the page
  const choices = path.join(env.data, "choices.json");
  expect(JSON.parse(fs.readFileSync(choices, "utf8")).update.automatic).toBe(false);
  // back as it was, for the tests after this one
  await p.evaluate(`${automatic}.click()`);
  await waitFor(`${automatic}.checked === true`);
  expect((await state()).automatic).toBe(true);
}, 60_000);

test("Computer: the engine is this version's, and with nothing to update there is no button to update it", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="computer"]')).toBe(true);
  await waitFor(`${pane("computer")}?.innerText.includes("è quello di questa versione di Mango Code")`, 30_000);
  expect(await p.evaluate(`!!document.querySelector('[data-action="settings-computer-update-engine"]')`)).toBe(false);
  expect(await p.evaluate(`${pane("computer")}.innerText`)).not.toContain("Cerca una versione nuova");
}, 60_000);

test("the search finds a setting of another section and brings its row into view", async () => {
  await type('[data-action="settings-search"] input', "dettatura");
  await waitFor(`document.querySelector('[data-slot="settings-search-results"]')?.innerText.includes("Dettatura")`);
  expect(await click('[data-slot="settings-search-results"] button', "Dettatura")).toBe(true);
  await waitFor(`${pane("general")} !== null`);
  expect(await p.evaluate(`new URL(location.href).searchParams.get("section")`)).toBe("general");
  await waitFor(`!!document.querySelector('[data-component="settings-page"] [data-found]')`, 5000);
  // the same result chosen again brings its row into view and marks it again
  await waitFor(`!document.querySelector('[data-component="settings-page"] [data-found]')`, 5000);
  await type('[data-action="settings-search"] input', "dettatura");
  expect(await click('[data-slot="settings-search-results"] button', "Dettatura")).toBe(true);
  await waitFor(`!!document.querySelector('[data-component="settings-page"] [data-found]')`, 5000);
  // a word the page does not show finds its row: «zoom» is «Grandezza»
  await type('[data-action="settings-search"] input', "zoom");
  await waitFor(`document.querySelector('[data-slot="settings-search-results"]')?.innerText.includes("Grandezza")`);
  // a search that finds nothing says so
  await type('[data-action="settings-search"] input', "zzzz");
  await waitFor(`document.querySelector('[data-component="settings-page"]').innerText.includes("Nessuna impostazione trovata.")`);
  await type('[data-action="settings-search"] input', "");
}, 60_000);

test("Models: the model on the computer opens its choices, and a style chosen there is saved", async () => {
  expect(await mouseClick('[data-component="settings-page"] [data-section="models"]')).toBe(true);
  await waitFor(`document.querySelector('[data-model-row]') !== null`, 30_000);
  const text = await p.evaluate(`${pane("models")}.innerText`);
  expect(text).toContain("Sul computer");
  expect(text).toContain("Un altro modello");
  const key = await p.evaluate(`document.querySelector('[data-model-row]').dataset.modelRow`);
  expect(await click(`[data-model-row="${key}"] button`)).toBe(true);
  await waitFor(`document.querySelector('[data-slot="settings-model-detail"]') !== null`);
  expect(await p.evaluate(`document.querySelector('[data-slot="settings-model-detail"]').innerText`)).toContain("Stile delle risposte");
  await shot("mango-settings-models");
  expect(await click('[data-action="settings-model-style"] button', "Preciso")).toBe(true);
  const choices = path.join(env.data, "choices.json");
  for (let i = 0; i < 40 && !(fs.existsSync(choices) && fs.readFileSync(choices, "utf8").includes("precise")); i++) await Bun.sleep(250);
  expect(JSON.parse(fs.readFileSync(choices, "utf8")).models[key].style).toBe("precise");
  await waitFor(`document.querySelector('[data-action="settings-model-style"] [aria-pressed="true"]')?.innerText.includes("Preciso")`);
  // back as it was, for the tests after this one
  expect(await click('[data-action="settings-model-style"] button', "Consigliato")).toBe(true);
  for (let i = 0; i < 40 && fs.readFileSync(choices, "utf8").includes("precise"); i++) await Bun.sleep(250);

  // «Togli dal computer» asks in a window of the app, with the model's name and the space it frees; «Annulla» keeps it
  const label = await p.evaluate(`document.querySelector('[data-model-row="${key}"] [data-slot="settings-v2-row-title"]')?.innerText`);
  // the row's controls come back once the choice above is read again
  await waitFor(`document.querySelector('[data-action="settings-model-remove"]')?.disabled === false`);
  expect(await click('[data-action="settings-model-remove"]')).toBe(true);
  await waitFor(`document.querySelector('[data-action="settings-model-remove-confirm"]') !== null`);
  const confirm = `document.querySelector('[data-action="settings-model-remove-confirm"]').closest('[role="dialog"]')`;
  const dialog = await p.evaluate(`${confirm}.innerText`);
  expect(dialog).toContain(label);
  expect(dialog).toContain("Libera");
  await shot("mango-settings-remove");
  const cancel = `[...${confirm}.querySelectorAll("button")].find((b) => b.innerText.includes("Annulla"))`;
  expect(await p.evaluate(`(() => { const b = ${cancel}; b?.click(); return !!b; })()`)).toBe(true);
  await waitFor(`document.querySelector('[data-action="settings-model-remove-confirm"]') === null`);
  await Bun.sleep(1000);
  expect(await p.evaluate(`!!document.querySelector('[data-model-row="${key}"]')`)).toBe(true);
}, 90_000);

test("the search finds a choice of a model: the first model opens and the choice comes into view", async () => {
  await type('[data-action="settings-search"] input', "dove gira");
  await waitFor(`document.querySelector('[data-slot="settings-search-results"]')?.innerText.includes("Dove gira")`);
  expect(await click('[data-slot="settings-search-results"] button', "Dove gira")).toBe(true);
  // the list comes from the agent a moment after the section: the row is found when it is there
  await waitFor(`document.querySelector('[data-slot="settings-model-detail"]') !== null`, 30_000);
  await waitFor(`document.querySelector('[data-component="settings-page"] [data-found]')?.innerText.includes("Dove gira")`, 10_000);
}, 60_000);

test("«Gestisci i modelli…» of the model menu opens the settings on Models", async () => {
  await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${session}` });
  await waitFor(`!!document.querySelector('[data-action="prompt-model"]')`);
  expect(await mouseClick('[data-action="prompt-model"]')).toBe(true);
  await waitFor(`document.querySelector('[data-slot="model-selector-scroll"]') !== null`);
  const manage = '[role="menu"] [data-option-key="action:manage"]';
  expect(await p.evaluate(`document.querySelector('${manage}')?.innerText`)).toContain("Gestisci i modelli");
  expect(await mouseClick(manage)).toBe(true);
  await waitFor(`${pane("models")} !== null`);
  expect(await p.evaluate(`new URL(location.href).searchParams.get("section")`)).toBe("models");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 60_000);
