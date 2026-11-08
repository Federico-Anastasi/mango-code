// mango-project.js - the project's context as Claude Code reads it.
//
// The app keeps out everything that is on the PC (OPENCODE_DISABLE_CLAUDE_CODE, OPENCODE_DISABLE_EXTERNAL_SKILLS:
// no ~/.claude, no global skills), but a project brings its own context and it must be read: that is what
// Claude Code does, and it is what an app needs when it opens Mango Code on one of its folders. For every project
// (every opencode instance has its own folder) the following are added to the config:
//   - the instructions: CLAUDE.md, CLAUDE.local.md and .claude/rules/*.md, from the open folder up to the
//     project root (opencode looks for them by itself, walking up); AGENTS.md is already read by opencode;
//   - the skills of the .claude/skills folders found while walking up;
//   - the MCP servers of the first .mcp.json found while walking up (Claude Code format: "mcpServers"),
//     translated to the opencode format. A name already used by Mango Code's servers stays ours (and the log
//     says so).
// The project root is the git repository's root if there is one, otherwise the open folder.
// The extra folders an app declared for this folder (PUT /mango/extra-folders, agent server) give their
// instructions like the open folder, without walking up and without .mcp.json; they are read at every request
// to the model, so they apply immediately (their skills are read by the agent's skills service).
//
// A rule with `paths:` in the frontmatter (list of globs, relative to the folder that contains `.claude/`) is
// not in the prompt: it is appended to the result of read, edit or write on a matching file, once per
// conversation (like the nearby instructions the agent attaches to read). At the tail and not in the system
// prompt because the prompt is the prefix the engine keeps in memory: touching it would mean re-reading the
// whole conversation. A rule without `paths:` is always in the prompt.

import fs from "node:fs";
import path from "node:path";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

// A .mcp.json server in the opencode format. stdio: {command, args, env}; http/sse: {url, headers}.
function toOpencodeMcp(s) {
  if (!s || typeof s !== "object") return null;
  if (s.url) return { type: "remote", url: s.url, headers: s.headers ?? {}, enabled: true };
  if (!s.command) return null;
  const v = { type: "local", command: [s.command, ...(Array.isArray(s.args) ? s.args : [])], enabled: true };
  if (s.env && typeof s.env === "object") v.environment = s.env;
  return v;
}

// The `rel` paths that exist, from the open folder up to the root included.
function walkUp(from, root, rel) {
  const out = [];
  let d = path.resolve(from);
  const stop = path.resolve(root);
  for (;;) {
    const p = path.join(d, rel);
    if (fs.existsSync(p)) out.push(p);
    // On Windows the same path can arrive with different letter case (C: and c:).
    if (d.toLowerCase() === stop.toLowerCase()) break;
    const up = path.dirname(d);
    if (up === d || !d.toLowerCase().startsWith(stop.toLowerCase())) break;
    d = up;
  }
  return out;
}

// The extra folders declared for `directory`: the agent server keeps them in this registry, in the same process.
// The key is the one defined by packages/opencode/src/server/shared/mango-folders.ts.
function extraFolders(directory) {
  return globalThis[Symbol.for("mango.folders")]?.get(path.resolve(directory).toLowerCase()) ?? [];
}

// A rules file: the frontmatter globs (`paths:`, null if there are none) and the text without frontmatter. A
// frontmatter that is not YAML or has a `paths` of another type does not make the rule disappear: it stays an
// always-loaded rule, and the log says so.
function readRule(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { globs: null, body: text };
  const warn = (reason) => {
    if (!warned.has(file)) console.warn(`mango-project: ${file}: ${reason}, the rule stays always loaded`);
    warned.add(file);
    return { globs: null, body: text };
  };
  let paths;
  try {
    paths = Bun.YAML.parse(m[1])?.paths;
  } catch (e) {
    return warn(`the frontmatter is not valid YAML (${e.message})`);
  }
  const globs = typeof paths === "string" ? [paths] : paths;
  if (globs === undefined || globs === null || (Array.isArray(globs) && globs.length === 0)) return { globs: null, body: text.slice(m[0].length) };
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return warn("`paths` is not a list of globs");
  return { globs, body: text.slice(m[0].length) };
}
const warned = new Set();

// The `.claude/rules/*.md` rules directly in `dir`, with the folder (`base`) their globs refer to.
function rulesIn(dir) {
  const folder = path.join(dir, ".claude", "rules");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((n) => n.endsWith(".md")).sort().map((n) => ({ file: path.join(folder, n), base: dir, ...readRule(path.join(folder, n)) }));
}

// CLAUDE.md, CLAUDE.local.md and the always-loaded rules of `dir`.
function instructionsIn(dir) {
  const out = ["CLAUDE.md", "CLAUDE.local.md"].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
  return [...out, ...rulesIn(dir).filter((r) => !r.globs).map((r) => r.file)];
}

const matches = (rule, file) => {
  const rel = path.relative(rule.base, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  const p = rel.split(path.sep).join("/");
  return rule.globs.some((g) => new Bun.Glob(g).match(p));
};

// The path rules already entered in a conversation: the memory lives in the tools' results
// (`metadata.rules`), so it holds across a restart, and after the conversation summary, which deletes their
// text, they enter again.
function enteredRules(messages) {
  const out = new Set();
  for (const m of messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool" || p.state?.status !== "completed" || p.state.time?.compacted) continue;
      for (const f of p.state.metadata?.rules ?? []) out.add(f);
    }
  }
  return out;
}

export const MangoProject = async ({ directory, worktree }) => {
  // For a folder outside git opencode gives the disk root as worktree: we do not walk up there.
  const wt = worktree ? path.resolve(worktree) : null;
  const root = wt && path.parse(wt).root !== wt ? wt : directory;
  // The folders that carry `.claude/rules`: those from the open folder up to the root, and the extra folders.
  const ruleFolders = () => [
    ...walkUp(directory, root, path.join(".claude", "rules")).map((r) => path.dirname(path.dirname(r))),
    ...extraFolders(directory),
  ];
  // Per conversation, the files that in-flight calls of the same message have already let in: the results of
  // that message are not yet in the history that reaches the plugin.
  const inProgress = new Map();
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      for (const dir of extraFolders(directory)) {
        for (const f of instructionsIn(dir)) output.system.push("Instructions from: " + f + "\n" + fs.readFileSync(f, "utf8"));
      }
    },
    "tool.execute.after": async (input, output) => {
      if (!FILE_TOOLS.has(input.tool) || typeof input.args?.filePath !== "string") return;
      const file = path.resolve(directory, input.args.filePath);
      const candidates = ruleFolders().flatMap(rulesIn).filter((r) => r.globs && matches(r, file));
      if (!candidates.length) return;
      if (inProgress.get(input.sessionID)?.message !== input.messageID) inProgress.set(input.sessionID, { message: input.messageID, files: new Set() });
      const claimed = inProgress.get(input.sessionID).files;
      const entered = enteredRules(input.messages);
      const fresh = candidates.filter((r) => !entered.has(r.file) && !claimed.has(r.file));
      if (!fresh.length) return;
      for (const r of fresh) claimed.add(r.file);
      output.metadata = { ...output.metadata, rules: fresh.map((r) => r.file) };
      output.output += "\n\n<system-reminder>\n" + fresh.map((r) => "Instructions from: " + r.file + "\n" + r.body).join("\n\n") + "\n</system-reminder>";
    },
    config: async (cfg) => {
      // Absolute paths, found here within the root: opencode looks for a relative path walking up to its
      // worktree, which outside git is the disk root (and that is how it found ~/.claude/rules).
      const instructions = [];
      for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) instructions.push(...walkUp(directory, root, name));
      for (const dir of walkUp(directory, root, path.join(".claude", "rules"))) {
        instructions.push(...rulesIn(path.dirname(path.dirname(dir))).filter((r) => !r.globs).map((r) => r.file));
      }
      cfg.instructions = [...(cfg.instructions ?? []), ...instructions];

      const skills = walkUp(directory, root, path.join(".claude", "skills"));
      if (skills.length) cfg.skills = { ...(cfg.skills ?? {}), paths: [...(cfg.skills?.paths ?? []), ...skills] };

      const [file] = walkUp(directory, root, ".mcp.json");
      if (!file) return;
      let servers;
      try {
        servers = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")).mcpServers ?? {};
      } catch (e) {
        throw new Error(`${file} is not valid JSON: ${e.message}`);
      }
      cfg.mcp = cfg.mcp ?? {};
      for (const [name, s] of Object.entries(servers)) {
        if (cfg.mcp[name]) {
          console.warn(`mango-project: the MCP server «${name}» of ${file} has the name of a Mango Code one, the Mango Code one stays`);
          continue;
        }
        const v = toOpencodeMcp(s);
        // As in Claude Code, a stdio server starts in the project folder (the relative paths of .mcp.json
        // are relative to it).
        if (v?.type === "local") v.cwd = path.dirname(file);
        if (v) cfg.mcp[name] = v;
      }
    },
  };
};
