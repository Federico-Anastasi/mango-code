// The harnesses in the app's real window (WebView2 CDP): Settings › Agent lists Mango Code's two and the user's own;
// «Duplica» makes one of the user's, whose base prompt is changed and saved; a model's detail in Models chooses it,
// and the choice stays when another choice of the model changes; the next conversation sends its prompt and measures
// its items under it; «Togli» is refused while a model uses it, and takes its switches with it once it goes. Pictures
// of the section at 1400 and 390 px. Fake engine. `off-screen bun test --cwd integration harness-page`, after
// `cargo build -p mango-code -p engine` in app/ and the agent's build.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { page, type Page } from "./cdp";
import { saveScreenshot, start, type Environment } from "./environment";
import { chatRequests, textOf } from "./requests";
import { atSizes, resizeWindow } from "./window";

const MINE = "mango-harness-1-copia";
const PROMPT = "You are a careful helper who works in the user's folder.";

let env: Environment;
let p: Page;
let mc: MangoCode;
let session: string;

const choices = () => {
  const file = path.join(env.data, "choices.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};
const settingsFile = () => JSON.parse(fs.readFileSync(path.join(env.data, "settings.json"), "utf8"));
const text = (selector: string) => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`) as Promise<string>;
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      await shot(`failed-${what.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
      throw new Error(`waited too long for: ${what}`);
    }
    await Bun.sleep(150);
  }
}

/** A click with the mouse, like a person, on the first element of `selector` whose text starts with `label`. */
async function mouseClick(selector: string, label = "") {
  const at = await p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim().startsWith(${JSON.stringify(label)}));
    el?.scrollIntoView({ block: "center" });
    const q = el?.getBoundingClientRect();
    return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  })()`);
  if (!at) throw new Error(`not on the page: ${selector} ${label}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/** A style of the model, clicked until it is saved: the row's controls stay off while the choice before is applied. */
async function clickUntil(style: string, done: () => boolean, what: string) {
  for (let attempt = 0; attempt < 10 && !done(); attempt++) {
    await mouseClick('[data-model-row="fake"] [data-action="settings-model-style"] button', style);
    for (let t = 0; t < 10 && !done(); t++) await Bun.sleep(200);
  }
  await waitUntil(done, what, 1000);
}

const shot = async (name: string) => saveScreenshot(env, name, (await p.send("Page.captureScreenshot", { format: "png" })).result.data);

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** A section of the settings, opened as a user does: from the gear of the project's conversation, then its entry. */
async function openSection(section: string) {
  if (!(await exists('[data-component="settings-page"]'))) {
    await p.send("Page.navigate", { url: `${env.agent}/${b64(env.project)}/session/${session}` });
    await waitUntil(() => exists('[data-action="titlebar-settings"]'), "the conversation");
    await Bun.sleep(1500);
    await mouseClick('[data-action="titlebar-settings"]');
    await waitUntil(() => exists('[data-component="settings-page"]'), "the settings");
  }
  await mouseClick(`[data-component="settings-page"] [data-section="${section}"]`);
  await waitUntil(() => exists(`[data-component="settings-page"] [data-pane="${section}"]`), `the section ${section}`);
}

/** The model's harness, chosen in its detail in Models. */
async function chooseHarness(name: string) {
  await openSection("models");
  await waitUntil(() => exists('[data-model-row="fake"]'), "the model");
  if (!(await exists('[data-model-row="fake"] [data-slot="settings-model-detail"]'))) await mouseClick('[data-model-row="fake"] button');
  await waitUntil(() => exists('[data-model-row="fake"] [data-action="settings-model-harness"]'), "the harness of the model");
  await mouseClick('[data-model-row="fake"] [data-action="settings-model-harness"] [data-component="select-v2"], [data-model-row="fake"] [data-action="settings-model-harness"][data-component="select-v2"]');
  await waitUntil(() => exists('[role="option"]'), "the harnesses to choose from");
  await mouseClick('[role="option"]', name);
}

beforeAll(async () => {
  env = await start([{ text: "Done." }, { text: "Done." }, { text: "Done." }], { window: true });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await resizeWindow(env.app.pid!, p, 1400, 900);
  mc = new MangoCode((await find(env.data))!);
  session = await mc.createSession(env.project, { title: "harness" });
  for await (const _ of mc.turn(session, env.project, "Hello", { model: "fake" }));
}, 200_000);

afterAll(() => {
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
});

test("Agent lists Mango Code's two harnesses; «Duplica» makes one of the user's, whose base prompt is saved", async () => {
  await openSection("agent");
  await waitUntil(() => exists(`[data-harness="mango-harness-2"]`), "the harnesses");
  expect(await text('[data-harness="mango-harness-2"]')).toContain("Nessun modello.");
  expect(await text('[data-harness="mango-harness-1"]')).toContain("Predefinito");

  await mouseClick('[data-harness="mango-harness-1"] [data-action="settings-harness-duplicate"]');
  await waitUntil(() => exists(`[data-harness="${MINE}"][aria-current="true"]`), "the copy, shown");
  expect(await text(`[data-harness="${MINE}"]`)).toContain("Nessun modello. Nato da Mango Harness 1.");
  expect(JSON.parse(fs.readFileSync(path.join(env.data, "harness", MINE, "harness.json"), "utf8"))).toEqual({
    name: "Mango Harness 1 (copia)",
    from: "mango-harness-1",
  });

  // the base prompt opens on its text, which this harness can change
  await waitUntil(() => exists('[data-component="settings-prompt"] [data-kind="base"]'), "the base prompt");
  await mouseClick('[data-component="settings-prompt"] [data-kind="base"] button');
  await waitUntil(() => exists('[data-kind="base"] textarea'), "the text of the base prompt");
  await p.evaluate(`(() => {
    const area = document.querySelector('[data-kind="base"] textarea');
    area.focus();
    area.value = ${JSON.stringify(PROMPT)};
    area.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await mouseClick('[data-kind="base"] [data-action="settings-harness-save"]');
  await waitUntil(() => fs.existsSync(path.join(env.data, "harness", MINE, "prompt.md")), "the prompt saved");
  expect(fs.readFileSync(path.join(env.data, "harness", MINE, "prompt.md"), "utf8")).toBe(PROMPT);

  // a switch of this harness is its own: «webfetch» off here only
  await mouseClick('[data-component="settings-prompt"] [data-kind="tools"] button');
  const webfetch = '[data-action="prompt-switch"][data-name="webfetch"] input';
  await waitUntil(() => exists(webfetch), "the tools of the harness");
  await p.evaluate(`document.querySelector(${JSON.stringify(webfetch)}).click()`);
  await waitUntil(() => settingsFile().harnesses?.[MINE]?.prompt?.tools?.webfetch === false, "the switch saved for the copy");
  expect(settingsFile().prompt?.tools?.webfetch).toBeUndefined();

  await p.evaluate(`document.querySelector('[data-component="settings-page"] [data-pane="agent"]').scrollTop = 0`);
  await atSizes(env.app.pid!, p, [[1400, 900], [390, 844]], async (width) => {
    await Bun.sleep(500);
    await shot(`harness-agent-${width}`);
  });
}, 120_000);

test("a model's detail chooses the harness, and changing another of its choices keeps it", async () => {
  await chooseHarness("Mango Harness 1 (copia)");
  await waitUntil(() => choices().models?.fake?.harness === MINE, "the harness chosen");
  await shot("harness-model-detail");

  await clickUntil("Preciso", () => choices().models?.fake?.style === "precise", "the style chosen");
  expect(choices().models.fake.harness).toBe(MINE);
  await clickUntil("Consigliato", () => choices().models?.fake?.style !== "precise", "the style back");
  expect(choices().models.fake.harness).toBe(MINE);

  // Agent says which model uses which harness
  await openSection("agent");
  await waitUntil(async () => !(await text(`[data-harness="${MINE}"]`)).includes("Nessun modello."), "the copy used by the model");
  expect(await text('[data-harness="mango-harness-1"]')).toContain("Nessun modello.");
}, 120_000);

test("the next conversation sends the harness's prompt, without its tool switched off, and measures its items under it", async () => {
  const id = await mc.createSession(env.project);
  for await (const _ of mc.turn(id, env.project, "Hello", { model: "fake" }));
  // the turn's request, not the title's: it is the one with the tools
  const sent = chatRequests(env.engineLog).filter((r) => (r.body.tools?.length ?? 0) > 0).at(-1)!.body;
  expect(textOf(sent.messages[0]!.content).startsWith(PROMPT)).toBe(true);
  expect(sent.tools!.map((t) => t.function.name)).not.toContain("webfetch");

  const settings = async () =>
    (await fetch(`${env.agent}/mango/settings?directory=${encodeURIComponent(env.project)}&harness=${MINE}`)).json();
  await waitUntil(
    async () => (await settings()).items.find((item: { type: string }) => item.type === "base")?.tokens > 0,
    "the base prompt measured under the copy",
  );
}, 120_000);

test("«Togli» is refused while a model uses the harness; once no model does, it goes with its switches", async () => {
  await openSection("agent");
  await mouseClick(`[data-harness="${MINE}"] button`);
  await waitUntil(() => exists(`[data-harness="${MINE}"] [data-action="settings-harness-remove"]`), "«Togli»");
  await mouseClick(`[data-harness="${MINE}"] [data-action="settings-harness-remove"]`);
  await waitUntil(() => exists('[data-component="settings-prompt"] [role="alert"]'), "the refusal");
  expect(await text('[data-component="settings-prompt"] [role="alert"]')).toContain("fake");
  expect(fs.existsSync(path.join(env.data, "harness", MINE))).toBe(true);

  await chooseHarness("Mango Harness 1");
  await waitUntil(() => choices().models?.fake?.harness === undefined, "the default harness again");
  await openSection("agent");
  await mouseClick(`[data-harness="${MINE}"] button`);
  await waitUntil(() => exists(`[data-harness="${MINE}"] [data-action="settings-harness-remove"]`), "«Togli»");
  await mouseClick(`[data-harness="${MINE}"] [data-action="settings-harness-remove"]`);
  await waitUntil(async () => !(await exists(`[data-harness="${MINE}"]`)), "the copy gone from the list");
  expect(fs.existsSync(path.join(env.data, "harness", MINE))).toBe(false);
  expect(settingsFile().harnesses?.[MINE]).toBeUndefined();
}, 120_000);
