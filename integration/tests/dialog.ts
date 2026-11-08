// Answers a real Windows dialog (the folder picker, a message) opened by the tests' app: it drives `selector.ps1`,
// which only looks at the windows of that process.

import path from "node:path";

/** `args`: `-Path <folder>` picks that folder, `-Cancel` cancels, with nothing it reads the message (in the output, line "text:") and presses "OK". */
export async function answer(processId: number, ...args: string[]) {
  const r = Bun.spawn(["powershell", "-NoProfile", "-File", path.join(import.meta.dir, "selector.ps1"), "-ProcessId", String(processId), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = [await new Response(r.stdout).text(), await new Response(r.stderr).text()];
  return { code: await r.exited, output: stdout + stderr };
}
