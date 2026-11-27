// A computer with no model, the app's real window, the real mouse and keyboard: the ways to bring a model of one's own. From the
// Home, «Ho già un file» and «Cerca su Hugging Face» both lead to «Un altro modello» in Settings › Models. A GGUF of the user's,
// chosen in the Windows dialog, is analyzed, added, loaded, and the first conversation is answered by that very file; a file that is
// not a GGUF says so and adds nothing. Hugging Face (a server of the test, `MANGO_HF_URL`): a name typed in the box lists
// repos with their downloads and likes and marks the reserved ones; a result opens its quantizations; a link pasted (the repo's
// page, the page of one file) opens the same, the file's quantization proposed; the model added is downloaded from the list and
// arrives with its bytes intact. What is not a model (a link elsewhere, a page of datasets, a repo with no GGUF, one that does not
// exist, a reserved one, a server that fails) says what is wrong in a sentence, adds nothing, and leaves the box usable.
// `off-screen bun test --cwd integration tests/first-start-paths.test.ts`.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { answer } from "./dialog";
import { start, type Environment } from "./environment";

setDefaultTimeout(180_000);

const MIB = 1024 * 1024;

/** A GGUF with a header only (one metadata entry: an architecture the count does not know), padded to `size` bytes. */
function gguf(size: number, seed: number) {
  const text = (s: string) => {
    const bytes = Buffer.from(s);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  const header = Buffer.alloc(24);
  header.write("GGUF", 0);
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(1n, 16);
  const type = Buffer.alloc(4);
  type.writeUInt32LE(8);
  const head = Buffer.concat([header, text("general.architecture"), type, text("zzz-test")]);
  return Buffer.concat([head, Uint8Array.from({ length: size - head.length }, (_, i) => (i * 31 + seed) % 251)]);
}
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const files: Record<string, Buffer> = { "tiny-Q4_K_M.gguf": gguf(2 * MIB, 1), "tiny-Q8_0.gguf": gguf(3 * MIB, 2), "closed-Q4_K_M.gguf": gguf(1 * MIB, 3) };
const SHA = "a".repeat(40);
const requests: string[] = [];
let fail = false;

const hf = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (fail) return new Response("{}", { status: 500 });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.pathname === "/api/models") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const all = [
        { id: "acme/tiny-GGUF", downloads: 1234567, likes: 89, gated: false },
        { id: "acme/closed-GGUF", downloads: 4321, likes: 7, gated: "manual" },
      ];
      return json(all.filter((m) => m.id.toLowerCase().includes(search)));
    }
    const revision = /^\/api\/models\/(acme\/[\w.-]+)\/revision\/main$/.exec(url.pathname);
    if (revision) {
      if (revision[1] === "acme/closed-GGUF") return json({ sha: SHA, gated: "manual" });
      return ["acme/tiny-GGUF", "acme/plain-model"].includes(revision[1]!) ? json({ sha: SHA, gated: false }) : json({ error: "Repository not found" }, 404);
    }
    const tree = /^\/api\/models\/(acme\/[\w.-]+)\/tree\/[0-9a-f]+$/.exec(url.pathname);
    if (tree) {
      const lfs = (name: string) => ({ type: "file", path: name, size: files[name]!.length, lfs: { oid: sha256(files[name]!), size: files[name]!.length } });
      if (tree[1] === "acme/tiny-GGUF") return json([lfs("tiny-Q4_K_M.gguf"), lfs("tiny-Q8_0.gguf"), { type: "file", path: "README.md", size: 10 }]);
      if (tree[1] === "acme/closed-GGUF") return json([lfs("closed-Q4_K_M.gguf")]);
      return json([{ type: "file", path: "model.safetensors", size: 100, lfs: { oid: "0".repeat(64), size: 100 } }]);
    }
    const resolve = /^\/(acme\/[\w.-]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
    if (resolve) {
      if (resolve[1] === "acme/closed-GGUF") return new Response("{}", { status: 403, headers: { "x-error-code": "GatedRepo" } });
      const bytes = files[decodeURIComponent(resolve[2]!)];
      if (!bytes) return new Response("{}", { status: 404 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (!range) return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      const [from, to] = [Number(range[1]), Math.min(Number(range[2]), bytes.length - 1)];
      return new Response(bytes.subarray(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${bytes.length}` } });
    }
    return new Response("{}", { status: 404 });
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-paths-"));
const site = path.join(root, "my-site");
fs.mkdirSync(site);
fs.writeFileSync(path.join(site, "a.txt"), "x");
const mine = path.join(root, "elsewhere", "my-own-Q4_0.gguf");
fs.mkdirSync(path.dirname(mine), { recursive: true });
fs.writeFileSync(mine, gguf(1 * MIB, 9));
const notGguf = path.join(root, "elsewhere", "notes.gguf");
fs.writeFileSync(notGguf, "These are my notes, not a model.\n".repeat(200));

let env: Environment;
let p: Page;

async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const t0 = Date.now();
  while (!(await Promise.resolve(condition()).catch(() => false))) {
    if (Date.now() - t0 > ms) {
      const page = await p.evaluate("document.body.innerText.slice(-900)").catch(() => "");
      throw new Error(["waited too long for: " + what, "--- the page ---", page, "--- console ---", ...p.console.slice(-4)].join("\n"));
    }
    await Bun.sleep(150);
  }
}
const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
const body = () => p.evaluate("document.body.innerText") as Promise<string>;
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;

/** A picture of the window in the folder `MANGO_TEST_SCREENSHOTS` names, if it is set. */
async function shot(name: string) {
  const folder = process.env.MANGO_TEST_SCREENSHOTS;
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  const taken = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(taken.result.data, "base64"));
}
const centre = (find: string) =>
  p.evaluate(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
async function click(find: string, what: string) {
  const at = await centre(find);
  if (!at) throw new Error(`not on the page: ${what}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const control = async (route: string) => (await fetch(`${env.engine}/control/${route}`)).json();
const line = () => p.evaluate(`${q('[data-slot="settings-other-model-line"]')}?.innerText ?? ""`) as Promise<string>;
const BOX = '[data-action="settings-other-model-search"] input';
const analysis = () => p.evaluate(`${q('[data-slot="settings-other-analysis"]')}?.innerText ?? ""`) as Promise<string>;
const standing = () => expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);

/** The user's words in the box of «Un altro modello», typed, and Enter. */
async function lookFor(words: string) {
  await click(q(BOX), "the box");
  await p.evaluate(`${q(BOX)}.select()`);
  await p.send("Input.insertText", { text: words });
  for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
}
/** The box has answered: not busy any more. */
const answered = () => waitUntil(async () => !/Cerco su Hugging Face…|Leggo il file…|Aggiungo il modello…/.test(await line()), "the box answered");
async function toSettingsModels() {
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=models` });
  await waitUntil(() => exists(BOX), "the box of «Un altro modello»");
}

beforeAll(async () => {
  env = await start([{ text: "Here I am." }], { window: true, noModels: true, args: [`${site}\\.`], env: { MANGO_HF_URL: `http://127.0.0.1:${hf.port}` } });
  p = await windowPage(env.cdp!, env.agent, 120_000);
  await waitUntil(async () => (await body()).includes("Benvenuto in Mango Code"), "the welcome", 60_000);
}, 240_000);

afterAll(() => {
  p?.close();
  env?.close();
  hf.stop(true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("«Ho già un file» and, in the list, «Cerca su Hugging Face» and «Scegli un file» all lead to «Un altro modello» in Models", async () => {
  await click(q('[data-action="mango-own-file"]'), "Ho già un file");
  await waitUntil(async () => (await p.evaluate("location.pathname")) === "/settings" && (await exists(BOX)), "Models with the box");
  expect(await exists('[data-action="settings-other-model-file"]')).toBe(true);
  for (const action of ["mango-search-hf", "mango-pick-file"]) {
    await p.send("Page.navigate", { url: `${env.agent}/` });
    await waitUntil(() => exists('[data-action="mango-choose"]'), "the welcome");
    await click(q('[data-action="mango-choose"]'), "the list");
    await waitUntil(() => exists(`[data-action="${action}"]`), action);
    await click(q(`[data-action="${action}"]`), action);
    await waitUntil(async () => (await p.evaluate("location.pathname")) === "/settings" && (await exists(BOX)), `Models with the box, from ${action}`);
  }
});

test("a file that is not a GGUF says so and adds nothing; the box can be used again", async () => {
  await click(q('[data-action="settings-other-model-file"]'), "Scegli un file");
  const picked = await answer(env.app.pid!, "-Path", notGguf);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(async () => (await line()).includes("non è un file GGUF"), "the sentence about the file");
  expect(await line()).toContain("notes.gguf");
  expect(await exists('[data-slot="settings-other-analysis"]')).toBe(false);
  expect((await control("models")).models.filter((m: { user?: boolean }) => m.user)).toEqual([]);
  expect(await p.evaluate(`${q('[data-action="settings-other-model-file"]')}.disabled`)).toBe(false);
  await standing();
});

let mineKey = "";

test("a GGUF of the user's is analyzed and added, and being the only model on the computer it becomes the one in use", async () => {
  await click(q('[data-action="settings-other-model-file"]'), "Scegli un file");
  const picked = await answer(env.app.pid!, "-Path", mine);
  expect(picked.code, picked.output).toBe(0);
  await waitUntil(() => exists('[data-slot="settings-other-analysis"]'), "the analysis");
  expect(await analysis()).toContain("my-own");
  await click(q('[data-action="settings-other-model-add"]'), "Aggiungi all'elenco");
  await waitUntil(async () => (await line()).includes("è nell'elenco qui sopra"), "the model in the list");
  const listed = (await control("models")).models.find((m: { key: string }) => m.key.startsWith("local-my-own"));
  expect(listed, "the model among the models").toMatchObject({ user: true, present: true, own_files: [mine] });
  mineKey = listed.key;
  // the app loads it by itself, as it does for a model that arrives by download
  const loaded = await waitUntil(async () => (await control("state")).model.phase === "ready", "the model loaded", 30_000).then(() => true, () => false);
  await Bun.sleep(1500);
  await shot("01-own-file-added-in-use");
  expect(loaded, `the model added is in use; the state is ${JSON.stringify((await control("state")).model)}`).toBe(true);
  expect((await control("state")).model.model).toBe(mineKey);
});

test("the first conversation is answered by that file", async () => {
  await p.send("Page.navigate", { url: `${env.agent}/` });
  await waitUntil(async () => (await body()).includes("my-site"), "the project", 60_000);
  await click(q('[aria-label="Nuova conversazione"]'), "Nuova conversazione");
  await waitUntil(async () => ((await p.evaluate("location.pathname")) as string).endsWith("/new-session") && (await exists('[data-component="prompt-input"]')), "the box");
  await Bun.sleep(1000);
  // not loaded by itself: the user picks it under the box, as the menu offers it
  if ((await control("state")).model.phase !== "ready") {
    await click(q('[data-action="prompt-model"]'), "the model button");
    await waitUntil(() => exists(`[role="menu"] [data-option-key="mango:${mineKey}"]`), "the model in the menu");
    await click(q(`[role="menu"] [data-option-key="mango:${mineKey}"]`), "the model");
    await waitUntil(async () => (await control("state")).model.phase === "ready", "the model loaded", 60_000);
  }
  await click(q('[data-component="prompt-input"]'), "the box");
  await p.send("Input.insertText", { text: "Hello from my own file" });
  await click(q('[data-action="prompt-submit"]'), "send");
  await waitUntil(async () => (await body()).includes("Here I am."), "the answer", 60_000);
  const chats = fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.route.startsWith("/v1/chat/completions"));
  expect(chats.length).toBeGreaterThan(0);
  expect(chats.at(-1).model_path.toLowerCase()).toBe(mine.toLowerCase());
});

test("a name typed in the box lists the repos with their downloads and likes, the reserved one marked; a result opens its quantizations", async () => {
  await toSettingsModels();
  await lookFor("GGUF");
  await waitUntil(() => exists('[data-other-result="acme/tiny-GGUF"]'), "the results");
  const rows = (await p.evaluate(`[...document.querySelectorAll('[data-other-result]')].map((r) => r.innerText.replace(/\\s+/g, " ").trim())`)) as string[];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("acme/tiny-GGUF");
  expect(rows[0]).toMatch(/1\.234\.567 scaricamenti · 89 mi piace/);
  expect(rows[0]).not.toContain("Riservato");
  expect(rows[1]).toContain("acme/closed-GGUF");
  expect(rows[1]).toContain("Riservato");
  await shot("07-hugging-face-search-results");
  expect(requests.some((r) => r.startsWith("GET /api/models?search=GGUF"))).toBe(true);

  await click(q('[data-other-result="acme/tiny-GGUF"]'), "the first result");
  await waitUntil(() => exists('[data-slot="settings-other-analysis"]'), "the analysis of the repo");
  const text = await analysis();
  expect(text).toContain("tiny");
  // both quantizations are offered, with their sizes, and one is proposed
  expect(await p.evaluate(`document.querySelectorAll('[data-slot="settings-other-variants"] small').length`)).toBe(2);
  expect(text).toContain("Q4_K_M");
  expect(text).toContain("Q8_0");
  expect(text).toContain("Consigliato");
});

test("the quantization chosen is the one added; the model is downloaded from the list and arrives with its bytes intact", async () => {
  // the quantization that is not the proposed one (the smallest comes first), chosen with the mouse
  const items = '[data-slot="settings-other-variants"] [data-slot="segmented-control-v2-item"]';
  const proposedIndex = (await p.evaluate(`[...document.querySelectorAll('${items}')].findIndex((i) => i.getAttribute("aria-pressed") === "true")`)) as number;
  expect(proposedIndex, "a quantization is proposed").toBeGreaterThanOrEqual(0);
  const otherIndex = proposedIndex === 0 ? 1 : 0;
  const other = ["Q4_K_M", "Q8_0"][otherIndex]!;
  const pickedLine = () => p.evaluate(`${q('[data-slot="settings-other-variants"] small[data-picked]')}.innerText`) as Promise<string>;
  const proposedLine = await pickedLine();
  await click(`document.querySelectorAll('${items}')[${otherIndex}]`, `the quantization ${other}`);
  await waitUntil(async () => (await pickedLine()) !== proposedLine, "the other quantization picked");
  await click(q('[data-action="settings-other-model-add"]'), "Aggiungi all'elenco");
  await waitUntil(async () => (await line()).includes("è nell'elenco qui sopra"), "the model in the list");
  const key = `hf-acme-tiny-gguf-${other.toLowerCase().replace(/_/g, "-")}`;
  const listed = (await control("models")).models.find((m: { key: string }) => m.key === key);
  expect(listed, `the model ${key} among the models`).toMatchObject({ user: true, present: false });
  // its row offers the download; the click starts it and the file arrives whole
  await waitUntil(() => exists(`[data-model-row="${key}"]`), "the row of the model added", 10_000).catch(() => {});
  const row = (await p.evaluate(`${q(`[data-model-row="${key}"]`)}?.innerText ?? "no row"`)) as string;
  const rowKeys = await p.evaluate(`[...document.querySelectorAll('[data-model-row]')].map((r) => r.dataset.modelRow)`);
  expect(row, `the row of the model added offers the download; the rows are ${JSON.stringify(rowKeys)}; the page: ${(await body()).slice(-900)}`).toContain("Scarica");
  await click(q(`[data-model-row="${key}"] [data-action="settings-model-download"]`), "the download button of the model added");
  const file = `tiny-${other}.gguf`;
  await waitUntil(async () => (await control("models")).models.find((m: { key: string }) => m.key === key).present === true, "the model on the computer", 90_000);
  const arrived = fs.readdirSync(env.modelsDir, { recursive: true }).map(String).find((f) => f.endsWith(file));
  expect(arrived, `${file} in the models folder`).toBeTruthy();
  expect(sha256(fs.readFileSync(path.join(env.modelsDir, arrived!)))).toBe(sha256(files[file]!));
});

test("a link pasted opens the repo; the link of one file proposes that file's quantization", async () => {
  await toSettingsModels();
  await lookFor("https://huggingface.co/acme/tiny-GGUF");
  await waitUntil(() => exists('[data-slot="settings-other-analysis"]'), "the analysis from the repo's page");
  expect(await analysis()).toContain("Q4_K_M");
  await lookFor("https://huggingface.co/acme/tiny-GGUF/blob/main/tiny-Q8_0.gguf");
  await waitUntil(async () => ((await p.evaluate(`${q('[data-slot="settings-other-variants"] small[data-picked]')}?.innerText ?? ""`)) as string).includes("Q8_0"), "the quantization of the file's link picked");
  await lookFor("acme/tiny-GGUF");
  await waitUntil(() => exists('[data-slot="settings-other-analysis"]'), "the analysis from owner/name");
  await standing();
});

for (const [what, text, sentence] of [
  ["a link that is not Hugging Face", "https://example.com/some/page", "Nessun modello trovato."],
  ["a page of datasets", "https://huggingface.co/datasets/acme/stuff", "Nessun modello trovato."],
  ["a name nobody has", "zzzzqqqq", "Nessun modello trovato."],
  ["a repo with no GGUF file", "https://huggingface.co/acme/plain-model", "non ci sono file GGUF"],
  ["a repo that does not exist", "https://huggingface.co/acme/ghost-model", "Non trovo questo modello"],
  ["a reserved repo", "https://huggingface.co/acme/closed-GGUF", "Questo modello chiede di accettare"],
] as const) {
  test(`${what}: a sentence says what is wrong, nothing is added, the box is usable again`, async () => {
    await toSettingsModels();
    const before = ((await control("models")).models as { key: string }[]).map((m) => m.key).sort();
    await lookFor(text);
    await waitUntil(async () => (await line()).includes(sentence) || (await body()).includes(sentence), `the sentence «${sentence}»`);
    await answered();
    expect(await exists('[data-slot="settings-other-analysis"]')).toBe(false);
    expect(((await control("models")).models as { key: string }[]).map((m) => m.key).sort()).toEqual(before);
    expect(await p.evaluate(`${q(BOX)}.disabled`)).toBe(false);
    await standing();
  });
}

test("Hugging Face failing (an error 500) is said in a sentence, and the next search works when it is back", async () => {
  await toSettingsModels();
  fail = true;
  await lookFor("GGUF");
  await waitUntil(async () => /Hugging Face/.test(await line()) && !/Cerco/.test(await line()), "a sentence about Hugging Face");
  expect(await line()).toContain("500");
  expect(await exists('[data-other-result]')).toBe(false);
  fail = false;
  await lookFor("GGUF");
  await waitUntil(() => exists('[data-other-result="acme/tiny-GGUF"]'), "the results again");
  await standing();
});
