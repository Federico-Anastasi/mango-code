// mango-cookie-import.mjs - brings the logins of YOUR Chrome into the mango-code browser.
//
// THE PROBLEM IT SOLVES. Attaching to the DEFAULT Chrome profile shows the "Allow remote
// debugging?" banner at EVERY connection: it is a Chrome security measure, it can't be turned
// off, and every click is a human - the opposite of autonomy. On a profile started by US
// (--remote-debugging-port on a user data dir of ours) that banner doesn't exist: we gave the
// consent by launching it. The price was starting logged out of everything.
//
// WHY THE FILE IS NOT COPIED. Seeding by "copying Cookies from the real profile" works only with
// Chrome CLOSED, and on a machine where Chrome is always open it never happens (MEASURED
// 2026-08-26: the .mango-seeded marker had never been written, and the mango-code profile had
// always been empty). With Chrome running the file is locked without sharing: Copy-Item fails with
// "in use by another process" and esentutl /y with JET_errFileAccessDenied. Both tried.
//
// WHAT IT DOES INSTEAD. It goes through the protocol, not the disk: Storage.getCookies on the real
// Chrome, Storage.setCookies on ours. No locked file, no encryption problem (Chrome re-encrypts the
// values when it saves them, with the key of the destination profile), and httpOnly cookies come
// too, which JavaScript couldn't read.
//
// THE BANNER IS PAID ONCE: it takes ONE connection to the real Chrome, the import one.
// From then on the mango-chrome-mcp cascade finds our browser on 9333 and never touches the
// default profile again - so no banner, ever.
//
//   node mango-cookie-import.mjs            imports (asks for consent once)
//   node mango-cookie-import.mjs --check     only says how the profile stands, touches nothing

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(SELF, "runtime", "chrome-profile");
const STAMP = path.join(PROFILE, ".mango-seeded");
const PORT = 9333;
const CHECK = process.argv.includes("--check");

const log = (s) => process.stdout.write(s + "\n");

// The language of the messages: the one chosen in <data>\settings.json ("language": "it" or "en",
// shared with the app and the terminal), otherwise the system language (Italian if it is Italian,
// English otherwise). Node has no Windows display language call: the locale of the Intl API is the
// closest thing.
function lang() {
  const data = process.env.MANGO_DATA || path.join(process.env.LOCALAPPDATA || "", "MangoCode");
  try {
    const chosen = JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8").replace(/^﻿/, "")).language;
    if (chosen === "it" || chosen === "en") return chosen;
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("it") ? "it" : "en";
}

// A user-facing text in both languages.
const tr = (it, en) => (lang() === "it" ? it : en);

// --- Minimal CDP, zero dependencies (WebSocket is global since Node 22) ----------------------
function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const to = setTimeout(() => reject(new Error(tr("timeout di connessione a ", "connection timeout to ") + url)), 20000);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });
    ws.addEventListener("error", () => reject(new Error(tr("connessione fallita a ", "connection failed to ") + url)));
    ws.addEventListener("open", () => {
      clearTimeout(to);
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
    });
  });
}

// The real Chrome publishes ONLY the WebSocket when debugging is on from chrome://inspect: the
// HTTP /json routes return 404 there, so the endpoint is read from DevToolsActivePort (line 1 the
// port, line 2 the path of the browser ws).
function realEndpoint() {
  const f = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data", "DevToolsActivePort");
  try {
    const [p, w] = fs.readFileSync(f, "utf8").split("\n");
    const port = Number(String(p).trim());
    const wsPath = String(w || "").trim();
    if (!Number.isInteger(port) || port <= 0 || !wsPath) return null;
    return "ws://127.0.0.1:" + port + wsPath;
  } catch {
    return null;
  }
}

async function browserWs(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) });
  return (await res.json()).webSocketDebuggerUrl;
}

function chromeExe() {
  return [
    path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  ].find((p) => fs.existsSync(p));
}

// Our browser: if it doesn't answer, start it and wait until it publishes /json/version.
// --remote-debugging-port on a user data dir of OURS is allowed and asks for no consent.
async function ensureMangoChrome() {
  try {
    return await browserWs(PORT);
  } catch {}
  const exe = chromeExe();
  if (!exe) throw new Error(tr("Chrome non trovato nei percorsi standard", "Chrome not found in the standard locations"));
  fs.mkdirSync(PROFILE, { recursive: true });
  log(tr("  accendo il browser di mango-code sulla " + PORT + "...", "  starting the mango-code browser on " + PORT + "..."));
  spawn(exe, ["--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE], {
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      return await browserWs(PORT);
    } catch {}
  }
  throw new Error(tr("il browser di mango-code non ha pubblicato /json/version sulla " + PORT, "the mango-code browser didn't publish /json/version on " + PORT));
}

// Storage.getCookies returns fields that setCookies does NOT accept (size, session): passing them
// makes the whole call fail. Only what is a valid CookieParam is kept.
function toParam(c) {
  const p = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (c.sameSite) p.sameSite = c.sameSite;
  if (c.priority) p.priority = c.priority;
  if (c.sourceScheme) p.sourceScheme = c.sourceScheme;
  if (typeof c.sourcePort === "number" && c.sourcePort > 0) p.sourcePort = c.sourcePort;
  // No expires = session cookie, which is exactly what they were.
  if (!c.session && typeof c.expires === "number" && c.expires > 0) p.expires = c.expires;
  return p;
}

async function main() {
  if (CHECK) {
    const seeded = fs.existsSync(STAMP);
    log(tr("profilo di mango-code: ", "mango-code profile: ") + PROFILE);
    log(tr("seminato: ", "seeded: ") + (seeded ? tr("SI (", "YES (") + fs.readFileSync(STAMP, "utf8").trim() + ")" : "NO"));
    process.exit(seeded ? 0 : 1);
  }

  const realUrl = realEndpoint();
  if (!realUrl) {
    log(tr("Il debug remoto sul TUO Chrome non e' acceso: senza, non c'e' da dove leggere i cookie.", "Remote debugging on YOUR Chrome is not on: without it there is nowhere to read the cookies from."));
    log(tr("Accendilo da chrome://inspect/#remote-debugging (o lancia: mango-code -Chrome) e rilancia.", "Turn it on from chrome://inspect/#remote-debugging (or run: mango-code -Chrome) and run this again."));
    process.exit(1);
  }

  log(tr("  leggo i cookie dal tuo Chrome (Chrome chiedera' il consenso: e' l'ULTIMA volta)...", "  reading the cookies from your Chrome (Chrome will ask for consent: it's the LAST time)..."));
  const real = await cdp(realUrl);
  const { cookies } = await real.send("Storage.getCookies");
  real.close();
  const domains = new Set(cookies.map((c) => c.domain.replace(/^\./, "")));
  const httpOnlyCount = cookies.filter((c) => c.httpOnly).length;
  log(tr(
    "  letti " + cookies.length + " cookie su " + domains.size + " domini (" + httpOnlyCount + " httpOnly)",
    "  read " + cookies.length + " cookies on " + domains.size + " domains (" + httpOnlyCount + " httpOnly)",
  ));

  const mangoUrl = await ensureMangoChrome();
  const mango = await cdp(mangoUrl);
  await mango.send("Storage.setCookies", { cookies: cookies.map(toParam) });
  const after = (await mango.send("Storage.getCookies")).cookies;
  mango.close();

  const writtenDomains = new Set(after.map((c) => c.domain.replace(/^\./, ""))).size;
  log(tr(
    "  scritti nel profilo di mango-code: " + after.length + " cookie su " + writtenDomains + " domini",
    "  written to the mango-code profile: " + after.length + " cookies on " + writtenDomains + " domains",
  ));

  fs.writeFileSync(STAMP, new Date().toISOString() + "\n", "utf8");
  log("");
  if (after.length === 0) {
    log(tr("NESSUN cookie scritto: qualcosa non ha funzionato, il profilo resta sloggato.", "NO cookie written: something went wrong, the profile stays logged out."));
    process.exit(1);
  }
  log(tr("Fatto. Da adesso mango-code usa il browser sulla " + PORT + ", che e' suo:", "Done. From now on mango-code uses the browser on " + PORT + ", which is its own:"));
  log(tr("niente piu' banner di consenso, e i login ci sono gia'.", "no more consent banner, and the logins are already there."));
  log(tr("Rilancialo quando vuoi con: mango-code -Chrome -Sandbox", "Run it again whenever you want with: mango-code -Chrome -Sandbox"));
}

main().catch((e) => {
  log(tr("FALLITO: ", "FAILED: ") + e.message);
  process.exit(1);
});
