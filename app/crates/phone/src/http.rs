//! The phone's port: the checks on every request and the streaming forwarding to the agent's server.
//!
//! Order of the checks: the requested address (`Host`) must be numeric, otherwise `403`; if there is an `Origin` it
//! must be `http://<Host>`, otherwise `403`; `/phone` is the entry with the key; every other request without a valid
//! session `401`; methods other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` `405`; the routes that only serve
//! the app on the PC (`PC_ONLY`) `403`; a chunked body (`Transfer-Encoding`) `400`. After these, `/phone/report` is
//! answered here by the app's `Reports` (`report`); everything else is forwarded.
//!
//! The forwarding goes to `127.0.0.1:<agent port>` with the agent's `Host` and, if there was one, `Origin` (to the
//! agent it is its own web UI) and without `Cookie`, `Referer`, `Authorization` or the proxy headers. One request per
//! connection (`Connection: close` on both sides): the reply returns as it arrives, piece by piece, so the events
//! (`GET /event`) don't wait. An `Upgrade` (the web UI's terminal, WebSocket) passes both ways.

use crate::Inner;
use anyhow::{bail, Context, Result};
use mango_common::tr;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const COOKIE: &str = "mango_phone";
const MAX_HEAD: usize = 64 * 1024;
/// The time to send the head and the body: a connection that sends nothing doesn't hold a thread forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The route answered here, not by the agent: the problem report (see `Reports`).
const REPORT: &str = "/phone/report";
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// Agent routes the web UI doesn't use: the app calls them at start (`warmup`) and the attached apps (`extra-folders`).
const PC_ONLY: &[&str] = &["/mango/warmup", "/mango/extra-folders"];
/// Headers that don't pass to the agent (`Host`, `Origin`, `Connection` and `Content-Length` are redone).
const STRIPPED: &[&str] = &[
    "host", "origin", "referer", "cookie", "authorization", "connection", "keep-alive", "upgrade", "te", "trailer",
    "transfer-encoding", "content-length", "proxy-connection", "proxy-authorization", "forwarded", "x-forwarded-for",
    "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
];

/// The open port: a thread accepts connections until `close` stops it.
pub(crate) struct Listener {
    stopped: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl Listener {
    /// Closes the port; when it returns the port is closed.
    pub(crate) fn close(self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.thread.join();
    }
}

pub(crate) fn listen(d: Arc<Inner>) -> Result<Listener> {
    let l = TcpListener::bind((d.listen_on, d.port))?;
    // Non-blocking, to notice `close` without a fake connection.
    l.set_nonblocking(true)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let f = stopped.clone();
    let thread = std::thread::Builder::new().name("phone-port".into()).spawn(move || {
        while !f.load(Ordering::SeqCst) {
            let Ok((c, _)) = l.accept() else {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            };
            // On Windows the connection inherits the port's «non-blocking». It is registered before passing it to its
            // thread: whoever turns off while the port closes finds it already among those to close.
            if c.set_nonblocking(false).is_err() {
                continue;
            }
            let id = d.track(&c);
            let d = d.clone();
            let _ = std::thread::Builder::new().name("phone-request".into()).spawn(move || {
                handle(&c, &d);
                d.untrack(id);
            });
        }
    })?;
    Ok(Listener { stopped, thread })
}

pub(crate) struct Head {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn path(&self) -> &str {
        self.url.split('?').next().unwrap_or("")
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
fn read_head(mut c: &TcpStream) -> Result<(Head, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            bail!("{}", tr!("testata troppo grande", "head too large"));
        }
        let n = c.read(&mut chunk)?;
        if n == 0 {
            bail!("{}", tr!("connessione chiusa nella testata", "connection closed in the head"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let text = std::str::from_utf8(&buf[..end]).with_context(|| tr!("testata non UTF-8", "head is not UTF-8"))?;
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

fn handle(c: &TcpStream, d: &Inner) {
    let _ = c.set_read_timeout(Some(REQUEST_TIMEOUT));
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
    if head.path() == "/phone" {
        return enter(c, d, &head, &address);
    }
    if !head.cookie().is_some_and(|v| d.valid_session(v)) {
        d.log(serde_json::json!({ "event": "refused", "outcome": 401, "reason": "no session", "address": address, "path": head.path() }));
        return no_session(c, &head);
    }
    if !METHODS.contains(&head.method.as_str()) {
        return refuse(405, "method not allowed", tr!("metodo non ammesso", "method not allowed"));
    }
    if pc_only(head.path()) {
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
    if head.path() == REPORT {
        return report(c, d, &head, rest, length, &address);
    }
    if let Err(e) = forward(c, d, &head, rest, length) {
        respond(c, 502, "application/json", &error(&tr!("l'agente non risponde: {e:#}", "the agent does not answer: {e:#}")), &[]);
    }
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
            let mut body = rest;
            body.truncate(length as usize);
            let missing = length - body.len() as u64;
            if (&*c).take(missing).read_to_end(&mut body).is_err() || body.len() as u64 != length {
                return fail(400, &tr!("segnalazione incompleta", "incomplete report"));
            }
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
        return respond(c, 401, "text/html; charset=utf-8", &key_page(), &[]);
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
fn no_session(c: &TcpStream, head: &Head) {
    if head.header("accept").is_some_and(|a| a.contains("text/html")) {
        return respond(c, 401, "text/html; charset=utf-8", &key_page(), &[]);
    }
    respond(
        c,
        401,
        "application/json",
        &error(&tr!("serve il link con la chiave, dall'app sul computer", "the link with the key is needed, from the app on the computer")),
        &[],
    );
}

fn key_page() -> String {
    let text = tr!(
        "Per entrare in Mango Code dal telefono apri il link con la chiave: nell'app sul computer, Impostazioni, «Dal telefono».",
        "To get into Mango Code from your phone, open the link with the key: in the app on the computer, Settings, «From your phone»."
    );
    format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Mango Code</title>\
<p style=\"font:16px system-ui;margin:24px\">{text}</p>"
    )
}

/// An IPv4 address written in numbers, with the port or without.
fn numeric(host: &str) -> bool {
    let ip = host.rsplit_once(':').map_or(host, |(ip, port)| if port.parse::<u16>().is_ok() { ip } else { "" });
    ip.parse::<Ipv4Addr>().is_ok()
}

/// The path is compared decoded, lowercase and without double slashes: `/mango//Warmup` and `/mango/%77armup` are the
/// same route.
fn pc_only(path: &str) -> bool {
    let mut p = decode(path).to_ascii_lowercase();
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    let p = p.trim_end_matches('/');
    PC_ONLY.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
}

fn decode(s: &str) -> String {
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

fn forward(c: &TcpStream, d: &Inner, head: &Head, rest: Vec<u8>, length: u64) -> Result<()> {
    let agent_host = format!("127.0.0.1:{}", d.agent_port);
    let mut agent = TcpStream::connect(&agent_host).with_context(|| tr!("connessione a {agent_host}", "connection to {agent_host}"))?;
    agent.set_nodelay(true).ok();
    let upgrade = head.header("upgrade").filter(|_| {
        head.header("connection").is_some_and(|v| v.split(',').any(|x| x.trim().eq_ignore_ascii_case("upgrade")))
    });
    let mut h = format!("{} {} HTTP/1.1\r\nHost: {agent_host}\r\n", head.method, head.url);
    match upgrade {
        Some(u) => h.push_str(&format!("Connection: Upgrade\r\nUpgrade: {u}\r\n")),
        None => h.push_str("Connection: close\r\n"),
    }
    if head.header("origin").is_some() {
        h.push_str(&format!("Origin: http://{agent_host}\r\n"));
    }
    if length > 0 {
        h.push_str(&format!("Content-Length: {length}\r\n"));
    }
    for (k, v) in &head.headers {
        if !STRIPPED.contains(&k.to_ascii_lowercase().as_str()) {
            h.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    h.push_str("\r\n");
    agent.write_all(h.as_bytes())?;
    // The body: what was already read with the head, then the rest from the phone. Bytes beyond `Content-Length` don't pass.
    let already = rest.len().min(length as usize);
    agent.write_all(&rest[..already])?;
    std::io::copy(&mut (&*c).take(length - already as u64), &mut agent)?;
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
            match with_connection_close(&reply_head) {
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

/// The reply head with `Connection: close` in place of its connection headers. `None` until the head is whole; beyond
/// `MAX_HEAD` it passes as it is.
fn with_connection_close(t: &[u8]) -> Option<Vec<u8>> {
    let Some(end) = t.windows(4).position(|w| w == b"\r\n\r\n") else {
        return (t.len() > MAX_HEAD).then(|| t.to_vec());
    };
    let text = String::from_utf8_lossy(&t[..end]);
    let mut out: Vec<u8> = text
        .split("\r\n")
        .filter(|r| {
            let r = r.to_ascii_lowercase();
            !r.starts_with("connection:") && !r.starts_with("keep-alive:")
        })
        .flat_map(|r| [r.as_bytes(), b"\r\n"].concat())
        .collect();
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out.extend_from_slice(&t[end + 4..]);
    Some(out)
}

fn error(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn respond(c: &TcpStream, status: u16, content_type: &str, body: &str, extra: &[&str]) {
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
    let _ = c.shutdown(Shutdown::Write);
    // The phone is given time to read before the socket disappears.
    let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
    let mut discard = [0u8; 256];
    while matches!(c.read(&mut discard), Ok(n) if n > 0) {}
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        303 => "See Other",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
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
        for p in ["/mango/warmup", "/mango/extra-folders", "/mango//warmup", "/MANGO/Extra-Folders", "/mango/%77armup", "/mango/extra-folders/", "//mango/warmup"] {
            assert!(pc_only(p), "{p}");
        }
        for p in ["/mango/engine/speed", "/mango/settings", "/session", "/mango/warmupx", "/event"] {
            assert!(!pc_only(p), "{p}");
        }
    }

    #[test]
    fn the_reply_closes_the_connection() {
        let r = with_connection_close(b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nX: y\r\n\r\nbody").unwrap();
        assert_eq!(String::from_utf8(r).unwrap(), "HTTP/1.1 200 OK\r\nX: y\r\nConnection: close\r\n\r\nbody");
        assert!(with_connection_close(b"HTTP/1.1 200 OK\r\nX: y\r\n").is_none());
    }
}
