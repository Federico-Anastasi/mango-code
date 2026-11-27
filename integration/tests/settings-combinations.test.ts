// Every combination of the choices of Computer, on several computers, with the real catalog and the real profiles: after
// each change every section of the settings opens, every model on the computer opens in Models and each of its choices
// is clicked with the mouse, and the page never falls: no exception, no section that stopped, no error page, and the
// place a model was saved with is always shown as chosen. The choices clicked stay saved from one change of Computer to
// the next, as a user leaves them, so a model saved on cards that are then left out is part of the walk. A harness of the
// user's that cannot be read, and one chosen for a model and then deleted, are there from the start.
// Fake engine, fake hardware (`MANGO_HARDWARE`). `off-screen bun test --cwd integration tests/settings-combinations.test.ts`,
// after `cargo build` in app/ and `app\scripts\build-agent.ps1`. About two minutes for each computer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeRoot, start, type Environment } from "./environment";
import { page, type Page } from "./cdp";
import { resizeWindow } from "./window";

const nvidia = (index: number, name: string, memory_mib: number, cc: [number, number]) => ({ index, name, vendor: "nvidia", memory_mib, shared_mib: 0, cuda_driver: [12, 6], cc });
const other = (index: number, name: string, vendor: string, memory_mib: number, shared_mib = 0) => ({ index, name, vendor, memory_mib, shared_mib, cuda_driver: null, cc: null });
const cpu = (avx2 = true) => ({ name: "Fake CPU", cores: 8, avx2, avx512: false });

const COMPUTERS = {
  "three cards of different memory": { gpus: [nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, [8, 6]), nvidia(1, "NVIDIA GeForce GTX 1080", 8192, [6, 1]), nvidia(2, "NVIDIA GeForce GTX 1660 SUPER", 6144, [7, 5])], cpu: cpu(), ram_mib: 65_536 },
  "one card of 8 GB": { gpus: [nvidia(0, "NVIDIA GeForce RTX 4060", 8188, [8, 9])], cpu: cpu(), ram_mib: 32_768 },
  "one small card": { gpus: [nvidia(0, "NVIDIA GeForce GTX 1650", 4096, [7, 5])], cpu: cpu(), ram_mib: 16_384 },
  "two identical cards and another": { gpus: [nvidia(0, "NVIDIA GeForce RTX 3060", 12_288, [8, 6]), nvidia(1, "NVIDIA GeForce GTX 1080", 8192, [6, 1]), nvidia(2, "NVIDIA GeForce RTX 3060", 12_288, [8, 6])], cpu: cpu(), ram_mib: 65_536 },
  "a card beside the integrated graphics": { gpus: [nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, [8, 6]), other(1, "Intel(R) UHD Graphics 630", "intel", 128, 32_000)], cpu: cpu(), ram_mib: 32_768 },
  "only the integrated graphics": { gpus: [other(0, "AMD Radeon(TM) Graphics", "amd", 512, 7700)], cpu: cpu(), ram_mib: 15_700 },
  "two cards of another make": { gpus: [other(0, "AMD Radeon RX 7800 XT", "amd", 16_368), other(1, "AMD Radeon RX 6800", "amd", 16_368)], cpu: cpu(), ram_mib: 32_768 },
  "no card, an old processor": { gpus: [], cpu: cpu(false), ram_mib: 16_384 },
} as const;

for (const [name, hardware] of Object.entries(COMPUTERS)) {
  describe(`the settings on a computer with ${name}`, () => {
    let env: Environment;
    let p: Page;
    let folder: string;

    beforeAll(async () => {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), "mango-hardware-"));
      const file = path.join(folder, "hardware.json");
      fs.writeFileSync(file, JSON.stringify(hardware));
      env = await start([{ text: "Done." }], { window: true, realCatalog: true, env: { MANGO_HARDWARE: file } });
      // a harness of the user's whose harness.json cannot be read, and one chosen for a model and then deleted
      fs.mkdirSync(path.join(env.data, "harness", "broken"), { recursive: true });
      fs.writeFileSync(path.join(env.data, "harness", "broken", "harness.json"), "{ not json");
      const catalog = JSON.parse(fs.readFileSync(path.join(env.root, "dist", "mango-models.json"), "utf8"));
      fs.writeFileSync(path.join(env.data, "choices.json"), JSON.stringify({ models: { [catalog.default]: { harness: "deleted" } } }));
      await env.restart();
      p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
      await resizeWindow(env.app.pid!, p, 1280, 900);
    }, 300_000);

    afterAll(() => {
      p?.close();
      env?.close();
      Bun.sleepSync(1500);
      if (env) removeRoot(env.root);
      fs.rmSync(folder, { recursive: true, force: true });
    });

    /** Throws if the page fell since the last look: an exception, a section that stopped, the error page. */
    let seen = 0;
    async function standing(where: string) {
      const fell = (await p.evaluate(`(() => {
        if (!document.querySelector('[data-component="settings-page"]')) return "no settings page: " + document.body.textContent.slice(0, 400);
        const failed = document.querySelector('[data-slot="settings-section-failed"]');
        return failed ? "a section stopped: " + failed.textContent : "";
      })()`)) as string;
      const thrown = p.console.slice(seen).filter((line) => line.startsWith("EXCEPTION") || line.startsWith("error: settings section"));
      seen = p.console.length;
      if (fell || thrown.length) throw new Error(`${name}, ${where}: ${[fell, ...thrown].filter(Boolean).join("\n")}`);
    }

    async function waitFor(condition: string, what: string, ms = 30_000) {
      for (let t = 0; t < ms; t += 200) {
        if (await p.evaluate(condition).catch(() => false)) return;
        await Bun.sleep(200);
      }
      throw new Error(`${name}: did not happen: ${what}`);
    }

    /** A click with the mouse on the `n`-th element of `selector`, brought into view. False if it is not there. */
    async function click(selector: string, n = 0) {
      const at = await p.evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${n}];
        if (!el || el.disabled || el.closest("[disabled], [aria-disabled='true'], [data-disabled]")) return null;
        el.scrollIntoView({ block: "center" });
        const q = el.getBoundingClientRect();
        return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
      })()`);
      if (!at) return false;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
      return true;
    }

    const count = (selector: string) => p.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`) as Promise<number>;

    /** The command a click started is over: the controls of `row`, off while it runs, are on again; elsewhere a moment. */
    async function settled(where: string, row?: string) {
      await Bun.sleep(row ? 150 : 600);
      if (row) await waitFor(`!document.querySelector('${row} [data-slot="segmented-control-v2-item"]:disabled')`, `${where}: the page answered`);
      await standing(where);
    }

    async function section(id: string) {
      await p.send("Page.navigate", { url: `${env.agent}/settings?section=${id}` });
      await waitFor(`!!document.querySelector('[data-pane="${id}"]')`, `the section ${id}`);
      await Bun.sleep(400);
      await standing(`section ${id}`);
    }

    /** Every section, and in Agent every harness of the list, the unreadable one too. */
    async function everySection(step: string) {
      for (const id of ["computer", "agent", "links", "general", "help"]) await section(id);
      await section("agent");
      const harnesses = '[data-pane="agent"] .settings-page-harness-pick';
      for (let i = 0; i < (await count(harnesses)); i++) {
        await click(harnesses, i);
        await settled(`${step}, Agent, harness ${i}`);
      }
    }

    /** Every model on the computer: opened, its place shown as chosen, and every one of its choices clicked. The last
     *  place clicked changes from model to model, so that the saved places are of every kind at the next change. */
    async function everyModel(step: string) {
      await section("models");
      await waitFor(`!!document.querySelector('[data-component="settings-models"] [data-model-row]')`, "the models");
      const keys = (await p.evaluate(`[...document.querySelectorAll('[data-component="settings-models"] [data-model-row]')].map((r) => r.dataset.modelRow)`)) as string[];
      for (const [index, key] of keys.entries()) {
        const row = `[data-model-row="${key}"]`;
        if (!(await click(`${row} > button`))) continue;
        const open = await p.evaluate(`(async () => {
          for (let t = 0; t < 50; t++) {
            if (document.querySelector('${row} [data-slot="settings-model-detail"]')) return true;
            await new Promise((r) => setTimeout(r, 100));
          }
          return false
        })()`);
        await standing(`${step}, ${key} opened`);
        if (!open) continue;
        const where = `${row} [data-action="settings-model-where"] button`;
        const chosen = `${row} [data-action="settings-model-where"] [data-pressed]`;
        if ((await count(where)) > 0) expect(await count(chosen), `${name}, ${step}: ${key} shows the place it was saved with`).toBe(1);
        for (const control of ["settings-model-context", "settings-model-style", "settings-model-reasoning"]) {
          const buttons = `${row} [data-action="${control}"] button`;
          for (let i = 0; i < (await count(buttons)); i++) if (await click(buttons, i)) await settled(`${step}, ${key}, ${control} ${i}`, row);
        }
        const cards = `${row} .settings-page-cards input`;
        for (let i = 0; i < (await count(cards)); i++) if (await click(cards, i)) await settled(`${step}, ${key}, card ${i}`, row);
        const places = await count(where);
        for (let i = 0; i < places; i++) if (await click(where, (index + i + 1) % places)) await settled(`${step}, ${key}, place ${(index + i + 1) % places}`, row);
        await click(`${row} > button`);
        await standing(`${step}, ${key} closed`);
      }
    }

    test("every change of Computer leaves every section and every model standing", async () => {
      await section("models");
      await everyModel("at the start");
      await everySection("at the start");

      await section("computer");
      const switches = '[data-component="settings-computer"] [data-action="settings-gpu-used"] input';
      const cards = await count(switches);
      // each card left out in turn, the ones before it staying out; then each one back
      const order = [...Array(cards).keys()];
      for (const i of [...order, ...order.reverse()]) {
        await section("computer");
        if (!(await click(switches, i))) continue;
        await settled(`Computer, card ${i}`);
        const small = '[data-action="settings-small-models"] button';
        for (let s = 0; s < (await count(small)); s++) if (await click(small, s)) await settled(`Computer, small models ${s}`);
        await everyModel(`after card ${i}`);
      }
      await everySection("at the end");
    }, 1_200_000);
  });
}
