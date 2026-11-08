// Existing PDF: reading the text (with the lines rebuilt) and the form fields; merging, splitting,
// rotating, reordering, watermark, page numbers and form filling, without redoing the file.
// Reading with `unpdf` (pdf.js), edits with `pdf-lib`. No OCR: a scan has no text to read.
import fs from "node:fs";
import path from "node:path";
import {
  PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts, degrees, rgb,
} from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { MAX_READ, pageList, existingFile, requireParams } from "./common.mjs";

const MAX_READ_PAGES = 20;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * pdf.js gives text pieces with their position, not lines: they are grouped by height (same line if the
 * difference is less than half the character height), sorted left to right, and wide gaps
 * (table columns) become two spaces. A line far from the previous one opens a paragraph.
 */
function linesFromItems(items) {
  const lines = [];
  for (const it of items) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    const y = it.transform[5], h = it.height || Math.abs(it.transform[3]) || 10;
    let r = lines.find((x) => Math.abs(x.y - y) < h / 2);
    if (!r) { r = { y, h, pieces: [] }; lines.push(r); }
    r.pieces.push({ x: it.transform[4], w: it.width, t: it.str });
  }
  lines.sort((a, b) => b.y - a.y);
  const out = [];
  let previous = null;
  for (const r of lines) {
    r.pieces.sort((a, b) => a.x - b.x);
    let text = "", end = null;
    for (const p of r.pieces) {
      if (end !== null) {
        const gap = p.x - end;
        if (gap > r.h * 1.2) text += "  ";
        else if (gap > r.h * 0.12 && !text.endsWith(" ") && !p.t.startsWith(" ")) text += " ";
      }
      text += p.t;
      end = p.x + p.w;
    }
    if (previous && previous.y - r.y > r.h * 1.9) out.push("");
    out.push(text.trimEnd());
    previous = r;
  }
  return out;
}

async function openPdf(file) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  try {
    return await getDocumentProxy(bytes);
  } catch (e) {
    if (/password/i.test(String(e?.message ?? e)) || e?.name === "PasswordException") throw new Error(`${path.basename(file)} is password-protected: cannot read it`);
    throw new Error(`${path.basename(file)} is not a readable PDF (${e?.message ?? e})`);
  }
}

async function formFields(file) {
  try {
    const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
    return doc.getForm().getFields().map((f) => {
      const name = f.getName();
      if (f instanceof PDFTextField) return `«${name}» (text)${f.getText() ? ` = «${f.getText()}»` : ""}`;
      if (f instanceof PDFCheckBox) return `«${name}» (checkbox: true/false)${f.isChecked() ? " = checked" : ""}`;
      if (f instanceof PDFDropdown || f instanceof PDFOptionList) return `«${name}» (choice among: ${f.getOptions().map((o) => `«${o}»`).join(", ")})`;
      if (f instanceof PDFRadioGroup) return `«${name}» (one of: ${f.getOptions().map((o) => `«${o}»`).join(", ")})`;
      return `«${name}»`;
    });
  } catch {
    return [];
  }
}

export async function read(file, { part } = {}) {
  const pdf = await openPdf(file);
  try {
    const total = pdf.numPages;
    let chosen;
    if (part === undefined || part === "") chosen = Array.from({ length: Math.min(total, MAX_READ_PAGES) }, (_, i) => i + 1);
    else {
      chosen = pageList(part, total, "page");
      if (chosen.length > MAX_READ_PAGES) chosen = chosen.slice(0, MAX_READ_PAGES);
    }
    const info = (await pdf.getMetadata().catch(() => null))?.info ?? {};
    const fields = await formFields(file);
    const output = [`PDF: ${path.basename(file)} — ${total} pages${info.Title ? ` — title «${info.Title}»` : ""}`];
    if (fields.length) output.push(`Fillable form with ${fields.length} fields (fill it with documents_edit, action fill_form):\n${fields.slice(0, 60).map((c) => `- ${c}`).join("\n")}${fields.length > 60 ? `\n- … and ${fields.length - 60} more` : ""}`);

    let budget = MAX_READ;
    let last = 0, withoutText = 0, done = 0;
    for (const n of chosen) {
      const page = await pdf.getPage(n);
      const lines = linesFromItems((await page.getTextContent()).items);
      if (!lines.length) withoutText++;
      const block = `\n--- page ${n} ---\n${lines.join("\n") || "(no text)"}`;
      if (budget - block.length < 0 && last) break;
      budget -= block.length;
      output.push(block);
      last = n;
      done++;
    }
    if (done && withoutText === done && !fields.length) {
      output.push("\nNone of these pages has text: it is probably a scan (images only). There is no text recognition (OCR) here: it cannot be read. Tell the user: a version of the document with the text, or a transcription, is needed.");
    }
    const lastRequested = chosen.at(-1);
    if (last < lastRequested) output.push(`\n… text truncated at page ${last}: continue with part="${last + 1}-${Math.min(total, last + MAX_READ_PAGES)}"`);
    else if (lastRequested < total) output.push(`\n… there are more pages: continue with part="${lastRequested + 1}-${Math.min(total, lastRequested + MAX_READ_PAGES)}"`);
    return output.join("\n");
  } finally {
    await pdf.loadingTask?.destroy?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

async function loadDoc(filePath) {
  try {
    return await PDFDocument.load(fs.readFileSync(filePath));
  } catch (e) {
    if (/encrypt/i.test(String(e?.message))) throw new Error(`${path.basename(filePath)} is password-protected: cannot edit it`);
    throw new Error(`${path.basename(filePath)} is not a valid PDF (${e?.message ?? e})`);
  }
}

// Also the Italian words, as a document may come from an Italian form.
const TRUE_VALUE = /^(true|yes|x|1|on|checked|vero|si|sì|spuntata|spuntato)$/i;

function fillForm(doc, fields, summary) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("«fields» must be an object {\"field name\": \"value\"}; the names are shown by documents_read");
  const form = doc.getForm();
  const all = form.getFields();
  if (!all.length) throw new Error("this PDF has no fields to fill (it is not a fillable form)");
  const names = all.map((f) => f.getName());
  for (const [name, value] of Object.entries(fields)) {
    const field = all.find((f) => f.getName() === name) ?? all.find((f) => f.getName().toLowerCase() === name.trim().toLowerCase());
    if (!field) throw new Error(`the field «${name}» does not exist. The fields are: ${names.slice(0, 40).map((n) => `«${n}»`).join(", ")}${names.length > 40 ? ", …" : ""}`);
    try {
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) { if (TRUE_VALUE.test(String(value).trim())) field.check(); else field.uncheck(); }
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        const options = field.getOptions();
        if (!options.includes(String(value))) throw new Error(`the value «${value}» is not among the possible items: ${options.map((o) => `«${o}»`).join(", ")}`);
        field.select(String(value));
      } else throw new Error("this type of field cannot be filled");
    } catch (e) {
      throw new Error(`field «${name}»: ${/encode|WinAnsi/i.test(String(e?.message)) ? "the text has characters the PDF cannot write (use Latin letters and common accents)" : e.message}`);
    }
  }
  form.updateFieldAppearances();
  summary.push(`filled ${Object.keys(fields).length} fields`);
}

async function watermark(doc, text, indices) {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  try { font.encodeText(text); } catch { throw new Error("the watermark has characters the PDF cannot write: use Latin letters, numbers and common accents"); }
  const pages = doc.getPages();
  for (const n of indices) {
    const p = pages[n - 1];
    const { width: W, height: H } = p.getSize();
    const maxLength = Math.hypot(W, H) * 0.7;
    const size = Math.min(110, (maxLength / font.widthOfTextAtSize(text, 1)));
    const w = font.widthOfTextAtSize(text, size), alt = size * 0.7;
    const ang = Math.atan2(H, W); // along the diagonal of the page
    const c = Math.cos(ang), s = Math.sin(ang);
    p.drawText(text, {
      x: W / 2 - (w / 2) * c + (alt / 2) * s,
      y: H / 2 - (w / 2) * s - (alt / 2) * c,
      size, font, color: rgb(0.55, 0.55, 0.55), opacity: 0.3, rotate: degrees((ang * 180) / Math.PI),
    });
  }
}

async function numberPages(doc, indices) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const n of indices) {
    const p = pages[n - 1];
    const t = `${n} / ${pages.length}`;
    p.drawText(t, { x: (p.getWidth() - font.widthOfTextAtSize(t, 9)) / 2, y: 18, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
  }
}

/** A new document with the pages `indices` (from 1) of `doc`, in the given order. */
async function withPages(doc, indices) {
  const fresh = await PDFDocument.create();
  const copied = await fresh.copyPages(doc, indices.map((n) => n - 1));
  copied.forEach((p) => fresh.addPage(p));
  return fresh;
}

export async function edit(file, ops, { destination }) {
  let doc = await loadDoc(file);
  const summary = [];
  const extraFiles = [];
  const pageCount = () => doc.getPageCount();

  for (const [i, op] of ops.entries()) {
    const label = `operation ${i + 1} («${op.action}»)`;
    try {
      switch (op.action) {
        case "merge": {
          requireParams(op, "other_files");
          const list = Array.isArray(op.other_files) ? op.other_files : [op.other_files];
          for (const f of list) {
            const other = await loadDoc(existingFile(f, "other_files"));
            const copied = await doc.copyPages(other, other.getPageIndices());
            copied.forEach((p) => doc.addPage(p));
            summary.push(`added ${other.getPageCount()} pages from ${path.basename(f)}`);
          }
          break;
        }
        case "extract_pages": {
          requireParams(op, "pages");
          const idx = pageList(op.pages, pageCount());
          doc = await withPages(doc, idx);
          summary.push(`kept pages ${op.pages} (now ${idx.length} pages)`);
          break;
        }
        case "delete_pages": {
          requireParams(op, "pages");
          const idx = pageList(op.pages, pageCount());
          if (idx.length >= pageCount()) throw new Error("cannot delete all the pages");
          [...idx].sort((a, b) => b - a).forEach((n) => doc.removePage(n - 1));
          summary.push(`deleted pages ${op.pages} (now ${pageCount()} pages)`);
          break;
        }
        case "reorder": {
          requireParams(op, "order");
          const idx = pageList(op.order, pageCount());
          if (idx.length !== pageCount()) throw new Error(`the order must name all ${pageCount()} pages, once each (e.g. ${[...Array(pageCount())].map((_, k) => pageCount() - k).join(",")})`);
          doc = await withPages(doc, idx);
          summary.push(`pages reordered: ${op.order}`);
          break;
        }
        case "rotate": {
          requireParams(op, "degrees");
          const g = Number(op.degrees);
          if (![90, 180, 270, -90].includes(g)) throw new Error("«degrees» can be 90, 180 or 270 (clockwise)");
          const idx = pageList(op.pages, pageCount());
          for (const n of idx) { const p = doc.getPage(n - 1); p.setRotation(degrees((((p.getRotation().angle + g) % 360) + 360) % 360)); }
          summary.push(`rotated ${idx.length} pages by ${g} degrees`);
          break;
        }
        case "watermark": {
          requireParams(op, "text");
          const idx = pageList(op.pages, pageCount());
          await watermark(doc, String(op.text), idx);
          summary.push(`watermark «${op.text}» on ${idx.length} pages`);
          break;
        }
        case "number_pages": {
          const idx = pageList(op.pages, pageCount());
          await numberPages(doc, idx);
          summary.push(`numbered ${idx.length} pages`);
          break;
        }
        case "fill_form": fillForm(doc, op.fields, summary); break;
        case "split": {
          requireParams(op, "every");
          if (ops.length > 1) throw new Error("«split» must be requested alone, with no other operations");
          const every = Number(op.every);
          if (!Number.isInteger(every) || every < 1) throw new Error("«every» is the number of pages of each file, e.g. 1 or 5");
          const base = destination.replace(/\.pdf$/i, "");
          const parts = Math.ceil(pageCount() / every);
          if (parts > 200) throw new Error(`that would make ${parts} files: increase «every»`);
          for (let k = 0; k < parts; k++) {
            const idx = Array.from({ length: Math.min(every, pageCount() - k * every) }, (_, j) => k * every + j + 1);
            const piece = await withPages(doc, idx);
            extraFiles.push({ path: `${base}_part${k + 1}.pdf`, data: Buffer.from(await piece.save()) });
          }
          summary.push(`split into ${parts} files of ${every} pages: ${base}_part1.pdf … _part${parts}.pdf`);
          break;
        }
        default:
          throw new Error(`action «${op.action}» does not exist for a PDF: use merge, extract_pages, delete_pages, reorder, rotate, watermark, number_pages, fill_form, split`);
      }
    } catch (e) {
      throw new Error(`${label}: ${e.message}. Nothing was saved.`);
    }
  }
  if (extraFiles.length) return { data: null, extraFiles, summary, warnings: [] };
  doc.setProducer("Mango Code");
  return { data: Buffer.from(await doc.save()), summary, warnings: [] };
}
