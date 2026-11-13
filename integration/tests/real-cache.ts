// Two user messages in a row with a real model: how much of its cache does the engine keep on the second one? The
// first turn reads a file of ~4,600 tokens; the engine's lines show what each request re-read ("prompt eval time") and
// how much it kept ("f_keep"). The second message should re-read a few dozen tokens: thousands mean the history of the
// previous turn changed (a chat template dropping past reasoning, tool outputs removed). It holds the GPUs for a few
// minutes: it is not part of `bun test`.
//
// Usage: bun integration/tests/real-cache.ts [model]   (the first message in a new folder re-reads the whole prompt:
// the app prepared another folder at startup)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { APP_EXE, writeLanguage } from "./environment";

const model = process.argv[2] ?? "3.5-2b";
const port = () =>
  new Promise<number>((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => ok(p));
    });
  });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-cache-"));
const data = path.join(root, "data");
const project = path.join(root, "project");
writeLanguage(data);
fs.mkdirSync(project);
const weeks = Array.from({ length: 120 }, (_, i) => `- Week ${i + 1}: watering rota for plot ${(i % 40) + 1}, compost turned, rain barrel at ${(i * 7) % 100}%, notes from the volunteer meeting about tools and seeds.`);
fs.writeFileSync(path.join(project, "notes.md"), ["# Sunflower", "", "A shared vegetable garden in the neighbourhood, 40 families, rainwater harvesting.", "", ...weeks, ""].join("\n"));
const app = spawn(APP_EXE, ["--service"], {
  env: { ...process.env, MANGO_DATA: data, MANGO_AGENT_PORT: String(await port()), MANGO_ENGINE_PORT: String(await port()) },
  stdio: "ignore",
});
try {
  let s = await find(data);
  for (let t0 = Date.now(); !s; s = await find(data)) {
    if (Date.now() - t0 > 300_000) throw new Error("app not ready");
    await Bun.sleep(1000);
  }
  const mc = new MangoCode(s);
  await mc.startModel(model);
  const id = await mc.createSession(project, { title: "two turns" });
  for (const message of ["Read notes.md and tell me in one line what it is about.", "Thanks. In one word: how many families?"]) {
    const t0 = Date.now();
    const tools: string[] = [];
    let text = "";
    for await (const p of mc.turn(id, project, message, { model })) {
      if (p.type === "tool" && (p.status === "completed" || p.status === "error")) tools.push(p.name);
      if (p.type === "text") text += p.delta;
    }
    console.log(`turn in ${((Date.now() - t0) / 1000).toFixed(0)} s; tools: ${tools.join(", ")}; answer: ${JSON.stringify(text.trim().slice(-160))}`);
  }
} finally {
  app.kill();
  await Bun.sleep(4000);
  const log = fs.readFileSync(path.join(data, "logs", "engine.log"), "utf8");
  for (const line of log.split("\n")) {
    if (/f_keep|prompt eval time/.test(line)) console.log(line.slice(0, 170));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
