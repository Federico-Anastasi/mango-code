// A program the model starts in the background with the shell (here a long `ping`, as a dev server would be) is listed
// for the conversation that started it, with "Stop" (route /mango/processes of the agent), and Stop ends it with what
// it started. Another conversation does not see it, a stale creation time (a PID taken by another program) is
// refused, and so is a Stop that is not JSON (a page of another site could send it without asking).
// With PowerShell (the default shell) and with Git Bash, where `&` and a command that times out leave a program whose
// parent has ended.
// `bun test integration`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";
import { page } from "./cdp";

type Running = { pid: number; started: number; name: string; command: string; asked: string };
const list = async (env: Environment, sessionID: string): Promise<Running[]> =>
  ((await (await fetch(`${env.agent}/mango/processes?sessionID=${encodeURIComponent(sessionID)}`)).json()) as { processes: Running[] }).processes;
const stop = (env: Environment, sessionID: string, item: { pid: number; started: number }, type = "application/json") =>
  fetch(`${env.agent}/mango/processes/stop`, {
    method: "POST",
    headers: { "content-type": type },
    body: JSON.stringify({ sessionID, pid: item.pid, started: item.started }),
  });
const alive = (pid: number) => spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid));
/** The test's own programs, by their PID, if a check failed before Stop. */
const cleanup = (left: Running[]) => left.filter((item) => alive(item.pid)).forEach((item) => spawnSync("taskkill", ["/PID", String(item.pid), "/T", "/F"]));

/** An environment for the tests of a `describe`: `prepare` writes in the project before the first conversation. */
function environment(script: unknown[], prepare?: (project: string) => void, options: Parameters<typeof start>[1] = {}) {
  const box: { env?: Environment; mc?: MangoCode } = {};
  beforeAll(async () => {
    box.env = await start(script, options);
    prepare?.(box.env.project);
    box.mc = new MangoCode((await find(box.env.data))!);
  }, 200_000);
  afterAll(() => {
    box.env?.close();
    Bun.sleepSync(1500);
    try {
      if (box.env) fs.rmSync(box.env.root, { recursive: true, force: true });
    } catch {}
  });
  return box;
}

describe("PowerShell", () => {
  // cmd waits for ping: the program listed is ping, and Stop ends cmd with it (cmd /c "a & b" would start b).
  const COMMAND = "Start-Process cmd -ArgumentList '/c','ping -n 300 127.0.0.1 >nul' -WindowStyle Hidden";
  const box = environment([{ tool: "bash", arguments: { command: COMMAND } }, { text: "Started." }]);

  test("the program the model left running is listed for its conversation and Stop ends it", async () => {
    const env = box.env!;
    const mc = box.mc!;
    const id = await mc.createSession(env.project, { title: "left running" });
    for await (const _ of mc.turn(id, env.project, "Start a server", { model: "fake" })) {
    }
    const other = await mc.createSession(env.project, { title: "another" });

    const left = await list(env, id);
    try {
      expect(left.map((item) => [item.name.toLowerCase(), item.asked])).toEqual([["ping.exe", COMMAND]]);
      expect(await list(env, other)).toEqual([]);
      expect((await stop(env, id, { pid: left[0].pid, started: left[0].started - 5000 })).status).toBe(404);
      expect(alive(left[0].pid)).toBe(true);
      expect((await stop(env, other, left[0])).status).toBe(404);
      expect((await stop(env, id, left[0], "text/plain")).status).toBe(415);
      expect(alive(left[0].pid)).toBe(true);

      const response = await stop(env, id, left[0]);
      expect(response.status).toBe(200);
      expect(alive(left[0].pid)).toBe(false);
      expect(await list(env, id)).toEqual([]);
    } finally {
      cleanup(left);
    }
  }, 120_000);
});

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

describe.skipIf(!fs.existsSync(GIT_BASH))("Git Bash", () => {
  // `&`: bash ends at once and ping keeps its output open. The second command times out: its subshell has already
  // ended, so stopping the command does not reach ping.
  const BACKGROUND = "ping -n 300 127.0.0.1 &";
  const TIMED_OUT = "(ping -n 300 127.0.0.1 &); sleep 60";
  const box = environment(
    [
      { tool: "bash", arguments: { command: BACKGROUND } },
      { tool: "bash", arguments: { command: TIMED_OUT, timeout: 3000 } },
      { text: "Started." },
    ],
    (project) => fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ shell: GIT_BASH })),
  );

  test("what a command left running with & or after its time ran out is listed, and Stop ends it", async () => {
    const env = box.env!;
    const mc = box.mc!;
    const id = await mc.createSession(env.project, { title: "left running" });
    const started = Date.now();
    for await (const _ of mc.turn(id, env.project, "Start a server", { model: "fake" })) {
    }
    // The command with `&` does not wait for ping (300 s): only the other one's 3 s.
    expect(Date.now() - started).toBeLessThan(60_000);
    const other = await mc.createSession(env.project, { title: "another" });

    const left = await list(env, id);
    try {
      expect(left.map((item) => [item.name.toLowerCase(), item.asked])).toEqual([
        ["ping.exe", BACKGROUND],
        ["ping.exe", TIMED_OUT],
      ]);
      expect(await list(env, other)).toEqual([]);
      for (const item of left) {
        expect((await stop(env, id, item)).status).toBe(200);
        expect(alive(item.pid)).toBe(false);
      }
      expect(await list(env, id)).toEqual([]);
    } finally {
      cleanup(left);
    }
  }, 180_000);
});

describe("in the window", () => {
  const COMMAND = "Start-Process cmd -ArgumentList '/c','ping -n 300 127.0.0.1 >nul' -WindowStyle Hidden";
  const box = environment([{ tool: "bash", arguments: { command: COMMAND } }, { text: "Started." }], undefined, { window: true });

  test("the side panel of the conversation lists the program it left running, and «Ferma» ends it", async () => {
    const env = box.env!;
    const mc = box.mc!;
    const p = await page(env.cdp!, (t) => t.url.startsWith(env.agent), 120_000);
    const id = await mc.createSession(env.project, { title: "left running" });
    const click = async (selector: string) => {
      const at = await p.evaluate(`(() => { const q = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`);
      if (!at) throw new Error(`not on the page: ${selector}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    };
    const until = async (what: string, condition: () => Promise<boolean>, ms = 30_000) => {
      for (let t = 0; t < ms && !(await condition().catch(() => false)); t += 250) await Bun.sleep(250);
      expect(await condition(), what).toBe(true);
    };
    let left: Running[] = [];
    try {
      for await (const _ of mc.turn(id, env.project, "Start a server", { model: "fake" })) {
      }
      left = await list(env, id);
      expect(left.map((item) => item.name.toLowerCase())).toEqual(["ping.exe"]);
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(env.project))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      await p.send("Page.navigate", { url: `${env.agent}/${b64}/session/${id}` });
      await until("the conversation", async () => (await p.evaluate(`document.body.innerText`)).includes("Started."));
      // the list is in the side panel, which the user opens from the top bar
      await click('[aria-controls="review-panel"]');
      await until("the list of the programs", async () => (await p.evaluate(`!!document.querySelector('[data-component="running-programs"] [data-slot="running-program"]')`)) as boolean);
      expect(await p.evaluate(`document.querySelector('[data-component="running-programs"]').innerText`)).toContain("PING.EXE");
      expect(await p.evaluate(`document.querySelector('[data-component="running-programs"]').innerText`)).toContain("Ferma");
      expect(alive(left[0].pid)).toBe(true);

      await click('[data-component="running-programs"] [data-slot="running-program"] button');
      await until("the program ended", async () => !alive(left[0].pid));
      await until("the list empty", async () => !(await p.evaluate(`!!document.querySelector('[data-component="running-programs"]')`)));
      expect(await list(env, id)).toEqual([]);
    } finally {
      cleanup(left);
      p.close();
    }
  }, 180_000);
});
