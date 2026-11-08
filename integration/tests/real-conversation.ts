// A real conversation, from the development app with a real model, watched: every 10 s the engine's counters
// (/metrics) are read. If the decode counter stays still for 90 s while the slot works, the engine is stuck:
// "Stop" is tried and it is measured whether it comes back free. It serves to reproduce the decode hang.
// It holds the GPUs for a few minutes: it is not part of `bun test`.
//
// Usage: bun integration/tests/real-conversation.ts [model] ["message"] [--stop-after <seconds>]
// (`--stop-after`: presses "Stop" halfway through the answer and measures how soon the engine is free again.)

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { writeLanguage } from "./environment";

const REPO = path.resolve(import.meta.dir, "..", "..");
const APP_EXE = path.join(REPO, "app", "target", "debug", "mango-code.exe");
const args = process.argv.slice(2);
const stopIndex = args.indexOf("--stop-after");
const stopAfter = stopIndex >= 0 ? Number(args.splice(stopIndex, 2)[1]) * 1000 : null;
const model = args[0] ?? "toq";
const message = args[1] ?? "Create a three-slide PowerPoint presentation about the Sunflower project (see notes.md): title, goals, timeline. Save it as sunflower.pptx.";
const LIMIT_MS = 12 * 60_000;
const STUCK_MS = 90_000;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

async function counters(engine: string) {
  try {
    const t = await (await fetch(`${engine}/metrics`, { signal: AbortSignal.timeout(5000) })).text();
    const v = (n: string) => Number(t.match(new RegExp(`^llamacpp:${n}(?:\\{[^}]*\\})? ([\\d.e+]+)`, "m"))?.[1] ?? NaN);
    return { written: v("tokens_predicted_total"), read: v("prompt_tokens_total"), busy: v("requests_processing") };
  } catch (e) {
    if (process.env.MANGO_DIAG) console.log(`  /metrics: ${e}`);
    return null;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-real-"));
const data = path.join(root, "data");
const project = path.join(root, "project");
writeLanguage(data);
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "notes.md"), "# Sunflower\n\nGoals: a shared vegetable garden in the neighbourhood, 40 families, rainwater harvesting.\nTimeline: project in March, sowing in April, first harvest in July.\n");
const app = spawn(APP_EXE, ["--service"], {
  env: { ...process.env, MANGO_DATA: data, MANGO_AGENT_PORT: String(await freePort()), MANGO_ENGINE_PORT: String(await freePort()) },
  stdio: "ignore",
});
try {
  let s = await find(data);
  for (let t0 = Date.now(); !s; s = await find(data)) {
    if (app.exitCode !== null) throw new Error(`the app closed; log in ${path.join(data, "logs")}`);
    if (Date.now() - t0 > 300_000) throw new Error("app not ready after 300 s");
    await Bun.sleep(1000);
  }
  const mc = new MangoCode(s);
  await mc.startModel(model);
  const id = await mc.createSession(project, { title: "real" });
  const t0 = Date.now();
  let last = await counters(s.engine);
  let stillSince = Date.now();
  let stuck = false;
  const watch = setInterval(async () => {
    const c = await counters(s!.engine);
    if (!c || !last) return;
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  [${sec} s] written ${c.written} (+${c.written - last.written}), read ${c.read} (+${c.read - last.read}), busy ${c.busy}`);
    if (c.written !== last.written || c.read !== last.read || c.busy === 0) stillSince = Date.now();
    else if (!stuck && Date.now() - stillSince > STUCK_MS) {
      stuck = true;
      console.log(`STUCK: nothing read or written for ${STUCK_MS / 1000} s with the slot busy. Trying "Stop".`);
      const tf = Date.now();
      await mc.abort(id, project);
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(1000);
        const d = await counters(s!.engine);
        if (d && d.busy === 0) {
          console.log(`  after "Stop" the engine is free in ${((Date.now() - tf) / 1000).toFixed(0)} s`);
          return;
        }
      }
      console.log('  after "Stop" the engine stays busy (60 s)');
    }
    last = c;
  }, 10_000);
  // The check after "Stop" must be awaited before closing the app (otherwise it queries a closed port).
  const stopped =
    stopAfter === null
      ? Promise.resolve()
      : (async () => {
          await Bun.sleep(stopAfter);
          console.log(`"Stop" after ${stopAfter / 1000} s`);
          const tf = Date.now();
          await mc.abort(id, project);
          for (let i = 0; i < 120; i++) {
            const d = await counters(s!.engine);
            if (d && d.busy === 0) return console.log(`  engine free ${((Date.now() - tf) / 1000).toFixed(1)} s after "Stop"`);
            await Bun.sleep(500);
          }
          console.log('  after "Stop" the engine stays busy (60 s)');
        })();
  const tools: string[] = [];
  let text = "";
  for await (const p of mc.turn(id, project, message, { model })) {
    if (p.type === "tool" && (p.status === "completed" || p.status === "error")) tools.push(`${p.name}:${p.status}`);
    if (p.type === "text") text += p.delta;
    if (p.type === "error") console.log("error:", JSON.stringify(p.error).slice(0, 300));
    if (Date.now() - t0 > LIMIT_MS) {
      console.log(`limit of ${LIMIT_MS / 60000} min: stopping`);
      await mc.abort(id, project);
      break;
    }
  }
  await stopped;
  clearInterval(watch);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s; tools: ${tools.join(", ")}`);
  console.log(`answer: ${JSON.stringify(text.trim().slice(-300))}`);
  console.log(`files in the project: ${fs.readdirSync(project).join(", ")}`);
} finally {
  if (app.exitCode !== null) console.log(`the app had already exited (code ${app.exitCode})`);
  app.kill();
  await Bun.sleep(4000);
  // The engine's log stays for analysis (the rest is removed).
  const log = path.join(data, "logs", "engine.log");
  if (fs.existsSync(log)) fs.copyFileSync(log, path.join(os.tmpdir(), "mango-real-engine.log"));
  for (const f of ["startup.log", "agent.log"]) {
    const p = path.join(data, "logs", f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(os.tmpdir(), `mango-real-${f}`));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
