// MCP server `documents`: creates, reads, edits and converts Word, Excel, PowerPoint and PDF.
// Four tools for all the formats: the model chooses the action, not the library. The protocol is spoken
// by hand (JSON-RPC over stdio, one line per message), like the other Mango Code MCPs. It runs with the
// bundled Bun runtime: the user's PC has neither Python nor Node.
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { STYLES, operationList, existingFile, writeAtomic } from "./common.mjs";

// stdout is the protocol channel: any message from the libraries goes to stderr.
console.log = console.warn = console.error;

const FORMATS = ["docx", "xlsx", "pptx", "pdf"];

const MODULES = {
  docx: { create: () => import("./docx.mjs").then((m) => m.createDocx), edit: () => import("./docx-edit.mjs") },
  xlsx: { create: () => import("./xlsx.mjs").then((m) => m.createXlsx), edit: () => import("./xlsx-edit.mjs") },
  pptx: { create: () => import("./pptx.mjs").then((m) => m.createPptx), edit: () => import("./pptx-edit.mjs") },
  pdf: { create: () => import("./pdf.mjs").then((m) => m.createPdf), edit: () => import("./pdf-edit.mjs") },
};

const DESC_CREATE = `Creates a Word (docx), Excel (xlsx), PowerPoint (pptx) or PDF file from Markdown text. After the call the file appears in the chat with the Open and Show in folder buttons: nothing else is needed.
Markdown format and examples: skills "word", "excel", "powerpoint", "pdf".
- docx and pdf: headings (#), paragraphs, **bold**, *italic*, lists, tables, images ![](path.png), [[page]] to start a new page.
- pptx: each "# Title" is a slide; below it, lists with "-" or text; "> " is the speaker note.
- xlsx: each "## Name" is a sheet, followed by a Markdown table; numbers with the decimal point (1250.5), formulas "=SUM(B2:B9)" with English names.
- xlsx and pptx: after a table, [[chart: bar | Title]] makes a chart of it (bar, line, pie, horizontal).`;

const DESC_EDIT = `Edits an existing file (docx, xlsx, pptx, pdf) without redoing it from scratch: the rest of the file (formulas, formats, slides, images) stays as it is. First look at the content with documents_read.
"operations" is a list, executed in order; if one fails nothing is saved. Each operation has "action" and its parameters:
- docx: replace(find, with) · add(markdown; where: end|start, or after/before="text of a paragraph", or end_of_section="heading") · delete(text) · delete_section(title) · add_table_row(table, cells)
- xlsx: set(sheet, cell, values) · add_rows(sheet, rows) · add_column(sheet, header, values) · add_sheet(name, markdown) · format(sheet, range, format, bold, fill, color) · clear(sheet, range) · replace(find, with) · chart(sheet, range, type, title, position)
- pptx: replace(find, with) · add_slide(markdown, after) · delete_slide(slide) · move_slide(slide, to)
- pdf: merge(other_files) · extract_pages(pages) · delete_pages(pages) · reorder(order) · rotate(degrees, pages) · watermark(text, pages) · number_pages() · fill_form(fields) · split(every)
Examples in the skill of the format. "save_as" saves a copy and leaves the original untouched.`;

const OPERATION = {
  type: "object",
  description: "One operation: 'action' plus the parameters of that action (see the list above)",
  properties: {
    action: { type: "string" },
    find: { type: "string" },
    with: { type: "string", description: "new text (can be empty, to delete)" },
    text: { type: "string", description: "docx: paragraph to delete; pdf: watermark text" },
    title: { type: "string" },
    markdown: { type: "string", description: "new content, as for documents_create" },
    where: { type: "string", description: "docx: end (default) or start" },
    after: { type: ["string", "integer"], description: "docx: text of the paragraph; pptx: slide number" },
    before: { type: "string" },
    end_of_section: { type: "string", description: "docx: heading of the section" },
    table: { type: "integer", description: "docx: number of the table, from 1" },
    cells: { type: "array", items: { type: "string" } },
    sheet: { type: "string", description: "xlsx: can be omitted if the file has only one sheet" },
    name: { type: "string" },
    cell: { type: "string", description: "e.g. B2" },
    range: { type: "string", description: "e.g. A1:D9" },
    values: { description: "a value, a list (one row) or a list of rows; formulas with =, {r} = row number" },
    rows: { description: "xlsx: list of rows (add_rows) or «2-9» (add_column)" },
    header: { type: "string" },
    format: { type: "string", description: "euro, percent, number, integer, date, text" },
    bold: { type: "boolean" },
    fill: { type: "string", description: "e.g. yellow or FFFF00" },
    color: { type: "string" },
    type: { type: "string", description: "bar, line, pie, horizontal" },
    position: { type: "string", description: "cell of the chart, e.g. G2" },
    slide: { type: "integer", description: "number, from 1" },
    to: { type: "integer" },
    other_files: { type: "array", items: { type: "string" } },
    pages: { type: "string", description: "e.g. 1-3,5; if missing: all" },
    order: { type: "string", description: "e.g. 3,1,2" },
    degrees: { type: "integer", description: "90, 180 or 270" },
    fields: { type: "object", description: "{\"field\": \"value\"}" },
    every: { type: "integer", description: "pages per file" },
  },
  required: ["action"],
};

const TOOLS = [
  {
    name: "create",
    description: DESC_CREATE,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: FORMATS, description: "File format" },
        file: { type: "string", description: "File name (e.g. report.docx) or full path; a plain name ends up in the project folder" },
        content: { type: "string", description: "The content in Markdown" },
        style: { type: "string", enum: Object.keys(STYLES), description: "Colors of the document (default blue)" },
        header: { type: "string", description: "docx and pdf only: text at the top of every page" },
      },
      required: ["type", "file", "content"],
    },
  },
  {
    name: "read",
    description: "Reads a Word, Excel, PowerPoint or PDF file and returns its content with the structure: headings, tables, FORMULAS and values of the sheets, slides with notes, PDF form fields. Use it before editing a file and instead of read for these formats. If the text is long it is truncated and says how to continue with 'part'.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path of the file (or name in the project folder)" },
        part: { type: "string", description: "Which part: xlsx = name of the sheet, also with a range (Expenses!A1:F80); pptx and pdf = slides or pages (2-4); docx = number of the block (2)" },
      },
      required: ["file"],
    },
  },
  {
    name: "edit",
    description: DESC_EDIT,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File to edit (docx, xlsx, pptx, pdf)" },
        operations: { type: "array", items: OPERATION, description: "The operations, in order" },
        save_as: { type: "string", description: "Optional: save the result under this name and leave the original untouched" },
        style: { type: "string", enum: Object.keys(STYLES), description: "Colors of the new content (tables, headings); default blue" },
      },
      required: ["file", "operations"],
    },
  },
  {
    name: "convert",
    description: "Converts a file to another format WITHOUT external programs: docx->pdf and xlsx->pdf (simplified version: headings, lists, tables and images, but not the original fonts, colors and layout), xlsx->csv, csv->xlsx. Not possible: pptx->pdf, pdf->docx, docx->xlsx and the like.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Source file" },
        format: { type: "string", enum: ["pdf", "csv", "xlsx"], description: "Target format" },
        save_as: { type: "string", description: "Optional: name of the target file" },
        sheet: { type: "string", description: "xlsx->csv: which sheet (if missing, one per sheet)" },
        separator: { type: "string", enum: [";", ","], description: "csv: ';' (default: Italian Excel, decimals with the comma) or ','" },
      },
      required: ["file", "format"],
    },
  },
];

const formatOf = (file) => {
  const ext = path.extname(file).toLowerCase().slice(1);
  if (!FORMATS.includes(ext)) throw new Error(`«${path.basename(file)}»: unsupported format. This works with ${FORMATS.map((f) => `.${f}`).join(", ")} (old .doc, .xls, .ppt files must first be saved in the new format from Word, Excel or PowerPoint)`);
  return ext;
};

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
const warningList = (warnings) => (warnings?.length ? `\nWARNING:\n${warnings.slice(0, 12).map((a) => `- ${a}`).join("\n")}${warnings.length > 12 ? `\n- … and ${warnings.length - 12} more` : ""}` : "");

/** Creates the file and returns the confirmation text. The errors are for the model: clear and actionable. */
export async function create({ type, file, content, style, header }) {
  if (!MODULES[type]) throw new Error(`unknown type «${type}»: use ${FORMATS.join(", ")}`);
  if (typeof file !== "string" || !file.trim()) throw new Error("missing file name");
  if (typeof content !== "string" || !content.trim()) throw new Error("the content is empty");
  if (!path.isAbsolute(file)) {
    throw new Error(`«${file}» is not a full path: write it with the project folder, e.g. C:\\Users\\...\\${path.basename(file)}`);
  }
  if (header && !["docx", "pdf"].includes(type)) throw new Error("«header» is only used for docx and pdf");
  const destination = path.extname(file).toLowerCase() === `.${type}` ? file : `${file}.${type}`;
  const dir = path.dirname(destination);

  const generate = await MODULES[type].create();
  const outcome = await generate(content, { dir, styleName: style, header });
  const { data, warnings } = Buffer.isBuffer(outcome) ? { data: outcome, warnings: [] } : outcome;
  writeAtomic(destination, data);
  return `File created: ${destination} (${kb(data.length)})${warningList(warnings)}`;
}

export async function read({ file, part }) {
  existingFile(file);
  const format = formatOf(file);
  const { read: readFile } = await MODULES[format].edit();
  return readFile(file, { part: part === undefined || part === null ? undefined : String(part) });
}

export async function edit({ file, operations, save_as: saveAs, style }) {
  existingFile(file);
  const format = formatOf(file);
  const ops = operationList(operations);
  let destination = file;
  if (saveAs) {
    if (!path.isAbsolute(saveAs)) throw new Error(`«${saveAs}» is not a full path`);
    destination = path.extname(saveAs).toLowerCase() === `.${format}` ? saveAs : `${saveAs}.${format}`;
  }
  const { edit: editFile } = await MODULES[format].edit();
  const outcome = await editFile(file, ops, { destination, styleName: style });
  const written = [];
  if (outcome.data) { writeAtomic(destination, outcome.data); written.push(`${destination} (${kb(outcome.data.length)})`); }
  for (const extra of outcome.extraFiles ?? []) { writeAtomic(extra.path, extra.data); written.push(`${extra.path} (${kb(extra.data.length)})`); }
  const verb = destination === file && outcome.data ? "File modified" : "File saved";
  return `${verb}: ${written.join(", ")}\n${outcome.summary.map((r) => `- ${r}`).join("\n")}${warningList(outcome.warnings)}`;
}

export async function convert({ file, format, save_as: saveAs, sheet, separator }) {
  existingFile(file);
  if (!["pdf", "csv", "xlsx"].includes(format)) throw new Error(`target format «${format}» is not possible: use pdf, csv or xlsx`);
  const from = path.extname(file).toLowerCase().slice(1);
  const { convert: convertFile } = await import("./convert.mjs");
  const outcome = await convertFile({ file, from, to: format, saveAs, sheet, separator });
  for (const f of outcome.files) writeAtomic(f.path, f.data);
  return `File created: ${outcome.files.map((f) => `${f.path} (${kb(f.data.length)})`).join(", ")}${outcome.note ? `\nNote: ${outcome.note}` : ""}${warningList(outcome.warnings)}`;
}

const ACTIONS = { create, read, edit, convert };

const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

async function handle(m) {
  if (m.method === "initialize") {
    return respond(m.id, { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "documents", version: "2.0.0" } });
  }
  if (m.method === "tools/list") return respond(m.id, { tools: TOOLS });
  if (m.method === "tools/call") {
    try {
      const action = ACTIONS[m.params?.name];
      if (!action) throw new Error(`unknown tool «${m.params?.name}»`);
      return respond(m.id, { content: [{ type: "text", text: await action(m.params.arguments ?? {}) }] });
    } catch (e) {
      return respond(m.id, { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true });
    }
  }
  if (m.id !== undefined) respond(m.id, {}); // ping and the like
}

// Only when launched as a server: whoever imports the actions (the tests) does not start the protocol.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    handle(m).catch((e) => console.error("documents:", e));
  });
}

export { TOOLS };
