// Rules with `paths:` (.claude/rules/*.md): they enter only when the conversation reads or changes a matching file,
// once per conversation, at the end of the tool's result; a rule without `paths:` stays in the prompt all the time.
// It holds for the working folder and for the extra folders. Scripted fake engine.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MangoCode, find } from "../client/mango-code";
import { start, type Environment } from "./environment";

const RUST = "RUST-PURPLE"; // src/**/*.rs, working folder
const DOC = "APRICOT-DOC"; // docs/*.md, working folder
const CONF = "LEMON-CONF"; // conf/*.toml, working folder: changed with edit
const DATA = "CHERRY-METHOD"; // data/**/*.csv, extra folder
const ALWAYS = "always cite the method keyword"; // the method's rule without paths:

let env: Environment;
let mc: MangoCode;
let project: string;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeAll(async () => {
  env = await start(({ project, method }) => [
    { tool: "read", arguments: { filePath: path.join(project, "note.txt") } },
    { tool: "read", arguments: { filePath: path.join(project, "src", "lib.rs") } },
    { tool: "read", arguments: { filePath: path.join(project, "src", "main.rs") } },
    { tool: "write", arguments: { filePath: path.join(project, "docs", "new.md"), content: "hello\n" } },
    { tool: "edit", arguments: { filePath: path.join(project, "conf", "a.toml"), oldString: "x = 1", newString: "x = 1 # ok" } },
    { tool: "read", arguments: { filePath: path.join(method, "CLAUDE.md") } },
    { tool: "read", arguments: { filePath: path.join(method, "data", "a.csv") } },
    { text: "Done." },
  ]);
  project = env.project;
  // The files are prepared before the first request: the agent reads the rules when the folder's instance is born.
  write(path.join(project, ".claude", "rules", "rust.md"), `---\npaths:\n  - "src/**/*.rs"\n---\n${RUST}: Rust files end with an empty line.\n`);
  write(path.join(project, ".claude", "rules", "doc.md"), `---\npaths: ["docs/*.md"]\n---\n${DOC}: documents are in English.\n`);
  write(path.join(env.method, ".claude", "rules", "data.md"), `---\npaths:\n  - "data/**/*.csv"\n---\n${DATA}: CSVs use the semicolon.\n`);
  for (const f of ["note.txt", "src/lib.rs", "src/main.rs", "docs/old.md"]) write(path.join(project, f), "content\n");
  write(path.join(env.method, "data", "a.csv"), "a;b\n");
  write(path.join(project, "conf", "a.toml"), "x = 1\n");
  write(path.join(project, ".claude", "rules", "conf.md"), `---\npaths: "conf/*.toml"\n---\n${CONF}: values are changed one at a time.\n`);
  mc = new MangoCode((await find(env.data))!);
}, 200_000);

afterAll(() => {
  env?.close();
  Bun.sleepSync(1500);
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {}
});

const chatRequests = () =>
  fs
    .readFileSync(env.engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.route.startsWith("/v1/chat/completions") && !r.headers["x-mango-warmup"]);

const textOf = (m: any): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const systemOf = (body: any) => body.messages.filter((m: any) => m.role === "system").map(textOf).join("\n");

async function runTurn(id: string) {
  const tools: { name: string; input: any; output: string }[] = [];
  for await (const p of mc.turn(id, project, "Look at the files", { model: "fake" })) {
    if (p.type === "tool" && p.status === "completed") tools.push({ name: p.name, input: p.input, output: p.output ?? "" });
    if (p.type === "tool" && p.status === "error") throw new Error(`${p.name}: ${p.error}`);
  }
  return tools;
}

const open = () => mc.createSession(project, { permissions: [{ permission: "external_directory", pattern: "*", action: "allow" }] });

test("a rule with paths is not in the prompt; one without paths is", async () => {
  await mc.setExtraFolders(project, [env.method]);
  await runTurn(await open());
  const first = chatRequests()[0].body;
  const s = systemOf(first);
  expect(s).toContain("TANGERINE"); // the project's CLAUDE.md
  expect(s).toContain(ALWAYS); // the method's rule without paths:
  for (const word of [RUST, DOC, CONF, DATA]) expect(JSON.stringify(first.messages)).not.toContain(word);
}, 180_000);

test("the rule enters with the matching file, at the end of the result, once; other files do not make it enter", async () => {
  const [note, lib, main, created, conf, claude, csv] = await runTurn(await open());
  expect(note.output).not.toContain(RUST);
  expect(lib.output).toContain(RUST);
  expect(lib.output).toContain(path.join(project, ".claude", "rules", "rust.md"));
  expect(lib.output.indexOf("</content>")).toBeLessThan(lib.output.indexOf(RUST)); // after the file's content
  expect(main.output).not.toContain(RUST); // already entered in this conversation
  expect(created.name).toBe("write");
  expect(created.output).toContain(DOC); // a file is changed: it enters with write too
  expect(created.output).not.toContain(RUST);
  expect(conf.name).toBe("edit");
  expect(conf.output).toContain(CONF); // with edit too, without having read the file
  expect(claude.output).not.toContain(DATA); // a file of the extra folder that does not match
  expect(csv.output).toContain(DATA); // the rule of an extra folder, relative to its root
  // the frontmatter does not enter: it is a loading detail, not an instruction
  expect(lib.output).not.toContain("paths:");
  // and the reminder really reaches the model: the next step sees it in the tool's result
  const last = chatRequests().at(-1)!.body;
  const results = last.messages.filter((m: any) => m.role === "tool").map(textOf).join("\n");
  expect(results.split(RUST).length - 1).toBe(1);
}, 180_000);

test("a new conversation reloads the rule at the first matching read", async () => {
  const [, lib] = await runTurn(await open());
  expect(lib.output).toContain(RUST);
}, 180_000);
