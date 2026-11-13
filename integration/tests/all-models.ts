// A conversation with every local model, from the real app (real catalog, real engines and weights): the engine
// manager starts one model at a time. It holds the GPUs for a few minutes: it is not part of `bun test`.
// Data and ports in a temporary folder, like the integration test.
//
// Usage: bun integration/tests/all-models.ts [key ...]   (without keys: all the offered ones)

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { APP_EXE, writeLanguage } from "./environment";


const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-models-"));
const data = path.join(root, "data");
const project = path.join(root, "project");
writeLanguage(data);
fs.mkdirSync(project);
const app = spawn(APP_EXE, ["--service"], {
  env: { ...process.env, MANGO_DATA: data, MANGO_AGENT_PORT: String(await freePort()), MANGO_ENGINE_PORT: String(await freePort()) },
  stdio: "ignore",
});
try {
  const t0 = Date.now();
  let s = await find(data);
  while (!s) {
    if (app.exitCode !== null) throw new Error(`the app closed; log in ${path.join(data, "logs")}`);
    if (Date.now() - t0 > 300_000) throw new Error("app not ready after 300 s");
    await Bun.sleep(1000);
    s = await find(data);
  }
  console.log(`app ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const mc = new MangoCode(s);
  const offered = await mc.models(project);
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : offered.map((m) => m.key);
  console.log(`offered models: ${offered.map((m) => `${m.key} (${m.context})`).join(", ")}`);
  for (const k of keys) {
    const id = await mc.createSession(project, { title: k });
    const t = Date.now();
    let text = "";
    let error = "";
    for await (const p of mc.turn(id, project, "Answer with a single word: ready.", { model: k })) {
      if (p.type === "text") text += p.delta;
      if (p.type === "error") error = JSON.stringify(p.error);
    }
    const m = await mc.engine();
    console.log(`${k.padEnd(8)} ${((Date.now() - t) / 1000).toFixed(0).padStart(4)} s  engine=${m.model}  ${error ? `ERROR ${error}` : JSON.stringify(text.trim())}`);
  }
} finally {
  app.kill();
  await Bun.sleep(3000);
  fs.rmSync(root, { recursive: true, force: true });
}
