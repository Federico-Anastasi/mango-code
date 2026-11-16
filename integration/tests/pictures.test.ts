// Pictures in a conversation, in the app's real window (WebView2 CDP), with the mouse and the keyboard like a person: the
// choice «Testo / Immagine» in the box, the request that becomes a picture (rewritten by a model that writes, or as it
// is), the question of the model that rewrites, the picture shown while it forms and when it is done, the description
// that can be corrected, «Rifai», stopping, the engine put away when the user leaves pictures, a conversation opened
// again, and the box with no model that draws. Fake engines, no GPU needed: the fake image engine draws real PNGs
// (`FAKE_SD_PNG`) and keeps the request it got in the file, which is read back here. Screenshots of every state go to the
// folder in `MANGO_SHOTS`, if set. `bun test --cwd integration tests/pictures.test.ts`, after
// `cargo build -p mango-code -p engine -p images` in app/ and `app\scripts\build-agent.ps1`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { page, type Page } from "./cdp";
import { start, type Environment } from "./environment";
import { atSizes } from "./window";

// The fake model that writes answers what rewrites a request: a description, or (for a «stemma») a question first.
const SCRIPT = [
  { if: "OPTIONS: Rosso", text: "PROMPT: a red logo for a pizzeria, flat vector" },
  { if: "stemma", text: "QUESTION: Di che colore?\nOPTIONS: Rosso | Blu" },
  { summary: "PROMPT: an old neon pizzeria sign at night, seen from the street, photograph" },
];
const DESCRIPTION = "an old neon pizzeria sign at night, seen from the street, photograph";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-pictures-"));
const site = path.join(root, "pizzeria-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "index.html"), "<h1>hello</h1>");
const pictures = path.join(site, "immagini");

let env: Environment;
let p: Page;
const shots = process.env.MANGO_SHOTS;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 60_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const seen = await p.evaluate("document.body.innerText.slice(-700)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", seen, "--- console ---", ...p.console.slice(-5)].join("\n"));
    }
    await Bun.sleep(120);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const text = (selector: string) => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`) as Promise<string>;
const body = () => p.evaluate("document.body.innerText") as Promise<string>;
const control = async (route: string) => (await fetch(`${env.engine}/control/${route}`)).json();
/** The pictures in the folder, in the order they were made. */
const files = () =>
  fs.existsSync(pictures)
    ? fs.readdirSync(pictures).filter((name) => name.endsWith(".png")).sort((a, b) => fs.statSync(path.join(pictures, a)).mtimeMs - fs.statSync(path.join(pictures, b)).mtimeMs)
    : [];

/** A click with the mouse, like a person, on the first element of `selector` whose text starts with `label` (any, if empty). */
async function click(selector: string, label = "") {
  const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.innerText ?? "").trim().startsWith(${JSON.stringify(label)}))`;
  // brought into view first, and measured when the page has stopped moving
  await p.evaluate(`${find}?.scrollIntoView({ block: "center" })`);
  await Bun.sleep(250);
  const at = await p.evaluate(`(() => { const q = (${find})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  if (!at) throw new Error(`not on the page: ${selector} ${label}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

const FIELD = '[data-component="prompt-input"]';
/** Writes in the box of the conversation, like a person: a click in it, then the keys. */
async function write(words: string) {
  await click(FIELD);
  await p.evaluate(`(() => { const e = document.querySelector('${FIELD}'); e.focus(); document.getSelection().selectAllChildren(e); })()`);
  await p.send("Input.insertText", { text: words });
}
async function key(name: string, code: number) {
  for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: code });
}
/** The send button, pressed again if the words are still in the box a few seconds later (the page was still settling). */
async function send() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await click('[data-action="prompt-submit"]');
    for (let t = 0; t < 4000; t += 200) {
      if (((await p.evaluate(`document.querySelector('${FIELD}')?.innerText.trim() ?? ""`)) as string) === "") return;
      await Bun.sleep(200);
    }
  }
}
/** The words are written and the box lets them go: the send button is on. */
const sendOn = () => waitUntil(() => p.evaluate(`document.querySelector('[data-action="prompt-submit"]')?.disabled === false`) as Promise<boolean>, "the send button on");

const pressed = (selector: string) => p.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-pressed") === "true"`) as Promise<boolean>;
const placeholder = () => p.evaluate(`(() => { const e = document.querySelector('${FIELD}'); return e?.parentElement?.innerText.replace(e.innerText, "").trim() ?? ""; })()`) as Promise<string>;

/** What the fake image engine got: it keeps the request in the file it drew (an `iTXt` chunk, `fake-request`). */
function received(file: string): { prompt: string; width: number; height: number; seed: number } {
  const png = fs.readFileSync(path.join(pictures, file));
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    if (kind === "iTXt") {
      const data = png.subarray(at + 8, at + 8 + length);
      const split = data.indexOf(0);
      return JSON.parse(data.subarray(split + 5).toString("utf8")).asked;
    }
    at += length + 12;
  }
  throw new Error(`no request in ${file}`);
}

/** The state of the page as it looks, in the dark and the light theme, at 1280 and 390 px. */
async function shoot(name: string, scroll = "") {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await atSizes(env.app.pid!, p, [[1280, 900], [390, 844]] as const, async (width) => {
    for (const scheme of ["dark", "light"]) {
      await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await Bun.sleep(500);
      if (scroll) await p.evaluate(`[...document.querySelectorAll(${JSON.stringify(scroll)})].at(-1)?.scrollIntoView({ block: "end" })`);
      await Bun.sleep(200);
      const shot = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(shots, `${name}-${width}-${scheme}.png`), Buffer.from(shot.result.data, "base64"));
    }
  });
  await p.send("Emulation.setEmulatedMedia", { features: [] });
}

/** From the Home: «Nuova conversazione», and the box to write in. */
async function newConversation() {
  // the window shows its first page before the folder the app was started with: a conversation made there has no project
  await waitUntil(async () => (await body()).includes("pizzeria-site"), "the project open", 60_000);
  await click("button", "Nuova conversazione");
  await waitUntil(() => exists(FIELD), "the box to write in");
}

const ROW = '[data-component="picture-tool"]';
const lastRowText = () => p.evaluate(`[...document.querySelectorAll('${ROW}')].at(-1)?.innerText ?? ""`) as Promise<string>;
const rows = () => p.evaluate(`document.querySelectorAll('${ROW}').length`) as Promise<number>;
/** The first conversation, known from when it is the only one. */
let first: string | undefined;
/** Its pictures as the agent holds them, with how each ended: the timeline draws only the rows in view. */
async function turns() {
  first ??= (await (await fetch(`${env.agent}/session?directory=${encodeURIComponent(site)}`)).json())[0].id as string;
  const history = (await (await fetch(`${env.agent}/session/${first}/message?directory=${encodeURIComponent(site)}`)).json()) as { parts: { type: string; tool?: string; state?: { status: string } }[] }[];
  return history.flatMap((m) => m.parts).filter((part) => part.type === "tool" && part.tool === "image_generate").map((part) => part.state?.status);
}
const made = async () => (await turns()).filter((status) => status === "completed").length;

beforeAll(async () => {
  env = await start(SCRIPT, {
    window: true,
    context: 65536,
    imageModels: ["pic1", "pic2"],
    imagePresent: ["pic1", "pic2"],
    args: [`${site}\\.`],
    env: { FAKE_SD_PNG: "1", FAKE_SD_STEP_MS: "700" },
  });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
  await waitUntil(async () => (await control("state")).model.phase === "ready", "the model ready");
  await newConversation();
}, 300_000);

afterAll(() => {
  p?.close();
  env?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("«Immagine» in the box: the placeholder, the models on the computer, the format and the size; «Testo» gives the box back", async () => {
  expect(await exists('[data-action="prompt-mode"]')).toBe(true);
  expect(await pressed('[data-mode="text"]')).toBe(true);
  expect(await exists('[data-action="prompt-picture-format"]')).toBe(false);
  await shoot("box-text");

  await click('[data-mode="picture"]');
  await waitUntil(() => pressed('[data-mode="picture"]'), "«Immagine» chosen");
  expect(await placeholder()).toContain("Descrivi l'immagine…");
  // the format and the size are segments, with their words; the defaults are chosen
  expect((await text('[data-action="prompt-picture-format"]')).replace(/\s+/g, " ")).toBe("Quadrata Verticale Orizzontale");
  expect((await text('[data-action="prompt-picture-size"]')).replace(/\s+/g, " ")).toBe("Piccola Grande");
  expect(await pressed('[data-picture-format="square"]')).toBe(true);
  expect(await pressed('[data-picture-size="small"]')).toBe(true);
  // no radio dots, no «+» (nothing to attach to a request for a picture)
  expect(await exists('[data-action="prompt-attach"]')).toBe(false);
  // the model menu lists the models that make pictures, the default first chosen
  expect(await text('[data-action="prompt-picture-model"]')).toContain("Picture pic1");
  await click('[data-action="prompt-picture-model"]');
  await waitUntil(() => exists('[data-model="pic2"]'), "the menu open");
  expect(await p.evaluate(`[...document.querySelectorAll('[data-model]')].map((e) => e.innerText.trim())`)).toEqual(["Picture pic1", "Picture pic2"]);
  await shoot("box-picture-menu");
  await click('[data-model="pic2"]');
  await waitUntil(async () => (await text('[data-action="prompt-picture-model"]')).includes("Picture pic2"), "the model chosen");
  await click('[data-action="prompt-picture-model"]');
  await waitUntil(() => exists('[data-model="pic1"]'), "the menu open again");
  await click('[data-model="pic1"]');
  await waitUntil(async () => (await text('[data-action="prompt-picture-model"]')).includes("Picture pic1"), "the model chosen again");
  await shoot("box-picture");

  await click('[data-mode="text"]');
  await waitUntil(() => pressed('[data-mode="text"]'), "«Testo» chosen");
  expect(await exists('[data-action="prompt-picture-format"]')).toBe(false);
  expect(await exists('[data-action="prompt-attach"]')).toBe(true);
}, 120_000);

test("a request in the box makes a picture: the words are rewritten, the steps are shown, the picture and the file appear", async () => {
  await click('[data-mode="picture"]');
  await click('[data-picture-format="portrait"]');
  await click('[data-picture-size="large"]');
  await waitUntil(async () => (await pressed('[data-picture-format="portrait"]')) && (await pressed('[data-picture-size="large"]')), "the choices made");
  await write("Un'insegna al neon per una pizzeria, di sera, vista dalla strada");
  await shoot("writing");
  await send();

  // the request is the user's bubble, the turn is one row of the conversation
  await waitUntil(async () => (await rows()) === 1, "the row of the picture");
  expect(await body()).toContain("Un'insegna al neon per una pizzeria, di sera, vista dalla strada");
  await waitUntil(async () => /Passo \d di 4/.test(await text(ROW)), "the steps");
  expect(await text(ROW)).toContain("Immagine");
  // the frame has the proportions of the picture from the start (720 x 1280)
  const frame = (await p.evaluate(`(() => { const q = document.querySelector('${ROW} [data-slot="picture-frame"]').getBoundingClientRect(); return [q.width, q.height]; })()`)) as number[];
  expect(frame[1]! / frame[0]!).toBeGreaterThan(1.6);
  expect(frame[1]!).toBeLessThanOrEqual(322);
  await waitUntil(() => exists(`${ROW} [data-slot="picture-preview"]`), "the preview");
  await shoot("drawing", ROW);

  await waitUntil(() => exists(`${ROW} [data-slot="picture-image"]`), "the picture", 90_000);
  const done = (await p.evaluate(`(() => { const i = document.querySelector('${ROW} [data-slot="picture-image"]'); return [i.complete, i.naturalWidth, i.naturalHeight]; })()`)) as number[];
  expect(done[0]).toBe(true);
  expect(done[2]! / done[1]!).toBeGreaterThan(1.6);
  // the file is in the folder of the pictures, and the image engine got the description the model wrote
  expect(files()).toHaveLength(1);
  const got = received(files()[0]!);
  expect(got.prompt).toBe(DESCRIPTION);
  expect([got.width, got.height]).toEqual([720, 1280]);
  // the muted line, the file among the files of the turn
  expect(await text(ROW)).toMatch(/\d+ s · 720 × 1280/);
  // how long it took is said once, under the picture: the heading of the row leaves it to that line
  expect((await text(ROW)).match(/\d+ s\b/g)).toHaveLength(1);
  await waitUntil(async () => (await body()).includes(files()[0]!), "the file among the files of the turn");
  expect(await body()).toContain("Mostra nella cartella");
  expect(await exists(`${ROW} [data-action="picture-description"]`)).toBe(true);
  expect(await text(ROW)).not.toContain(DESCRIPTION);
  await shoot("done", ROW);
  // the box is the user's again, on the same side
  expect(await pressed('[data-mode="picture"]')).toBe(true);
  expect((await control("state")).image_loaded).toBe("pic1");
}, 180_000);

test("a click on the picture opens its file in the panel", async () => {
  await click(`${ROW} [data-action="picture-open"]`);
  // the panel is native, outside the page: the bridge tells what it shows
  const shown = async () => decodeURI(((await p.evaluate(`window.__MANGO_DESKTOP__.preview.state()`)) as { url: string }).url);
  await waitUntil(async () => (await shown()).endsWith(`/${files()[0]}`), "the picture in the panel", 20_000);
  // the page keeps its conversation
  expect(await exists(`${ROW} [data-slot="picture-image"]`)).toBe(true);
  await shoot("panel", ROW);
  // closed again: in a narrow window the panel takes the place of the conversation
  await click('[aria-label="Chiudi l\'anteprima"]');
  await waitUntil(async () => !(await exists('[aria-label="Chiudi l\'anteprima"]')), "the panel closed");
}, 60_000);

test("the description is collapsed, opens, and can be corrected; «Rifai» draws again with the stored one, a new seed", async () => {
  await click(`${ROW} [data-action="picture-description"]`);
  await waitUntil(() => exists(`${ROW} textarea`), "the description opened");
  expect(await p.evaluate(`document.querySelector('${ROW} textarea').value`)).toBe(DESCRIPTION);
  await shoot("description", ROW);
  await click(`${ROW} [data-action="picture-description"]`);
  await waitUntil(async () => !(await exists(`${ROW} textarea`)), "the description closed");

  await click(`${ROW} [data-action="picture-again"]`);
  await waitUntil(async () => files().length === 2, "the second picture", 90_000);
  expect(files()[1]).toMatch(/-2\.png$/);
  const again = received(files()[1]!);
  expect(again.prompt).toBe(DESCRIPTION);
  // the same format and size, another picture
  expect([again.width, again.height]).toEqual([720, 1280]);
  await waitUntil(async () => (await made()) === 2 && !(await exists(`${ROW} [data-slot="picture-preview"]`)), "the row of the second picture done");
}, 180_000);

test("a corrected description is what the image engine receives, nothing rewrites it", async () => {
  await waitUntil(async () => !(await body()).includes("Passo "), "the conversation quiet");
  const opened = () => exists(`${ROW} textarea`);
  await p.evaluate(`(() => { const all = document.querySelectorAll('${ROW} [data-action="picture-description"]'); all[all.length - 1].scrollIntoView({ block: "center" }); })()`);
  await p.evaluate(`(() => { const all = document.querySelectorAll('${ROW} [data-action="picture-description"]'); const q = all[all.length - 1].getBoundingClientRect(); window.__at = { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
  const at = await p.evaluate("window.__at");
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  await waitUntil(opened, "the description opened");
  const corrected = "a green neon pizzeria sign, rainy night, wide angle";
  await p.evaluate(`(() => { const all = document.querySelectorAll('${ROW} textarea'); const t = all[all.length - 1]; t.focus(); t.select(); })()`);
  await p.send("Input.insertText", { text: corrected });
  await click(`[data-action="picture-again-description"]`);
  await waitUntil(async () => files().length === 3, "the third picture", 90_000);
  expect(received(files()[2]!).prompt).toBe(corrected);
  await waitUntil(async () => (await made()) === 3 && !(await exists(`${ROW} [data-slot="picture-preview"]`)), "the third row done");
}, 180_000);

test("a question of the model that rewrites is shown by the dock of the conversation; an option answers it and the picture is made", async () => {
  await click('[data-mode="picture"]');
  await write("Uno stemma per la pizzeria");
  await send();
  await waitUntil(async () => (await body()).includes("Di che colore?"), "the question", 60_000);
  expect(await body()).toContain("Rosso");
  expect(await body()).toContain("Blu");
  await shoot("question");
  await click('[data-slot="question-option"]', "Rosso");
  await click('[data-slot="question-footer-actions"] button', "Invia");
  await waitUntil(async () => files().length === 4, "the picture after the answer", 90_000);
  expect(received(files()[3]!).prompt).toBe("a red logo for a pizzeria, flat vector");
  await waitUntil(async () => !(await body()).includes("Di che colore?") && (await made()) === 4, "the dock closed and the row done");
}, 180_000);

test("a stop while the picture is drawn cancels the job, the row says it was stopped and the box works again", async () => {
  await write("Un'insegna blu");
  await sendOn();
  await send();
  await waitUntil(async () => /Passo \d di 4/.test(await lastRowText()), "the steps", 60_000);
  // the send button is the stop one while the conversation works
  await send();
  await waitUntil(async () => (await lastRowText()).includes("Fermata"), "the row says it was stopped", 30_000);
  await waitUntil(async () => (await control("image")).jobs.some((job: { status: string }) => job.status === "cancelled"), "the job cancelled");
  expect(files()).toHaveLength(4);
  await shoot("stopped", ROW);
  // the box is the user's again
  await write("Un'insegna rossa");
  await waitUntil(() => p.evaluate(`document.querySelector('[data-action="prompt-submit"]').disabled === false`) as Promise<boolean>, "the send button on");
}, 120_000);

test("a question left open when the turn is stopped does not stay on the screen", async () => {
  await write("Uno stemma grande");
  await sendOn();
  await send();
  await waitUntil(async () => (await body()).includes("Di che colore?"), "the question", 60_000);
  // the dock takes the place of the box: the turn is stopped from outside, as another client would, and no
  // «question rejected» arrives: the session going idle is what closes the dock
  const session = (await (await fetch(`${env.agent}/session?directory=${encodeURIComponent(site)}`)).json())[0].id as string;
  expect((await fetch(`${env.agent}/session/${session}/abort?directory=${encodeURIComponent(site)}`, { method: "POST" })).ok).toBe(true);
  await waitUntil(async () => !(await body()).includes("Di che colore?"), "the dock closed with the stop", 30_000);
  await waitUntil(() => exists(FIELD), "the box back");
  expect(await lastRowText()).toContain("Fermata");
  await shoot("question-stopped", ROW);
}, 120_000);

test("when the user leaves pictures the engine that draws is put away: «Testo», then the Home", async () => {
  // a picture stays on the engine for the next one
  await write("Un'insegna gialla");
  await sendOn();
  await send();
  await waitUntil(async () => files().length === 5, "the picture", 90_000);
  await waitUntil(async () => (await control("state")).image_loaded === "pic1", "the engine on");
  // back to «Testo»: put away, once
  await click('[data-mode="text"]');
  await waitUntil(async () => (await control("state")).image_loaded === null, "the engine put away", 15_000);

  // another picture, then the Home: the same
  await click('[data-mode="picture"]');
  await write("Un'insegna verde");
  await sendOn();
  await send();
  await waitUntil(async () => files().length === 6, "the picture", 90_000);
  await waitUntil(async () => (await control("state")).image_loaded === "pic1", "the engine on again");
  // the «Home» tab of the title bar: the leaf that says just that
  await p.evaluate(`(() => { const e = [...document.querySelectorAll("span, div, a, button")].find((n) => n.children.length === 0 && n.textContent.trim() === "Home"); e.setAttribute("data-test-home", ""); })()`);
  await click("[data-test-home]");
  await waitUntil(async () => !(await exists(FIELD)), "the Home open");
  await waitUntil(async () => (await control("state")).image_loaded === null, "the engine put away after the Home", 20_000);
}, 300_000);

test("a conversation opened again shows its pictures and opens on «Immagine»", async () => {
  // the box remembers the choice; without it the last turn decides
  const session = (await (await fetch(`${env.agent}/session?directory=${encodeURIComponent(site)}`)).json())[0].id as string;
  await p.evaluate(`Object.keys(localStorage).filter((k) => k.includes("prompt")).forEach((k) => localStorage.removeItem(k))`);
  const b64 = Buffer.from(site).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${session}` });
  await waitUntil(() => exists(`${ROW} [data-slot="picture-image"]`), "the pictures", 60_000);
  // the conversation is long and its timeline draws what is in view: the last pictures are there; the agent holds all of them
  await waitUntil(async () => (await rows()) >= 2, "the last pictures of the conversation");
  // six pictures and two that were stopped
  expect((await turns()).sort()).toEqual(["completed", "completed", "completed", "completed", "completed", "completed", "error", "error"]);
  await waitUntil(() => pressed('[data-mode="picture"]'), "the box on «Immagine»");
  expect(await exists('[data-action="prompt-picture-format"]')).toBe(true);
  await shoot("reopened", ROW);
}, 120_000);

test("leaving a conversation of pictures for a new one puts the engine away", async () => {
  await write("Un'insegna viola");
  await sendOn();
  await send();
  await waitUntil(async () => files().length === 7, "the picture", 90_000);
  await waitUntil(async () => (await control("state")).image_loaded === "pic1", "the engine on");
  await click('[aria-label="Nuova conversazione"]');
  // a conversation with no picture in it opens on «Testo»
  await waitUntil(async () => (await exists(FIELD)) && (await rows()) === 0 && (await pressed('[data-mode="text"]')), "the new conversation, on «Testo»");
  await waitUntil(async () => (await control("state")).image_loaded === null, "the engine put away after the new conversation", 20_000);
}, 180_000);

test("«Ignora» on the question leaves the choice to the model, and the picture is made", async () => {
  await click('[data-mode="picture"]');
  await write("Uno stemma tondo");
  await sendOn();
  await send();
  await waitUntil(async () => (await body()).includes("Di che colore?"), "the question", 60_000);
  await click('[data-component="dock-prompt"] button', "Ignora");
  await waitUntil(async () => files().length === 8, "the picture after the question was dismissed", 90_000);
  expect(received(files()[7]!).prompt).toBe("a red logo for a pizzeria, flat vector");
  await waitUntil(async () => !(await body()).includes("Di che colore?") && (await exists(`${ROW} [data-slot="picture-image"]`)), "the dock closed and the picture shown");
}, 180_000);

test("a page reloaded just after the user left pictures still puts the engine away", async () => {
  await click('[data-mode="picture"]');
  await write("Un'insegna arancione");
  await sendOn();
  await send();
  await waitUntil(async () => (await control("state")).image_loaded === "pic1", "the engine on", 90_000);
  await waitUntil(async () => !(await body()).includes("Passo "), "the picture made");
  await p.evaluate(`(() => { const e = [...document.querySelectorAll("span, div, a, button")].find((n) => n.children.length === 0 && n.textContent.trim() === "Home"); e.setAttribute("data-test-home", ""); })()`);
  // leaving for the Home starts the wait before the engine is put away (a second and a half); the page goes at once, before it ends
  await click("[data-test-home]");
  const clicked = Date.now();
  while (await exists(FIELD)) await Bun.sleep(5);
  await p.send("Page.reload");
  expect(Date.now() - clicked).toBeLessThan(1000);
  await waitUntil(async () => (await body()).includes("pizzeria-site"), "the Home back", 60_000);
  expect(await exists(FIELD)).toBe(false);
  await waitUntil(async () => (await control("state")).image_loaded === null, "the engine put away by the page that came back", 20_000);
}, 180_000);

test("a page reloaded with pictures on view keeps the engine however long the app takes to answer", async () => {
  await newConversation();
  await click('[data-mode="picture"]');
  await write("Un'insegna blu");
  await sendOn();
  await send();
  await waitUntil(async () => (await control("state")).image_loaded === "pic1", "the engine on", 90_000);
  await waitUntil(async () => !(await body()).includes("Passo "), "the picture made");
  // every answer takes longer than the wait before the engine is put away (a second and a half)
  await p.send("Network.enable");
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 });
  try {
    await p.send("Page.reload");
    await Bun.sleep(12_000);
    expect((await control("state")).image_loaded).toBe("pic1");
  } finally {
    await p.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  await waitUntil(() => exists(FIELD), "the conversation back", 90_000);
  await Bun.sleep(3000);
  expect((await control("state")).image_loaded).toBe("pic1");
  // leaving the pictures puts it away, as always
  await click('[data-mode="text"]');
  await waitUntil(async () => (await control("state")).image_loaded === null, "the engine put away", 20_000);
}, 240_000);

test("the first picture the model makes by itself asks first, in plain words with what it will draw", async () => {
  // as long as the descriptions a model writes
  const drawn =
    "A grey tabby cat asleep on a worn green velvet sofa, curled against a knitted cushion, late afternoon light coming " +
    "through a window on the left and drawing long soft shadows across the fabric. Shallow depth of field, the cat's " +
    "face in focus and the room behind it blurred: a bookshelf, a floor lamp, a plant. Warm, quiet, photograph, 50 mm.";
  const own = await start(
    [
      { tool: "image_generate", arguments: { prompt: drawn, name: "gatto-sul-divano" } },
      { text: "Ecco il gatto." },
      { summary: "Un gatto" },
    ],
    { window: true, context: 65536, imageModels: ["pic1"], imagePresent: ["pic1"], args: [`${site}\\.`], env: { FAKE_SD_PNG: "1" } },
  );
  const q = await page(own.cdp!, (t) => t.url.startsWith(own.agent), 120_000);
  const [previous, main] = [p, env];
  p = q;
  env = own;
  try {
    await waitUntil(async () => (await control("state")).model.phase === "ready", "the model ready");
    await newConversation();
    await write("Disegna un gatto");
    await sendOn();
    await send();
    await waitUntil(() => exists("[data-picture-prompt]"), "the question of the permission", 60_000);
    expect(await body()).toMatch(/Il modello vuole creare un'immagine di \d+ × \d+ pixel\. Disegnerà:/);
    expect(await text("[data-picture-prompt]")).toBe(drawn);
    expect(fs.existsSync(path.join(pictures, "gatto-sul-divano.png"))).toBe(false);
    await shoot("permission");
    await click('[data-slot="permission-footer-actions"] button', "Consenti una volta");
    await waitUntil(() => fs.existsSync(path.join(pictures, "gatto-sul-divano.png")), "the picture", 90_000);
    await waitUntil(() => exists(`${ROW} [data-slot="picture-image"]`), "the picture in the conversation");
    await waitUntil(async () => (await body()).includes("Ecco il gatto."), "the model's answer after the picture");
    // a picture the model made by itself is not made again from the row: the words were not the user's
    expect(await exists(`${ROW} [data-action="picture-again"]`)).toBe(false);
    await shoot("own-picture", ROW);
  } finally {
    q.close();
    own.close();
    p = previous;
    env = main;
  }
}, 300_000);

test("a picture rewritten by another model leaves the conversations that write with the model they had", async () => {
  const own = await start(SCRIPT, {
    window: true,
    context: 65536,
    otherModels: ["ling"],
    imageModels: ["pic1"],
    imagePresent: ["pic1"],
    args: [`${site}\\.`],
    env: { FAKE_SD_PNG: "1" },
  });
  const q = await page(own.cdp!, (t) => t.url.startsWith(own.agent), 120_000);
  const [previous, main] = [p, env];
  p = q;
  env = own;
  const writer = () => p.evaluate(`document.querySelector('[data-action="prompt-model"]')?.innerText ?? ""`) as Promise<string>;
  try {
    await waitUntil(async () => (await control("state")).model.phase === "ready", "the model ready");
    await newConversation();
    await waitUntil(async () => (await writer()).includes("Fake model"), "the model that writes");
    const before = files().length;
    await click('[data-mode="picture"]');
    await write("Un'insegna al neon per una pizzeria");
    await sendOn();
    await send();
    await waitUntil(async () => files().length === before + 1, "the picture", 90_000);
    // Ling wrote the description: the engine is on it
    await waitUntil(async () => (await control("state")).model.model === "ling", "the engine on the model that rewrites");
    await Bun.sleep(3000);
    await click('[data-mode="text"]');
    await waitUntil(async () => (await writer()) !== "", "the model of the text side");
    expect(await writer()).toContain("Fake model");
    // the manager says which model the conversations stay on: a page loaded again, with no memory of the picture, finds it
    expect((await control("state")).conversation_model).toBe("fake");
    await p.send("Page.reload");
    await waitUntil(async () => (await exists(FIELD)) && (await writer()) !== "", "the conversation back");
    await Bun.sleep(3000);
    expect(await writer()).toContain("Fake model");
    // a new conversation opens with the default model, not with the one the engine was lent to
    await click('[aria-label="Nuova conversazione"]');
    await waitUntil(async () => (await exists(FIELD)) && (await rows()) === 0, "the new conversation");
    await Bun.sleep(3000);
    expect(await writer()).toContain("Fake model");
    // a message there is answered by that model: the engine goes back to it
    await write("Ciao");
    await sendOn();
    await send();
    await waitUntil(async () => (await control("state")).model.model === "fake", "the engine back on the model of the conversation", 60_000);
    expect((await control("state")).conversation_model).toBeNull();
    expect(await writer()).toContain("Fake model");
  } finally {
    q.close();
    own.close();
    p = previous;
    env = main;
  }
}, 300_000);

test("with no model that draws on the computer the «Immagine» side says so, leads to the settings, and does not send", async () => {
  const bare = await start(SCRIPT, {
    window: true,
    context: 65536,
    imageModels: ["pic1"],
    imagePresent: [],
    args: [`${site}\\.`],
    env: { FAKE_SD_PNG: "1" },
  });
  const q = await page(bare.cdp!, (t) => t.url.startsWith(bare.agent), 120_000);
  const [previous, main] = [p, env];
  p = q;
  env = bare;
  try {
    await waitUntil(async () => (await control("state")).model.phase === "ready", "the model ready");
    await newConversation();
    await waitUntil(() => exists('[data-action="prompt-mode"]'), "the choice «Testo / Immagine»");
    await click('[data-mode="picture"]');
    await waitUntil(() => exists('[data-component="picture-notice"]'), "the line");
    expect(await text('[data-component="picture-notice"]')).toContain("Sul computer non c'è un modello che disegna.");
    expect(await exists('[data-action="prompt-picture-model"]')).toBe(false);
    await write("Una pizza");
    await waitUntil(async () => (await text(FIELD)).includes("Una pizza"), "the words in the box");
    expect(await p.evaluate(`document.querySelector('[data-action="prompt-submit"]').disabled`)).toBe(true);
    expect((await control("image")).jobs).toEqual([]);
    await shoot("no-model");
    await click('[data-action="picture-choose-model"]');
    await waitUntil(async () => /fanno immagini/i.test(await body()), "the settings on the group of the pictures", 20_000);
    expect(await exists('[data-model-row="pic1"]')).toBe(true);
  } finally {
    q.close();
    bare.close();
    p = previous;
    env = main;
  }
}, 240_000);
