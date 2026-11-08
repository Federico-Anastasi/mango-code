// mango-documents.js - the `documents_*` tools run in a process outside the project and do not know where
// the session folder is: here a plain file name (report.docx, Attachments/accounts.xlsx) becomes
// a full path inside that folder, before the tool starts.
import path from "node:path";

const PATH_PARAMS = ["file", "save_as"];

export const MangoDocuments = async ({ directory }) => {
  const full = (p) => (typeof p === "string" && p.trim() && !path.isAbsolute(p) ? path.resolve(directory, p) : p);
  return {
    "tool.execute.before": async (input, output) => {
      if (!input.tool?.startsWith("documents_")) return;
      const a = output.args;
      if (!a || typeof a !== "object") return;
      for (const k of PATH_PARAMS) if (k in a) a[k] = full(a[k]);
      // «operations» can arrive as a list or as JSON text; the other PDFs to merge are paths too
      let ops = a.operations;
      if (typeof ops === "string") { try { ops = JSON.parse(ops); } catch { return; } }
      if (ops && !Array.isArray(ops) && typeof ops === "object") ops = [ops];
      if (Array.isArray(ops)) {
        for (const op of ops) {
          if (op && Array.isArray(op.other_files)) op.other_files = op.other_files.map(full);
          else if (op && typeof op.other_files === "string") op.other_files = full(op.other_files);
        }
        a.operations = ops;
      }
    },
  };
};
