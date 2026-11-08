// Existing Word (.docx): reading with the structure, and edits that leave the rest of the file intact.
// A .docx is a zip of XML: only the touched part is read and changed (document.xml, numbering.xml...),
// everything else (styles, images, headers, settings) travels unchanged.
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  MAX_READ, parseXml, openZip, descendants, escapeMarkdown, childrenOf, requireParams, serializeXml, replaceInParagraph, truncate,
} from "./common.mjs";
import { createDocx } from "./docx.mjs";
import { REL, addOverride, copyPart, relList, readRels, addRel, relativeTarget, relsOf, resolveTarget } from "./ooxml.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const isOn = (el, name) => {
  const f = childrenOf(el, name)[0];
  if (!f) return false;
  const v = f.getAttribute("w:val");
  return v === null || !["0", "false", "off"].includes(v);
};

// ---------------------------------------------------------------------------------------------
// Document structure: styles, numberings, links
// ---------------------------------------------------------------------------------------------

async function load(file) {
  const zip = await openZip(file, "Word");
  const part = zip.file("word/document.xml");
  if (!part) throw new Error(`${path.basename(file)} is not a valid Word document (word/document.xml is missing)`);
  return { zip, doc: parseXml(await part.async("string")) };
}

async function readPart(zip, name) {
  const f = zip.file(name);
  return f ? parseXml(await f.async("string")) : null;
}

/** styleId -> { name, level }: the heading level (1-9) deduced from the style name, Italian names included. */
function styleMap(styles) {
  const m = new Map();
  if (!styles) return m;
  for (const s of descendants(styles.documentElement, "w:style")) {
    if (s.getAttribute("w:type") !== "paragraph") continue;
    const name = (childrenOf(s, "w:name")[0]?.getAttribute("w:val") ?? "").toLowerCase();
    const mm = name.match(/^(?:heading|titolo)\s*(\d)$/);
    m.set(s.getAttribute("w:styleId"), { name, level: mm ? Number(mm[1]) : name === "title" || name === "titolo" ? 1 : 0 });
  }
  return m;
}

function headingLevel(p, styles) {
  const pPr = childrenOf(p, "w:pPr")[0];
  if (!pPr) return 0;
  const st = childrenOf(pPr, "w:pStyle")[0]?.getAttribute("w:val");
  if (st && styles.get(st)?.level) return styles.get(st).level;
  const out = childrenOf(pPr, "w:outlineLvl")[0]?.getAttribute("w:val");
  return out !== undefined && out !== null && out !== "" && Number(out) < 9 ? Number(out) + 1 : 0;
}

/** numId -> ilvl -> "bullet" | "ordered" */
function numberingMap(num) {
  const m = new Map();
  if (!num) return m;
  const abstracts = new Map();
  for (const a of descendants(num.documentElement, "w:abstractNum")) {
    const lv = new Map();
    for (const l of childrenOf(a, "w:lvl")) lv.set(l.getAttribute("w:ilvl"), childrenOf(l, "w:numFmt")[0]?.getAttribute("w:val") === "bullet" ? "bullet" : "ordered");
    abstracts.set(a.getAttribute("w:abstractNumId"), lv);
  }
  for (const n of descendants(num.documentElement, "w:num")) {
    m.set(n.getAttribute("w:numId"), abstracts.get(childrenOf(n, "w:abstractNumId")[0]?.getAttribute("w:val")) ?? new Map());
  }
  return m;
}

/** styleId -> the style's `<w:numPr>` (or that of the first style it derives from that has one): Word lists are often in the style («List Bullet»), not in the paragraph. */
function styleNumberings(styles) {
  const per = new Map();
  if (!styles) return per;
  const base = new Map();
  for (const s of descendants(styles.documentElement, "w:style")) {
    const pPr = childrenOf(s, "w:pPr")[0];
    per.set(s.getAttribute("w:styleId"), pPr ? childrenOf(pPr, "w:numPr")[0] ?? null : null);
    base.set(s.getAttribute("w:styleId"), childrenOf(s, "w:basedOn")[0]?.getAttribute("w:val") ?? null);
  }
  const resolved = new Map();
  for (const id of per.keys()) {
    let cur = id;
    for (let k = 0; cur && k < 10 && !per.get(cur); k++) cur = base.get(cur);
    resolved.set(id, cur ? per.get(cur) : null);
  }
  return resolved;
}

async function context(zip) {
  const rels = await readPart(zip, "word/_rels/document.xml.rels");
  const links = new Map();
  if (rels) for (const r of childrenOf(rels.documentElement, "Relationship")) links.set(r.getAttribute("Id"), r.getAttribute("Target"));
  return {
    styles: styleMap(await readPart(zip, "word/styles.xml")),
    styleNum: styleNumberings(await readPart(zip, "word/styles.xml")),
    num: numberingMap(await readPart(zip, "word/numbering.xml")),
    links,
    counters: new Map(),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Inline text of a paragraph, with **bold**, *italic* and [link](url). */
function inline(p, ctx, opts) {
  const pieces = [];
  const add = (text, b, i, url) => {
    if (text === "") return;
    const last = pieces.at(-1);
    if (last && last.b === b && last.i === i && last.url === url) last.text += text;
    else pieces.push({ text, b, i, url });
  };
  const run = (r, url) => {
    const rPr = childrenOf(r, "w:rPr")[0];
    const b = rPr ? isOn(rPr, "w:b") : false, i = rPr ? isOn(rPr, "w:i") : false;
    for (const n of childrenOf(r)) {
      if (n.nodeName === "w:t") add(n.textContent, b, i, url);
      else if (n.nodeName === "w:tab") add("\t", false, false, url);
      else if (n.nodeName === "w:br") add(n.getAttribute("w:type") === "page" ? "\n[[page]]\n" : "\n", false, false, url);
      else if (n.nodeName === "w:drawing" || n.nodeName === "w:pict") {
        const img = opts?.image?.(n);
        add(img ?? "[image]", false, false, undefined);
      }
    }
  };
  const descend = (el, url) => {
    for (const n of childrenOf(el)) {
      switch (n.nodeName) {
        case "w:r": run(n, url); break;
        case "w:hyperlink": {
          const id = n.getAttribute("r:id");
          descend(n, id ? ctx.links.get(id) : undefined);
          break;
        }
        case "w:ins": case "w:smartTag": case "w:fldSimple": case "w:sdt": case "w:customXml":
          descend(n.nodeName === "w:sdt" ? (childrenOf(n, "w:sdtContent")[0] ?? n) : n, url);
          break;
        default: break;
      }
    }
  };
  descend(p, undefined);
  return pieces
    .map((x) => {
      let t = x.text;
      if (/^\s*$/.test(t)) return t;
      const [, lead, body, trail] = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const plain = opts?.escape ? escapeMarkdown(body) : body;
      t = x.url ? `[${plain}](${x.url})` : plain;
      if (x.b && !opts?.flat) t = `**${t}**`;
      if (x.i && !opts?.flat) t = `*${t}*`;
      return lead + t + trail;
    })
    .join("");
}

const plainTextOf = (p) => descendants(p, "w:t").map((t) => t.textContent).join("");

function listItem(p, ctx) {
  const pPr = childrenOf(p, "w:pPr")[0];
  const paragraphStyle = pPr && childrenOf(pPr, "w:pStyle")[0]?.getAttribute("w:val");
  const numPr = (pPr && childrenOf(pPr, "w:numPr")[0]) ?? (paragraphStyle ? ctx.styleNum.get(paragraphStyle) : null);
  if (!numPr) return null;
  const id = childrenOf(numPr, "w:numId")[0]?.getAttribute("w:val");
  if (!id || id === "0") return null;
  const lvl = childrenOf(numPr, "w:ilvl")[0]?.getAttribute("w:val") ?? "0";
  const kind = ctx.num.get(id)?.get(lvl) ?? "bullet";
  const k = `${id}/${lvl}`;
  if (kind === "bullet") return { level: Number(lvl), mark: "-" };
  const n = (ctx.counters.get(k) ?? 0) + 1;
  ctx.counters.set(k, n);
  for (const other of [...ctx.counters.keys()]) if (other.startsWith(`${id}/`) && Number(other.split("/")[1]) > Number(lvl)) ctx.counters.delete(other);
  return { level: Number(lvl), mark: `${n}.` };
}

function markdownTable(tbl, ctx, opts) {
  const rows = childrenOf(tbl, "w:tr").map((tr) => childrenOf(tr, "w:tc").map((tc) => descendants(tc, "w:p").map((p) => inline(p, ctx, { ...opts, flat: true })).filter(Boolean).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " ")));
  if (!rows.length) return "";
  const n = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: n }, (_, i) => r[i] ?? "");
  const [head, ...rest] = rows.map(pad);
  return [`| ${head.join(" | ")} |`, `|${" --- |".repeat(n)}`, ...rest.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** Text blocks (one per paragraph or table) of the body, in order. */
function bodyBlocks(body, ctx, opts) {
  const out = [];
  const visit = (el) => {
    for (const n of childrenOf(el)) {
      if (n.nodeName === "w:p") {
        const text = inline(n, ctx, opts).trim();
        if (!text) { listItem(n, ctx); continue; }
        const level = headingLevel(n, ctx.styles);
        if (level) { out.push(`${"#".repeat(Math.min(level, 6))} ${text}`); continue; }
        const item = listItem(n, ctx);
        out.push(item ? `${"  ".repeat(item.level)}${item.mark} ${text}` : opts?.escape ? text.replace(/^(#|>|[+-]|\d+[.)])(\s)/, "\\$1$2") : text);
      } else if (n.nodeName === "w:tbl") {
        const t = markdownTable(n, ctx, opts);
        if (t) out.push(t);
      } else if (n.nodeName === "w:sdt") {
        const c = childrenOf(n, "w:sdtContent")[0];
        if (c) visit(c);
      }
    }
  };
  visit(body);
  return out;
}

const isListItem = (b) => /^\s*(-|\d+\.) /.test(b);
/** Joins the blocks into Markdown: list items go on a plain new line, the rest is separated by an empty line. */
export function joinBlocks(blocks) {
  return blocks.reduce((acc, b, k) => (k === 0 ? b : acc + (isListItem(b) && isListItem(blocks[k - 1]) ? "\n" : "\n\n") + b), "");
}

/** The text of the document as Markdown. With `imageDir`, PNG and JPEG images are extracted there and cited by path instead of the [image] mark. */
export async function documentAsMarkdown(file, { imageDir, escape = false } = {}) {
  const { zip, doc } = await load(file);
  const ctx = await context(zip);
  const body = doc.getElementsByTagName("w:body")[0];
  let image;
  if (imageDir) {
    // The document's PNG and JPEG images are extracted into a folder, and the Markdown cites them by path.
    fs.mkdirSync(imageDir, { recursive: true });
    for (const name of Object.keys(zip.files).filter((n) => /^word\/media\/[^/]+\.(png|jpe?g)$/i.test(n))) {
      fs.writeFileSync(path.join(imageDir, path.basename(name)), await zip.file(name).async("nodebuffer"));
    }
    image = (node) => {
      const id = node.getElementsByTagName("a:blip")[0]?.getAttribute("r:embed");
      const target = id && ctx.links.get(id);
      if (!target || !/\.(png|jpe?g)$/i.test(target)) return null;
      const descr = node.getElementsByTagName("wp:docPr")[0]?.getAttribute("descr") ?? "";
      return `![${descr.replace(/[[\]]/g, "")}](<${path.join(imageDir, path.basename(target)).replace(/\\/g, "/")}>)`;
    };
  }
  const blocks = bodyBlocks(body, ctx, { image, escape });
  return { blocks, zip, ctx };
}

async function partsText(zip, prefix, ctx) {
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => new RegExp(`^word/${prefix}\\d*\\.xml$`).test(n)).sort()) {
    const d = parseXml(await zip.file(name).async("string"));
    const t = descendants(d.documentElement, "w:p").map((p) => inline(p, ctx).trim()).filter(Boolean).join(" / ");
    if (t) out.push(t);
  }
  return out;
}

export async function read(file, { part } = {}) {
  const { blocks, zip, ctx } = await documentAsMarkdown(file);
  const doc = parseXml(await zip.file("word/document.xml").async("string"));
  const imageCount = doc.getElementsByTagName("w:drawing").length + doc.getElementsByTagName("w:pict").length;
  const tableCount = doc.getElementsByTagName("w:tbl").length;
  const headers = await partsText(zip, "header", ctx);
  const footers = await partsText(zip, "footer", ctx);

  // Reading blocks: groups of paragraphs up to MAX_READ characters.
  const groups = [];
  let cur = [], len = 0;
  for (const b of blocks) {
    if (len + b.length > MAX_READ && cur.length) { groups.push(cur); cur = []; len = 0; }
    cur.push(b); len += b.length + 2;
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) groups.push([]);

  const n = part === undefined ? 1 : Number(part);
  if (!Number.isInteger(n) || n < 1 || n > groups.length) throw new Error(`invalid part «${part}»: the document is read in ${groups.length} ${groups.length === 1 ? "part (the 1st)" : `parts (1 to ${groups.length})`}`);

  const head = [
    `Word document: ${path.basename(file)} — ${blocks.length} text blocks, ${tableCount} tables, ${imageCount} images.`,
    ...(headers.length ? [`Header: ${headers.join(" | ")}`] : []),
    ...(footers.length ? [`Footer: ${footers.join(" | ")}`] : []),
    groups.length > 1 ? `Part ${n} of ${groups.length}${n < groups.length ? ` (continue with part=${n + 1})` : ""}` : "",
  ].filter(Boolean);
  const body = joinBlocks(groups[n - 1]);
  return `${head.join("\n")}\n\n${truncate(body || "(the document has no text)", MAX_READ * 2, "use part for the other sections")}`;
}

// ---------------------------------------------------------------------------------------------
// Editing: text replacement
// ---------------------------------------------------------------------------------------------

function setText(t, text) {
  t.textContent = text;
  t.setAttribute("xml:space", "preserve");
}

/** Line break in the new text of a replacement: `<w:br/>` and a new `<w:t>` in the same format group. */
const wordLineBreak = (doc, line) => {
  const t = doc.createElementNS(W, "w:t");
  setText(t, line);
  return [doc.createElementNS(W, "w:br"), t];
};
const replaceInWord = (p, find, replacement) => replaceInParagraph(p, "w:t", find, replacement, wordLineBreak);

async function replaceEverywhere(zip, doc, find, replacement) {
  let total = 0;
  total += descendants(doc.documentElement, "w:p").reduce((n, p) => n + replaceInWord(p, find, replacement), 0);
  const others = [];
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n))) {
    const d = parseXml(await zip.file(name).async("string"));
    const k = descendants(d.documentElement, "w:p").reduce((n, p) => n + replaceInWord(p, find, replacement), 0);
    if (k) { total += k; others.push([name, d]); }
  }
  return { total, others };
}

// ---------------------------------------------------------------------------------------------
// Editing: Markdown insertion (merging a fragment created by createDocx)
// ---------------------------------------------------------------------------------------------

const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

function bodyChildren(body) {
  return childrenOf(body).filter((n) => n.nodeName !== "w:sectPr");
}
function bodyParagraphs(body) {
  return bodyChildren(body).filter((n) => n.nodeName === "w:p");
}
function findParagraph(body, text, what) {
  const t = normalize(text);
  const found = bodyParagraphs(body).filter((p) => normalize(plainTextOf(p)).includes(t));
  if (!found.length) throw new Error(`${what}: no paragraph contains «${text}». Copy the exact text from documents_read`);
  return { p: found[0], count: found.length };
}

/** The element that ends the section whose heading is `heading`: the first element after the section. */
function sectionEnd(body, heading, styles) {
  const level = headingLevel(heading, styles);
  const children = bodyChildren(body);
  let i = children.indexOf(heading) + 1;
  for (; i < children.length; i++) {
    const l = children[i].nodeName === "w:p" ? headingLevel(children[i], styles) : 0;
    if (l && l <= level) break;
  }
  return children[i] ?? null; // null = end of the body
}

function nextId(values) {
  const ids = values.map((v) => Number(String(v).replace(/\D/g, "")) || 0);
  return Math.max(0, ...ids) + 1;
}

/**
 * Builds the Markdown fragment with `createDocx` and brings its elements into the document `zip`/`doc`:
 * missing styles, numbered lists, images and links are remapped. Returns the nodes to insert.
 */
async function fragment(markdown, zip, doc, dir, styleName) {
  const buf = await createDocx(markdown, { dir, styleName });
  const F = await JSZip.loadAsync(buf);
  const fdoc = parseXml(await F.file("word/document.xml").async("string"));
  const fbody = fdoc.getElementsByTagName("w:body")[0];
  const nodes = bodyChildren(fbody);
  if (!nodes.length) throw new Error("the Markdown to add is empty");

  // 1. Styles
  const targetStyles = await readPart(zip, "word/styles.xml");
  const fragmentStyles = await readPart(F, "word/styles.xml");
  if (targetStyles && fragmentStyles) {
    const mt = styleMap(targetStyles);
    const targetIds = new Set(descendants(targetStyles.documentElement, "w:style").map((s) => s.getAttribute("w:styleId")));
    const byLevel = new Map([...mt].filter(([, v]) => v.level).map(([id, v]) => [v.level, id]));
    const used = new Set();
    for (const node of nodes) {
      for (const tag of ["w:pStyle", "w:rStyle", "w:tblStyle"]) for (const e of descendants(node, tag)) used.add(e.getAttribute("w:val"));
    }
    const fragmentStyleDefs = new Map(descendants(fragmentStyles.documentElement, "w:style").map((s) => [s.getAttribute("w:styleId"), s]));
    const mf = styleMap(fragmentStyles);
    const remap = new Map();
    for (const id of used) {
      if (!id || targetIds.has(id)) continue;
      const level = mf.get(id)?.level;
      if (level && byLevel.has(level)) { remap.set(id, byLevel.get(level)); continue; }
      const def = fragmentStyleDefs.get(id);
      if (def) { targetStyles.documentElement.appendChild(targetStyles.importNode(def, true)); targetIds.add(id); }
    }
    for (const node of nodes) {
      for (const tag of ["w:pStyle", "w:rStyle", "w:tblStyle"]) {
        for (const e of descendants(node, tag)) if (remap.has(e.getAttribute("w:val"))) e.setAttribute("w:val", remap.get(e.getAttribute("w:val")));
      }
    }
    zip.file("word/styles.xml", serializeXml(targetStyles));
  }

  // 2. Numbered lists
  const fragmentNum = await readPart(F, "word/numbering.xml");
  const usedNum = new Set();
  for (const node of nodes) for (const e of descendants(node, "w:numId")) usedNum.add(e.getAttribute("w:val"));
  if (fragmentNum && usedNum.size) {
    let targetNum = await readPart(zip, "word/numbering.xml");
    if (!targetNum) {
      targetNum = parseXml(serializeXml(fragmentNum));
      for (const x of childrenOf(targetNum.documentElement)) targetNum.documentElement.removeChild(x);
      await registerPart(zip, "word/numbering.xml", REL("numbering"), "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
    }
    const root = targetNum.documentElement;
    const targetAbstracts = descendants(root, "w:abstractNum").map((a) => a.getAttribute("w:abstractNumId"));
    const targetNumIds = descendants(root, "w:num").map((a) => a.getAttribute("w:numId"));
    let nextAbstract = nextId(targetAbstracts), nextNum = nextId(targetNumIds);
    const numMap = new Map();
    const firstNum = childrenOf(root, "w:num")[0] ?? childrenOf(root, "w:numIdMacAtCleanup")[0] ?? null;
    for (const id of usedNum) {
      const n = descendants(fragmentNum.documentElement, "w:num").find((x) => x.getAttribute("w:numId") === id);
      if (!n) continue;
      const aId = childrenOf(n, "w:abstractNumId")[0].getAttribute("w:val");
      const a = descendants(fragmentNum.documentElement, "w:abstractNum").find((x) => x.getAttribute("w:abstractNumId") === aId);
      const a2 = root.ownerDocument.importNode(a, true);
      a2.setAttribute("w:abstractNumId", String(nextAbstract));
      for (const x of childrenOf(a2, "w:nsid").concat(childrenOf(a2, "w:tmpl"))) a2.removeChild(x);
      root.insertBefore(a2, firstNum);
      const n2 = root.ownerDocument.importNode(n, true);
      n2.setAttribute("w:numId", String(nextNum));
      childrenOf(n2, "w:abstractNumId")[0].setAttribute("w:val", String(nextAbstract));
      const mac = childrenOf(root, "w:numIdMacAtCleanup")[0] ?? null;
      root.insertBefore(n2, mac);
      numMap.set(id, String(nextNum));
      nextAbstract++; nextNum++;
    }
    for (const node of nodes) for (const e of descendants(node, "w:numId")) if (numMap.has(e.getAttribute("w:val"))) e.setAttribute("w:val", numMap.get(e.getAttribute("w:val")));
    zip.file("word/numbering.xml", serializeXml(targetNum));
  }

  // 3. Links and images: each relationship of the fragment becomes a relationship of the document
  const fragmentRels = await readRels(F, "word/document.xml");
  const targetRels = await readRels(zip, "word/document.xml");
  const ctF = parseXml(await F.file("[Content_Types].xml").async("string"));
  const ct = parseXml(await zip.file("[Content_Types].xml").async("string"));
  const fRel = new Map(relList(fragmentRels).map((r) => [r.getAttribute("Id"), r]));
  const relMap = new Map();
  const partMap = new Map();
  for (const node of nodes) {
    for (const e of [node, ...descendants(node, "*")]) {
      for (const a of ["r:id", "r:embed", "r:link"]) {
        const old = e.getAttribute?.(a);
        if (!old) continue;
        if (!relMap.has(old)) {
          const r = fRel.get(old);
          if (!r) continue;
          if (r.getAttribute("TargetMode") === "External") relMap.set(old, addRel(targetRels, r.getAttribute("Type"), r.getAttribute("Target"), true));
          else {
            const dest = await copyPart(F, zip, ctF, ct, resolveTarget("word/document.xml", r.getAttribute("Target")), { map: partMap });
            relMap.set(old, addRel(targetRels, r.getAttribute("Type"), relativeTarget("word/document.xml", dest)));
          }
        }
        e.setAttribute(a, relMap.get(old));
      }
    }
  }
  if (relMap.size) {
    zip.file(relsOf("word/document.xml"), serializeXml(targetRels));
    zip.file("[Content_Types].xml", serializeXml(ct));
  }

  // 4. Image identifiers (wp:docPr) unique in the document
  const imageIds = descendants(doc.documentElement, "wp:docPr").map((d) => d.getAttribute("id"));
  let next = nextId(imageIds);
  for (const node of nodes) for (const d of descendants(node, "wp:docPr")) d.setAttribute("id", String(next++));

  return nodes.map((n) => doc.importNode(n, true));
}

async function registerPart(zip, name, relType, contentType) {
  const targetRels = await readRels(zip, "word/document.xml");
  addRel(targetRels, relType, relativeTarget("word/document.xml", name));
  zip.file(relsOf("word/document.xml"), serializeXml(targetRels));
  const ct = parseXml(await zip.file("[Content_Types].xml").async("string"));
  addOverride(ct, name, contentType);
  zip.file("[Content_Types].xml", serializeXml(ct));
}

// ---------------------------------------------------------------------------------------------
// Editing: actions
// ---------------------------------------------------------------------------------------------

function addTableRow(table, cells, afterText) {
  const rows = childrenOf(table, "w:tr");
  if (!rows.length) throw new Error("the table has no rows");
  let template = rows.at(-1);
  if (afterText) {
    const t = normalize(afterText);
    const r = rows.find((x) => normalize(plainTextOf(x)).includes(t));
    if (!r) throw new Error(`no row of the table contains «${afterText}»`);
    template = r;
  }
  const columns = childrenOf(template, "w:tc");
  if (cells.length !== columns.length) throw new Error(`the table has ${columns.length} columns but you gave ${cells.length} texts in "cells": ${columns.length} are needed`);
  const fresh = template.cloneNode(true);
  childrenOf(fresh, "w:tc").forEach((tc, i) => {
    const ps = childrenOf(tc, "w:p");
    ps.slice(1).forEach((p) => tc.removeChild(p));
    const p = ps[0];
    const runs = descendants(p, "w:r");
    const templateRun = runs.find((r) => childrenOf(r, "w:t").length) ?? runs[0];
    for (const r of childrenOf(p, "w:r").concat(childrenOf(p, "w:hyperlink"))) p.removeChild(r);
    const r = templateRun ? templateRun.cloneNode(false) : p.ownerDocument.createElementNS(W, "w:r");
    const rPr = templateRun && childrenOf(templateRun, "w:rPr")[0];
    if (rPr) r.appendChild(rPr.cloneNode(true));
    const t = p.ownerDocument.createElementNS(W, "w:t");
    setText(t, String(cells[i]));
    r.appendChild(t);
    p.appendChild(r);
  });
  template.parentNode.insertBefore(fresh, template.nextSibling);
}

export async function edit(file, ops, { styleName }) {
  const { zip, doc } = await load(file);
  const body = doc.getElementsByTagName("w:body")[0];
  const styles = styleMap(await readPart(zip, "word/styles.xml"));
  const dir = path.dirname(file);
  const summary = [];
  const warnings = [];
  const otherParts = new Map();

  for (const [i, op] of ops.entries()) {
    const label = `operation ${i + 1} («${op.action}»)`;
    try {
      switch (op.action) {
        case "replace": {
          requireParams(op, "find");
          if (op.with === undefined || op.with === null) throw new Error("missing «with» (the new text; it can be empty to delete)");
          const { total, others } = await replaceEverywhere(zip, doc, String(op.find), String(op.with));
          if (!total) throw new Error(`the text «${op.find}» is not in the document. Copy it exactly as documents_read shows it (capitals and accents included; a text spanning two paragraphs is not found)`);
          for (const [n, d] of others) otherParts.set(n, d);
          summary.push(`«${op.find}» → «${op.with}»: ${total} ${total === 1 ? "time" : "times"}`);
          break;
        }
        case "add": {
          requireParams(op, "markdown");
          const nodes = await fragment(String(op.markdown), zip, doc, dir, styleName);
          const sectPr = childrenOf(body, "w:sectPr").at(-1) ?? null;
          let before = sectPr, where = "at the end";
          if (op.after !== undefined && op.after !== "") {
            const { p, count } = findParagraph(body, String(op.after), "after");
            before = p.nextSibling; where = `after «${String(op.after).slice(0, 40)}»${count > 1 ? ` (there are ${count}: used the first)` : ""}`;
          } else if (op.before !== undefined && op.before !== "") {
            const { p, count } = findParagraph(body, String(op.before), "before");
            before = p; where = `before «${String(op.before).slice(0, 40)}»${count > 1 ? ` (there are ${count}: used the first)` : ""}`;
          } else if (op.end_of_section !== undefined && op.end_of_section !== "") {
            const { p } = findParagraph(body, String(op.end_of_section), "end_of_section");
            if (!headingLevel(p, styles)) throw new Error(`«${op.end_of_section}» is not a heading: give the heading of the section`);
            before = sectionEnd(body, p, styles) ?? sectPr; where = `at the end of the section «${op.end_of_section}»`;
          } else if (op.where === "start") { before = bodyChildren(body)[0] ?? sectPr; where = "at the start"; }
          else if (op.where && op.where !== "end") throw new Error(`«where» can be end or start, not «${op.where}»: for a precise point use after, before or end_of_section`);
          for (const n of nodes) body.insertBefore(n, before);
          summary.push(`added content ${where}`);
          break;
        }
        case "delete": {
          requireParams(op, "text");
          const { p, count } = findParagraph(body, String(op.text), "delete");
          p.parentNode.removeChild(p);
          summary.push(`deleted the paragraph «${plainTextOf(p).slice(0, 50)}»${count > 1 ? ` (${count - 1} others contain it, not touched)` : ""}`);
          break;
        }
        case "delete_section": {
          requireParams(op, "title");
          const { p } = findParagraph(body, String(op.title), "delete_section");
          if (!headingLevel(p, styles)) throw new Error(`«${op.title}» is not a heading`);
          const end = sectionEnd(body, p, styles);
          let n = 0;
          for (let x = p; x && x !== end && x.nodeName !== "w:sectPr";) { const next = x.nextSibling; x.parentNode.removeChild(x); x = next; n++; }
          summary.push(`deleted the section «${op.title}» (${n} elements)`);
          break;
        }
        case "add_table_row": {
          requireParams(op, "table", "cells");
          const tables = childrenOf(body, "w:tbl");
          const t = tables[Number(op.table) - 1];
          if (!t) throw new Error(`table ${op.table} does not exist: the document has ${tables.length}`);
          if (!Array.isArray(op.cells)) throw new Error("«cells» must be a list of texts, one per column");
          addTableRow(t, op.cells, op.after);
          summary.push(`added a row to table ${op.table}`);
          break;
        }
        default:
          throw new Error(`action «${op.action}» does not exist for a Word file: use replace, add, delete, delete_section, add_table_row`);
      }
    } catch (e) {
      throw new Error(`${label}: ${e.message}. Nothing was saved.`);
    }
  }

  zip.file("word/document.xml", serializeXml(doc));
  for (const [n, d] of otherParts) zip.file(n, serializeXml(d));
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data, summary, warnings };
}
