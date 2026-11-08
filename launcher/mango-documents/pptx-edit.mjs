// Existing PowerPoint (.pptx): reading (text, tables, notes) and edits that leave the other slides intact.
// A .pptx is a zip of XML: each slide is a part of its own, the order is in presentation.xml.
import path from "node:path";
import JSZip from "jszip";
import {
  MAX_READ, parseXml, openZip, descendants, pageList, childrenOf, requireParams, serializeXml, replaceInParagraph,
} from "./common.mjs";
import { createPptx } from "./pptx.mjs";
import {
  NS_REL, REL, addOverride, copyPart, emptyRels, relList, readRels, readXml, addRel, freePart, relativeTarget, relsOf, resolveTarget, contentType,
} from "./ooxml.mjs";

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const PRES = "ppt/presentation.xml";

// ---------------------------------------------------------------------------------------------
// Structure: the list of slides in order
// ---------------------------------------------------------------------------------------------

async function load(file) {
  const zip = await openZip(file, "PowerPoint");
  const pres = await readXml(zip, PRES);
  if (!pres) throw new Error(`${path.basename(file)} is not a valid PowerPoint presentation (${PRES} is missing)`);
  return { zip, pres, presRels: await readRels(zip, PRES), ct: parseXml(await zip.file("[Content_Types].xml").async("string")) };
}

/** The slides in order: `{ id, rId, part, el }`. */
function slideList(pres, presRels) {
  const list = pres.getElementsByTagName("p:sldIdLst")[0];
  if (!list) return [];
  return childrenOf(list, "p:sldId").map((el) => {
    const rId = el.getAttributeNS(NS_REL, "id") || el.getAttribute("r:id");
    const rel = relList(presRels).find((r) => r.getAttribute("Id") === rId);
    return { id: el.getAttribute("id"), rId, part: rel ? resolveTarget(PRES, rel.getAttribute("Target")) : null, el };
  }).filter((s) => s.part);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const runsText = (ap) => childrenOf(ap).map((n) => {
  if (n.nodeName === "a:fld" && /slidenum/i.test(n.getAttribute("type") ?? "")) return ""; // the page number is not content
  if (n.nodeName === "a:r" || n.nodeName === "a:fld") return descendants(n, "a:t").map((t) => t.textContent).join("");
  if (n.nodeName === "a:br") return "\n";
  return "";
}).join("");

const isTitle = (sp) => {
  const ph = sp.getElementsByTagName("p:ph")[0];
  return !!ph && ["title", "ctrTitle"].includes(ph.getAttribute("type"));
};

function tableLines(tbl) {
  const rows = childrenOf(tbl, "a:tr").map((tr) => childrenOf(tr, "a:tc").map((tc) => descendants(tc, "a:p").map(runsText).filter(Boolean).join(" ").replace(/\|/g, "\\|")));
  if (!rows.length) return [];
  const n = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: n }, (_, i) => r[i] ?? "");
  const [head, ...rest] = rows.map(pad);
  return [`| ${head.join(" | ")} |`, `|${" --- |".repeat(n)}`, ...rest.map((r) => `| ${r.join(" | ")} |`)];
}

/** Content of a slide: title and text lines, tables, marks for images and charts. */
function slideContent(doc) {
  let title = "";
  const lines = [];
  const visit = (el) => {
    for (const n of childrenOf(el)) {
      if (n.nodeName === "p:sp") {
        const paragraphs = descendants(n, "a:p").map((ap) => ({ ap, t: runsText(ap).trim() })).filter((x) => x.t);
        if (!paragraphs.length) continue;
        if (isTitle(n) && !title) { title = paragraphs.map((x) => x.t).join(" "); continue; }
        for (const { ap, t } of paragraphs) {
          const pPr = childrenOf(ap, "a:pPr")[0];
          const lvl = Number(pPr?.getAttribute("lvl") ?? 0);
          const bullet = pPr && (childrenOf(pPr, "a:buChar").length || childrenOf(pPr, "a:buAutoNum").length);
          lines.push(bullet ? `${"  ".repeat(lvl)}- ${t}` : t);
        }
      } else if (n.nodeName === "p:graphicFrame") {
        const tbl = n.getElementsByTagName("a:tbl")[0];
        if (tbl) lines.push(...tableLines(tbl));
        else if (n.getElementsByTagName("c:chart").length) lines.push("[chart]");
        else lines.push("[embedded object]");
      } else if (n.nodeName === "p:pic") {
        const d = n.getElementsByTagName("p:cNvPr")[0]?.getAttribute("descr");
        lines.push(d ? `[image: ${d}]` : "[image]");
      } else if (n.nodeName === "p:grpSp") visit(n);
    }
  };
  visit(doc.getElementsByTagName("p:spTree")[0]);
  return { title, lines };
}

async function notesOf(zip, slidePart) {
  const rels = await readXml(zip, relsOf(slidePart));
  const r = rels && relList(rels).find((x) => x.getAttribute("Type") === REL("notesSlide"));
  if (!r) return "";
  const doc = await readXml(zip, resolveTarget(slidePart, r.getAttribute("Target")));
  if (!doc) return "";
  return descendants(doc.documentElement, "p:sp")
    .filter((sp) => sp.getElementsByTagName("p:ph")[0]?.getAttribute("type") === "body")
    .flatMap((sp) => descendants(sp, "a:p").map((ap) => runsText(ap).trim()))
    .filter(Boolean).join("\n");
}

export async function read(file, { part } = {}) {
  const { zip, pres, presRels } = await load(file);
  const slides = slideList(pres, presRels);
  if (!slides.length) throw new Error("the presentation has no slides");
  const chosen = pageList(part, slides.length, "slide");
  const output = [`PowerPoint presentation: ${path.basename(file)} — ${slides.length} slides`];
  let budget = MAX_READ;
  for (const n of chosen) {
    const s = slides[n - 1];
    const { title, lines } = slideContent(await readXml(zip, s.part));
    const notes = await notesOf(zip, s.part);
    const block = [`\n## Slide ${n}${title ? ` — ${title}` : ""}`, ...(lines.length ? lines : ["(no other text)"]), ...(notes ? [`Speaker notes: ${notes.replace(/\n/g, " / ")}`] : [])].join("\n");
    budget -= block.length;
    if (budget < 0 && n !== chosen[0]) {
      output.push(`\n… slides ${n}-${chosen.at(-1)} not shown: continue with part="${n}-${chosen.at(-1)}"`);
      break;
    }
    output.push(block);
  }
  return output.join("\n");
}

// ---------------------------------------------------------------------------------------------
// PowerPoint sections (p14:sectionLst): a slide id outside every section, or left over after
// a deletion, makes PowerPoint say the file needs repair.
// ---------------------------------------------------------------------------------------------

function readSections(pres) {
  const lst = pres.getElementsByTagName("p14:sectionLst")[0];
  if (!lst) return null;
  const sections = childrenOf(lst, "p14:section");
  const members = new Map();
  sections.forEach((sz, i) => descendants(sz, "p14:sldId").forEach((x) => members.set(x.getAttribute("id"), i)));
  return { sections, members };
}

/** Rewrites the section lists following the current order of the slides. */
function applySections(pres, sec) {
  if (!sec) return;
  const order = childrenOf(pres.getElementsByTagName("p:sldIdLst")[0], "p:sldId").map((x) => x.getAttribute("id"));
  sec.sections.forEach((sz, i) => {
    let list = childrenOf(sz, "p14:sldIdLst")[0];
    if (!list) { list = pres.createElementNS(NS_P14, "p14:sldIdLst"); sz.appendChild(list); }
    for (const x of childrenOf(list)) list.removeChild(x);
    for (const id of order) if (sec.members.get(id) === i) {
      const el = pres.createElementNS(NS_P14, "p14:sldId");
      el.setAttribute("id", id);
      list.appendChild(el);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/** The «blank» layout of the presentation: the one the added slides rest on (shapes have their own position). */
async function blankLayout(zip) {
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
  let last = null;
  for (const n of names) {
    const d = await readXml(zip, n);
    const type = d.documentElement.getAttribute("type");
    const name = d.getElementsByTagName("p:cSld")[0]?.getAttribute("name") ?? "";
    if (type === "blank" || /^(blank|vuota|vuoto)$/i.test(name)) return n; // also the Italian names of PowerPoint templates
    if (type === "titleOnly" || type === "obj") last = last ?? n;
  }
  const chosen = last ?? names[0];
  if (!chosen) throw new Error("the presentation has no layout: cannot tell where to put the new slides");
  return chosen;
}

/** Name (cSld) of each layout of the presentation: needed to find the layout of our own files (BODY, COVER). */
async function layoutsByName(zip) {
  const m = new Map();
  for (const n of Object.keys(zip.files).filter((x) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(x))) {
    const d = await readXml(zip, n);
    m.set(d.getElementsByTagName("p:cSld")[0]?.getAttribute("name") ?? "", n);
  }
  return m;
}

async function notesMasterPart(zip, presRels) {
  const r = relList(presRels).find((x) => x.getAttribute("Type") === REL("notesMaster"));
  return r ? resolveTarget(PRES, r.getAttribute("Target")) : null;
}

async function addSlides(state, op, dir, styleName, warnings) {
  const { zip, pres, presRels, ct } = state;
  requireParams(op, "markdown");
  const buf = await createPptx(String(op.markdown), { dir, styleName, noCover: true });
  const F = await JSZip.loadAsync(buf);
  const ctF = parseXml(await F.file("[Content_Types].xml").async("string"));
  const presF = await readXml(F, PRES);
  const fragmentSlides = slideList(presF, await readRels(F, PRES));

  const existing = slideList(pres, presRels);
  let after = existing.length;
  if (op.after !== undefined && op.after !== null && op.after !== "") {
    after = Number(op.after);
    if (!Number.isInteger(after) || after < 0 || after > existing.length) throw new Error(`«after» must be a slide number from 0 to ${existing.length}, not «${op.after}»`);
  }
  const layout = await blankLayout(zip);
  const byName = await layoutsByName(zip);
  const notesMaster = await notesMasterPart(zip, presRels);
  const sec = readSections(pres);
  const list = pres.getElementsByTagName("p:sldIdLst")[0];
  const map = new Map();
  let skippedNotes = false;

  for (const [k, sf] of fragmentSlides.entries()) {
    const dest = freePart(zip, "ppt/slides/slide#.xml");
    zip.file(dest, await F.file(sf.part).async("string"));
    const origRels = await readRels(F, sf.part);
    const fresh = emptyRels();
    let notesPartF = null;
    for (const r of relList(origRels)) {
      const type = r.getAttribute("Type");
      if (type === REL("slideLayout")) {
        // A file made by us already has the slide layout (title, rule, number): it is reused; otherwise the blank one.
        const nameF = (await readXml(F, resolveTarget(sf.part, r.getAttribute("Target"))))?.getElementsByTagName("p:cSld")[0]?.getAttribute("name");
        addRel(fresh, type, relativeTarget(dest, (nameF && byName.get(nameF)) || layout), false, r.getAttribute("Id"));
        continue;
      }
      if (type === REL("notesSlide")) { notesPartF = resolveTarget(sf.part, r.getAttribute("Target")); continue; }
      if (r.getAttribute("TargetMode") === "External") { addRel(fresh, type, r.getAttribute("Target"), true, r.getAttribute("Id")); continue; }
      const copied = await copyPart(F, zip, ctF, ct, resolveTarget(sf.part, r.getAttribute("Target")), { map, skipTypes: ["slideLayout", "notesSlide", "slideMaster"] });
      addRel(fresh, type, relativeTarget(dest, copied), false, r.getAttribute("Id"));
    }
    // Speaker notes (if any) need the presentation's «notes master».
    if (notesPartF) {
      const notesDoc = await readXml(F, notesPartF);
      const hasText = notesDoc && descendants(notesDoc.documentElement, "p:sp").some((sp) => sp.getElementsByTagName("p:ph")[0]?.getAttribute("type") === "body" && descendants(sp, "a:t").some((t) => t.textContent.trim()));
      if (hasText && notesMaster) {
        const notesPart = freePart(zip, "ppt/notesSlides/notesSlide#.xml");
        zip.file(notesPart, await F.file(notesPartF).async("string"));
        const notesRels = emptyRels();
        addRel(notesRels, REL("notesMaster"), relativeTarget(notesPart, notesMaster));
        addRel(notesRels, REL("slide"), relativeTarget(notesPart, dest));
        zip.file(relsOf(notesPart), serializeXml(notesRels));
        addOverride(ct, notesPart, contentType(ctF, notesPartF));
        addRel(fresh, REL("notesSlide"), relativeTarget(dest, notesPart), false, `rIdNote${k}`);
      } else if (hasText) skippedNotes = true;
    }
    zip.file(relsOf(dest), serializeXml(fresh));
    addOverride(ct, dest, contentType(ctF, sf.part));

    const rId = addRel(presRels, REL("slide"), relativeTarget(PRES, dest));
    const ids = childrenOf(list, "p:sldId").map((x) => Number(x.getAttribute("id")));
    const newId = Math.max(255, ...ids) + 1;
    const el = pres.createElementNS(NS_P, "p:sldId");
    el.setAttribute("id", String(newId));
    el.setAttributeNS(NS_REL, "r:id", rId);
    const current = childrenOf(list, "p:sldId");
    const next = current[after + k] ?? null;
    list.insertBefore(el, next);
    if (sec) {
      const neighbor = current[after + k - 1] ?? next;
      sec.members.set(String(newId), neighbor ? (sec.members.get(neighbor.getAttribute("id")) ?? 0) : 0);
    }
  }
  if (skippedNotes) warnings.push("the speaker notes of the added slides were not inserted: this presentation has never used notes");
  applySections(pres, sec);
  return `added ${fragmentSlides.length} slides after ${after === 0 ? "the start position (at the beginning)" : `slide ${after}`}`;
}

/** Counts how many relationships of the package point to each part. */
async function referenceCounts(zip) {
  const count = new Map();
  for (const n of Object.keys(zip.files).filter((x) => x.endsWith(".rels"))) {
    const doc = parseXml(await zip.file(n).async("string"));
    const owner = n.replace("_rels/", "").replace(/\.rels$/, "");
    for (const r of relList(doc)) {
      if (r.getAttribute("TargetMode") === "External") continue;
      const t = resolveTarget(owner, r.getAttribute("Target"));
      count.set(t, (count.get(t) ?? 0) + 1);
    }
  }
  return count;
}

/** Removes a part (and what only it used) from the package and from the content types. */
async function removePart(zip, ct, part, count) {
  const ov = childrenOf(ct.documentElement, "Override").find((o) => o.getAttribute("PartName") === `/${part}`);
  if (ov) ct.documentElement.removeChild(ov);
  const rels = await readXml(zip, relsOf(part));
  zip.remove(part);
  if (rels) {
    zip.remove(relsOf(part));
    for (const r of relList(rels)) {
      if (r.getAttribute("TargetMode") === "External") continue;
      const t = resolveTarget(part, r.getAttribute("Target"));
      count.set(t, (count.get(t) ?? 1) - 1);
      if (count.get(t) <= 0 && zip.file(t) && !/\/(slideLayout|slideMaster|notesMaster|theme)/.test(t)) await removePart(zip, ct, t, count);
    }
  }
}

async function deleteSlide(state, op) {
  const { zip, pres, presRels, ct } = state;
  requireParams(op, "slide");
  const slides = slideList(pres, presRels);
  if (slides.length < 2) throw new Error("cannot delete the only slide of the presentation");
  const n = Number(op.slide);
  const s = slides[n - 1];
  if (!Number.isInteger(n) || !s) throw new Error(`slide ${op.slide} does not exist: the presentation has ${slides.length}`);
  const sec = readSections(pres);
  s.el.parentNode.removeChild(s.el);
  const rel = relList(presRels).find((r) => r.getAttribute("Id") === s.rId);
  presRels.documentElement.removeChild(rel);
  if (sec) sec.members.delete(s.id);
  applySections(pres, sec);
  // the slide and its notes: gone; the images and charts used only by it: gone too
  const count = await referenceCounts(zip);
  const slideRels = await readXml(zip, relsOf(s.part));
  const notes = slideRels && relList(slideRels).find((r) => r.getAttribute("Type") === REL("notesSlide"));
  if (notes) await removePart(zip, ct, resolveTarget(s.part, notes.getAttribute("Target")), count);
  await removePart(zip, ct, s.part, count);
  return `deleted slide ${n}`;
}

function moveSlide(state, op) {
  const { pres, presRels } = state;
  requireParams(op, "slide", "to");
  const slides = slideList(pres, presRels);
  const from = Number(op.slide), to = Number(op.to);
  if (!Number.isInteger(from) || !slides[from - 1]) throw new Error(`slide ${op.slide} does not exist: the presentation has ${slides.length}`);
  if (!Number.isInteger(to) || to < 1 || to > slides.length) throw new Error(`position ${op.to} does not exist: from 1 to ${slides.length}`);
  const sec = readSections(pres);
  const list = slides[from - 1].el.parentNode;
  const el = slides[from - 1].el;
  list.removeChild(el);
  const rest = childrenOf(list, "p:sldId");
  list.insertBefore(el, rest[to - 1] ?? null);
  if (sec) {
    // The moved slide joins the section of its neighbors
    const order = childrenOf(list, "p:sldId");
    const k = order.indexOf(el);
    const neighbor = order[k - 1] ?? order[k + 1];
    sec.members.set(el.getAttribute("id"), sec.members.get(neighbor?.getAttribute("id")) ?? 0);
  }
  applySections(pres, sec);
  return `moved slide ${from} to position ${to}`;
}

export async function edit(file, ops, { styleName }) {
  const state = await load(file);
  const dir = path.dirname(file);
  const summary = [];
  const warnings = [];

  for (const [i, op] of ops.entries()) {
    const label = `operation ${i + 1} («${op.action}»)`;
    try {
      switch (op.action) {
        case "replace": {
          requireParams(op, "find");
          if (op.with === undefined || op.with === null) throw new Error("missing «with» (the new text; it can be empty)");
          let total = 0;
          const parts = Object.keys(state.zip.files).filter((n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
          for (const n of parts) {
            const d = await readXml(state.zip, n);
            const k = descendants(d.documentElement, "a:p").reduce((x, p) => x + replaceInParagraph(p, "a:t", String(op.find), String(op.with)), 0);
            if (k) { total += k; state.zip.file(n, serializeXml(d)); }
          }
          if (!total) throw new Error(`the text «${op.find}» is not in any slide. Copy it exactly as documents_read shows it`);
          summary.push(`«${op.find}» → «${op.with}»: ${total} ${total === 1 ? "time" : "times"}`);
          break;
        }
        case "add_slide": summary.push(await addSlides(state, op, dir, styleName, warnings)); break;
        case "delete_slide": summary.push(await deleteSlide(state, op)); break;
        case "move_slide": summary.push(moveSlide(state, op)); break;
        default:
          throw new Error(`action «${op.action}» does not exist for a PowerPoint file: use replace, add_slide, delete_slide, move_slide`);
      }
    } catch (e) {
      throw new Error(`${label}: ${e.message}. Nothing was saved.`);
    }
  }
  state.zip.file(PRES, serializeXml(state.pres));
  state.zip.file(relsOf(PRES), serializeXml(state.presRels));
  state.zip.file("[Content_Types].xml", serializeXml(state.ct));
  const data = await state.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data, summary, warnings };
}
