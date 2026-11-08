// Shared pieces: Markdown reading, palette, images; zip and XML helpers for existing files.
import fs from "node:fs";
import path from "node:path";
import { Lexer } from "marked";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/** Palette: `primary` for headings and table headers, `light` for row and table backgrounds. */
export const STYLES = {
  blue: { primary: "1F4E79", light: "DEEAF6", text: "1A1A1A" },
  green: { primary: "2E6B3F", light: "E3F1E6", text: "1A1A1A" },
  orange: { primary: "B45309", light: "FDEBD3", text: "1A1A1A" },
  graphite: { primary: "37414B", light: "E9ECEF", text: "1A1A1A" },
};

export function resolveStyle(name) {
  const s = STYLES[name ?? "blue"];
  if (!s) throw new Error(`unknown style «${name}»: use ${Object.keys(STYLES).join(", ")}`);
  return s;
}

/** Markdown blocks (marked.Lexer, no raw HTML: the text is written by a model). */
export function blocks(markdown) {
  return new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, "\n")).filter((t) => t.type !== "space");
}

/** Plain text of a sequence of inline tokens (no formatting). */
export function plainText(tokens = []) {
  return tokens
    .map((t) => {
      if (t.type === "br") return "\n";
      if (t.type === "image") return "";
      if (t.tokens) return plainText(t.tokens);
      return t.text ?? t.raw ?? "";
    })
    .join("");
}

/** Inline tokens -> flat segments `{ text, bold, italic, code, strike, link }`, without nesting. */
export function segments(tokens = [], base = {}) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case "strong": out.push(...segments(t.tokens, { ...base, bold: true })); break;
      case "em": out.push(...segments(t.tokens, { ...base, italic: true })); break;
      case "del": out.push(...segments(t.tokens, { ...base, strike: true })); break;
      case "codespan": out.push({ ...base, text: t.text, code: true }); break;
      case "link": out.push(...segments(t.tokens, { ...base, link: t.href })); break;
      case "br": out.push({ ...base, text: "\n" }); break;
      case "image": break; // images are handled at block level
      case "escape": case "text":
        if (t.tokens?.length) out.push(...segments(t.tokens, base));
        else out.push({ ...base, text: t.text });
        break;
      default: out.push({ ...base, text: t.text ?? t.raw ?? "" });
    }
  }
  return out;
}

/**
 * Single-line directives: `[[page]]` (page break) and `[[chart: type | title]]` (chart of the data of the
 * table before it). Returns `{ name, type, title }`, or null if the paragraph is normal text.
 */
export function directive(tok) {
  if (tok.type !== "paragraph") return null;
  const m = tok.text.trim().match(/^\[\[\s*(page|chart)\s*(?::\s*([^\]|]*?))?\s*(?:\|\s*([^\]]*?))?\s*\]\]$/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), type: (m[2] ?? "").toLowerCase(), title: m[3] ?? "" };
}

const CHART_TYPES = ["bar", "horizontal", "line", "pie"];
export function chartType(d) {
  if (!CHART_TYPES.includes(d.type)) {
    throw new Error(`chart «${d.type || "(empty)"}»: write [[chart: bar]], [[chart: line]], [[chart: pie]] or [[chart: horizontal]], with an optional title after the bar: [[chart: bar | Revenue 2026]]`);
  }
  return d.type;
}

/** Images `![alt](path)` inside a paragraph. */
export function imagesOf(tokens = []) {
  return tokens.flatMap((t) => (t.type === "image" ? [t] : t.tokens ? imagesOf(t.tokens) : []));
}

/**
 * Reads an image cited in the Markdown: a local path (absolute, or relative to the folder of the created
 * file). Only PNG, JPEG and GIF: those are the formats Word, PowerPoint and PDF accept without
 * conversion. A clear error instead of a page without the image.
 */
export function readImage(href, dir) {
  if (/^https?:/i.test(href)) throw new Error(`image ${href}: download it into the project first and use the file path`);
  const p = path.resolve(dir, decodeURI(href.replace(/^file:\/+/i, "")));
  if (!fs.existsSync(p)) throw new Error(`image not found: ${p}`);
  const data = fs.readFileSync(p);
  const size = imageSize(data);
  if (!size) throw new Error(`image ${p}: unsupported format (PNG, JPEG or GIF required)`);
  return { data, ...size, path: p };
}

function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { type: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Fits (width, height) inside a maximum box, never enlarging. */
export function fit({ width, height }, maxW, maxH = Infinity) {
  const f = Math.min(1, maxW / width, maxH / height);
  return { width: Math.round(width * f), height: Math.round(height * f) };
}

// ---------------------------------------------------------------------------------------------
// Helpers to read and edit existing files (zip + XML), used by the «-edit» modules.
// ---------------------------------------------------------------------------------------------
/** A path the model may have written wrong: an error with the fix. */
export function existingFile(file, name = "file") {
  if (typeof file !== "string" || !file.trim()) throw new Error(`missing parameter «${name}»`);
  if (!path.isAbsolute(file)) {
    throw new Error(`«${file}» is not a full path: write it with the project folder, e.g. C:\\Users\\...\\${path.basename(file)}`);
  }
  if (!fs.existsSync(file)) throw new Error(`the file ${file} does not exist: check the name (you can list the folder with glob)`);
  if (fs.statSync(file).isDirectory()) throw new Error(`${file} is a folder, not a file`);
  return file;
}

/** Writes a file atomically: either it is there in full or the previous one stays. */
export function writeAtomic(destination, data) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = `${destination}.mango-tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, destination);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES") {
      throw new Error(`cannot write ${destination}: the file is open in another program (Word, Excel...). Ask the user to close it, or save under another name (parameter save_as)`);
    }
    throw e;
  }
}

export async function openZip(file, format) {
  let z;
  try {
    z = await JSZip.loadAsync(fs.readFileSync(file));
  } catch {
    throw new Error(`${path.basename(file)} is not a real ${format} file: it is damaged or has the wrong extension`);
  }
  return z;
}

export const parseXml = (text) => new DOMParser({ onError: () => {} }).parseFromString(text, "text/xml");
export const serializeXml = (doc) => {
  const s = new XMLSerializer().serializeToString(doc);
  return s.startsWith("<?xml") ? s : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
};

/** Direct children of an element with that name (e.g. "w:p"). */
export function childrenOf(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (name === undefined || n.nodeName === name)) out.push(n);
  return out;
}
/** Descendants with that name, in document order (a copy: the tree can be changed while iterating). */
export const descendants = (el, name) => Array.from(el.getElementsByTagName(name));


export function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** «A», «B», ... «AA» <-> 1, 2, ... 27 */
export function columnLetters(n) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function columnNumber(letters) {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

/** «2-4,7» -> [2,3,4,7] (numbers from 1), checking they fall within `total`. */
export function pageList(spec, total, what = "page") {
  if (spec === undefined || spec === null || spec === "" || String(spec).toLowerCase() === "all") {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out = [];
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`«${spec}» is not a list of ${what}s: write for example 1-3,5`);
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (from < 1 || to < from || to > total) throw new Error(`${what} «${part.trim()}» is outside the document, which has ${total}`);
    for (let i = from; i <= to; i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}

/** Truncates a long text, saying how to continue. */
export function truncate(text, max, howToContinue) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (text truncated: ${howToContinue})`;
}

export const MAX_READ = 14000;

/** Normalizes the `operations` argument: a list of objects (even if the model sends a JSON string or a single object). */
export function operationList(op) {
  let v = op;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new Error("«operations» must be a list of objects, e.g. [{\"action\":\"replace\",\"find\":\"a\",\"with\":\"b\"}]"); }
  }
  if (v && !Array.isArray(v) && typeof v === "object") v = [v];
  if (!Array.isArray(v) || !v.length) throw new Error("missing «operations»: a list with at least one operation, e.g. [{\"action\":\"replace\",\"find\":\"a\",\"with\":\"b\"}]");
  v.forEach((o, i) => {
    if (!o || typeof o !== "object" || typeof o.action !== "string") throw new Error(`operation ${i + 1}: missing «action»`);
  });
  return v;
}

/** Checks that the operation has the required parameters, with a message for the model. */
export function requireParams(op, ...names) {
  for (const n of names) {
    if (op[n] === undefined || op[n] === null || op[n] === "") {
      throw new Error(`action «${op.action}»: missing parameter «${n}»`);
    }
  }
}

/**
 * Replaces `find` with `replacement` inside an OOXML paragraph, even if the text is split across several
 * formatting runs: the new text takes the format of where the found text starts. `tag` is the text element
 * ("w:t" in Word, "a:t" in PowerPoint). `lineBreak(doc, line)` gives the nodes to insert for a line break in
 * the new text (in Word `<w:br/>` and a new `<w:t>`); without it, the line break becomes a space. Returns how many times.
 */
export function replaceInParagraph(p, tag, find, replacement, lineBreak) {
  let ts = descendants(p, tag);
  if (!ts.length) return 0;
  const full = ts.map((t) => t.textContent).join("");
  const positions = [];
  for (let i = full.indexOf(find); i >= 0; i = full.indexOf(find, i + find.length)) positions.push(i);
  const lines = lineBreak ? replacement.split("\n") : [replacement.replace(/\r?\n/g, " ")];
  const setText = (t, text) => { t.textContent = text; t.setAttribute("xml:space", "preserve"); };
  // Right to left: the positions on the left do not change when editing on the right.
  for (const start of positions.reverse()) {
    const end = start + find.length;
    let off = 0;
    const spans = ts.map((t) => { const x = { t, from: off, to: off + t.textContent.length }; off = x.to; return x; });
    const first = spans.find((x) => x.from <= start && x.to > start);
    const last = spans.find((x) => x.from < end && x.to >= end);
    if (!first || !last) continue;
    const before = first.t.textContent.slice(0, start - first.from);
    const after = last.t.textContent.slice(end - last.from);
    if (first === last) setText(first.t, before + lines[0] + (lines.length === 1 ? after : ""));
    else {
      setText(first.t, before + lines[0]);
      for (const x of spans) if (x.from > first.from && x.from < last.from) setText(x.t, "");
      setText(last.t, after);
    }
    let afterEl = first.t;
    lines.slice(1).forEach((line, k) => {
      const nodes = lineBreak(first.t.ownerDocument, line + (k === lines.length - 2 && first === last ? after : ""));
      for (const n of nodes) { first.t.parentNode.insertBefore(n, afterEl.nextSibling); afterEl = n; }
    });
    ts = descendants(p, tag);
  }
  return positions.length;
}

/** The text of a document that will end up in a Markdown file: the author's Markdown marks stay text. */
export const escapeMarkdown = (t) => t.replace(/([\`*_[\]<>~])/g, "\$1");
