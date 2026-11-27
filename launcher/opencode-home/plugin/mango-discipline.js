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

// The instructions on how to look at a web page depend on the request's model (one process serves
// models that see images and text-only ones). They go into the system prompt: fixed per model, so the
// cached prefix does not change between turns.
const WEB_DIR = process.env.MANGO_HOME ? `${process.env.MANGO_HOME}\\harness\\shared` : null;
const webInstructions = {};
const readWeb = async (images) => {
  const name = images ? "web-images.md" : "web-text.md";
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

  // The harness of the conversation (input.harness) says whether each reminder is on, how often it comes (every N user
  // turns: 1, 1+N, 1+2N, ...; every N tool executions within the same run) and its text (hooks.md). The reminder at the
  // tail of the user's message says that it is not the request, which it could otherwise be taken for.
  return {
    // Every N user turns: a synthetic part at the tail of the user's message.
    "chat.message": async (input, output) => {
      const s = get(input.sessionID);
      s.turns += 1;
      s.actions = 0; // new turn: the action counter restarts
      const hook = input.harness.hooks["discipline-messages"];
      if (!hook?.on || (s.turns - 1) % hook.every !== 0) return;
      output.parts.push({
        id: tailID(output.parts),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: input.harness.texts["discipline-messages"],
        synthetic: true, // it is not something the user wrote
      });
    },

    // Every N tool executions within a long run: at the end of the tool's output, which the model reads right
    // after the result.
    "tool.execute.after": async (input, output) => {
      const s = get(input.sessionID);
      s.actions += 1;
      const hook = input.harness.hooks["discipline-calls"];
      if (!hook?.on || s.actions % hook.every !== 0) return;
      output.output = String(output.output || "") + "\n\n" + input.harness.texts["discipline-calls"];
    },

    "experimental.chat.system.transform": async (input, output) => {
      const text = await readWeb(Boolean(input.model?.capabilities?.input?.image));
      if (text) output.system.push(text);
    },
  };
};
