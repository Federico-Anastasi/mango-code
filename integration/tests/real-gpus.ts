// Releasing and resuming the GPUs on the real engine (U5): the development app with a real model (the default
// one unless given), data and ports in a temporary folder. It measures the seconds of "release" and "resume", the
// GPUs' memory before and after, and how many tokens the engine rereads when the conversation resumes.
// It holds the GPUs for a couple of minutes: it is not part of `bun test`.
//
// Usage: bun integration/tests/real-gpus.ts [model]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { writeLanguage } from "./environment";

const REPO = path.resolve(import.meta.dir, "..", "..");
const APP_EXE = path.join(REPO, "app", "target", "debug", "mango-code.exe");
const model = process.argv[2];

const freePort = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });
const vram = () => execFileSync("nvidia-smi", ["--query-gpu=index,memory.used", "--format=csv,noheader"], { encoding: "utf8" }).trim().split("\n").map((r) => r.trim()).join(" | ");
const reads = (data: string) => {
  const log = fs.readFileSync(path.join(data, "logs", "engine.log"), "utf8");
  const m = [...log.matchAll(/prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/g)].at(-1);
  return m ? `${m[2]} tokens in ${(Number(m[1]) / 1000).toFixed(1)} s` : "no read in the log";
};
const seconds = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-gpus-"));
const data = path.join(root, "data");
const project = path.join(root, "project");
writeLanguage(data);
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "notes.md"), "# Notes\n\nThe project is called Sunflower and starts in March.\n");
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
  if (model) await mc.startModel(model);
  const st = await mc.engine();
  console.log(`started ${st.model} on ${st.gpus.map((x: any) => `${x.index} (${x.memory_used_mib} MiB)`).join(", ")}`);

  const id = await mc.createSession(project, { title: "gpus" });
  const turn = async (text: string) => {
    const t0 = Date.now();
    let answer = "";
    for await (const p of mc.turn(id, project, text)) if (p.type === "text") answer += p.delta;
    return `${seconds(t0)}, engine: ${reads(data)}, answer: ${JSON.stringify(answer.trim().slice(0, 80))}`;
  };
  console.log(`first message: ${await turn("Read notes.md and tell me in one line what the project is called.")}`);
  console.log(`VRAM before: ${vram()}`);

  let t0 = Date.now();
  const released = await mc.release();
  console.log(`release: ${seconds(t0)}, phase ${released.phase}`);
  await Bun.sleep(1500);
  console.log(`VRAM after:  ${vram()}`);

  t0 = Date.now();
  const resumed = await mc.resume();
  console.log(`resume: ${seconds(t0)}, phase ${resumed.phase}`);
  console.log(`second message: ${await turn("And when does it start? One line.")}`);
} finally {
  app.kill();
  await Bun.sleep(4000);
  fs.rmSync(root, { recursive: true, force: true });
}
