//! The phone's ports: the checks on every request and the streaming forwarding to the agent's server (main port) or to the
//! page the computer's browser panel shows (preview port, `site.rs`).
//!
//! Order of the checks: the requested address (`Host`) must be numeric, otherwise `403`; if there is an `Origin` it
//! must be `http://<Host>`, otherwise `403`; `/phone` is the entry with the key; every other request without a valid
//! session `401`, except the app's manifest and icons (`PUBLIC_FILES`), which the system reads without the cookie; methods
//! other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` `405`; the routes that only serve
//! the app on the PC (`PC_ONLY`) `403`; a chunked body (`Transfer-Encoding`) `400`. After these, `/phone/report` is
//! answered here by the app's `Reports` (`report`), `/phone/preview` and `/phone/file` by `site.rs`; everything else is forwarded.
//! The preview port has the same checks, no entry and no public files: it needs the session for everything.
//!
//! The forwarding goes to `127.0.0.1:<agent port>` with the agent's `Host` and, if there was one, `Origin` (to the
//! agent it is its own web UI) and without `Cookie`, `Referer`, `Authorization` or the proxy headers. To a page of the
//! computer it goes the same way, to its own loopback address, with the page's cookies (not the phone's session); the HTML of
//! the page the panel shows, when a browser opens it, is read whole to put a script in it (`with_script`); a call a page makes
//! through the script carries the `Origin` of the page the panel shows, as on the computer (`Upstream::call`). One request per
//! connection (`Connection: close` on both sides): the reply returns as it arrives, piece by piece, so the events
//! (`GET /event`) don't wait. An `Upgrade` (a WebSocket) passes both ways.

use crate::{site, Inner};
use anyhow::{bail, Context, Result};
use mango_common::tr;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const COOKIE: &str = "mango_phone";
const MAX_HEAD: usize = 64 * 1024;
/// The time to send the head and the body: a connection that sends nothing doesn't hold a thread forever.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The time to send the head in all, however slowly it comes.
const HEAD_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(2) } else { Duration::from_secs(10) };
/// Connections open at once, both ports: past this a new one is closed unanswered. A phone needs a handful.
pub(crate) const MAX_CONNECTIONS: usize = 64;
/// The route answered here, not by the agent: the problem report (see `Reports`).
const REPORT: &str = "/phone/report";
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// Agent routes the web UI doesn't use: the app calls them (`reload`, after it rewrote the agent's configuration) and the
/// attached apps (`extra-folders`). The model, the models and the computer (`/mango/state`, `/mango/models`,
/// `/mango/computer`, `/mango/model/*`) pass: from the phone too the model is chosen. So do the pictures
/// (`/mango/image/*`). The programs the agent left running
/// (`processes`, with their "Stop") are shown and stopped on the PC only.
const PC_ONLY: &[&str] = &["/mango/reload", "/mango/quiet", "/mango/extra-folders", "/mango/processes"];
/// Static files of the web UI that need no session: the app's manifest and icons are read by the system (the home screen, the
/// browser's tab), which does not send the cookie, and the page that asks for the key shows the icon. The agent serves them without
/// a password too, and they carry no data.
const PUBLIC_FILES: &[&str] = &[
    "/site.webmanifest",
    "/favicon-v3.svg",
    "/favicon-v3.ico",
    "/favicon-96x96-v3.png",
    "/apple-touch-icon-v3.png",
    "/web-app-manifest-192x192.png",
    "/web-app-manifest-512x512.png",
];
/// Headers that don't pass to the agent (`Host`, `Origin`, `Connection` and `Content-Length` are redone).
const STRIPPED: &[&str] = &[
    "host", "origin", "referer", "cookie", "authorization", "connection", "keep-alive", "upgrade", "te", "trailer",
    "transfer-encoding", "content-length", "proxy-connection", "proxy-authorization", "forwarded", "x-forwarded-for",
    "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
];

/// Which of the two ports a connection came to.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    /// The web UI and the agent.
    Main,
    /// The pages of the computer's browser panel.
    Preview,
}

/// The open ports: one thread accepts the connections on all of them until `close` stops it, and every few seconds it
/// follows the addresses (`Inner::reconcile`).
pub(crate) struct Listener {
    stopped: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl Listener {
    /// Closes the ports; when it returns they are closed.
    pub(crate) fn close(self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.thread.join();
    }
}

/// How often the addresses are read again: the Wi-Fi changes them.
const RECHECK: Duration = Duration::from_secs(3);

/// A port with the listeners it has now, one for each address.
pub(crate) struct Port {
    role: Role,
    pub(crate) number: u16,
    pub(crate) listeners: Vec<(Ipv4Addr, TcpListener)>,
}

/// Opens both ports on the addresses the links show, and keeps them there.
pub(crate) fn listen(d: Arc<Inner>) -> Result<Listener> {
    let mut ports = [
        Port { role: Role::Main, number: d.port, listeners: Vec::new() },
        Port { role: Role::Preview, number: d.preview_port, listeners: Vec::new() },
    ];
    d.reconcile(&mut ports);
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let thread = std::thread::Builder::new().name("phone-port".into()).spawn(move || run(&d, ports, &flag))?;
    Ok(Listener { stopped, thread })
}

fn run(d: &Arc<Inner>, mut ports: [Port; 2], stopped: &AtomicBool) {
    let mut checked = Instant::now();
    while !stopped.load(Ordering::SeqCst) {
        if checked.elapsed() >= RECHECK {
            d.reconcile(&mut ports);
            checked = Instant::now();
        }
        let mut idle = true;
        for port in &ports {
            for (_, l) in &port.listeners {
                let Ok((c, _)) = l.accept() else { continue };
                idle = false;
                // On Windows the connection inherits the port's «non-blocking». It is registered before passing it to its
                // thread: whoever turns off while the port closes finds it already among those to close.
                if c.set_nonblocking(false).is_err() || d.connections.lock().unwrap().len() >= MAX_CONNECTIONS {
                    continue;
                }
                let id = d.track(&c);
                let (d, role) = (d.clone(), port.role);
                let _ = std::thread::Builder::new().name("phone-request".into()).spawn(move || {
                    handle(&c, &d, role);
                    d.untrack(id);
                });
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

pub(crate) struct Head {
    pub(crate) method: String,
    pub(crate) url: String,
    headers: Vec<(String, String)>,
}

impl Head {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub(crate) fn path(&self) -> &str {
        self.url.split('?').next().unwrap_or("")
    }

    /// The same request for another address on the server it is forwarded to.
    pub(crate) fn with_url(&self, url: String) -> Head {
        Head { method: self.method.clone(), url, headers: self.headers.clone() }
    }

    /// The browser is opening a page or a frame, not fetching something for a page: `Sec-Fetch-Dest` says so. A browser
    /// that does not send it is taken at its `Accept`.
    pub(crate) fn is_document(&self) -> bool {
        match self.header("sec-fetch-dest") {
            Some(dest) => matches!(dest, "document" | "iframe" | "frame"),
            None => self.header("accept").is_some_and(|a| a.contains("text/html")),
        }
    }

    fn cookie(&self) -> Option<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|c| c.trim().split_once('='))
            .find(|(k, _)| *k == COOKIE)
            .map(|(_, v)| v)
    }
}

/// Reads the request head; also returns the body bytes that have already arrived.
pub(crate) fn read_head(mut c: &TcpStream) -> Result<(Head, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let deadline = Instant::now() + HEAD_TIMEOUT;
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            bail!("{}", tr!("testata troppo grande", "head too large"));
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            bail!("{}", tr!("testata troppo lenta", "head too slow"));
        }
        c.set_read_timeout(Some(left.min(REQUEST_TIMEOUT)))?;
        let n = c.read(&mut chunk)?;
        if n == 0 {
            bail!("{}", tr!("connessione chiusa nella testata", "connection closed in the head"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    c.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    let text = std::str::from_utf8(&buf[..end]).with_context(|| tr!("testata non UTF-8", "head is not UTF-8"))?;
    // Only "\r\n" ends a line: any other break or a NUL would become lines of the request to the agent.
    if text.replace("\r\n", "").contains(['\r', '\n', '\0']) {
        bail!("{}", tr!("caratteri di controllo nella testata", "control characters in the head"));
    }
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (Some(method), Some(url), Some(version), None) = (first.next(), first.next(), first.next(), first.next()) else {
        bail!("{}", tr!("prima riga malformata", "malformed first line"));
    };
    if !version.starts_with("HTTP/1.") || !url.starts_with('/') {
        bail!("{}", tr!("richiesta non ammessa", "request not allowed"));
    }
    let headers = lines
        .map(|r| r.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).with_context(|| tr!("intestazione malformata", "malformed header")))
        .collect::<Result<Vec<_>>>()?;
    Ok((Head { method: method.to_string(), url: url.to_string(), headers }, buf[end + 4..].to_vec()))
}

fn handle(c: &TcpStream, d: &Inner, role: Role) {
    let _ = c.set_write_timeout(Some(REQUEST_TIMEOUT));
    let address = c.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let (head, rest) = match read_head(c) {
        Ok(x) => x,
        Err(e) => return respond(c, 400, "application/json", &error(&format!("{e:#}")), &[]),
    };
    // `reason` is the English text for the log; `message` the one the phone's user reads, in the current language.
    let refuse = |status: u16, reason: &str, message: String| {
        d.log(serde_json::json!({ "event": "refused", "outcome": status, "reason": reason, "address": address, "path": head.path() }));
        respond(c, status, "application/json", &error(&message), &[]);
    };
    let Some(host) = head.header("host").filter(|h| numeric(h)) else {
        return refuse(
            403,
            "the address must be numeric (http://192.168.x.y:port or http://100.x.y.z:port)",
            tr!(
                "l'indirizzo dev'essere numerico (http://192.168.x.y:porta o http://100.x.y.z:porta)",
                "the address must be numeric (http://192.168.x.y:port or http://100.x.y.z:port)"
            ),
        );
    };
    if head.header("origin").is_some_and(|o| o != format!("http://{host}")) {
        return refuse(403, "request from a foreign web page", tr!("richiesta da una pagina web estranea", "request from a foreign web page"));
    }
    if role == Role::Main && head.path() == "/phone" {
        return enter(c, d, &head, &address);
    }
    let public = role == Role::Main && matches!(head.method.as_str(), "GET" | "HEAD") && PUBLIC_FILES.contains(&head.path());
    if !public && !head.cookie().is_some_and(|v| d.valid_session(v)) {
        d.log(serde_json::json!({ "event": "refused", "outcome": 401, "reason": "no session", "address": address, "path": head.path() }));
        return no_session(c, &head, role);
    }
    if !METHODS.contains(&head.method.as_str()) {
        return refuse(405, "method not allowed", tr!("metodo non ammesso", "method not allowed"));
    }
    if role == Role::Main && pc_only(head.path()) {
        return refuse(403, "this route is only for the app on the computer", tr!("questa rotta è solo per l'app sul computer", "this route is only for the app on the computer"));
    }
    if head.header("transfer-encoding").is_some() {
        return refuse(
            400,
            "a chunked body (Transfer-Encoding) is not supported: Content-Length is required",
            tr!(
                "il corpo a blocchi (Transfer-Encoding) non è supportato: serve Content-Length",
                "a chunked body (Transfer-Encoding) is not supported: Content-Length is required"
            ),
        );
    }
    let Ok(length) = head.header("content-length").map_or(Ok(0), |v| v.parse::<u64>()) else {
        return refuse(400, "invalid Content-Length", tr!("Content-Length non valido", "invalid Content-Length"));
    };
    if role == Role::Preview {
        return site::serve(c, d, &head, rest, length);
    }
    if head.path() == REPORT {
        return report(c, d, &head, rest, length, &address);
    }
    if site::is_preview_route(head.path()) {
        return site::preview_route(c, d, &head, rest, length, &address);
    }
    if site::is_file_route(head.path()) {
        return site::file_route(c, d, &head, &address);
    }
    if let Err(e) = relay(c, &head, rest, length, &Upstream::agent(d.agent_port.load(Ordering::SeqCst), frame_src(&head, d))) {
        respond(c, 502, "application/json", &error(&tr!("l'agente non risponde: {e:#}", "the agent does not answer: {e:#}")), &[]);
    }
}

/// The preview port as the phone reaches it: its own address (the numeric `Host` it asked for) with the second port.
fn frame_src(head: &Head, d: &Inner) -> Option<String> {
    let ip = head.header("host")?.rsplit_once(':').map_or_else(|| head.header("host"), |(ip, _)| Some(ip))?;
    Some(format!("http://{ip}:{}", d.preview_port))
}

/// The body of a request, `length` bytes (some already read with the head, in `rest`), or `None` if it has no length,
/// is longer than `max`, or the phone does not finish it.
pub(crate) fn body(c: &TcpStream, mut rest: Vec<u8>, length: u64, max: u64) -> Option<Vec<u8>> {
    if length > max {
        return None;
    }
    rest.truncate(length as usize);
    let missing = length - rest.len() as u64;
    c.take(missing).read_to_end(&mut rest).ok()?;
    (rest.len() as u64 == length).then_some(rest)
}

/// `/phone/report`: `GET` says what a report may carry, `POST` hands one to the app. The body must have a length and
/// stay within what the app allows; what comes back is the app's reply or its status and sentence. The log has the
/// outcome and never the content.
fn report(c: &TcpStream, d: &Inner, head: &Head, rest: Vec<u8>, length: u64, address: &str) {
    let log = |outcome: u16| d.log(serde_json::json!({ "event": "report", "outcome": outcome, "address": address, "bytes": length }));
    let fail = |status: u16, message: &str| {
        log(status);
        respond(c, status, "application/json", &error(message), &[]);
    };
    match head.method.as_str() {
        "GET" => respond(c, 200, "application/json", &d.reports.info().to_string(), &["Cache-Control: no-store"]),
        "POST" => {
            if head.header("content-length").is_none() {
                return fail(400, &tr!("serve Content-Length", "Content-Length is required"));
            }
            if length > d.reports.max_body() {
                return fail(413, &tr!("la segnalazione è troppo grande", "the report is too large"));
            }
            let Some(body) = body(c, rest, length, length) else {
                return fail(400, &tr!("segnalazione incompleta", "incomplete report"));
            };
            match d.reports.submit(body) {
                Ok(reply) => {
                    log(200);
                    respond(c, 200, "application/json", &reply.to_string(), &["Cache-Control: no-store"]);
                }
                Err((status, message)) => fail(status, &message),
            }
        }
        _ => fail(405, &tr!("metodo non ammesso", "method not allowed")),
    }
}

/// `GET /phone?key=…`: with the right key a new session in the cookie and off to the web UI.
fn enter(c: &TcpStream, d: &Inner, head: &Head, address: &str) {
    if head.method != "GET" {
        return respond(c, 405, "application/json", &error(&tr!("metodo non ammesso", "method not allowed")), &[]);
    }
    let key = head.url.split_once('?').and_then(|(_, q)| q.split('&').find_map(|p| p.strip_prefix("key="))).unwrap_or("");
    if !d.right_key(key) {
        d.log(serde_json::json!({ "event": "refused", "outcome": 401, "reason": "wrong or missing key", "address": address }));
        return respond(c, 401, "text/html; charset=utf-8", &key_page(!key.is_empty()), &["Cache-Control: no-store"]);
    }
    match d.new_session() {
        Ok(value) => {
            d.log(serde_json::json!({ "event": "entry", "address": address }));
            let cookie = format!("Set-Cookie: {COOKIE}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", crate::SESSION_DURATION_S);
            respond(c, 303, "text/plain; charset=utf-8", "", &["Location: /", &cookie, "Cache-Control: no-store"]);
        }
        Err(e) => respond(c, 500, "application/json", &error(&tr!("sessione non salvata: {e:#}", "session not saved: {e:#}")), &[]),
    }
}

/// Without a session: a sentence for whoever opens a page from the browser, JSON for the rest.
fn no_session(c: &TcpStream, head: &Head, role: Role) {
    if role == Role::Main && head.header("accept").is_some_and(|a| a.contains("text/html")) {
        return respond(c, 401, "text/html; charset=utf-8", &key_page(false), &["Cache-Control: no-store"]);
    }
    respond(
        c,
        401,
        "application/json",
        &error(&tr!("serve il link con la chiave, dall'app sul computer", "the link with the key is needed, from the app on the computer")),
        &[],
    );
}

/// The page of whoever arrives without a session (or with a key that is no longer good): the app's dark look, the icon, how to get in
/// and a field where the link or the key can be pasted (a phone app installed on the home screen cannot open a link).
/// The page for whoever arrives without a session, or with a key that is no longer good: the app's dark look, the icon, how to get in
/// and a field where the link or the key can be pasted (an app installed on the home screen cannot open a link).
const KEY_PAGE: &str = include_str!("key.html");

fn key_page(wrong: bool) -> String {
    let notice = if wrong {
        let text = tr!(
            "Questa chiave non vale più: forse ne è stata creata una nuova. Apri il link aggiornato.",
            "This key is no longer valid: a new one may have been made. Open the updated link."
        );
        format!("<p class=\"notice\">{text}</p>")
    } else {
        String::new()
    };
    let steps = tr!(
        "Sul computer apri Mango Code, poi Impostazioni e «Dal telefono»: lì trovi il codice QR e il link. Inquadra il codice con la fotocamera oppure apri il link da questo telefono.",
        "On the computer open Mango Code, then Settings and «From your phone»: there you find the QR code and the link. Scan the code with the camera or open the link on this phone."
    );
    KEY_PAGE
        .replace("{lang}", mango_common::i18n::lang().code())
        .replace("{title}", &tr!("Mango Code dal telefono", "Mango Code from your phone"))
        .replace("{steps}", &steps)
        .replace("{notice}", &notice)
        .replace("{label}", &tr!("Oppure incolla qui il link", "Or paste the link here"))
        .replace("{button}", &tr!("Entra", "Get in"))
}

/// An IPv4 address written in numbers, with the port or without.
fn numeric(host: &str) -> bool {
    let ip = host.rsplit_once(':').map_or(host, |(ip, port)| if port.parse::<u16>().is_ok() { ip } else { "" });
    ip.parse::<Ipv4Addr>().is_ok()
}

/// The path is compared decoded, lowercase and without double slashes: `/mango//Reload` and `/mango/%72eload` are the
/// same route.
fn pc_only(path: &str) -> bool {
    let mut p = decode(path).to_ascii_lowercase();
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    let p = p.trim_end_matches('/');
    PC_ONLY.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
}

pub(crate) fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match hex {
            Some(x) => {
                out.push(x);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where a request is forwarded: always an address of this computer's loopback, built here from a port, never from what
/// the phone writes.
pub(crate) struct Upstream {
    addrs: Vec<SocketAddr>,
    /// The `Host` (and, for an `Origin`, the origin) the server is given: its own.
    host: String,
    /// A page of the computer rather than the agent: the page's own cookies go to it and its redirects are brought back.
    site: bool,
    /// The page the panel shows, whose HTML carries the script that sends its calls to the computer's addresses to the phone
    /// port (`site::SCRIPT_TAG`).
    page: bool,
    /// A call a page makes to a server of the computer, through `site::LOOPBACK`: its redirects stay in the route.
    call: bool,
    /// The `Origin` the server is given in place of the phone's: the one the computer's browser would send. For a call, the
    /// origin of the page the panel shows; none for a page that is a file, and the phone's goes on.
    origin: Option<String>,
    /// What the computer's browser would say in `Sec-Fetch-Site` for this call: the phone's browser says `same-origin`,
    /// because it only talks to the phone's port.
    fetch_site: Option<&'static str>,
    /// The origin the web UI may show in a frame, added to its content policy: the preview port of the phone's own address.
    frame: Option<String>,
}

impl Upstream {
    pub(crate) fn agent(port: u16, frame: Option<String>) -> Upstream {
        Upstream { addrs: vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)], host: format!("127.0.0.1:{port}"), site: false, page: false, call: false, origin: Some(format!("http://127.0.0.1:{port}")), fetch_site: None, frame }
    }

    /// `localhost` is tried on both loopback addresses (a server may listen on only one); no name is ever resolved.
    fn site(host: &str, port: u16) -> Upstream {
        let mut addrs = vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)];
        if host == "localhost" {
            addrs.push(SocketAddr::new(Ipv6Addr::LOCALHOST.into(), port));
        }
        Upstream { addrs, host: format!("{host}:{port}"), site: true, page: false, call: false, origin: Some(format!("http://{host}:{port}")), fetch_site: None, frame: None }
    }

    /// The page the panel shows: a site whose HTML is given the script.
    pub(crate) fn page(host: &str, port: u16) -> Upstream {
        Upstream { page: true, ..Upstream::site(host, port) }
    }

    /// A call of a page to a server of the computer; `fetch_site` is how that server sees the page's place, and `page_origin`
    /// is the page's origin on the computer (none for a file).
    pub(crate) fn call(host: &str, port: u16, fetch_site: &'static str, page_origin: Option<String>) -> Upstream {
        Upstream { call: true, origin: page_origin, fetch_site: Some(fetch_site), ..Upstream::site(host, port) }
    }

    fn connect(&self) -> Result<TcpStream> {
        let mut last = None;
        for a in &self.addrs {
            debug_assert!(a.ip().is_loopback());
            match TcpStream::connect_timeout(a, Duration::from_secs(5)) {
                Ok(s) => return Ok(s),
                Err(e) => last = Some(e),
            }
        }
        Err(last.map_or_else(|| anyhow::anyhow!("no address"), anyhow::Error::from)).with_context(|| tr!("connessione a {}", "connection to {}", self.host))
    }
}

/// The request's cookies without the phone's session, `None` if nothing else is left: a page gets its own cookies,
/// never the key to the computer.
fn without_session(cookie: &str) -> Option<String> {
    let rest: Vec<&str> = cookie.split(';').map(str::trim).filter(|c| !c.is_empty() && c.split_once('=').map(|(k, _)| k) != Some(COOKIE)).collect();
    (!rest.is_empty()).then(|| rest.join("; "))
}

pub(crate) fn relay(c: &TcpStream, head: &Head, rest: Vec<u8>, length: u64, up: &Upstream) -> Result<()> {
    let host = up.host.as_str();
    let mut agent = up.connect()?;
    agent.set_nodelay(true).ok();
    let upgrade = head.header("upgrade").filter(|_| {
        head.header("connection").is_some_and(|v| v.split(',').any(|x| x.trim().eq_ignore_ascii_case("upgrade")))
    });
    let mut h = format!("{} {} HTTP/1.1\r\nHost: {host}\r\n", head.method, head.url);
    match upgrade {
        Some(u) => h.push_str(&format!("Connection: Upgrade\r\nUpgrade: {u}\r\n")),
        None => h.push_str("Connection: close\r\n"),
    }
    if let Some(origin) = head.header("origin") {
        h.push_str(&format!("Origin: {}\r\n", up.origin.as_deref().unwrap_or(origin)));
    }
    if length > 0 {
        h.push_str(&format!("Content-Length: {length}\r\n"));
    }
    // A page is read to put the script in it, so it is asked for as it is, not compressed; its files keep their compression.
    let document = up.page && head.is_document();
    for (k, v) in &head.headers {
        if up.site && k.eq_ignore_ascii_case("cookie") {
            if let Some(cookie) = without_session(v) {
                h.push_str(&format!("Cookie: {cookie}\r\n"));
            }
        } else if document && k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        } else if let (true, Some(site)) = (k.eq_ignore_ascii_case("sec-fetch-site"), up.fetch_site) {
            h.push_str(&format!("Sec-Fetch-Site: {site}\r\n"));
        } else if !STRIPPED.contains(&k.to_ascii_lowercase().as_str()) {
            h.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    if document {
        h.push_str("Accept-Encoding: identity\r\n");
    }
    h.push_str("\r\n");
    agent.write_all(h.as_bytes())?;
    // The body: what was already read with the head, then the rest from the phone. Bytes beyond `Content-Length` don't pass.
    let already = rest.len().min(length as usize);
    agent.write_all(&rest[..already])?;
    std::io::copy(&mut c.take(length - already as u64), &mut agent)?;
    let _ = c.set_read_timeout(None);

    let mut to_phone = c.try_clone()?;
    if upgrade.is_some() {
        // After the reply the two ends talk freely: one thread per direction.
        let mut from_phone = c.try_clone()?;
        let mut to_agent = agent.try_clone()?;
        if rest.len() > already {
            to_agent.write_all(&rest[already..])?;
        }
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut from_phone, &mut to_agent);
            let _ = to_agent.shutdown(Shutdown::Both);
        });
        let _ = std::io::copy(&mut agent, &mut to_phone);
        let _ = c.shutdown(Shutdown::Both);
        return Ok(());
    }

    // The watchdog: after the request the phone sends nothing more; if the read returns it has closed (a closed page,
    // the event stream left), and the connection with the agent is closed too.
    let guard = c.try_clone()?;
    let agent_guard = agent.try_clone()?;
    std::thread::spawn(move || {
        let mut b = [0u8; 1];
        if let Ok(0) | Err(_) = guard.peek(&mut b) {
            let _ = agent_guard.shutdown(Shutdown::Both);
        }
    });

    let mut buf = vec![0u8; 16 * 1024];
    let mut reply_head = Vec::new();
    let mut written = false;
    loop {
        let n = match agent.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if !written && reply_head.is_empty() => return Err(e.into()),
            Err(_) => break,
        };
        let chunk = if written {
            buf[..n].to_vec()
        } else {
            reply_head.extend_from_slice(&buf[..n]);
            match with_connection_close(&reply_head, up) {
                Some(p) if document && head.method != "HEAD" => with_script(p, &mut agent),
                Some(p) => p,
                None => continue,
            }
        };
        written = true;
        if to_phone.write_all(&chunk).and_then(|_| to_phone.flush()).is_err() {
            break;
        }
    }
    let _ = c.shutdown(Shutdown::Both);
    let _ = agent.shutdown(Shutdown::Both);
    if !written && reply_head.is_empty() {
        bail!("{}", tr!("l'agente ha chiuso senza rispondere", "the agent closed without answering"));
    }
    Ok(())
}

/// The reply head with `Connection: close` in place of its connection headers and, for a page (HTML), `Cache-Control: no-cache`:
/// the phone asks again at every opening, so after an update it never shows the old version (the files with a hash in the name
/// are other addresses and stay in its cache). For a page of the computer a redirect is brought back to the phone's port
/// (`relocated`). For a page with a content policy, `frame` is added to what it may show in a frame, with `blob:` (the PDF
/// the page itself holds in memory). `None` until the head is whole; beyond `MAX_HEAD` it passes as it is.
fn with_connection_close(t: &[u8], up: &Upstream) -> Option<Vec<u8>> {
    let Some(end) = t.windows(4).position(|w| w == b"\r\n\r\n") else {
        return (t.len() > MAX_HEAD).then(|| t.to_vec());
    };
    let text = String::from_utf8_lossy(&t[..end]);
    let page = text.split("\r\n").any(|r| {
        let r = r.to_ascii_lowercase();
        r.strip_prefix("content-type:").is_some_and(|v| v.trim_start().starts_with("text/html"))
    });
    let frame = up.frame.as_deref();
    let mut out: Vec<u8> = text
        .split("\r\n")
        .filter(|r| {
            let lower = r.to_ascii_lowercase();
            !lower.starts_with("connection:") && !lower.starts_with("keep-alive:") && !(page && lower.starts_with("cache-control:")) && !(up.site && sets_session(r))
        })
        .map(|r| match r.split_once(':') {
            Some((name, value)) if page && frame.is_some() && name.eq_ignore_ascii_case("content-security-policy") => {
                format!("{name}: {}; frame-src 'self' blob: {}", value.trim().trim_end_matches(';'), frame.unwrap_or_default())
            }
            Some((name, value)) if up.site && name.eq_ignore_ascii_case("location") => {
                relocated(value.trim(), up).map_or_else(|| r.to_string(), |path| format!("{name}: {path}"))
            }
            _ => r.to_string(),
        })
        .flat_map(|r| [r.as_bytes(), b"\r\n"].concat())
        .collect();
    if page {
        out.extend_from_slice(b"Cache-Control: no-cache\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out.extend_from_slice(&t[end + 4..]);
    Some(out)
}

/// A `Set-Cookie` line for the phone's session cookie. Cookies belong to a host, not to a port, so a server of the computer
/// that sets it would replace the phone's session in the phone's browser.
fn sets_session(line: &str) -> bool {
    let value = line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie")).map(|(_, value)| value);
    value.is_some_and(|v| v.trim_start().split_once('=').is_some_and(|(name, _)| name == COOKIE))
}

/// Where a `Location` of a server of the computer leads on the phone's port, `None` if it stays as it is. A browser resolves
/// it against the phone's address, so an address of the computer would be the phone's own: the page's own address becomes
/// a path, any other address of the computer (`localhost` or `127.0.0.1`, any port) goes through `site::LOOPBACK`, and so
/// does a path in the reply to a call that came through it. Whatever else (another site, a relative reference) is not touched.
fn relocated(location: &str, up: &Upstream) -> Option<String> {
    let (target, fragment) = location.split_at(location.find('#').unwrap_or(location.len()));
    let route = |name: &str, port: u16, path: &str| format!("{}/{name}/{port}{path}{fragment}", site::LOOPBACK);
    if target.starts_with('/') && !target.starts_with("//") {
        let (name, port) = up.host.rsplit_once(':')?;
        return up.call.then(|| port.parse().ok().map(|port| route(name, port, target))).flatten();
    }
    let absolute = if target.starts_with("//") { format!("http:{target}") } else { target.to_string() };
    let (host, to, path) = site::loopback_page(&absolute)?;
    if up.page && format!("{host}:{to}") == up.host {
        return Some(format!("{path}{fragment}"));
    }
    Some(route(host, to, &path))
}

/// The most of an HTML page that is held to put the script in it: a bigger one passes as it is.
pub(crate) const MAX_PAGE: usize = 4 * 1024 * 1024;
/// The most time a page is held for: a page that has not ended by then (a stream, a slow server) passes as it is.
const PAGE_WAIT: Duration = if cfg!(test) { Duration::from_millis(800) } else { Duration::from_secs(3) };

/// The start of a reply (`reply`: its head as `with_connection_close` left it and the body bytes that came with it) with
/// `site::SCRIPT_TAG` in the page, if it is an HTML page that can be read: UTF-8 (or a byte-compatible set), not compressed,
/// whole within `PAGE_WAIT` and not bigger than `MAX_PAGE`. The page is then one piece, with its `Content-Length`. Whatever
/// else it is, the reply is left as it came, what was read of it to find out goes with it, and the rest follows as it arrives.
fn with_script(reply: Vec<u8>, agent: &mut TcpStream) -> Vec<u8> {
    let Some(end) = reply.windows(4).position(|w| w == b"\r\n\r\n") else { return reply };
    let text = String::from_utf8_lossy(&reply[..end]).into_owned();
    let mut lines = text.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
    let header = |name: &str| lines.clone().find_map(|r| r.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()));
    let content_type = header("content-type").map(|v| v.to_ascii_lowercase());
    let html = content_type.as_deref().is_some_and(|v| v.starts_with("text/html"));
    let plain = header("content-encoding").is_none_or(|v| v.eq_ignore_ascii_case("identity"));
    let download = header("content-disposition").is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("attachment"));
    // The script is ASCII: it fits a page in UTF-8 and nothing else (UTF-16 would be torn).
    let utf8 = content_type.as_deref().and_then(|v| v.split(';').skip(1).find_map(|p| p.trim().strip_prefix("charset="))).is_none_or(|c| matches!(c.trim_matches('"'), "utf-8" | "utf8"));
    if !html || !plain || download || !utf8 || status < 200 || matches!(status, 204 | 205 | 206 | 304) {
        return reply;
    }
    let chunked = header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let length = header("content-length").and_then(|v| v.parse::<usize>().ok());

    let mut raw = reply[end + 4..].to_vec();
    let deadline = Instant::now() + PAGE_WAIT;
    let mut buf = vec![0u8; 16 * 1024];
    let whole = loop {
        if length.is_some_and(|n| raw.len() >= n) || (chunked && raw.ends_with(b"0\r\n\r\n") && dechunk(&raw).is_some()) {
            break true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if raw.len() > MAX_PAGE || left.is_zero() || agent.set_read_timeout(Some(left)).is_err() {
            break false;
        }
        match agent.read(&mut buf) {
            Ok(0) => break true,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(_) => break false,
        }
    };
    let _ = agent.set_read_timeout(None);
    let unchanged = |raw: &[u8]| [&reply[..end + 4], raw].concat();
    if !whole || raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]) {
        return unchanged(&raw);
    }
    let page = if chunked {
        dechunk(&raw)
    } else {
        match length {
            Some(n) => raw.get(..n).map(<[u8]>::to_vec),
            None => Some(raw.clone()),
        }
    };
    let Some(page) = page else { return unchanged(&raw) };
    let at = site::script_position(&page);
    let mut out: Vec<u8> = text
        .split("\r\n")
        .filter(|r| {
            let r = r.to_ascii_lowercase();
            !r.starts_with("content-length:") && !r.starts_with("transfer-encoding:")
        })
        .flat_map(|r| [r.as_bytes(), b"\r\n"].concat())
        .collect();
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", page.len() + site::SCRIPT_TAG.len()).as_bytes());
    out.extend_from_slice(&page[..at]);
    out.extend_from_slice(site::SCRIPT_TAG.as_bytes());
    out.extend_from_slice(&page[at..]);
    out
}

/// The body of a chunked reply put together; `None` if it is not whole or not well formed.
fn dechunk(raw: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    let mut rest = raw;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size = std::str::from_utf8(&rest[..line_end]).ok()?.split(';').next()?.trim();
        let size = usize::from_str_radix(size, 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(body);
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size..)?.strip_prefix(b"\r\n")?;
    }
}

pub(crate) fn error(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

pub(crate) fn respond(c: &TcpStream, status: u16, content_type: &str, body: &str, extra: &[&str]) {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        reason(status),
        body.len()
    );
    for a in extra {
        head.push_str(a);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    let mut c = c;
    let _ = c.write_all(head.as_bytes()).and_then(|_| c.write_all(body.as_bytes())).and_then(|_| c.flush());
    finish(c);
}

/// After the last byte of a reply: the phone is given time to read before the socket disappears.
pub(crate) fn finish(mut c: &TcpStream) {
    let _ = c.shutdown(Shutdown::Write);
    let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
    let mut discard = [0u8; 256];
    while matches!(c.read(&mut discard), Ok(n) if n > 0) {}
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        303 => "See Other",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        422 => "Unprocessable Content",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_numeric_addresses() {
        for yes in ["192.168.1.20:47096", "100.101.102.103:47096", "127.0.0.1:47096", "10.0.0.2"] {
            assert!(numeric(yes), "{yes}");
        }
        for no in ["mango.example:47096", "localhost:47096", "evil.com", "192.168.1.20.nip.io:47096", "[::1]:47096", "", "1.2.3.4:port", "1.2.3:80"] {
            assert!(!numeric(no), "{no}");
        }
    }

    #[test]
    fn the_pc_only_routes_cannot_be_got_around() {
        for p in ["/mango/reload", "/mango/quiet", "/mango/extra-folders", "/mango//reload", "/MANGO/Extra-Folders", "/mango/%72eload", "/mango/extra-folders/", "//mango/reload", "/mango/processes", "/mango/processes/stop"] {
            assert!(pc_only(p), "{p}");
        }
        for p in [
            "/mango/engine/speed",
            "/mango/settings",
            "/session",
            "/mango/reloadx",
            "/event",
            "/mango/state",
            "/mango/models",
            "/mango/computer",
            "/mango/model/use",
            "/mango/model/retry",
        ] {
            assert!(!pc_only(p), "{p}");
        }
    }

    #[test]
    fn the_reply_closes_the_connection() {
        let r = with_connection_close(b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nX: y\r\n\r\nbody", &Upstream::agent(4096, None)).unwrap();
        assert_eq!(String::from_utf8(r).unwrap(), "HTTP/1.1 200 OK\r\nX: y\r\nConnection: close\r\n\r\nbody");
        assert!(with_connection_close(b"HTTP/1.1 200 OK\r\nX: y\r\n", &Upstream::agent(4096, None)).is_none());
    }

    #[test]
    fn a_page_is_asked_for_again_every_time_and_a_file_keeps_its_own_cache_rule() {
        let page = with_connection_close(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: max-age=600\r\n\r\n<html>", &Upstream::agent(4096, None)).unwrap();
        assert_eq!(
            String::from_utf8(page).unwrap(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n<html>"
        );
        let file = with_connection_close(b"HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncache-control: max-age=600\r\n\r\nx", &Upstream::agent(4096, None)).unwrap();
        assert_eq!(
            String::from_utf8(file).unwrap(),
            "HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncache-control: max-age=600\r\nConnection: close\r\n\r\nx"
        );
    }

    #[test]
    fn a_page_gets_its_own_cookies_and_never_the_phones_session() {
        assert_eq!(without_session("theme=dark; mango_phone=abc; lang=it").as_deref(), Some("theme=dark; lang=it"));
        assert_eq!(without_session("mango_phone=abc"), None);
        assert_eq!(without_session("a=1").as_deref(), Some("a=1"));
        // a cookie that only ends like the session's is not it
        assert_eq!(without_session("x_mango_phone=1; mango_phone2=2").as_deref(), Some("x_mango_phone=1; mango_phone2=2"));
    }

    #[test]
    fn a_redirect_to_the_pages_own_address_becomes_a_path_and_any_other_address_of_the_computer_goes_through_the_route() {
        let reply = |up: &Upstream, location: &str| {
            let head = format!("HTTP/1.1 302 Found\r\nlocation: {location}\r\nX: y\r\n\r\n");
            String::from_utf8(with_connection_close(head.as_bytes(), up).unwrap()).unwrap()
        };
        let page = Upstream::page("localhost", 3000);
        assert!(reply(&page, "http://localhost:3000/a?b=1").contains("\r\nlocation: /a?b=1\r\n"));
        assert!(reply(&page, "http://localhost:3000").contains("\r\nlocation: /\r\n"));
        assert!(reply(&page, "http://localhost:3000/a#top").contains("\r\nlocation: /a#top\r\n"));
        // the computer's other addresses, a similar port and the other name of the same port are other servers
        assert!(reply(&page, "http://localhost:30001/a").contains("\r\nlocation: /__mango_loopback/localhost/30001/a\r\n"));
        assert!(reply(&page, "http://127.0.0.1:3000/a").contains("\r\nlocation: /__mango_loopback/127.0.0.1/3000/a\r\n"));
        // another site, a relative reference and https are left to the browser
        for same in ["http://example.com/", "/a", "a", "https://localhost:3000/", "http://localhost.evil.com:3000/"] {
            let r = reply(&page, same);
            assert!(r.contains(&format!("\r\nlocation: {same}\r\n")), "{same}: {r}");
        }
        // the agent's replies are never touched
        assert!(reply(&Upstream::agent(4096, None), "http://localhost:4000/a").contains("\r\nlocation: http://localhost:4000/a\r\n"));

        let call = Upstream::call("127.0.0.1", 4000, "cross-site", None);
        assert!(reply(&call, "http://127.0.0.1:4000/api/").contains("\r\nlocation: /__mango_loopback/127.0.0.1/4000/api/\r\n"));
        assert!(reply(&call, "/login").contains("\r\nlocation: /__mango_loopback/127.0.0.1/4000/login\r\n"));
        assert!(reply(&call, "//localhost:8080/x?y=1#z").contains("\r\nlocation: /__mango_loopback/localhost/8080/x?y=1#z\r\n"));
        assert!(reply(&call, "login").contains("\r\nlocation: login\r\n"));
    }

    #[test]
    fn a_forwarding_never_leaves_the_loopback() {
        for up in [Upstream::agent(4096, None), Upstream::page("localhost", 3000), Upstream::call("127.0.0.1", 3000, "cross-site", None)] {
            assert!(!up.addrs.is_empty() && up.addrs.iter().all(|a| a.ip().is_loopback()), "{}", up.host);
        }
    }

    #[test]
    fn the_web_ui_may_frame_the_preview_port_and_only_it() {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; img-src data:\r\n\r\n<html>";
        let page = String::from_utf8(with_connection_close(head.as_bytes(), &Upstream::agent(4096, Some("http://192.168.1.20:47097".into()))).unwrap()).unwrap();
        assert!(page.contains("\r\nContent-Security-Policy: default-src 'self'; img-src data:; frame-src 'self' blob: http://192.168.1.20:47097\r\n"), "{page}");
        // a file without the page's type, and a page without a policy, are left as they are
        let script = "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Security-Policy: default-src 'self'\r\n\r\n";
        let r = String::from_utf8(with_connection_close(script.as_bytes(), &Upstream::agent(4096, Some("http://192.168.1.20:47097".into()))).unwrap()).unwrap();
        assert!(!r.contains("frame-src"));
        let bare = String::from_utf8(with_connection_close(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n", &Upstream::agent(4096, Some("http://x:1".into()))).unwrap()).unwrap();
        assert!(!bare.contains("frame-src"));
    }
}
