#!/usr/bin/env node
// mango-websearch-mcp.js — HOME-MADE web search MCP for mango-code. Zero cloud, zero
// API keys, zero third-party services, zero Docker: direct multi-engine scrapers + text
// extraction with Mozilla's Readability + markdown conversion. It is the same recipe as the
// commercial tools (Tavily/Jina/Firecrawl), cut to the bone and tuned for a local 35B:
//
//   search        -> DDG lite + Bing + Startpage in parallel, merged and deduped (an engine
//                    that breaks or gets blocked = we go on with the others).
//   read_url      -> page -> Readability (boilerplate gone) -> markdown; images as compact
//                    links [img: alt](url) so they can be downloaded with curl.
//   research      -> search + the first N pages ALREADY extracted, in ONE call (Tavily
//                    pattern): fewer round trips = fewer wasted turns for a slow model.
//   search_images -> image search (DDG Images internal JSON API, no key): direct URLs,
//                    ready for curl.
//
// The engines were chosen by PROBING (2026-07-18): Brave=429, Ecosia=403, Mojeek=empty;
// DDG/Bing/Startpage serve real HTML. When one changes its markup, fix its parser.
// MCP protocol spoken by hand (line-delimited JSON-RPC over stdio): no SDK, no churn.

const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const enc = encodeURIComponent;

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
td.remove(["script", "style", "noscript", "iframe"]);
// images as compact links: the URL survives (downloadable with curl) without the noise of
// embedded ![...] markdown; no data URIs (huge and useless)
td.addRule("img-compact", { filter: "img", replacement: (_, node) => {
  const src = node.getAttribute("src") || "";
  if (!/^https?:/.test(src)) return "";
  return `[img: ${(node.getAttribute("alt") || "no-alt").slice(0, 60)}](${src})`;
} });

async function get(url, accept, ua) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": ua || UA, accept: accept || "text/html,*/*" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) {
      // some sites (Medium & co.) block "anonymous" browsers but serve Googlebot: one retry
      if (!ua && (r.status === 403 || r.status === 429))
        return get(url, accept, "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
      throw new Error(`HTTP ${r.status}`);
    }
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- search: direct scrapers, one parser per engine ----------
function dom(html, url) {
  const vc = new VirtualConsole(); // real pages = broken CSS/JS: jsdom must not shout on stderr
  return new JSDOM(html, url ? { url, virtualConsole: vc } : { virtualConsole: vc }).window.document;
}
// dom for the scrapers: drop style/script/svg BEFORE reading the textContent (Startpage inlines
// <style> inside the anchors -> without this the titles come out full of CSS)
function sdom(html, url) {
  const doc = dom(html, url);
  doc.querySelectorAll("style,script,svg").forEach(n => n.remove());
  return doc;
}
const ENGINES = {
  duckduckgo: async q => {
    const doc = sdom(await get(`https://html.duckduckgo.com/html/?q=${enc(q)}`));
    return [...doc.querySelectorAll(".result")].map(el => {
      const a = el.querySelector("a.result__a");
      let url = a ? a.href : "";
      const m = /uddg=([^&]+)/.exec(url); if (m) url = decodeURIComponent(m[1]); // de-redirect
      return { title: a ? a.textContent.trim() : "", url,
               snippet: el.querySelector(".result__snippet")?.textContent.trim() || "" };
    });
  },
  bing: async q => {
    const doc = sdom(await get(`https://www.bing.com/search?q=${enc(q)}&count=10`), "https://www.bing.com/");
    return [...doc.querySelectorAll("li.b_algo")].map(el => {
      const a = el.querySelector("h2 a");
      let url = a ? a.href : "";
      const m = /[?&]u=a1([^&]+)/.exec(url); // bing.com/ck/a: destination in base64url
      if (m) { try { url = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch (_) {} }
      return { title: a ? a.textContent.trim() : "", url,
               snippet: el.querySelector(".b_caption p, .b_caption")?.textContent.trim() || "" };
    });
  },
  startpage: async q => {
    const doc = sdom(await get(`https://www.startpage.com/sp/search?query=${enc(q)}`), "https://www.startpage.com/");
    return [...doc.querySelectorAll("div.result")].map(el => {
      const anchors = [...el.querySelectorAll('a[href^="http"]')].filter(a => !/startpage\.com/.test(a.href));
      const a = anchors.find(x => x.textContent.replace(/\s+/g, " ").trim().length > 5 && !/anonymous view/i.test(x.textContent)) || anchors[0];
      return { title: a ? a.textContent.replace(/\s+/g, " ").trim() : "", url: a ? a.href : "",
               snippet: el.querySelector("p")?.textContent.trim() || "" };
    });
  },
};
const canon = u => { try { const x = new URL(u); return (x.host + x.pathname).toLowerCase().replace(/\/$/, ""); } catch (_) { return u; } };
async function search({ query, max_results = 8 }) {
  const names = Object.keys(ENGINES);
  const settled = await Promise.allSettled(names.map(n => ENGINES[n](query)));
  const status = [], byUrl = new Map();
  settled.forEach((s, i) => {
    if (s.status === "rejected") { status.push(`${names[i]}: FAILED (${s.reason.message})`); return; }
    const rows = s.value.filter(r => r.url && r.url.startsWith("http"));
    status.push(`${names[i]}: ${rows.length}`);
    rows.forEach((r, rank) => {
      const k = canon(r.url);
      const e = byUrl.get(k);
      if (e) { e.engines.push(names[i]); if (r.snippet.length > e.snippet.length) e.snippet = r.snippet; }
      else byUrl.set(k, { ...r, engines: [names[i]], rank });
    });
  });
  if (!byUrl.size) throw new Error("all engines failed: " + status.join(" · "));
  const results = [...byUrl.values()] // first the ones confirmed by more engines, then by rank
    .sort((a, b) => b.engines.length - a.engines.length || a.rank - b.rank)
    .slice(0, max_results)
    .map(({ rank, ...r }) => r);
  return { source: status.join(" · "), results };
}

// ---------- search_images (DDG Images internal JSON API) ----------
async function searchImages({ query, max_results = 12 }) {
  const html = await get(`https://duckduckgo.com/?q=${enc(query)}&iax=images&ia=images`);
  const m = /vqd=["']?([\d-]+)/.exec(html); // anti-abuse token, it is in the page
  if (!m) throw new Error("vqd token not found: DDG changed the page, update the parser");
  const j = JSON.parse(await get(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${enc(query)}&vqd=${m[1]}`, "application/json"));
  return { query, images: (j.results || []).slice(0, max_results).map(r => ({
      title: r.title, image_url: r.image, thumbnail: r.thumbnail,
      width: r.width, height: r.height, source_page: r.url })),
    hint: 'to download: curl.exe -L --output <dest> "<image_url>" (then Read to verify them: you are a VL model)' };
}

// ---------- read_url ----------
function extract(html, url) {
  const doc = dom(html, url);
  const art = new Readability(doc).parse();
  if (art && art.content && art.textContent.trim().length > 200) {
    return { title: art.title, byline: art.byline, md: td.turndown(art.content) };
  } // Readability fails on non-article pages (technical docs, indexes): take the whole body
  return { title: doc.title, byline: null, md: td.turndown(doc.body ? doc.body.innerHTML : html) };
}
async function readUrl({ url, max_chars = 20000 }) {
  // new reddit is an anti-bot SPA; old.reddit serves real HTML
  url = url.replace(/^https?:\/\/(www\.)?reddit\.com\//, "https://old.reddit.com/");
  const raw = await get(url);
  if (!/<[a-z][\s\S]*>/i.test(raw)) return raw.slice(0, max_chars); // already text/markdown
  const { title, byline, md } = extract(raw, url);
  let out = `# ${title || url}\n${byline ? byline + "\n" : ""}source: ${url}\n\n${md.replace(/\n{3,}/g, "\n\n")}`;
  if (out.length > max_chars) out = out.slice(0, max_chars) + `\n\n[TRUNCATED at ${max_chars} chars — re-read with a higher max_chars if needed]`;
  return out;
}

// ---------- research (Tavily pattern: search + extraction in one call) ----------
async function research({ query, fetch_top = 3, max_chars_per_page = 8000 }) {
  const { source, results } = await search({ query, max_results: 12 });
  const seen = new Set(), candidates = [];
  for (const r of results) { // distinct domains: 3 pages of the same site = 1 perspective
    const host = (() => { try { return new URL(r.url).host; } catch (_) { return r.url; } })();
    if (!seen.has(host)) { seen.add(host); candidates.push(r); }
  }
  // walks the candidates until it has fetch_top READABLE pages (403/anti-bot: skipped, the
  // next candidate takes its place) — never waste the model's turn on "[unreadable]"
  const pages = [], used = new Set();
  for (const r of candidates) {
    if (pages.length >= fetch_top) break;
    try {
      const text = await readUrl({ url: r.url, max_chars: max_chars_per_page });
      if (text.replace(/\s+/g, " ").length < 300) throw new Error("empty page/anti-bot");
      pages.push({ title: r.title, url: r.url, content: text }); used.add(r);
    } catch (_) { /* next candidate */ }
  }
  return { query, source, pages,
    other_results: candidates.filter(r => !used.has(r)).slice(0, 6).map(r => ({ title: r.title, url: r.url, snippet: r.snippet })) };
}

// ---------- MCP protocol ----------
const TOOLS = [
  { name: "search", description: "Web search (DuckDuckGo+Bing+Startpage scraped in parallel, merged and deduped; results confirmed by more engines rank first). Returns title+url+snippet. For current events, recent facts, anything newer than training data.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "search query" },
      max_results: { type: "number", description: "max results (default 8)" } }, required: ["query"] } },
  { name: "search_images", description: "Image search (DuckDuckGo Images). Returns direct image URLs + thumbnails + source pages. To download: curl.exe -L --output <dest> \"<image_url>\". You are a vision model: Read the downloaded file to verify it.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "image search query" },
      max_results: { type: "number", description: "max results (default 12)" } }, required: ["query"] } },
  { name: "read_url", description: "Fetch a URL and return the main content as clean markdown (Mozilla Readability: strips nav/ads/footer). Use after search to read a promising result.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "http(s) URL to read" },
      max_chars: { type: "number", description: "truncate output (default 20000)" } }, required: ["url"] } },
  { name: "research", description: "One-call deep search: searches, then fetches the top N results (distinct domains) and returns their content already extracted as clean text. Prefer this over search+read_url chains when you need actual page content.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "research question" },
      fetch_top: { type: "number", description: "pages to fetch (default 3)" },
      max_chars_per_page: { type: "number", description: "truncate each page (default 8000)" } }, required: ["query"] } },
];
const HANDLERS = { search, search_images: searchImages, read_url: readUrl, research };

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", async d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: m.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} }, serverInfo: { name: "mango-websearch", version: "1.0.0" } } });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call") {
      try {
        const r = await HANDLERS[m.params.name](m.params.arguments || {});
        out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 1) }] } });
      } catch (e) {
        out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true } });
      }
    } else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} }); // ping & co.
  }
});
process.stdin.on("end", () => process.exit(0));
