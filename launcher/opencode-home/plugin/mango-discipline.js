// mango-discipline.js - re-injects a short discipline reminder into the context, and adds the web
// instructions of the model to the system prompt.
//
// WHY: on a weak local model (27-35B at 4 bit) the system prompt rules "dilute" as the context grows:
// it stops verifying, closes with promises, guesses. A plugin always fires; a skill is opt-in.
//
// The reminder goes at the TAIL (last part of the user message, or end of a tool's output), never in
// the system prompt: that is the prefix llama.cpp keeps in cache, touching it would re-prefill the
// whole context at every injection. At the tail nothing is recomputed.
//
// Loaded automatically: it lives in <OPENCODE_CONFIG_DIR>/plugin/ (opencode-home\plugin\).

const TURNS = 3;    // re-inject every TURNS user turns (1, 4, 7, ...)
const ACTIONS = 12; // re-inject every ACTIONS tool executions within the same run

// The header is what the integration tests look for.
const REMINDER = [
  "DISCIPLINE (local model) - keep these rules active:",
  "1. Verify: run it and show the output before saying done, fixed or working.",
  "2. Bug or failing test: find the cause before fixing it (skill `debugging`).",
  "3. Code: write the failing test first (skill `test-first`). Documents and pages don't need it.",
  "4. No TODO, FIXME or placeholders: do it now, or ask before leaving it out.",
  "5. After 2 failed attempts: stop guessing, search the docs, the code and the web (skill `debugging`).",
  "6. Recent or current facts: search the web first (`web-search` tools) and trust the system date.",
].join("\n");

// At the tail of the user's message the reminder must not read as the request: a small model took it
// for the task ("the user wants me to read the mango-discipline document") and never did what was asked.
const USER_REMINDER =
  "<mango-discipline>\nStanding rules that Mango Code adds every few messages. They are NOT the user's request: do not act on them, keep following them while you do what the user asked.\n" +
  REMINDER +
  "\n</mango-discipline>\nNow do what the user asked in the message above.";

// The instructions on how to look at a web page depend on the request's model (one process serves
// models that see images and text-only ones). They go into the system prompt: fixed per model, so the
// cached prefix does not change between turns.
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
// opencode VALIDATES the id of every part: "prt" plus 26 characters. A meaningful id is REJECTED and
// the message POST dies before reaching the model ("unexpected server error" on the first message of
// every session). The id must also be the HIGHEST in the message: parts are sorted by id, and a lower
// one moves the reminder BEFORE the question, losing the recency that is the reason for the tail.
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function partID() {
  let out = Date.now().toString(16).padStart(12, "0").slice(-12);
  for (let i = 0; i < 14; i++) out += B62[Math.floor(Math.random() * B62.length)];
  return "prt_" + out;
}

// Highest id present, same prefix (time + counter), random tail replaced by the highest possible
// ("z" is the maximum character of the alphabet): the part comes out last by construction.
function tailID(parts) {
  let max = "";
  for (const p of parts) if (typeof p.id === "string" && p.id > max) max = p.id;
  if (max.startsWith("prt_") && max.length === 30) {
    const id = max.slice(0, 16) + "zzzzzzzzzzzzzz";
    if (id !== max) return id;
  }
  return partID(); // unexpected format: better a valid id in any position than none
}

export const MangoDiscipline = async () => {
  // Per-session counters, in memory: the plugin lives as long as the opencode process.
  const state = new Map(); // sessionID -> { turns, actions }
  const get = (id) => {
    let s = state.get(id);
    if (!s) { s = { turns: 0, actions: 0 }; state.set(id, s); }
    return s;
  };

  return {
    // Every TURNS user turns: a synthetic part at the tail of the user's message.
    "chat.message": async (input, output) => {
      const s = get(input.sessionID);
      s.turns += 1;
      s.actions = 0; // new turn: the action counter restarts
      if (s.turns % TURNS !== 1) return;
      output.parts.push({
        id: tailID(output.parts),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: USER_REMINDER,
        synthetic: true, // it is not something the user wrote
      });
    },

    // Every ACTIONS tool executions within a long run: at the end of the tool's output, which the
    // model reads right after the result.
    "tool.execute.after": async (input, output) => {
      const s = get(input.sessionID);
      s.actions += 1;
      if (s.actions % ACTIONS !== 0) return;
      output.output = String(output.output || "") + "\n\n<mango-discipline>\n" + REMINDER + "\n</mango-discipline>";
    },

    "experimental.chat.system.transform": async (input, output) => {
      const text = await readWeb(Boolean(input.model?.capabilities?.input?.image));
      if (text) output.system.push(text);
    },
  };
};
