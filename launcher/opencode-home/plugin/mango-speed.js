// mango-speed.js - prefill and decode t/s of the turn that just ended, ALWAYS on screen.
//
// WHY. The two numbers that matter are not the same number: on a GTX 1660 SUPER, which has no
// tensor cores, prefill is the bottleneck, while decode runs on VRAM bandwidth.
// Looking at them separately is the only way to tell whether a slow turn was "long context to
// digest" or "slow generation" - and they are two different knobs.
//
// WHY THE TERMINAL TITLE AND NOT THE STATUS BAR. Verified inside the real TUI (pty): opencode
// 1.18.23 loads the files in plugin/ ONLY as server plugins - the api they get is
// { client, project, worktree, directory, serverUrl, $ }, with no `slots` and no `ui`. The
// official way to add bar widgets (api.slots.register) exists in the types but cannot be
// reached from here: tui.json does not load the file, and @opentui/solid does not resolve from
// plugins. These are the same issues open upstream (opencode #23539 and #28902).
// The terminal title, instead, is ALWAYS visible - it is the Windows Terminal tab - it updates
// at every turn and costs no screen space. The OSC 0 sequence does not move the cursor and does
// not touch the framebuffer: verified that the TUI keeps drawing exactly the same.
//
// WHERE THE NUMBERS COME FROM. llama-server exposes /metrics (the engine starts with --metrics).
// The cumulative COUNTERS are used, not the gauges: llama.cpp RESETS the bucket at every scrape
// of /metrics, so another reader polling the engine at the same time takes the window away.
// The counters are monotonic: whoever else reads them, our delta stays right.
//
// WHEN. Baseline at the user's message (`chat.message`), reading at the end of the turn
// (`session.idle`) -> the delta is exactly that turn, prefill included.

import fs from "node:fs";
import path from "node:path";

// The title is text the user reads: Italian or English, as chosen in <data>\settings.json; without a
// choice, the system language.
function lang() {
  const data = process.env.MANGO_DATA || path.join(process.env.LOCALAPPDATA || "", "MangoCode");
  try {
    const chosen = JSON.parse(fs.readFileSync(process.env.MANGO_SETTINGS || path.join(data, "settings.json"), "utf8")).language;
    if (chosen === "it" || chosen === "en") return chosen;
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("it") ? "it" : "en";
}
const tr = (it, en) => (lang() === "it" ? it : en);

// The engine may be on another PC (mango-code -Remote): t/s are asked to WHOEVER computes,
// not to localhost. The launcher exports MANGO_ENGINE_URL; without it, localhost.
const METRICS = (process.env.MANGO_ENGINE_URL || "http://127.0.0.1:8080") + "/metrics";
const KEYS = [
  "llamacpp:prompt_tokens_total",
  "llamacpp:prompt_seconds_total",
  "llamacpp:tokens_predicted_total",
  "llamacpp:tokens_predicted_seconds_total",
];

async function read() {
  try {
    const res = await fetch(METRICS, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const out = {};
    for (const line of (await res.text()).split("\n")) {
      if (line.startsWith("#")) continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const name = line.slice(0, sp);
      if (!KEYS.includes(name)) continue;
      const v = Number(line.slice(sp + 1).trim());
      if (Number.isFinite(v)) out[name] = v;
    }
    return KEYS.every((k) => k in out) ? out : null;
  } catch {
    return null; // engine off or not ours: the feature disappears, it does not break the session
  }
}

// OSC 0 = "set icon and window title". Closed by BEL, the form Windows Terminal accepts without
// complaint.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const setTitle = (s) => {
  try { process.stdout.write(ESC + "]0;" + s + BEL); } catch {}
};

// 793.654 -> "794", 33.8176 -> "33.8": below 100 t/s one decimal is useful, above it is noise.
const fmt = (n) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));
const tok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

export const MangoSpeed = async () => {
  const base = new Map(); // sessionID -> counters at the start of the turn
  let last = "";          // last value shown: survives turns with no work

  setTitle("mango-code");

  return {
    "chat.message": async (input) => {
      const snap = await read();
      if (snap) base.set(input.sessionID, snap);
      setTitle(last ? "... | " + last : "mango-code | " + tr("in corso", "in progress"));
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const id = event.properties && event.properties.sessionID;
      const b = base.get(id);
      if (!b) return;
      base.delete(id);

      const now = await read();
      if (!now) return;

      const dPromptTok = now["llamacpp:prompt_tokens_total"] - b["llamacpp:prompt_tokens_total"];
      const dPromptSec = now["llamacpp:prompt_seconds_total"] - b["llamacpp:prompt_seconds_total"];
      const dPredTok = now["llamacpp:tokens_predicted_total"] - b["llamacpp:tokens_predicted_total"];
      const dPredSec = now["llamacpp:tokens_predicted_seconds_total"] - b["llamacpp:tokens_predicted_seconds_total"];

      const parts = [];
      // A turn fully in cache has no prefill: dPromptSec ~ 0. Better to print nothing than a
      // division by zero disguised as a speed record.
      if (dPromptTok > 0 && dPromptSec > 0.01) {
        parts.push("pp " + fmt(dPromptTok / dPromptSec) + " t/s (" + tok(dPromptTok) + ")");
      }
      if (dPredTok > 0 && dPredSec > 0.01) {
        parts.push("tg " + fmt(dPredTok / dPredSec) + " t/s (" + tok(dPredTok) + ")");
      }
      if (!parts.length) return;

      last = parts.join("  ");
      setTitle("mango-code | " + last);
    },
  };
};
