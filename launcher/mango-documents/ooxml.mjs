// Helpers for the OOXML package (a zip of XML parts): relative paths, relationships, content types, part copying.
// Used by all the modules that edit existing Word, Excel or PowerPoint files.
import { parseXml, childrenOf, serializeXml } from "./common.mjs";

export const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
export const REL = (type) => `${NS_REL}/${type}`;

export const dirOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);
export const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
export const relsOf = (part) => `${dirOf(part)}_rels/${baseName(part)}.rels`;

/** Absolute path in the package of a `Target` relative to `fromPart`. */
export function resolveTarget(fromPart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const pieces = dirOf(fromPart).split("/").filter(Boolean);
  for (const p of target.split("/")) {
    if (p === "..") pieces.pop();
    else if (p !== ".") pieces.push(p);
  }
  return pieces.join("/");
}

/** `Target` relative from `fromPart` to `toPart`. */
export function relativeTarget(fromPart, toPart) {
  const from = dirOf(fromPart).split("/").filter(Boolean), to = toPart.split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => ".."), ...to].join("/");
}

export async function readXml(zip, part) {
  const f = zip.file(part);
  return f ? parseXml(await f.async("string")) : null;
}

export const emptyRels = () => parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}"/>`);

/** The relationships of a part (an empty document if it has none). */
export async function readRels(zip, part) {
  return (await readXml(zip, relsOf(part))) ?? emptyRels();
}

export const relList = (relsDoc) => childrenOf(relsDoc.documentElement, "Relationship");

/** Adds a relationship and returns its Id: a free one if none is given, otherwise the given one (not to be repeated). */
export function addRel(relsDoc, type, target, external = false, id = null) {
  let chosenId = id;
  if (!chosenId) {
    const used = new Set(relList(relsDoc).map((r) => r.getAttribute("Id")));
    let n = 1;
    while (used.has(`rId${n}`)) n++;
    chosenId = `rId${n}`;
  }
  const el = relsDoc.createElementNS(NS_PKG_REL, "Relationship");
  el.setAttribute("Id", chosenId);
  el.setAttribute("Type", type);
  el.setAttribute("Target", target);
  if (external) el.setAttribute("TargetMode", "External");
  relsDoc.documentElement.appendChild(el);
  return chosenId;
}

export function addOverride(ct, part, type) {
  const root = ct.documentElement;
  if (childrenOf(root, "Override").some((o) => o.getAttribute("PartName") === `/${part}`)) return;
  const el = ct.createElementNS(NS_CT, "Override");
  el.setAttribute("PartName", `/${part}`);
  el.setAttribute("ContentType", type);
  root.appendChild(el);
}

function addDefault(ct, extension, type) {
  const root = ct.documentElement;
  if (childrenOf(root, "Default").some((d) => d.getAttribute("Extension").toLowerCase() === extension.toLowerCase())) return;
  const el = ct.createElementNS(NS_CT, "Default");
  el.setAttribute("Extension", extension);
  el.setAttribute("ContentType", type);
  root.insertBefore(el, root.firstChild);
}

/** Content type of a part: its `Override` entry, otherwise the `Default` of its extension. */
export function contentType(ct, part) {
  const o = childrenOf(ct.documentElement, "Override").find((x) => x.getAttribute("PartName") === `/${part}`);
  if (o) return o.getAttribute("ContentType");
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  return childrenOf(ct.documentElement, "Default").find((d) => d.getAttribute("Extension").toLowerCase() === ext)?.getAttribute("ContentType") ?? null;
}

/** First free name in the package, replacing `#` with 1, 2, 3... (e.g. «ppt/slides/slide#.xml»). */
export function freePart(zip, template) {
  for (let n = 1; ; n++) {
    const p = template.replace("#", String(n));
    if (!zip.file(p)) return p;
  }
}

/**
 * Copies a part from one package to another with all the parts it points to (images, charts, embedded
 * workbooks), giving free names in the destination. `skipTypes` are the relationship types that are NOT
 * followed (e.g. the slide layout, which is a different one in the destination). Returns the new path.
 * `map` avoids copying the same part twice.
 */
export async function copyPart(from, to, ctFrom, ctTo, part, { skipTypes = [], map = new Map() } = {}) {
  if (map.has(part)) return map.get(part);
  const ext = part.slice(part.lastIndexOf("."));
  const template = `${dirOf(part)}${baseName(part).replace(/\d*\.[^.]+$/, "")}#${ext}`;
  const dest = to.file(part) ? freePart(to, template) : part;
  map.set(part, dest);
  const data = await from.file(part).async("nodebuffer");
  to.file(dest, data);
  const type = contentType(ctFrom, part);
  if (type) {
    const hasOverride = childrenOf(ctFrom.documentElement, "Override").some((x) => x.getAttribute("PartName") === `/${part}`);
    if (hasOverride) addOverride(ctTo, dest, type); else addDefault(ctTo, ext.slice(1), type);
  }
  const rels = await readXml(from, relsOf(part));
  if (rels) {
    const fresh = emptyRels();
    for (const r of relList(rels)) {
      const t = r.getAttribute("Type");
      if (skipTypes.some((s) => t.endsWith(`/${s}`))) continue;
      const el = fresh.createElementNS(NS_PKG_REL, "Relationship");
      el.setAttribute("Id", r.getAttribute("Id"));
      el.setAttribute("Type", t);
      if (r.getAttribute("TargetMode") === "External") {
        el.setAttribute("Target", r.getAttribute("Target"));
        el.setAttribute("TargetMode", "External");
      } else {
        const source = resolveTarget(part, r.getAttribute("Target"));
        if (!from.file(source)) continue;
        const copied = await copyPart(from, to, ctFrom, ctTo, source, { skipTypes, map });
        el.setAttribute("Target", relativeTarget(dest, copied));
      }
      fresh.documentElement.appendChild(el);
    }
    to.file(relsOf(dest), serializeXml(fresh));
  }
  return dest;
}
