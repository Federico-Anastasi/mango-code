// mango-discipline.js - re-injects a discipline reminder into the context and blocks the hunt for
// skills on disk.
//
// WHY IT EXISTS: on a weak local model (27-35B at 4 bit) the system prompt rules "dilute" as the
// context grows -> the model stops verifying, closes with promises, guesses. A plugin is
// DETERMINISTIC (it always fires, it is not opt-in like a skill) and fights this drift.
//
// HOW IT WORKS
//   1. A single process: the plugin is loaded ONCE inside opencode and the state lives in
//      memory.
//   2. The reminder is appended at the TAIL (last part of the user message, or tail of a tool's
//      output). NEVER in the system prompt: the system prompt is the prefix llama.cpp keeps in
//      cache, touching it would mean re-prefilling the whole context at every injection. At the
//      tail it costs zero recomputed tokens. Where prefill is the bottleneck, this is
//      not a detail.
//   3. The hunt for skills is blocked with a throw: in opencode skills are a NATIVE tool
//      (`skill`), so the model rarely gets it wrong, but the remedy costs two lines and stays.
//
// Loaded automatically because it lives in <OPENCODE_CONFIG_DIR>/plugin/ (opencode-home\plugin\).

const TURNS = 3;    // re-inject every TURNS user turns (1, 4, 7, ...)
const ACTIONS = 12; // re-inject every ACTIONS tool executions within the same run

// Web search is our MCP (the built-in websearch is off in opencode.json because it would go
// through an external provider).
const LINES = [
  "DISCIPLINE (local model) - keep these ACTIVE right now:",
  "0. WEB / CURRENT FACTS: for recent or current events, or facts that may be newer than your training, do NOT answer from memory - search the web FIRST and TRUST the system date. `web-search` MCP tools: `research` (best: search plus the top pages extracted, one call), `search` (links only), `read_url` (one page as markdown), `search_images` (image URLs -> download with curl, then read to verify).",
  "1. VERIFY before you claim: run the command and SHOW its output before saying done/works/fixed. No claim without fresh evidence.",
  "2. ROOT CAUSE before fixing: no blind patches. On any bug or failing test, open the `systematic-debugging` skill.",
  "3. TEST before new code: open the `test-driven-development` skill; write the failing test first.",
  "4. NO deferred work: no TODO/FIXME/placeholder - do it now or ask for permission to defer.",
  "5. After 2 failed attempts: STOP guessing - open the `research-after-failure` skill and search (docs/codebase/web) before retrying.",
  "6. ANSWERS: concise and dense, no filler. Aim for 3-10 lines; go past 20 lines only if the user asks.",
  "7. READING FILES: `grep` first to find the line, then `read` with `offset`/`limit` around it - a window of 100-200 lines, not 30-line slices. Read a whole file only if it is short or you must change several distant places (without `limit` it returns up to 2000 lines / 50 KB). After an `edit` do NOT re-read the file: `edit` re-reads it itself.",
];
const LINE_TEXT =
  "8. PAGES AS TEXT: you do not see images, and you do have a browser. To look at a web page (also one you wrote: chrome-devtools_new_page on file:///<full path>), use chrome-devtools_take_snapshot and check chrome-devtools_list_console_messages for errors.";
const LINE_IMAGES =
  "8. IMAGES: you ARE a vision model. If the user attaches a screenshot, LOOK AT IT. Never claim you cannot see images - that is false. If an image is genuinely missing from the context, say so and ask them to paste it again.";
// Line 8 depends on the conversation's model: one process can host models that see images and
// text-only models (the app offers them all). MANGO_IMAGE_MODELS is the list of ids that see
// them, written by whoever generates the config (mango-code.ps1, the app's agent-cfg).
const IMAGE_MODELS = new Set((process.env.MANGO_IMAGE_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean));
const reminder = (modelID) => [...LINES, IMAGE_MODELS.has(modelID) ? LINE_IMAGES : LINE_TEXT].join("\n");
// At the tail of the user's message the reminder must not read as the request: a small model took it for the task
// ("the user wants me to read the mango-discipline document") and never did what the user asked.
const userReminder = (modelID) =>
  "<mango-discipline>\nStanding rules that Mango Code adds every few messages. They are NOT the user's request: do not act on them, keep them while you do what the user asked.\n" +
  reminder(modelID) +
  "\n</mango-discipline>\nNow do what the user asked in the message above.";

// The instructions on how to look at a web page, also per model: they go into the system prompt
// (they are fixed per model, so the cached prefix does not change between turns).
const WEB_DIR = process.env.MANGO_HOME ? `${process.env.MANGO_HOME}\\opencode-home` : null;
const webInstructions = {};
const readWeb = async (images) => {
  const name = images ? "MANGO-web-images.md" : "MANGO-web-text.md";
  if (!(name in webInstructions)) {
    const { readFile } = await import("node:fs/promises");
    webInstructions[name] = WEB_DIR ? await readFile(`${WEB_DIR}\\${name}`, "utf8") : "";
  }
  return webInstructions[name];
};

// --- part ids ------------------------------------------------------------------------------
// opencode VALIDATES the id of every part: prefix "prt" plus 26 characters, like the ones it
// generates itself (prt_03d14d124001y8ULbdFV6qoyq9). A meaningful id like "mango-discipline-1"
// is REJECTED by the schema and the message POST dies BEFORE reaching the model: in the TUI you
// see "unexpected server error" on the injection turn - that is, the very first message of every
// session. And omitting the id is not an option: we build the part, so we must give the id.
// Format: 12 characters of hexadecimal time (so it sorts) + 14 random ones = 26.
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function partID() {
  let out = Date.now().toString(16).padStart(12, "0").slice(-12);
  for (let i = 0; i < 14; i++) out += B62[Math.floor(Math.random() * B62.length)];
  return "prt_" + out;
}

// ...and it is not enough for the id to be VALID: it must also be the HIGHEST in the message.
// opencode sorts parts by id, so an id lower than the user text's moves the reminder BEFORE the
// question - and there the recency, which is the whole reason it goes at the tail instead of in
// the system prompt, is lost. How time is encoded inside the id is opencode's business and
// cannot be guessed: take the highest id already present and keep its prefix (time + counter),
// replacing the random tail with the highest possible one. "z" is the maximum character of the
// alphabet used, so the part comes out last by construction.
function tailID(parts) {
  let max = "";
  for (const p of parts) if (typeof p.id === "string" && p.id > max) max = p.id;
  if (max.startsWith("prt_") && max.length === 30) {
    const id = max.slice(0, 16) + "zzzzzzzzzzzzzz";
    if (id !== max) return id;
  }
  return partID(); // unexpected format: better a valid id in any position than none
}

// --- recognizing the "skill hunt" ------------------------------------------------------------
// Instead of using the `skill` tool, the model tends to look for them ON DISK and find none.
// The INTENT is intercepted and the model is instructed: rewriting the path would plug only one hole.
const norm = (s) => (typeof s === "string" ? s.replace(/\//g, "\\").toLowerCase() : "");
const pointsAtSkillsDir = (p) => {
  const n = norm(p);
  return n.includes("\\.claude\\skills") || n.includes("\\skills\\") || n.endsWith("\\skills");
};
// anchored on purpose so it does NOT catch project names like SkillBar.tsx
const looksLikeSkillHunt = (pat) => /(?:^|[\\/*.])skills?(?:$|[\\/*.])|skill\.md/i.test(pat || "");

export const MangoDiscipline = async ({ directory }) => {
  // Per-session state, in memory: the plugin lives as long as the opencode process.
  const state = new Map(); // sessionID -> { turns, actions, modelID }
  const get = (id) => {
    let s = state.get(id);
    if (!s) { s = { turns: 0, actions: 0, modelID: undefined }; state.set(id, s); }
    return s;
  };

  return {
    // --- reminder every TURNS user turns -----------------------------------------------------
    // A synthetic part is appended to the user's message: it is the last thing the model reads
    // before answering (recency) and it does not touch the cached prefix.
    "chat.message": async (input, output) => {
      const s = get(input.sessionID);
      s.turns += 1;
      s.actions = 0; // new turn: the action counter restarts
      s.modelID = input.model?.modelID ?? s.modelID;
      if (s.turns % TURNS !== 1) return;
      output.parts.push({
        id: tailID(output.parts),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: userReminder(s.modelID),
        synthetic: true, // marked synthetic: it is not something the user wrote
      });
    },

    // --- skill hunt block --------------------------------------------------------------------
    // A throw here cancels the tool execution and the message goes back to the model.
    "tool.execute.before": async (input, output) => {
      const a = output.args || {};
      let hunting = false;
      if (input.tool === "glob") hunting = pointsAtSkillsDir(a.path) || looksLikeSkillHunt(a.pattern);
      else if (input.tool === "read") hunting = pointsAtSkillsDir(a.filePath || a.path);
      else if (input.tool === "grep" || input.tool === "list") hunting = pointsAtSkillsDir(a.path);
      if (!hunting) return;
      throw new Error(
        "Skills are NOT files to look for on disk. To USE one, invoke it by NAME with the " +
        "`skill` tool (skill({ name: \"<name>\" })): its description lists the available ones. " +
        "Reading their files by hand does not activate them.",
      );
    },

    // --- reminder every ACTIONS tools, within a long run --------------------------------------
    // At the tail of the tool's output: the model reads it right after the result, and it is the
    // only point of the context that can be touched without invalidating the KV cache.
    "tool.execute.after": async (input, output) => {
      const s = get(input.sessionID);
      s.actions += 1;
      if (s.actions % ACTIONS !== 0) return;
      output.output = String(output.output || "") + "\n\n<mango-discipline>\n" + reminder(s.modelID) + "\n</mango-discipline>";
    },

    // --- the model's web instructions ----------------------------------------------------------
    "experimental.chat.system.transform": async (input, output) => {
      const text = await readWeb(Boolean(input.model?.capabilities?.input?.image));
      if (text) output.system.push(text);
    },
  };
};
