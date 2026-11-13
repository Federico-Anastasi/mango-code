// mango-web-diet.js - keeps repeated page trees out of the context.
//
// THE PROBLEM, MEASURED on the database of the browsing sessions:
//
//   tool           calls     chars     of which tree
//   take_snapshot     31   1,064,375     1,064,375   <- requested, it is its job
//   wait_for          17     551,995       550,925   <- NEVER requested
//   click             28     272,275       267,509   <- requested with includeSnapshot
//   press_key          7      34,332        33,761   <- same
//
// A LinkedIn accessibility tree is ~33,000 characters, i.e. ~8k tokens. Repeated at every move,
// it is what burned the context in five or six navigations.
//
// BUT THE TWO CASES ARE NOT THE SAME CASE, and treating them alike was a mistake:
//
//   wait_for does NOT have the includeSnapshot parameter: it always appends the tree, needed or
//   not. Here the model asked for nothing, so taking that stuff away removes nothing it knows
//   it has. It is simply cut.
//
//   click, fill, fill_form, press_key, drag, hover, upload_file have includeSnapshot, which
//   defaults to FALSE: if the tree is there, it is because the model asked for it. Cutting it
//   behind its back - as the first version of this file did - made it blind right after a
//   click: it asked for the page, got a note instead, concluded the panel was stuck and started
//   pressing Escape at random. The context was saved and the navigation broke.
//
// WHAT IT DOES NOW. For the second group it does NOT touch the output: it acts BEFORE, turns
// includeSnapshot off in the request, and then says so plainly in the reply. The model receives
// exactly what the message describes - no surprises - and knows how to get the tree back if it
// really needs it. This is the difference between optimizing and lying.

const MARK = "## Latest page snapshot";

// They append the tree without anyone asking: it is cut on the way out.
const ALWAYS_APPENDS = new Set(["chrome-devtools_wait_for"]);

// They have includeSnapshot (default false): it is turned off on the way in, and declared.
const HAS_FLAG = new Set([
  "chrome-devtools_click",
  "chrome-devtools_fill",
  "chrome-devtools_fill_form",
  "chrome-devtools_press_key",
  "chrome-devtools_drag",
  "chrome-devtools_hover",
  "chrome-devtools_upload_file",
]);

// A model that cannot see images is not advised to take screenshots. Whether it can is in the request's model, as the
// configuration says it (see mango-discipline.js): a model added without restarting the agent counts too.
const noteOff = (images) =>
  "[mango-code: includeSnapshot turned off. The page tree costs ~8k tokens and repeating it at every " +
  "move exhausts the context. " +
  (images
    ? "If you need the updated uids call chrome-devtools_take_snapshot; " +
      "if you only need to see how it went, chrome-devtools_take_screenshot costs a fifth.]"
    : "To see how it went call chrome-devtools_take_snapshot.]");

const NOTE_CUT =
  "[mango-code: page tree omitted - wait_for always appends it, even when it is not needed. " +
  "For the updated uids: chrome-devtools_take_snapshot.]";

export const MangoWebDiet = async () => {
  const downgraded = new Set(); // callIDs on which we turned the flag off
  const sees = new Map(); // sessionID -> whether the model of its latest request sees images

  return {
    "experimental.chat.system.transform": async (input) => {
      if (input.sessionID) sees.set(input.sessionID, Boolean(input.model?.capabilities?.input?.image));
    },

    "tool.execute.before": async (input, output) => {
      if (!HAS_FLAG.has(input.tool)) return;
      const args = output.args;
      if (!args || args.includeSnapshot !== true) return;
      args.includeSnapshot = false;
      if (input.callID) downgraded.add(input.callID);
    },

    "tool.execute.after": async (input, output) => {
      if (!input.tool || !input.tool.startsWith("chrome-devtools_")) return;
      const text = String(output.output || "");

      if (input.callID && downgraded.has(input.callID)) {
        downgraded.delete(input.callID);
        const note = noteOff(sees.get(input.sessionID));
        output.output = text ? text + "\n\n" + note : note;
        return;
      }

      if (!ALWAYS_APPENDS.has(input.tool)) return;
      const i = text.indexOf(MARK);
      if (i < 0) return;
      // Everything BEFORE the marker is kept: it is the outcome of the wait
      // ("Element matching [...] found."), the only thing the model had asked for.
      const head = text.slice(0, i).trim();
      output.output = head ? head + "\n\n" + NOTE_CUT : NOTE_CUT;
    },
  };
};
