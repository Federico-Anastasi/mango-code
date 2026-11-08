// Prepares the staging folder from which Tauri builds the installer.
//
// The resources come from the repo's `launcher/`: it is the same tree the terminal uses, and the installed app
// finds it again under `resources/` with the same shape. The agent is `mango-code.exe`, built from the repo
// sources with `launcher/setup.ps1 -Only opencode` in `launcher/opencode/web/` (another location,
// if `launcher/mango-paths.json` names one).
//
// The installer is a base one: app, agent, resources. No engines and no NVIDIA libraries (they were more than
// three quarters of the weight): at first run the app looks at the hardware and downloads the matching engine, with the
// `mango-engines.json` and `profiles/` catalogs it carries.
//
// Why a staging folder and not `resources` pointing at `launcher/`: next to the real files
// there are generated configs, secrets, browser profiles, logs, the 9 GB model. Here every file that goes in is
// named: an explicit list for the top-level files and for the folders tracked by git, and for `node_modules`
// only the packages the scripts really use (dependency closure). At the end a check rejects
// any file that must never go in.
//
// Usage: node scripts/prepare-installer.mjs [--opencode <mango-code.exe>]
//   default: <opencode>/web/mango-code.exe, with <opencode> = launcher/opencode or what mango-paths.json says

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "..", "launcher");
const STAGING = path.join(HERE, "staging");
// Tauri copies the staging under <installation>/resources: Paths::discover() looks there.
const ROOT = path.join(STAGING, "resources");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));

const PATHS_FILE = path.join(DIST, "mango-paths.json");
const AGENT_DIR = (fs.existsSync(PATHS_FILE) && readJson(PATHS_FILE).opencode) || path.join(DIST, "opencode");

const opencodeFlag = process.argv.indexOf("--opencode");
const OPENCODE_EXE =
  opencodeFlag > 0 ? path.resolve(process.argv[opencodeFlag + 1]) : path.join(AGENT_DIR, "web", "mango-code.exe");

const MODELS = readJson(path.join(DIST, "mango-models.json"));

// Top-level files of the distribution (relative to DIST).
const FILES = [
  "mango-models.json",
  "mango-engines.json",
  "package.json",
  "mango-websearch-mcp.js",
  "mango-chrome-mcp.mjs",
  "mango-mcp-stdout.cjs",
  "mango-mcp-watchdog.cjs",
  "mango-documents/mcp.mjs",
  "mango-documents/common.mjs",
  "mango-documents/ooxml.mjs",
  "mango-documents/convert.mjs",
  "mango-documents/docx.mjs",
  "mango-documents/docx-edit.mjs",
  "mango-documents/pdf.mjs",
  "mango-documents/pdf-edit.mjs",
  "mango-documents/pptx.mjs",
  "mango-documents/pptx-edit.mjs",
  "mango-documents/xlsx.mjs",
  "mango-documents/xlsx-edit.mjs",
  "mango-documents/chart-xlsx.mjs",
  "mango-documents/profile.mjs",
  "opencode-home/MANGO.md",
  "opencode-home/MANGO-agent.md",
  "opencode-home/MANGO-dev.md",
  "opencode-home/MANGO-manager.md",
  "opencode-home/MANGO-web-images.md",
  "opencode-home/MANGO-web-text.md",
  "opencode-home/opencode.template.json",
  // Carried together with node_modules, so the first start does not go online to install the plugin.
  "opencode-home/package.json",
];

// Whole folders: allowed only if every file is tracked by git (nothing personal).
const TRACKED_DIRS = ["chat-templates", "mango-plugin", "opencode-home/plugin", "profiles"];

// Node packages: roots and node_modules folder from which the closure is computed.
const NODE = [
  { modules: "node_modules", roots: ["jsdom", "@mozilla/readability", "turndown", "chrome-devtools-mcp", "docx", "pdfmake", "pptxgenjs", "exceljs", "marked", "jszip", "@xmldom/xmldom", "pdf-lib", "unpdf", "fast-formula-parser"] },
  { modules: "opencode-home/node_modules", roots: ["@opencode-ai/plugin", "@opencode-ai/sdk"] },
];

// Never in the staging, anywhere in the tree.
const FORBIDDEN = [
  [/(^|\/)mango-paths\.json$/, "mango-paths.json"],
  [/(^|\/)mango-secrets\.json$/, "mango-secrets.json"],
  [/(^|\/)opencode-home\/opencode\.json$/, "opencode.json (generated)"],
  [/^runtime\//, "runtime/"],
  [/^engine\//, "engines: downloaded at first run"],
  [/(^|\/)(llama-server\.exe|(cudart|cublas|cublasLt)[^/]*\.dll)$/i, "engine or NVIDIA library: downloaded at first run"],
  [/\.log$/i, "log"],
  [/\.gguf$/i, "GGUF model"],
  [/(^|\/)ggml-[^/]*\.bin$/i, "whisper model"],
];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function copy(from, toRel) {
  const to = path.join(ROOT, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

function tracked(folder) {
  const out = execFileSync("git", ["ls-files", "-z", "--", folder], { cwd: DIST, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

// --- dependency closure of node_modules ---
function resolvePackage(name, fromDir, base) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const c = path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(c, "package.json"))) return c;
    if (d === base || d === path.dirname(d)) break;
  }
  const c = path.join(base, "node_modules", name);
  return fs.existsSync(path.join(c, "package.json")) ? c : null;
}

function closure(baseModules, roots) {
  const base = path.dirname(baseModules); // the folder that contains node_modules
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = readJson(path.join(dir, "package.json"));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const n of Object.keys(deps)) {
      const d = resolvePackage(n, dir, base);
      if (d) visit(d); // an optional dependency that is not installed simply is not there
    }
    // Nested packages travel with the parent: their dependencies must be there too.
    const nested = path.join(dir, "node_modules");
    if (fs.existsSync(nested)) {
      for (const e of fs.readdirSync(nested, { withFileTypes: true })) {
        if (e.name.startsWith(".") || !e.isDirectory()) continue;
        const below = e.name.startsWith("@") ? fs.readdirSync(path.join(nested, e.name)).map((x) => path.join(nested, e.name, x)) : [path.join(nested, e.name)];
        for (const s of below) if (fs.existsSync(path.join(s, "package.json"))) visit(s);
      }
    }
  };
  for (const r of roots) {
    const d = resolvePackage(r, base, base);
    if (!d) throw new Error(`package ${r} missing from ${baseModules}: run npm install`);
    visit(d);
  }
  // The top-level packages are copied (the nested ones travel inside them).
  const topLevel = (d) => {
    const parts = path.relative(baseModules, d).split(path.sep);
    return path.join(baseModules, ...parts.slice(0, parts[0].startsWith("@") ? 2 : 1));
  };
  return [...new Set([...seen].map(topLevel))];
}

// Only types and source maps are dropped. Documentation stays: chrome-devtools-mcp reads the .md files at runtime.
const DISCARDED = /(\.d\.(c|m)?ts|\.map)$/i;

function copyPackage(dir, dest) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".bin" || e.name === ".package-lock.json") continue;
    const from = path.join(dir, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyPackage(from, to);
    else if (!DISCARDED.test(e.name)) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

// --- run ---
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

for (const f of FILES) {
  const from = path.join(DIST, f);
  if (!fs.existsSync(from)) throw new Error(`${f} missing from ${DIST}`);
  copy(from, f);
}

for (const c of TRACKED_DIRS) {
  const list = tracked(c);
  if (!list.length) throw new Error(`${c}: no file tracked by git`);
  for (const f of list) copy(path.join(DIST, f), f);
  const present = [...walkFiles(path.join(DIST, c))].length;
  if (present !== list.length) {
    console.warn(`  ${c}: ${present - list.length} files not tracked by git left out`);
  }
}

// The skill that optimizes Mango Code on a PC, at the repo root: the models page points to it, to be given to a frontier
// AI, and in the installed app it lives in `resources/optimize`.
const skill = tracked(path.join("..", "optimize"));
if (!skill.length) throw new Error("optimize: no file tracked by git");
for (const f of skill) copy(path.join(DIST, f), path.relative("..", f));
// mango-tune, the skill's measuring tool, goes next to it: whoever installs the app uses the skill without building.
const TUNE = path.resolve(HERE, "..", "target", "release", "mango-tune.exe");
if (!fs.existsSync(TUNE)) throw new Error(`${TUNE} missing: cargo build --release -p engine --bin mango-tune in app/`);
copy(TUNE, "optimize/mango-tune.exe");

// The licenses travel with the program: whoever receives the installer also receives the texts and, in NOTICE.md,
// where the source code is.
const legal = [...tracked(path.join("..", "LICENSES")), "../LICENSE", "../NOTICE.md", "../TRADEMARKS.md"];
for (const f of legal) copy(path.join(DIST, f), path.join("licenses", path.basename(f)));

if (!fs.existsSync(OPENCODE_EXE)) throw new Error(`${OPENCODE_EXE} missing: build it with launcher\\setup.ps1 -Only opencode, or use --opencode <path>`);
copy(OPENCODE_EXE, "opencode/web/mango-code.exe");

for (const { modules, roots } of NODE) {
  const base = path.join(DIST, modules);
  const packages = closure(base, roots);
  for (const p of packages) copyPackage(p, path.join(ROOT, modules, path.relative(base, p)));
  console.log(`  ${modules}: ${packages.length} packages`);
}

// Every declared model must have its chat template in the installer.
for (const [key, m] of Object.entries(MODELS.models)) {
  if (m.chat_template && !fs.existsSync(path.join(ROOT, "chat-templates", m.chat_template))) {
    throw new Error(`model ${key} names the chat template ${m.chat_template}, which is not in the staging`);
  }
}

// --- final check ---
let count = 0, bytes = 0, longest = "";
for (const f of walkFiles(ROOT)) {
  const r = rel(f);
  for (const [re, why] of FORBIDDEN) if (re.test(r)) throw new Error(`forbidden file in the staging (${why}): ${r}`);
  count++;
  bytes += fs.statSync(f).size;
  if (r.length > longest.length) longest = r;
}
console.log(`staging: ${count} files, ${(bytes / 2 ** 20).toFixed(1)} MiB in ${STAGING}`);
console.log(`longest relative path: ${longest.length} characters (${longest})`);
