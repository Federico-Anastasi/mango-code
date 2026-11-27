// The requests the agent sends for a model whose harness is Mango Harness 2. The first request of a conversation is the
// one in `packages/opencode/test/mango-harness/examples`, byte for byte, today's date in place of the file's. What a
// tool answers, also when it fails, reaches the model as the harness wrote it.
// Run it, after `cargo build -p mango-code -p engine` and the agent's build, with
// `off-screen bun test --cwd integration harness-2-requests`.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find, type Step } from "../client/mango-code";
import { REPO, start } from "./environment";
import { chatRequests, type ChatBody } from "./requests";

const EXAMPLES = path.join(REPO, "packages", "opencode", "test", "mango-harness", "examples");
const RULES = "\n\n<mango-rules>";
const AFTER_FAILED_CALL =
  "<system-reminder>\nThat did not work. The answer above says what was wrong: change the command. Do not send it again as it is.\n</system-reminder>";

type Example = { messages: { role: string; content: string }[]; tools: unknown[] };

/** Runs one turn of a new conversation in a folder named `project` and gives the requests meant for the model. */
async function requests(project: string, said: string, script: unknown[]): Promise<ChatBody[]> {
  const env = await start(script, { harness: "mango-harness-2" });
  try {
    const folder = path.join(env.root, project);
    fs.mkdirSync(folder);
    const mc = new MangoCode((await find(env.data))!);
    const id = await mc.createSession(folder);
    const steps: Step[] = [];
    for await (const step of mc.turn(id, folder, said, { model: "fake" })) steps.push(step);
    expect(steps.at(-1)?.type).toBe("end");
    return chatRequests(env.engineLog)
      .map((r) => r.body)
      .filter((b) => (b.tools?.length ?? 0) > 0);
  } finally {
    env.close();
    Bun.sleepSync(1500);
  }
}

// `own-tool` has a tool of the user's own, which needs an MCP server of the user's in the environment.
for (const name of ["notes"]) {
  test(`${name}: the first request is the example's`, async () => {
    const example = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8")) as Example;
    const [system, user] = example.messages;
    const project = system.content.match(/^- Project: (.+)\. You are inside its folder/m)![1];
    const [first] = await requests(project, user.content.slice(0, user.content.indexOf(RULES)), [{ text: "Done." }]);
    // The agent writes the date of the PC's clock, and `bun test` runs in UTC: around midnight the two days differ.
    const sent = (first.messages[0] as { content: string }).content.match(/^- Date: (.+)\.$/m)![1];
    expect(Math.abs(new Date(sent).getTime() - new Date(new Date().toDateString()).getTime())).toBeLessThanOrEqual(86_400_000);
    expect(first.messages).toEqual([
      { role: "system", content: system.content.replace(/^- Date: .+\.$/m, `- Date: ${sent}.`) },
      { role: "user", content: user.content },
    ]);
    expect(first.tools).toEqual(example.tools);
  }, 300_000);
}

test("a call that fails reaches the model as the harness answered it, with the hook after it", async () => {
  const all = await requests("notes", "Read missing.txt.", [{ tool: "read", arguments: { path: "missing.txt" } }, { text: "Done." }]);
  const result = all[1].messages.at(-1) as { role: string; content: string };
  expect(result.role).toBe("tool");
  expect(result.content).toStartWith("No file missing.txt. The folder . holds:\n");
  expect(result.content).toEndWith(`\n\n${AFTER_FAILED_CALL}`);
}, 300_000);
