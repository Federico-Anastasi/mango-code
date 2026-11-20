// A program of the app's run is stopped when the app is ended by force with all its processes (`taskkill /F /T` on the app,
// as a crash or a task manager would): the guardian the app starts at the beginning (`mango-code.exe --reap`) is outside the
// app's job and is not a child of the app, so it outlives the app and stops the programs of the run, without waiting for the
// next start. Two ways to see it: a program that carries the run's mark (the guardian's command line says it), and a program
// the model starts through the agent's shell (with the Microsoft Store's PowerShell 7 it is created outside every job, so
// only the guardian can stop it).
// `off-screen bun test --cwd integration tests/guardian.test.ts`, after `cargo build -p mango-code -p engine` in app/.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const alive = (pid: number) => spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true }).stdout.includes(String(pid));
const processes = (name: string) =>
  spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`], { encoding: "utf8", windowsHide: true })
    .stdout.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ pid: Number(line.split("|")[0]), command: line.slice(line.indexOf("|") + 1) }));
/** The guardians of the app `appPid`: the processes of the app's program with `--reap` and its pid. */
const guardians = (appPid: number) => processes("mango-code.exe").filter((p) => p.command.includes(`--reap ${appPid} `));
const gone = async (pid: number, ms = 20_000) => {
  for (let waited = 0; waited < ms; waited += 200) {
    if (!alive(pid)) return true;
    await Bun.sleep(200);
  }
  return false;
};
const kill = (pid: number) => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });

const strays: number[] = [];
const environments: Environment[] = [];
afterAll(() => {
  strays.filter(alive).forEach(kill);
  environments.forEach((env) => env.close());
});

describe("a program that carries the run's mark", () => {
  test("is stopped by the guardian, with nothing else, when the app is ended by force", async () => {
    const env = await start([{ text: "Here I am." }]);
    environments.push(env);
    const appPid = env.app.pid!;
    const [guard] = guardians(appPid);
    expect(guardians(appPid).length, "one guardian, the copy started by the first one").toBe(1);
    const run = /--reap \d+ (\S+) --detached/.exec(guard.command)![1];
    const marked = spawn("ping", ["-n", "300", "127.0.0.1"], { env: { ...process.env, MANGO_APP_RUN: run }, stdio: "ignore", windowsHide: true });
    const another = spawn("ping", ["-n", "300", "127.0.0.1"], { env: { ...process.env, MANGO_APP_RUN: `${appPid}-another` }, stdio: "ignore", windowsHide: true });
    const unmarked = spawn("ping", ["-n", "300", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    const own = [marked, another, unmarked] as ChildProcess[];
    strays.push(...own.map((c) => c.pid!));
    expect(own.every((c) => alive(c.pid!))).toBe(true);

    kill(appPid);

    expect(await gone(appPid)).toBe(true);
    expect(await gone(marked.pid!), "the program of the run").toBe(true);
    expect(await gone(guard.pid), "the guardian, once its work is done").toBe(true);
    expect([another, unmarked].map((c) => alive(c.pid!)), "a program of another run and one without a mark stay").toEqual([true, true]);
    expect(fs.readFileSync(path.join(env.data, "logs", "startup.log"), "utf8")).not.toContain("guardian of the programs");
  }, 180_000);
});

describe("a program the model starts through the agent's shell", () => {
  // A count no other session uses, to find this program among the pings of the PC.
  const COMMAND = "Start-Process cmd -ArgumentList '/c','ping -n 297 127.0.0.1 >nul' -WindowStyle Hidden";
  const pings = () => processes("PING.EXE").filter((p) => p.command.includes("-n 297 "));

  test("is stopped by the guardian when the app is ended by force", async () => {
    const env = await start([{ tool: "bash", arguments: { command: COMMAND } }, { text: "Started." }]);
    environments.push(env);
    const mc = new MangoCode((await find(env.data))!);
    const id = await mc.createSession(env.project, { title: "left running" });
    for await (const _ of mc.turn(id, env.project, "Start a server", { model: "fake" })) {
    }
    const left = pings();
    strays.push(...left.map((p) => p.pid));
    expect(left.length, "the program the model started").toBe(1);
    const appPid = env.app.pid!;
    const [guard] = guardians(appPid);

    kill(appPid);

    expect(await gone(appPid)).toBe(true);
    expect(await gone(left[0].pid), "the program the model left running").toBe(true);
    expect(await gone(guard.pid), "the guardian, once its work is done").toBe(true);
  }, 180_000);
});
