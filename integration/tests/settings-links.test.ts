// Settings › Computer and Settings › Connections inside the app's window (WebView2 CDP), through the bridge as a person
// uses them: the cards used by the models and where a small model runs, saved in choices.json; the phone and the lending
// of the engine turned on from their cards, with the code to copy and never an address or a key in the page; a text that
// is not a code refused by the card of the engine of another PC, with nothing saved. Fake engine. The ports of the phone
// and of the sharing sit on 127.0.0.1 (`MANGO_PHONE_PC_ONLY`, `MANGO_SHARE_PC_ONLY`, development builds only). The
// screenshots stay in %TEMP%\mango-settings-*.png. `bun test integration`, after `cargo build -p mango-code -p engine`
// in app/.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { resizeWindow } from "./window";

let env: Environment;
let p: Page;
let phonePort: number;
let sharePort: number;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const n = (s.address() as net.AddressInfo).port;
      s.close(() => ok(n));
    });
  });

beforeAll(async () => {
  phonePort = await freePort();
  sharePort = await freePort();
  env = await start([{ text: "Done." }], {
    window: true,
    env: {
      MANGO_PHONE_PC_ONLY: "1",
      MANGO_PHONE_PORT: String(phonePort),
      MANGO_SHARE_PC_ONLY: "1",
      MANGO_SHARE_PORT: String(sharePort),
    },
  });
  p = await page(env.cdp!, (t) => t.url.startsWith(env.agent));
  await resizeWindow(env.app.pid!, p, 1280, 900);
}, 200_000);

afterAll(async () => {
  // the sharing and the phone back off, as they were
  await p?.evaluate(`window.__MANGO_DESKTOP__.engineShare.setEnabled(false)`).catch(() => {});
  await p?.evaluate(`window.__MANGO_DESKTOP__.phone.setEnabled(false)`).catch(() => {});
  p?.close();
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const shot = async (name: string) => {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), `mango-settings-${name}.png`), Buffer.from(r.result.data, "base64"));
};

async function waitFor(condition: string, ms = 20_000) {
  for (let t = 0; t < ms; t += 250) {
    if (await p.evaluate(condition)) return;
    await Bun.sleep(250);
  }
  throw new Error(`did not happen: ${condition}`);
}

/** Click on an element of the page, by selector and text. */
const click = (selector: string, text = "") =>
  p.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** Writes in a field as typing does: the page listens to `input`. */
const type = (selector: string, text: string) =>
  p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const choices = () => {
  const file = path.join(env.data, "choices.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};

async function until(what: string, done: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms && !done(); t += 250) await Bun.sleep(250);
  if (!done()) throw new Error(`did not happen: ${what}`);
}

const open = async (section: string) => {
  await p.send("Page.navigate", { url: `${env.agent}/settings?section=${section}` });
  await waitFor(`document.querySelector('[data-component="settings-page"] [data-pane="${section}"]') !== null`);
};

test("Computer: the cards, the processor and the engine, and a choice saved for small models", async () => {
  await open("computer");
  await waitFor(`!!document.querySelector('[data-component="settings-computer"] [data-component="settings-v2-list"]')`, 30_000);
  const text: string = await p.evaluate(`document.querySelector('[data-component="settings-computer"]').innerText`);
  for (const said of ["Schede video", "Di serie, per un modello che sta in una scheda", "Processore e memoria", "Motore", "è quello di questa versione di Mango Code"])
    expect(text, said).toContain(said);
  await shot("computer");

  // a card that can be changed (no sentence under it) leaves the models and comes back
  const card: string | null = await p.evaluate(
    `[...document.querySelectorAll('[data-action="settings-gpu-used"]')].find((row) => !row.querySelector('button, input')?.disabled)?.dataset.gpu ?? null`,
  );
  if (card) {
    const toggle = `document.querySelector('[data-action="settings-gpu-used"][data-gpu=${JSON.stringify(card)}] input')`;
    await p.evaluate(`${toggle}.click()`);
    await until("the card left out", () => (choices().computer?.unused_gpus ?? []).includes(card));
    await waitFor(`${toggle}.checked === false`);
    await p.evaluate(`${toggle}.click()`);
    await until("the card back", () => !(choices().computer?.unused_gpus ?? []).includes(card));
  }

  expect(await click('[data-action="settings-small-models"] button', "Tutte le schede")).toBe(true);
  await until("small models on all the cards", () => choices().computer?.small_models === "all");
  await waitFor(`document.querySelector('[data-component="settings-computer"]').innerText.includes("Più contesto")`);
  expect(await click('[data-action="settings-small-models"] button', "Una scheda")).toBe(true);
  await until("small models on one card", () => (choices().computer?.small_models ?? "one") === "one");
}, 120_000);

test("Connections: five cards, off by default", async () => {
  await open("links");
  const cards: string[] = await p.evaluate(`[...document.querySelectorAll('[data-link-card]')].map((c) => c.dataset.linkCard)`);
  expect(cards).toEqual(["phone", "share", "remote", "cloud", "token"]);
  const text: string = await p.evaluate(`document.querySelector('[data-component="settings-links"]').innerText`);
  for (const said of ["Telefono", "Usa Mango Code dal telefono", "Presta il motore ai miei PC", "Usa il motore di un altro PC", "Cloud, a pagamento", "Hugging Face", "Non collegato"])
    expect(text, said).toContain(said);
  expect(await p.evaluate(`document.querySelector('[data-action="settings-share-switch"] input').checked`)).toBe(false);
  expect(await p.evaluate(`document.querySelector('[data-action="settings-phone-switch"] input').checked`)).toBe(false);
  await shot("links");
}, 60_000);

test("Connections: the lending of the engine turned on from its card copies the code, never showing the address or the key", async () => {
  await p.evaluate(`document.querySelector('[data-action="settings-share-switch"] input').click()`);
  await waitFor(`!document.querySelector('[data-action="settings-share-open"]').disabled`);
  expect((await p.evaluate(`window.__MANGO_DESKTOP__.engineShare.state()`)).enabled).toBe(true);
  expect(await click('[data-action="settings-share-open"]')).toBe(true);
  await waitFor(`!!document.querySelector('[data-slot="settings-share-access"]')`);
  const card: string = await p.evaluate(`document.querySelector('[data-link-card="share"]').innerText`);
  expect(card).not.toContain(`127.0.0.1:${sharePort}`);
  expect(card).toContain("Copia il codice");
  expect(card).toContain("in chiaro sul Wi-Fi");
  expect(await p.evaluate(`document.documentElement.innerHTML.match(/[0-9a-f]{48}/)`)).toBeNull();
  await shot("links-share");
  await p.evaluate(`document.querySelector('[data-action="settings-share-switch"] input').click()`);
  await waitFor(`document.querySelector('[data-action="settings-share-switch"] input').checked === false`);
  expect((await p.evaluate(`window.__MANGO_DESKTOP__.engineShare.state()`)).enabled).toBe(false);
}, 60_000);

test("Connections: the phone turned on from its card shows its QR", async () => {
  await p.evaluate(`document.querySelector('[data-action="settings-phone-switch"] input').click()`);
  await waitFor(`!document.querySelector('[data-action="settings-phone-open"]').disabled`);
  expect(await click('[data-action="settings-phone-open"]')).toBe(true);
  await waitFor(`!!document.querySelector('[data-slot="settings-phone-access"] img')`);
  await shot("links-phone");
  await p.evaluate(`document.querySelector('[data-action="settings-phone-switch"] input').click()`);
  await waitFor(`document.querySelector('[data-action="settings-phone-switch"] input').checked === false`);
}, 60_000);

test("Connections: a text that is not a code is refused by the card of the engine of another PC, and nothing is saved", async () => {
  expect(await click('[data-action="settings-remote-open"]')).toBe(true);
  await waitFor(`!!document.querySelector('[data-action="settings-remote-form"] input')`);
  await type('[data-action="settings-remote-form"] input', "not a code");
  expect(await click('[data-action="settings-remote-form"] button')).toBe(true);
  await waitFor(`!!document.querySelector('[data-link-card="remote"] .settings-page-error')`);
  expect(fs.existsSync(path.join(env.data, "remote-engine.json"))).toBe(false);
  expect(await p.evaluate(`location.pathname`)).toBe("/settings");
  expect(p.console.filter((c) => c.startsWith("EXCEPTION"))).toEqual([]);
}, 60_000);
