//! The engine manager's port: forwards to the running `llama-server` and governs the GPUs.
//!
//! * `POST /v1/...` with the `"model"` field (key of mango-models.json): starts that model if needed (waiting for
//!   the other one's in-flight requests), then forwards. Every other route (`/health`, `/props`, `/slots`,
//!   `/metrics`, ...) goes to the running engine; 503 if no engine is running. A model the plan refuses (unknown,
//!   missing files, doesn't fit) gives 422: the agent doesn't retry and shows the sentence.
//! * `GET /engine` → the state (`PublicState`).
//! * `POST /engine/release` `{"gpus": [0, 2], "pid"?: n}` (no body = all) → releases the GPUs; the loan belongs to
//!   the calling process (or to `pid`, `0` = to nobody) and ends when that process closes.
//! * `POST /engine/resume` → gives the GPUs back and restarts the model; replies when it's ready.
//! * `POST /engine/model` `{"model": "toq"}` → starts that model; replies when it's ready (422 if the plan refuses it).
//!
//! Forwarding is byte for byte: the request goes to the engine with `Connection: close` and the reply returns to
//! the client as it arrives (the engine's headers and chunks), piece by piece. A thread watches the client's
//! socket: if the client closes (the «Stop» button), the connection to the engine is closed at once too, and the
//! engine cancels the task even while it is reading the prompt, when it has nothing to write yet.
//!
//! Every route rejects requests that come from a web page (`Origin` header, or a `Host` that is not `127.0.0.1` or
//! `localhost`: a name of the page's own pointing here): the engine is for the agent and for apps on the PC, which send
//! neither. Without this a site open in the browser could use the model or release the GPUs (a "simple" request doesn't
//! go through CORS). A request is read within bounded time and memory (`MAX_LINE`, `MAX_HEADERS`, `READ_TIMEOUT`).
//! Errors have the shape of OpenAI's (`{"error": {"message", "type"}}`).

use crate::share::Share;
use crate::EngineManager;
use anyhow::{bail, Context, Result};
use mango_common::tr;
use serde_json::{json, Value};
use std::cell::Cell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// A request body larger than this (base64 images included) is an error.
const MAX_BODY: usize = 256 * 1024 * 1024;
/// The longest line of a request's head, and how many lines: a client that sends more is not an app of this computer.
const MAX_LINE: usize = 16 * 1024;
const MAX_HEADERS: usize = 100;
/// How long a client may stay silent while it sends the request: the thread of a connection that stops is not held for ever.
const READ_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(30) };
/// The time a PC of the network has to send the head of its request, however slowly it comes.
const HEAD_DEADLINE: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(10) };
/// Request headers that pass on to the engine.
const FORWARDED: &[&str] = &["content-type", "accept", "authorization", "x-mango-warmup"];

/// Opens the port on 127.0.0.1 and serves on a thread of its own (one thread per connection).
pub fn serve(m: EngineManager, port: u16) -> Result<()> {
    let l = TcpListener::bind(("127.0.0.1", port)).with_context(|| format!("engine port {port}"))?;
    std::thread::Builder::new().name("engine-http".into()).spawn(move || {
        for c in l.incoming().flatten() {
            let m = m.clone();
            let _ = std::thread::Builder::new().name("engine-request".into()).spawn(move || handle(c, &m, None));
        }
    })?;
    Ok(())
}

struct Request {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// One line of the head, at most `MAX_LINE` bytes: a longer one is an error, not memory.
fn head_line(r: &mut BufReader<&Timed>, line: &mut String) -> Result<usize> {
    let n = r.by_ref().take(MAX_LINE as u64 + 1).read_line(line)?;
    if line.len() > MAX_LINE {
        bail!("{}", tr!("riga troppo lunga", "line too long"));
    }
    Ok(n)
}

/// The socket with an optional deadline for the whole head: a client that sends a byte at a time does not hold the thread.
struct Timed<'a> {
    stream: &'a TcpStream,
    deadline: Cell<Option<Instant>>,
}

impl Read for &Timed<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if let Some(d) = self.deadline.get() {
            let left = d.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            self.stream.set_read_timeout(Some(left.min(READ_TIMEOUT)))?;
        }
        let mut s = self.stream;
        s.read(buf)
    }
}

/// What the network gate answers to a request it does not let through.
#[derive(Debug)]
struct Refused {
    status: u16,
    /// For the log, in English.
    reason: &'static str,
    /// For whoever uses the other PC, in the current language.
    message: String,
    path: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Refused {}

/// What a PC of the network may do, in order: no web pages, a numeric address (a name pointing here is another site's),
/// the key, and only the routes a PC that uses the engine needs. The loans of the GPUs and the writes to the engine stay
/// for the apps of this PC.
fn admit(method: &str, url: &str, headers: &[(String, String)], share: &Share) -> std::result::Result<(), Refused> {
    let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    let path = url.split('?').next().unwrap_or("");
    let refuse = |status, reason, message: String| Err(Refused { status, reason, message, path: path.to_string() });
    if header("Origin").is_some() {
        return refuse(403, "request from a web page", tr!("il motore risponde ai tuoi PC, non alle pagine web", "the engine answers your PCs, not web pages"));
    }
    if !header("Host").is_some_and(|h| h.rsplit_once(':').map_or(h, |(ip, _)| ip).parse::<Ipv4Addr>().is_ok()) {
        return refuse(
            403,
            "the address must be numeric",
            tr!("l'indirizzo dev'essere numerico (http://192.168.x.y:porta o http://100.x.y.z:porta)", "the address must be numeric (http://192.168.x.y:port or http://100.x.y.z:port)"),
        );
    }
    let key = header("Authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if !share.right_key(key.trim()) {
        return refuse(
            401,
            "wrong or missing key",
            tr!(
                "La chiave non è giusta, oppure la condivisione è spenta: copia di nuovo il codice dal PC con il motore e incollalo in «Modelli e motore».",
                "The key is not right, or sharing is off: copy the code again from the PC with the engine and paste it in \"Models and engine\"."
            ),
        );
    }
    // Decoded paths and `..` are not routes of the engine's: nothing that is not written here passes.
    let clean = !path.contains("..") && !path.contains('%');
    let allowed = clean
        && match method {
            "GET" => path.starts_with("/v1/") || matches!(path, "/health" | "/props" | "/metrics" | "/slots" | "/engine" | "/mango/models"),
            "POST" => path.starts_with("/v1/"),
            _ => false,
        };
    if !allowed {
        return refuse(403, "route not shared", tr!("questa rotta è solo per l'app sul PC con il motore", "this route is only for the app on the PC with the engine"));
    }
    Ok(())
}

/// `gate`: the request comes from the network. It is checked as soon as its head is read, before the body: whoever has no
/// right to ask does not make the manager read hundreds of MB.
fn read_request(c: &TcpStream, gate: Option<&Share>) -> Result<Request> {
    c.set_read_timeout(Some(READ_TIMEOUT))?;
    let timed = Timed { stream: c, deadline: Cell::new(gate.map(|_| Instant::now() + HEAD_DEADLINE)) };
    let mut r = BufReader::new(&timed);
    let mut line = String::new();
    head_line(&mut r, &mut line)?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(url)) = (parts.next(), parts.next()) else {
        bail!("{}", tr!("richiesta malformata", "malformed request"))
    };
    let (method, url) = (method.to_string(), url.to_string());
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if head_line(&mut r, &mut h)? == 0 || headers.len() > MAX_HEADERS {
            bail!("{}", tr!("connessione chiusa nelle intestazioni", "connection closed in the headers"));
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    timed.deadline.set(None);
    c.set_read_timeout(Some(READ_TIMEOUT))?;
    if let Some(share) = gate {
        admit(&method, &url, &headers, share)?;
    }
    let n: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if n > MAX_BODY {
        bail!("{}", tr!("richiesta troppo grande", "request too large"));
    }
    // The memory grows with the bytes that arrive, not with the length the client announces.
    let mut body = Vec::new();
    r.take(n as u64).read_to_end(&mut body)?;
    if body.len() != n {
        bail!("{}", tr!("corpo della richiesta incompleto", "request body incomplete"));
    }
    // The wait is over: the socket is then watched for the client closing (`Stop`), with no time limit.
    c.set_read_timeout(None)?;
    Ok(Request { method, url, headers, body })
}

/// A request from another PC (`share.rs`): the gate is in `read_request`.
pub(crate) fn handle_network(c: TcpStream, share: &Share) {
    handle(c, share.manager(), Some(share));
}

fn handle(c: TcpStream, m: &EngineManager, net: Option<&Share>) {
    let mut req = match read_request(&c, net) {
        Ok(r) => r,
        Err(e) => {
            return match (e.downcast_ref::<Refused>(), net) {
                (Some(r), Some(share)) => {
                    let address = c.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
                    share.refused(&address, r.status, r.reason, &r.path);
                    respond(&c, r.status, error(&r.message))
                }
                _ => respond(&c, 400, error(&format!("{e:#}"))),
            };
        }
    };
    if net.is_none() && (req.header("Origin").is_some() || req.header("Host").is_some_and(|h| !mango_common::loopback_host(h))) {
        return respond(&c, 403, error(&tr!("il motore risponde alle app sul PC, non alle pagine web", "the engine answers apps on the PC, not web pages")));
    }
    if net.is_some() {
        // The key is for this manager, not for the engine.
        req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
    }
    // The body is read only with `Content-Length`: a chunked one would arrive empty (and `release` without a body
    // releases all the GPUs), so it's rejected.
    if req.header("Transfer-Encoding").is_some() {
        return respond(
            &c,
            400,
            error(&tr!(
                "il corpo a blocchi (Transfer-Encoding) non è supportato: serve Content-Length",
                "a chunked body (Transfer-Encoding) is not supported: Content-Length is required"
            )),
        );
    }
    let path = req.url.split('?').next().unwrap_or("").to_string();
    if let (Some(share), "/mango/models") = (net, path.as_str()) {
        return respond(&c, 200, share.offered());
    }
    if path == "/engine" || path.starts_with("/engine/") {
        let t0 = Instant::now();
        let (status, v) = control(&req, &path, &c, m);
        if req.method == "POST" {
            log_call(m, &c, &req, &path, status, &v, t0.elapsed());
        }
        return respond(&c, status, v);
    }
    let permit = if path.starts_with("/v1/") && req.method == "POST" {
        let key = serde_json::from_slice::<Value>(&req.body).ok().and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string));
        m.acquire(key.as_deref())
    } else {
        match m.phase() {
            crate::Phase::Running => m.acquire(None),
            f => return respond(&c, 503, error(&tr!("il motore non è acceso ({f:?})", "the engine is not running ({f:?})"))),
        }
    };
    let permit = match permit {
        Ok(u) => u,
        // A model that doesn't start as it is must not be retried, and the agent retries 5xx: 422, with the sentence that explains it.
        Err(e) => return respond(&c, if e.is::<crate::WillNotStart>() { 422 } else { 503 }, error(&format!("{e:#}"))),
    };
    if let Err(e) = forward(&c, &permit.url, &req) {
        // Before anything has been written to the client the error can still be told; after that, the connection drops.
        respond(&c, 502, error(&tr!("il motore non risponde: {e:#}", "the engine does not answer: {e:#}")));
    }
    drop(permit);
}

/// Who called what, when and with what outcome: one line in `manager.log` for every call that changes the engine's
/// state (`release`, `resume`, `model`). For the caller the PC gives the address and the `User-Agent`.
fn log_call(m: &EngineManager, c: &TcpStream, req: &Request, route: &str, status: u16, reply: &Value, duration: Duration) {
    let body = String::from_utf8_lossy(&req.body);
    let mut line = json!({
        "route": route,
        "body": body.chars().take(500).collect::<String>(),
        "status": status,
        "duration_ms": duration.as_millis() as u64,
        "address": c.peer_addr().map(|a| a.to_string()).unwrap_or_default(),
        "user_agent": req.header("User-Agent").unwrap_or(""),
    });
    if status != 200 {
        line["error"] = reply["error"]["message"].clone();
    }
    m.log(line);
}

fn control(req: &Request, path: &str, c: &TcpStream, m: &EngineManager) -> (u16, Value) {
    let body = &req.body;
    let json_body = || -> Value { if body.is_empty() { json!({}) } else { serde_json::from_slice(body).unwrap_or(Value::Null) } };
    let outcome = match (req.method.as_str(), path) {
        ("GET", "/engine") => Ok(m.state()),
        ("POST", "/engine/release") => {
            let v = json_body();
            // A body that isn't an object (a list, a number) doesn't say which GPUs: it doesn't become "all".
            if !v.is_object() {
                return (400, error(&tr!("il corpo non è un oggetto JSON", "the body is not a JSON object")));
            }
            let caller = || match (c.peer_addr(), c.local_addr()) {
                (Ok(client), Ok(server)) => crate::loan::owner_of(client, server),
                _ => None,
            };
            let pid = match loan_pid(&v, caller) {
                Ok(p) => p,
                Err(e) => return (400, error(&e)),
            };
            let who = crate::Requester { pid, who: req.header("User-Agent").unwrap_or("").to_string() };
            match v.get("gpus") {
                None | Some(Value::Null) => m.release(None, who),
                Some(Value::Array(a)) => {
                    let Some(gpus) = a.iter().map(|x| x.as_u64().and_then(|n| u32::try_from(n).ok())).collect::<Option<Vec<u32>>>() else {
                        return (400, error(&gpus_must_be_a_list()));
                    };
                    m.release(Some(&gpus), who)
                }
                Some(_) => return (400, error(&gpus_must_be_a_list())),
            }
        }
        ("POST", "/engine/resume") => m.resume(&mut |_| {}),
        ("POST", "/engine/model") => {
            let v = json_body();
            let Some(k) = v.get("model").and_then(Value::as_str) else {
                return (400, error(&tr!("manca «model»", "«model» is missing")));
            };
            m.start(k, &mut |_| {}).map(|_| m.state())
        }
        _ => return (404, error(&tr!("rotta sconosciuta: {path}", "unknown route: {path}"))),
    };
    match outcome {
        Ok(s) => (200, serde_json::to_value(s).unwrap_or(Value::Null)),
        // A model the plan refuses answers 422, as on `/v1/`: the sentence says why and nobody retries.
        Err(e) => (if e.is::<crate::WillNotStart>() { 422 } else { 500 }, error(&format!("{e:#}"))),
    }
}

fn gpus_must_be_a_list() -> String {
    tr!("«gpus» deve essere un elenco di indici", "«gpus» must be a list of indexes")
}

/// Forwards the request to the engine and copies the reply, byte for byte, until the engine closes.
/// `Err` only if nothing could be written to the client (the caller can still answer 502).
fn forward(client: &TcpStream, base: &str, req: &Request) -> Result<()> {
    let host = base.trim_start_matches("http://");
    let mut engine = TcpStream::connect(host).with_context(|| tr!("connessione a {host}", "connection to {host}"))?;
    engine.set_nodelay(true).ok();
    let mut head = format!("{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", req.method, req.url, req.body.len());
    for name in FORWARDED {
        if let Some(v) = req.header(name) {
            head.push_str(&format!("{name}: {v}\r\n"));
        }
    }
    head.push_str("\r\n");
    engine.write_all(head.as_bytes())?;
    engine.write_all(&req.body)?;

    // The watchdog: after the request the client sends nothing more. If the read returns, it has closed.
    let client_guard = client.try_clone()?;
    let engine_guard = engine.try_clone()?;
    std::thread::Builder::new().name("engine-watchdog".into()).spawn(move || {
        let mut b = [0u8; 1];
        if let Ok(0) | Err(_) = client_guard.peek(&mut b) {
            let _ = engine_guard.shutdown(Shutdown::Both);
        }
    })?;

    let mut to_client = client.try_clone()?;
    let mut buf = vec![0u8; 16 * 1024];
    let mut written = false;
    // The reply head is held until it's whole: the manager closes the connection after every reply, and if the
    // engine doesn't say so the manager does (a client that keeps connections open would reuse a closed one).
    let mut head: Option<Vec<u8>> = Some(Vec::new());
    loop {
        let n = match engine.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if !written => return Err(e.into()),
            Err(_) => break,
        };
        let chunk = match head.as_mut() {
            Some(t) => {
                t.extend_from_slice(&buf[..n]);
                match with_connection_close(t) {
                    Some(whole) => {
                        head = None;
                        whole
                    }
                    None => continue,
                }
            }
            None => buf[..n].to_vec(),
        };
        if to_client.write_all(&chunk).and_then(|_| to_client.flush()).is_err() {
            break;
        }
        written = true;
    }
    if let Some(t) = head.filter(|t| !t.is_empty()) {
        let _ = to_client.write_all(&t).and_then(|_| to_client.flush());
        written = true;
    }
    // End of the reply: close towards the client (the watchdog unblocks) and towards the engine.
    let _ = client.shutdown(Shutdown::Both);
    let _ = engine.shutdown(Shutdown::Both);
    if !written {
        bail!("{}", tr!("il motore ha chiuso senza rispondere", "the engine closed without answering"));
    }
    Ok(())
}

/// The head of an HTTP reply with `Connection: close`, added if missing. `None` until the head is whole (beyond
/// 64 KiB it isn't a head: it's left as it is).
fn with_connection_close(t: &[u8]) -> Option<Vec<u8>> {
    let Some(end) = t.windows(4).position(|w| w == b"\r\n\r\n") else {
        return (t.len() > 64 * 1024).then(|| t.to_vec());
    };
    let lines = String::from_utf8_lossy(&t[..end]).to_ascii_lowercase();
    if lines.split("\r\n").skip(1).any(|r| r.starts_with("connection:")) {
        return Some(t.to_vec());
    }
    let mut v = t[..end].to_vec();
    v.extend_from_slice(b"\r\nConnection: close");
    v.extend_from_slice(&t[end..]);
    Some(v)
}

/// The process a loan is tied to: that of «pid» (`0`: nobody, until resume), or without «pid» the one that calls,
/// recognized from the connection (`caller`). If it isn't recognized it's an error: a loan that never ends isn't
/// born by mistake.
fn loan_pid(v: &Value, caller: impl FnOnce() -> Option<u32>) -> Result<Option<u32>, String> {
    match v.get("pid") {
        None | Some(Value::Null) => caller().map(Some).ok_or_else(|| {
            tr!(
                "non riesco a riconoscere il processo che chiama: manda «pid» (il suo numero, o 0 per un prestito fino a «resume»)",
                "I can't recognize the calling process: send «pid» (its number, or 0 for a loan until «resume»)"
            )
        }),
        Some(x) => match x.as_u64().map(u32::try_from) {
            Some(Ok(0)) => Ok(None),
            Some(Ok(n)) => Ok(Some(n)),
            _ => Err(tr!("«pid» deve essere il numero di un processo", "«pid» must be a process number")),
        },
    }
}

fn error(msg: &str) -> Value {
    json!({ "error": { "message": msg, "type": "mango_engine" } })
}

fn respond(c: &TcpStream, status: u16, v: Value) {
    let body = v.to_string();
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    let mut c = c;
    let _ = c.write_all(head.as_bytes()).and_then(|_| c.write_all(body.as_bytes())).and_then(|_| c.flush());
    let _ = c.shutdown(Shutdown::Write);
    // The client is given time to read before the socket disappears.
    let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
    let mut discard = [0u8; 256];
    while matches!(c.read(&mut discard), Ok(n) if n > 0) {}
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        422 => "Unprocessable Content",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `read_request` makes of what a client sends and then stops sending: it must not wait for ever or reserve
    /// the memory of a length that is only announced.
    fn read(sent: &[u8]) -> (Result<Request>, Duration) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        client.write_all(sent).unwrap();
        let (server, _) = l.accept().unwrap();
        let t0 = Instant::now();
        let r = read_request(&server, None);
        (r, t0.elapsed())
    }

    #[test]
    fn a_client_that_stops_sending_does_not_hold_the_request_and_a_huge_header_is_refused() {
        let (r, took) = read(b"POST /v1/x HTTP/1.1\r\nContent-Length: 200000000\r\n\r\nabc");
        assert!(r.is_err() && took < Duration::from_secs(10), "{took:?}");
        let (r, took) = read(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        assert!(r.is_err() && took < Duration::from_secs(10), "{took:?}");
        let (r, took) = read(format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_LINE + 10)).as_bytes());
        assert!(r.is_err() && took < Duration::from_secs(1), "{took:?}");
        let (r, _) = read(b"POST /v1/x HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc");
        assert_eq!(r.ok().map(|r| r.body), Some(b"abc".to_vec()));
    }

    /// A PC of the network that sends the head a byte at a time, always before the read times out, does not keep the thread.
    #[test]
    fn a_head_sent_drop_by_drop_is_cut_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let manager = EngineManager::new(Box::new(|k, _, _| bail!("no model in the tests ({k})")), Box::new(Vec::new), dir.path(), None);
        let share = Share::new(dir.path(), manager, 0, true).unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (server, _) = l.accept().unwrap();
        let drip = std::thread::spawn(move || {
            for byte in b"GET / HTTP/1.1
X: aaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
                if client.write_all(&[*byte]).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let t0 = Instant::now();
        assert!(read_request(&server, Some(&share)).is_err());
        assert!(t0.elapsed() < Duration::from_millis(2500), "{:?}", t0.elapsed());
        drop(server);
        drip.join().unwrap();
    }

    #[test]
    fn the_loan_is_the_given_pids_or_the_callers_and_never_nobodys_by_mistake() {
        let nobody = || -> Option<u32> { None };
        assert_eq!(loan_pid(&json!({ "pid": 42 }), nobody), Ok(Some(42)));
        assert_eq!(loan_pid(&json!({ "pid": 0 }), nobody), Ok(None));
        assert_eq!(loan_pid(&json!({}), || Some(7)), Ok(Some(7)));
        // If the calling process isn't recognized, the loan doesn't become "until resume" without saying so.
        assert!(loan_pid(&json!({}), nobody).unwrap_err().contains("«pid»"));
        assert!(loan_pid(&json!({ "pid": "x" }), nobody).is_err());
        assert!(loan_pid(&json!({ "pid": 1u64 << 33 }), nobody).is_err());
    }
}
