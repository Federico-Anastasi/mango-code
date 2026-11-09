//! The phone port's tests: a fake agent on 127.0.0.1 that remembers the requests, the phone port on 127.0.0.1 (not on
//! all networks: no firewall warnings during the tests) and hand-written requests.

use super::*;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

/// A fake agent: for each connection it sends the request head on `received` and answers with `reply`; then it
/// closes, like the real agent with `Connection: close`, except for an event stream, which stays open.
struct Agent {
    port: u16,
    received: mpsc::Receiver<String>,
}

fn agent(reply: &'static str) -> Agent {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, received) = mpsc::channel();
    std::thread::spawn(move || {
        let mut open = Vec::new();
        for mut c in l.incoming().flatten() {
            let mut buf = Vec::new();
            let mut b = [0u8; 4096];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = c.read(&mut b).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&b[..n]);
            }
            let end = buf.windows(4).position(|w| w == b"\r\n\r\n").map_or(buf.len(), |i| i + 4);
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let length: usize = head
                .lines()
                .find_map(|r| r.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                .unwrap_or(0);
            let mut body = buf[end..].to_vec();
            while body.len() < length {
                let n = c.read(&mut b).unwrap();
                body.extend_from_slice(&b[..n]);
            }
            let _ = tx.send(format!("{head}{}", String::from_utf8_lossy(&body)));
            let _ = c.write_all(reply.as_bytes());
            if reply.contains("text/event-stream") {
                open.push(c);
            }
        }
    });
    Agent { port, received }
}

/// The app's side of the reports: it keeps what arrives, refuses what starts with "bad".
struct FakeReports {
    received: Mutex<Vec<Vec<u8>>>,
}

impl Reports for FakeReports {
    fn max_body(&self) -> u64 {
        100
    }
    fn info(&self) -> serde_json::Value {
        serde_json::json!({ "maxBytes": 60 })
    }
    fn submit(&self, body: Vec<u8>) -> std::result::Result<serde_json::Value, (u16, String)> {
        if body.starts_with(b"bad") {
            return Err((422, "this report is not good".into()));
        }
        self.received.lock().unwrap().push(body);
        Ok(serde_json::json!({ "sent": true }))
    }
}

/// The computer's side of the browser panel and the projects: what the panel shows, what it was asked to open.
struct FakeComputer {
    shown: Mutex<Option<Shown>>,
    folders: Mutex<Vec<PathBuf>>,
    opened: Mutex<Vec<String>>,
}

impl Computer for FakeComputer {
    fn shown(&self) -> Option<Shown> {
        self.shown.lock().unwrap().clone()
    }
    fn open(&self, page: Page) -> std::result::Result<(), (u16, String)> {
        let (url, file) = match page {
            Page::Url(url) => (url, None),
            Page::File(path) => (format!("file:///{}", path.display()), Some(path)),
        };
        self.opened.lock().unwrap().push(url.clone());
        *self.shown.lock().unwrap() = Some(Shown { url, title: "opened".into(), file });
        Ok(())
    }
    fn project_folders(&self) -> std::result::Result<Vec<PathBuf>, String> {
        Ok(self.folders.lock().unwrap().clone())
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Fixture {
    t: Phone,
    port: u16,
    preview_port: u16,
    data: tempfile::TempDir,
    reports: Arc<FakeReports>,
    computer: Arc<FakeComputer>,
}

fn fixture(agent: &Agent) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let port = free_port();
    let preview_port = free_port();
    let reports = Arc::new(FakeReports { received: Mutex::new(Vec::new()) });
    let computer = Arc::new(FakeComputer { shown: Mutex::new(None), folders: Mutex::new(Vec::new()), opened: Mutex::new(Vec::new()) });
    let t = Phone::new(data.path(), &data.path().join("logs"), Ipv4Addr::LOCALHOST, port, preview_port, agent.port, reports.clone(), computer.clone()).unwrap();
    Fixture { t, port, preview_port, data, reports, computer }
}

impl Fixture {
    fn key(&self) -> String {
        self.t.d.saved.lock().unwrap().key.clone().unwrap()
    }

    /// Sends a hand-written request (`{host}` becomes the port's address) and reads the whole reply.
    fn send(&self, request: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        c.write_all(request.replace("{host}", &format!("127.0.0.1:{}", self.port)).as_bytes()).unwrap();
        let mut r = String::new();
        let _ = c.read_to_string(&mut r);
        r
    }

    /// The same, to the preview port (`{host}` is its address).
    fn send_preview(&self, request: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", self.preview_port)).unwrap();
        c.write_all(request.replace("{host}", &format!("127.0.0.1:{}", self.preview_port)).as_bytes()).unwrap();
        let mut r = Vec::new();
        let _ = c.read_to_end(&mut r);
        String::from_utf8_lossy(&r).into_owned()
    }

    /// Makes the panel show `url` (with its file, if it is a local one).
    fn show(&self, url: &str, file: Option<&Path>) {
        *self.computer.shown.lock().unwrap() = Some(Shown { url: url.into(), title: "Title".into(), file: file.map(Path::to_path_buf) });
    }

    /// Enters with the key and returns the cookie's value.
    fn enter(&self) -> String {
        let r = self.send(&format!("GET /phone?key={} HTTP/1.1\r\nHost: {{host}}\r\n\r\n", self.key()));
        assert!(r.starts_with("HTTP/1.1 303"), "{r}");
        r.lines().find_map(|l| l.strip_prefix("Set-Cookie: mango_phone=")).unwrap().split(';').next().unwrap().to_string()
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.data.path().join("logs").join("phone.log")).unwrap_or_default()
    }
}

fn status(r: &str) -> &str {
    r.split(' ').nth(1).unwrap_or("")
}

const OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nhello";

#[test]
fn off_by_default_the_port_is_not_open() {
    let a = agent(OK);
    let p = fixture(&a);
    let s = p.t.state();
    assert!(!s.enabled && !s.listening && s.home.is_none() && s.away.is_none());
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_err());
    assert!(!p.data.path().join("phone.json").exists());
}

#[test]
fn you_get_in_only_with_the_right_key_and_the_cookie_is_not_the_key() {
    let a = agent(OK);
    let p = fixture(&a);
    assert!(p.t.set_enabled(true).unwrap().listening);
    let key = p.key();
    assert_eq!(key.len(), 48);

    let without = p.send("GET /phone HTTP/1.1\r\nHost: {host}\r\n\r\n");
    assert_eq!(status(&without), "401");
    assert!(!without.contains("Set-Cookie"));
    let wrong = p.send(&format!("GET /phone?key={}0 HTTP/1.1\r\nHost: {{host}}\r\n\r\n", &key[1..]));
    assert_eq!(status(&wrong), "401");
    let short = p.send(&format!("GET /phone?key={} HTTP/1.1\r\nHost: {{host}}\r\n\r\n", &key[..10]));
    assert_eq!(status(&short), "401");

    let right = p.send(&format!("GET /phone?key={key} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"));
    assert_eq!(status(&right), "303");
    assert!(right.contains("Location: /\r\n"));
    let cookie = right.lines().find(|l| l.starts_with("Set-Cookie: ")).unwrap();
    assert!(cookie.contains("; HttpOnly") && cookie.contains("; SameSite=Strict") && cookie.contains("; Path=/"), "{cookie}");
    assert!(!cookie.contains(&key));
    // Only the cookie's hash is saved; the key never goes in the log.
    let value = cookie.strip_prefix("Set-Cookie: mango_phone=").unwrap().split(';').next().unwrap();
    let saved = std::fs::read_to_string(p.data.path().join("phone.json")).unwrap();
    assert!(!saved.contains(value));
    let log = p.log();
    assert!(log.contains("\"entry\"") && log.contains("wrong or missing key"));
    assert!(!log.contains(&key) && !log.contains(&key[1..]) && !log.contains(value));
}

#[test]
fn without_a_session_nothing_reaches_the_agent() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let r = p.send("GET /session HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\n\r\n");
    assert_eq!(status(&r), "401");
    let r = p.send("GET / HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\n\r\n");
    assert_eq!(status(&r), "401");
    assert!(r.contains("Content-Type: text/html"));
    let r = p.send("GET /session HTTP/1.1\r\nHost: {host}\r\nCookie: mango_phone=made-up\r\n\r\n");
    assert_eq!(status(&r), "401");
    // The key isn't worth anything as a cookie.
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={}\r\n\r\n", p.key()));
    assert_eq!(status(&r), "401");
    assert!(a.received.try_recv().is_err());
}

#[test]
fn whoever_arrives_without_the_key_gets_a_page_that_says_how_to_get_in() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let r = p.send("GET /phone HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\n\r\n");
    assert_eq!(status(&r), "401");
    assert!(r.contains("Cache-Control: no-store"));
    // the app's look and the way in: a dark page made for the phone's screen, the icon, a field for the link or the key
    for part in ["viewport-fit=cover", "#15171f", "src=\"/favicon-v3.svg\"", "<input id=\"k\"", "font-size: 16px"] {
        assert!(r.contains(part), "{part}: {r}");
    }
    assert!(!r.contains("class=\"notice\""));
    for placeholder in ["{lang}", "{title}", "{steps}", "{notice}", "{label}", "{button}"] {
        assert!(!r.contains(placeholder), "{placeholder} left in the page");
    }
    let r = p.send("GET /phone?key=wrong HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\n\r\n");
    assert_eq!(status(&r), "401");
    assert!(r.contains("class=\"notice\""), "a key that does not work says so: {r}");
    assert!(a.received.try_recv().is_err());
}

#[test]
fn the_icons_and_the_manifest_need_no_session_and_nothing_else_does() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    for path in ["/site.webmanifest", "/favicon-v3.svg", "/apple-touch-icon-v3.png", "/web-app-manifest-512x512.png"] {
        let r = p.send(&format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\nCookie: other=1\r\n\r\n"));
        assert_eq!(status(&r), "200", "{path}: {r}");
        let received = a.received.recv().unwrap();
        assert!(received.starts_with(&format!("GET {path} HTTP/1.1\r\n")) && !received.to_ascii_lowercase().contains("cookie"), "{received}");
    }
    for request in [
        "POST /site.webmanifest HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n",
        "GET /site.webmanifest/../session HTTP/1.1\r\nHost: {host}\r\n\r\n",
        "GET /assets/index.js HTTP/1.1\r\nHost: {host}\r\n\r\n",
        "GET /favicon-v3.svg HTTP/1.1\r\nHost: evil.example\r\n\r\n",
    ] {
        assert_ne!(status(&p.send(request)), "200", "{request}");
    }
    assert!(a.received.try_recv().is_err());
}

#[test]
fn the_page_of_the_web_ui_is_asked_for_again_every_time() {
    let a = agent("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\nConnection: keep-alive\r\n\r\n<html>");
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let r = p.send(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nAccept: text/html\r\n\r\n"));
    assert_eq!(status(&r), "200");
    assert!(r.contains("Cache-Control: no-cache\r\n"), "{r}");
}

#[test]
fn with_the_session_it_passes_to_the_agent_as_the_web_ui_without_cookie() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let r = p.send(&format!(
        "POST /session?directory=C%3A%5Cp HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://{{host}}\r\nReferer: http://{{host}}/x\r\n\
Cookie: other=1; mango_phone={cookie}\r\nAuthorization: Basic eDp5\r\nX-Forwarded-For: 1.2.3.4\r\nx-opencode-directory: C%3A%5Cp\r\n\
Content-Type: application/json\r\nContent-Length: 13\r\n\r\n{{\"title\":\"x\"}}"
    ));
    assert_eq!(status(&r), "200", "{r}");
    assert!(r.ends_with("hello"));
    assert!(r.contains("Connection: close\r\n") && !r.contains("keep-alive"));
    let received = a.received.recv().unwrap();
    let pa = a.port;
    assert!(received.starts_with("POST /session?directory=C%3A%5Cp HTTP/1.1\r\n"), "{received}");
    assert!(received.contains(&format!("Host: 127.0.0.1:{pa}\r\n")));
    assert!(received.contains(&format!("Origin: http://127.0.0.1:{pa}\r\n")));
    assert!(received.contains("x-opencode-directory: C%3A%5Cp\r\n"));
    assert!(received.ends_with("\r\n\r\n{\"title\":\"x\"}"));
    let lowercase = received.to_ascii_lowercase();
    for stripped in ["cookie:", "referer:", "authorization:", "x-forwarded-for:", &format!("127.0.0.1:{}", p.port)] {
        assert!(!lowercase.contains(stripped), "{stripped} in {received}");
    }
}

#[test]
fn foreign_origin_and_non_numeric_address_are_refused() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    for origin in ["https://foreign-site.example", "http://127.0.0.1:1", "null", "http://localhost"] {
        let r = p.send(&format!("POST /session HTTP/1.1\r\nHost: {{host}}\r\nOrigin: {origin}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
        assert_eq!(status(&r), "403", "{origin}");
    }
    // A name that points to the computer (DNS rebinding): refused even with the right key.
    for host in ["mango.example", &format!("localhost:{}", p.port), &format!("127.0.0.1.nip.io:{}", p.port)] {
        let r = p.send(&format!("GET /phone?key={} HTTP/1.1\r\nHost: {host}\r\n\r\n", p.key()));
        assert_eq!(status(&r), "403", "{host}");
        let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {host}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
        assert_eq!(status(&r), "403", "{host}");
    }
    let r = p.send(&format!("GET /session HTTP/1.1\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "403");
    assert!(a.received.try_recv().is_err());
}

#[test]
fn app_routes_methods_and_chunked_bodies_are_refused() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let with = |line: &str, others: &str| p.send(&format!("{line} HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n{others}\r\n"));
    assert_eq!(status(&with("POST /mango/warmup?directory=C%3A%5Cp", "")), "403");
    assert_eq!(status(&with("PUT /mango/%65xtra-folders", "")), "403");
    assert_eq!(status(&with("TRACE /session", "")), "405");
    assert_eq!(status(&with("CONNECT /session", "")), "405");
    assert_eq!(status(&with("POST /session", "Transfer-Encoding: chunked\r\n")), "400");
    assert_eq!(status(&p.send("GET http://evil.example/ HTTP/1.1\r\nHost: {host}\r\n\r\n")), "400");
    assert!(a.received.try_recv().is_err());
}

/// The reports are the app's, not the agent's: they need the session like everything else, they carry a body the app
/// reads, they are bounded and nothing of them reaches the agent.
#[test]
fn problem_reports_go_to_the_app_with_the_session_and_within_the_limit() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let post = |extra: &str, body: &str| {
        format!("POST /phone/report HTTP/1.1\r\nHost: {{host}}\r\n{extra}Content-Length: {}\r\n\r\n{body}", body.len())
    };
    // without a session: 401, and the app saw nothing
    assert_eq!(status(&p.send(&post("", "hello"))), "401");
    assert_eq!(status(&p.send("GET /phone/report HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\n\r\n")), "401");
    assert!(p.reports.received.lock().unwrap().is_empty());

    let cookie = p.enter();
    let cookie = format!("Cookie: mango_phone={cookie}\r\n");
    // a foreign page cannot send one
    assert_eq!(status(&p.send(&post(&format!("{cookie}Origin: https://foreign.example\r\n"), "hello"))), "403");

    // the page asks what it may send
    let info = p.send(&format!("GET /phone/report HTTP/1.1\r\nHost: {{host}}\r\n{cookie}\r\n"));
    assert_eq!(status(&info), "200");
    assert!(info.ends_with("{\"maxBytes\":60}"), "{info}");

    // a report: the app gets the body as it is
    let ok = p.send(&post(&format!("{cookie}Origin: http://{{host}}\r\n"), "hello"));
    assert_eq!(status(&ok), "200", "{ok}");
    assert!(ok.ends_with("{\"sent\":true}"));
    assert_eq!(p.reports.received.lock().unwrap().as_slice(), [b"hello".to_vec()]);
    // the app says no: its status and its sentence reach the phone
    let bad = p.send(&post(&cookie, "bad report"));
    assert_eq!(status(&bad), "422");
    assert!(bad.contains("this report is not good"));
    // too big: refused before reading it
    let big = p.send(&post(&cookie, &"x".repeat(101)));
    assert_eq!(status(&big), "413", "{big}");
    // other methods, no length
    assert_eq!(status(&p.send(&format!("DELETE /phone/report HTTP/1.1\r\nHost: {{host}}\r\n{cookie}\r\n"))), "405");
    assert_eq!(status(&p.send(&format!("POST /phone/report HTTP/1.1\r\nHost: {{host}}\r\n{cookie}\r\n"))), "400");
    // the agent never saw any of it, and the log has the outcome and no content
    assert!(a.received.try_recv().is_err());
    let log = p.log();
    assert!(log.contains("\"report\"") && !log.contains("hello"));
    assert_eq!(p.reports.received.lock().unwrap().len(), 1);
}

#[test]
fn a_new_key_and_turning_off_drop_the_sessions() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let (key, cookie) = (p.key(), p.enter());
    p.t.new_key().unwrap();
    assert_ne!(p.key(), key);
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "401");
    let r = p.send(&format!("GET /phone?key={key} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"));
    assert_eq!(status(&r), "401");

    let (key, cookie) = (p.key(), p.enter());
    let s = p.t.set_enabled(false).unwrap();
    assert!(!s.enabled && !s.listening);
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_err());
    assert!(p.t.new_key().is_err());
    // Turned on again: new key, the earlier link and cookie are not valid.
    p.t.set_enabled(true).unwrap();
    assert_ne!(p.key(), key);
    let r = p.send(&format!("GET /phone?key={key} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"));
    assert_eq!(status(&r), "401");
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "401");
}

#[test]
fn turning_off_also_closes_the_open_events() {
    // The agent sends the head and an event, then keeps the stream open.
    let a = agent("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {}\n\n");
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let mut c = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
    write!(c, "GET /event HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: mango_phone={cookie}\r\n\r\n", p.port).unwrap();
    // The event arrives while the stream is still open: no waiting for the end of the reply.
    let mut read = Vec::new();
    let mut b = [0u8; 1024];
    while !String::from_utf8_lossy(&read).contains("data: {}") {
        let n = c.read(&mut b).unwrap();
        assert!(n > 0, "stream closed before the event");
        read.extend_from_slice(&b[..n]);
    }
    p.t.set_enabled(false).unwrap();
    // After turning off the stream ends (read at 0 or connection closed).
    c.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
    let ended = loop {
        match c.read(&mut b) {
            Ok(0) => break true,
            Ok(_) => continue,
            Err(e) => break e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::TimedOut,
        }
    };
    assert!(ended);
}

#[test]
fn on_and_sessions_stay_after_a_restart() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    p.t.d.listener.lock().unwrap().take().unwrap().close();
    let t = Phone::new(p.data.path(), &p.data.path().join("logs"), Ipv4Addr::LOCALHOST, p.port, p.preview_port, a.port, p.reports.clone(), p.computer.clone()).unwrap();
    assert!(t.state().listening);
    let r = p.send(&format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "200");
}

#[test]
fn at_most_twenty_sessions() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let first = p.enter();
    for _ in 0..MAX_SESSIONS {
        p.enter();
    }
    assert_eq!(p.t.d.saved.lock().unwrap().sessions.len(), MAX_SESSIONS);
    assert!(!p.t.d.valid_session(&first));
}

#[test]
fn a_port_in_use_is_reported() {
    let a = agent(OK);
    let p = fixture(&a);
    let busy = TcpListener::bind(("127.0.0.1", p.port)).unwrap();
    let s = p.t.set_enabled(true).unwrap();
    assert!(s.enabled && !s.listening);
    assert!(s.error.unwrap().contains(&p.port.to_string()));
    drop(busy);
}

#[test]
fn the_qr_is_an_svg() {
    let s = qr::svg("http://192.168.1.20:47096/phone?key=00112233445566778899aabbccddeeff0011223344556677");
    assert!(s.starts_with("<svg ") && s.ends_with("</svg>") && s.contains("<path d=\"M"));
}

// ---------------------------------------------------------------- the browser panel's pages (preview port)

/// A cookie header for the requests of a session.
fn with_cookie(cookie: &str) -> String {
    format!("Cookie: mango_phone={cookie}\r\n")
}

fn preview_get(p: &Fixture, cookie: &str, path: &str) -> String {
    p.send_preview(&format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(cookie)))
}

fn body(r: &str) -> &str {
    r.split_once("\r\n\r\n").map_or("", |(_, b)| b)
}

/// A folder with a small site, a file outside it and a link in it that leads out.
struct Site {
    root: tempfile::TempDir,
}

impl Site {
    fn new() -> Site {
        let root = tempfile::tempdir().unwrap();
        let site = root.path().join("site");
        std::fs::create_dir_all(site.join("sub")).unwrap();
        std::fs::write(site.join("index.html"), "<html>home</html>").unwrap();
        std::fs::write(site.join("style.css"), "body{}").unwrap();
        std::fs::write(site.join("sub").join("app.js"), "1;").unwrap();
        std::fs::write(site.join("sub").join("index.html"), "<html>sub</html>").unwrap();
        std::fs::create_dir_all(root.path().join("outside")).unwrap();
        std::fs::write(root.path().join("outside").join("secret.txt"), "secret").unwrap();
        // A directory link, as Windows allows without privileges, to the folder outside.
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(site.join("link")).arg(root.path().join("outside")).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
        Site { root }
    }
    fn dir(&self) -> PathBuf {
        self.root.path().join("site")
    }
}

/// The path as a JSON string's content.
fn json_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\")
}

#[test]
fn the_preview_port_is_open_only_while_the_phone_is_on() {
    let a = agent(OK);
    let p = fixture(&a);
    assert!(TcpStream::connect(("127.0.0.1", p.preview_port)).is_err());
    p.t.set_enabled(true).unwrap();
    assert!(TcpStream::connect(("127.0.0.1", p.preview_port)).is_ok());
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_ok());
    p.t.set_enabled(false).unwrap();
    assert!(TcpStream::connect(("127.0.0.1", p.preview_port)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_err());
}

#[test]
fn a_busy_preview_port_keeps_the_phone_off_and_says_which() {
    let a = agent(OK);
    let p = fixture(&a);
    let busy = TcpListener::bind(("127.0.0.1", p.preview_port)).unwrap();
    let s = p.t.set_enabled(true).unwrap();
    assert!(s.enabled && !s.listening);
    assert!(s.error.unwrap().contains(&p.preview_port.to_string()));
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_err());
    drop(busy);
}

#[test]
fn the_preview_port_needs_the_phones_session_for_everything() {
    let a = agent(OK);
    let page = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    p.show(&format!("http://127.0.0.1:{}/", page.port), None);
    let cookie = p.enter();
    for request in [
        "GET / HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\n\r\n".to_string(),
        "GET /style.css HTTP/1.1\r\nHost: {host}\r\nCookie: mango_phone=made-up\r\n\r\n".to_string(),
        // the key is not worth anything as a cookie, and the entry of the main port does not exist here
        format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={}\r\n\r\n", p.key()),
        format!("GET /phone?key={} HTTP/1.1\r\nHost: {{host}}\r\n\r\n", p.key()),
        "GET /favicon-v3.svg HTTP/1.1\r\nHost: {host}\r\n\r\n".to_string(),
        "POST /form HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n".to_string(),
    ] {
        let r = p.send_preview(&request);
        assert_eq!(status(&r), "401", "{request}: {r}");
        assert!(!r.contains("<form") && !r.contains("Set-Cookie"), "{r}");
    }
    assert!(page.received.try_recv().is_err() && a.received.try_recv().is_err());
    // the cookie of the main port's session is the one that opens it
    assert_eq!(status(&preview_get(&p, &cookie, "/")), "200");
    // and a session dropped by a new key stops working on this port too
    p.t.new_key().unwrap();
    assert_eq!(status(&preview_get(&p, &cookie, "/")), "401");
    assert!(p.log().contains("no session"));
}

#[test]
fn the_preview_port_has_the_address_origin_and_method_checks_of_the_main_port() {
    let a = agent(OK);
    let page = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    p.show(&format!("http://127.0.0.1:{}/", page.port), None);
    let cookie = p.enter();
    let c = with_cookie(&cookie);
    for host in ["mango.example", &format!("localhost:{}", p.preview_port), &format!("127.0.0.1.nip.io:{}", p.preview_port)] {
        let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {host}\r\n{c}\r\n"));
        assert_eq!(status(&r), "403", "{host}");
    }
    assert_eq!(status(&p.send_preview(&format!("GET / HTTP/1.1\r\n{c}\r\n"))), "403");
    for origin in ["https://foreign-site.example", &format!("http://127.0.0.1:{}", p.port), "null"] {
        let r = p.send_preview(&format!("POST /x HTTP/1.1\r\nHost: {{host}}\r\nOrigin: {origin}\r\n{c}Content-Length: 0\r\n\r\n"));
        assert_eq!(status(&r), "403", "{origin}");
    }
    assert_eq!(status(&p.send_preview(&format!("TRACE / HTTP/1.1\r\nHost: {{host}}\r\n{c}\r\n"))), "405");
    assert_eq!(status(&p.send_preview(&format!("POST / HTTP/1.1\r\nHost: {{host}}\r\n{c}Transfer-Encoding: chunked\r\n\r\n"))), "400");
    assert_eq!(status(&p.send_preview("GET http://evil.example/ HTTP/1.1\r\nHost: {host}\r\n\r\n")), "400");
    assert!(page.received.try_recv().is_err() && a.received.try_recv().is_err());
}

#[test]
fn the_preview_goes_only_to_the_page_the_panel_shows() {
    let a = agent(OK);
    let shown = agent(OK);
    let other = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    p.show(&format!("http://127.0.0.1:{}/start", shown.port), None);
    // The phone writes another address in the head, a path that looks like one, a port: none of it is used.
    for (host, path) in [
        (format!("127.0.0.1:{}", other.port), "/a?x=1".to_string()),
        (format!("127.0.0.1:{}", p.preview_port), format!("//127.0.0.1:{}/b", other.port)),
        ("10.0.0.5:80".to_string(), format!("/c?next=http://127.0.0.1:{}/", other.port)),
    ] {
        let r = p.send_preview(&format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nCookie: theme=dark; mango_phone={cookie}; lang=it\r\nReferer: http://{host}/\r\n\r\n"));
        assert_eq!(status(&r), "200", "{r}");
        let received = shown.received.recv().unwrap();
        assert!(received.starts_with(&format!("GET {path} HTTP/1.1\r\n")), "{received}");
        assert!(received.contains(&format!("Host: 127.0.0.1:{}\r\n", shown.port)), "{received}");
        // the page has its own cookies and never the session of the phone
        assert!(received.contains("Cookie: theme=dark; lang=it\r\n") && !received.contains("mango_phone"), "{received}");
        assert!(!received.to_ascii_lowercase().contains("referer"), "{received}");
    }
    assert!(other.received.try_recv().is_err() && a.received.try_recv().is_err());

    // The panel moves on: the next request goes to its new page, not to the old one.
    p.show(&format!("http://127.0.0.1:{}/", other.port), None);
    assert_eq!(status(&preview_get(&p, &cookie, "/")), "200");
    assert!(other.received.recv().is_ok() && shown.received.try_recv().is_err());
    // An Origin of the phone's page becomes the page's own.
    let r = p.send_preview(&format!("POST /api HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://127.0.0.1:{}\r\n{}Content-Length: 0\r\n\r\n", p.preview_port, with_cookie(&cookie)));
    assert_eq!(status(&r), "200");
    assert!(other.received.recv().unwrap().contains(&format!("Origin: http://127.0.0.1:{}\r\n", other.port)));
}

#[test]
fn localhost_is_a_name_only_for_the_loopback() {
    let a = agent(OK);
    let shown = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    assert_eq!(status(&preview_get(&p, &cookie, "/")), "200");
    assert!(shown.received.recv().unwrap().contains(&format!("Host: localhost:{}\r\n", shown.port)));
}

#[test]
fn a_page_that_is_not_the_computers_is_never_relayed() {
    let a = agent(OK);
    let server = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let n = server.port;
    for url in [
        format!("http://192.168.1.5:{n}/"),
        format!("http://localhost.evil.com:{n}/"),
        format!("http://127.0.0.1:{n}@evil.com/"),
        format!("https://127.0.0.1:{n}/"),
        format!("http://[::1]:{n}/"),
        format!("http://0.0.0.0:{n}/"),
        "https://example.com/".to_string(),
        "about:blank".to_string(),
    ] {
        p.show(&url, None);
        let r = preview_get(&p, &cookie, "/");
        assert_eq!(status(&r), "404", "{url}: {r}");
        assert!(r.contains("Content-Type: text/html") && r.contains("<h1>"), "{url}: {r}");
    }
    // nothing shown: a page that says so
    *p.computer.shown.lock().unwrap() = None;
    let r = preview_get(&p, &cookie, "/");
    assert_eq!(status(&r), "404");
    assert!(r.contains("<h1>"), "{r}");
    assert!(server.received.try_recv().is_err() && a.received.try_recv().is_err());
}

#[test]
fn a_server_that_does_not_answer_is_said_in_a_page() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    p.show(&format!("http://127.0.0.1:{}/", free_port()), None);
    let r = preview_get(&p, &cookie, "/");
    assert_eq!(status(&r), "502", "{r}");
    assert!(r.contains("text/html"));
}

#[test]
fn a_redirect_to_the_pages_own_address_comes_back_as_a_path() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let own = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/next?a=1\r\nContent-Length: 0\r\n\r\n");
    std::thread::spawn(move || {
        for mut c in l.incoming().flatten() {
            let mut b = [0u8; 2048];
            let _ = c.read(&mut b);
            let _ = c.write_all(own.as_bytes());
        }
    });
    p.show(&format!("http://127.0.0.1:{port}/"), None);
    let r = preview_get(&p, &cookie, "/old");
    assert_eq!(status(&r), "302");
    assert!(r.contains("Location: /next?a=1\r\n"), "{r}");
}

#[test]
fn the_page_reload_socket_passes_both_ways() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut c, _) = l.accept().unwrap();
        let mut head = Vec::new();
        let mut b = [0u8; 1024];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = c.read(&mut b).unwrap();
            head.extend_from_slice(&b[..n]);
        }
        c.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").unwrap();
        let n = c.read(&mut b).unwrap();
        c.write_all(&b[..n]).unwrap();
    });
    p.show(&format!("http://127.0.0.1:{port}/"), None);
    let mut c = TcpStream::connect(("127.0.0.1", p.preview_port)).unwrap();
    c.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    write!(
        c,
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{pp}\r\nOrigin: http://127.0.0.1:{pp}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n{}\r\n",
        with_cookie(&cookie),
        pp = p.preview_port
    )
    .unwrap();
    let mut read = Vec::new();
    let mut b = [0u8; 1024];
    while !read.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = c.read(&mut b).unwrap();
        assert!(n > 0);
        read.extend_from_slice(&b[..n]);
    }
    assert!(String::from_utf8_lossy(&read).starts_with("HTTP/1.1 101"));
    c.write_all(b"ping").unwrap();
    assert_eq!(c.read(&mut b).unwrap(), 4);
    assert_eq!(&b[..4], b"ping");
}

#[test]
fn a_local_file_is_served_read_only_from_its_folder_and_never_beyond() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let site = Site::new();
    p.show("file:///site/index.html", Some(&site.dir().join("index.html")));

    let r = preview_get(&p, &cookie, "/");
    assert_eq!(status(&r), "200", "{r}");
    assert!(r.contains("Content-Type: text/html") && body(&r) == "<html>home</html>" && r.contains("nosniff"), "{r}");
    let r = preview_get(&p, &cookie, "/style.css?v=2");
    assert!(r.contains("Content-Type: text/css") && body(&r) == "body{}", "{r}");
    assert_eq!(body(&preview_get(&p, &cookie, "/sub/app.js")), "1;");
    assert_eq!(body(&preview_get(&p, &cookie, "/sub/")), "<html>sub</html>");
    assert_eq!(body(&preview_get(&p, &cookie, "/sub/%61pp.js")), "1;");
    // a part of a file, as the browser asks for videos
    let r = p.send_preview(&format!("GET /style.css HTTP/1.1\r\nHost: {{host}}\r\n{}Range: bytes=1-3\r\n\r\n", with_cookie(&cookie)));
    assert_eq!(status(&r), "206");
    assert!(r.contains("Content-Range: bytes 1-3/6\r\n") && body(&r) == "ody", "{r}");
    let r = p.send_preview(&format!("HEAD /style.css HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(&cookie)));
    assert_eq!(status(&r), "200");
    assert!(r.contains("Content-Length: 6") && body(&r).is_empty());

    // Whatever leads out of the folder is not found, however it is written.
    for path in [
        "/../outside/secret.txt",
        "/%2e%2e/outside/secret.txt",
        "/sub/../../outside/secret.txt",
        "/..%2foutside/secret.txt",
        "/..%5coutside%5csecret.txt",
        "/sub/..\\..\\outside\\secret.txt",
        "/C:/Windows/win.ini",
        "/%43%3a/Windows/win.ini",
        "/index.html::$DATA",
        "/link/secret.txt",
        "/CON",
        "/nul.txt",
        "/missing.html",
    ] {
        let r = preview_get(&p, &cookie, path);
        assert_eq!(status(&r), "404", "{path}: {r}");
        assert!(!body(&r).contains("secret</"), "{path}: {r}");
    }
    // read-only
    for method in ["POST", "PUT", "DELETE", "PATCH"] {
        let r = p.send_preview(&format!("{method} /index.html HTTP/1.1\r\nHost: {{host}}\r\n{}Content-Length: 0\r\n\r\n", with_cookie(&cookie)));
        assert_eq!(status(&r), "405", "{method}");
    }
    assert_eq!(std::fs::read_to_string(site.dir().join("index.html")).unwrap(), "<html>home</html>");
    assert!(a.received.try_recv().is_err());
}

#[test]
fn the_state_of_the_panel_is_told_to_the_phone() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let state = |p: &Fixture| {
        let r = p.send(&format!("GET /phone/preview HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(&cookie)));
        assert_eq!(status(&r), "200", "{r}");
        serde_json::from_str::<serde_json::Value>(body(&r)).unwrap()
    };
    let r = p.send("GET /phone/preview HTTP/1.1\r\nHost: {host}\r\n\r\n");
    assert_eq!(status(&r), "401");

    let s = state(&p);
    assert_eq!(s["port"], p.preview_port);
    assert!(s["page"].is_null());
    p.show("http://localhost:3000/blog/post?x=1", None);
    let s = state(&p);
    assert_eq!(s["page"]["path"], "/blog/post?x=1");
    assert_eq!(s["page"]["local"], true);
    assert_eq!(s["page"]["label"], "localhost:3000/blog/post?x=1");
    p.show("file:///x/mia%20pagina.html", Some(Path::new("/x/mia pagina.html")));
    assert_eq!(state(&p)["page"]["path"], "/mia%20pagina.html");
    p.show("https://example.com/a", None);
    assert_eq!(state(&p)["page"]["local"], false);
    // the address of a page outside is not told, nor is a file's place on the disk
    assert!(!state(&p).to_string().contains("example.com/a"));
    p.show("file:///x/mia%20pagina.html", Some(Path::new("/x/mia pagina.html")));
    assert!(!state(&p).to_string().contains("/x/"));
}

#[test]
fn the_phone_asks_the_panel_to_open_a_page_of_the_computer_and_nothing_else() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let site = Site::new();
    p.computer.folders.lock().unwrap().push(site.dir());
    let origin = format!("Origin: http://127.0.0.1:{}\r\n", p.port);
    let open = |json: &str| {
        p.send(&format!("POST /phone/preview HTTP/1.1\r\nHost: {{host}}\r\n{origin}{}Content-Length: {}\r\n\r\n{json}", with_cookie(&cookie), json.len()))
    };
    let r = open(r#"{"url":"http://localhost:5173/"}"#);
    assert_eq!(status(&r), "200", "{r}");
    assert_eq!(p.computer.opened.lock().unwrap().as_slice(), ["http://localhost:5173/"]);
    assert!(r.contains("\"local\":true"));

    let dir = json_path(&site.dir());
    let index = json_path(&site.dir().join("index.html"));
    let r = open(&format!(r#"{{"directory":"{dir}","path":"{index}"}}"#));
    assert_eq!(status(&r), "200", "{r}");
    assert!(r.contains("\"path\":\"/index.html\""), "{r}");
    // and the phone sees it through the preview port
    assert_eq!(body(&preview_get(&p, &cookie, "/")), "<html>home</html>");

    let opened = p.computer.opened.lock().unwrap().len();
    let css = json_path(&site.dir().join("style.css"));
    let outside = json_path(&site.root.path().join("outside").join("secret.txt"));
    let link = json_path(&site.dir().join("link").join("secret.txt"));
    let up = json_path(&site.dir().join("..").join("outside").join("secret.txt"));
    let none = json_path(&site.dir().join("nothing.html"));
    for (json, wanted) in [
        (r#"{"url":"https://example.com/"}"#.to_string(), "400"),
        (r#"{"url":"http://192.168.1.5:3000/"}"#.to_string(), "400"),
        (r#"{"url":"http://localhost:3000@evil.com/"}"#.to_string(), "400"),
        (r#"{"url":"file:///C:/Windows/win.ini"}"#.to_string(), "400"),
        (r#"{"url":"javascript:alert(1)"}"#.to_string(), "400"),
        (format!(r#"{{"url":"http://localhost:3000/","path":"{index}"}}"#), "400"),
        (r#"{}"#.to_string(), "400"),
        ("not json".to_string(), "400"),
        // not a web page
        (format!(r#"{{"directory":"{dir}","path":"{css}"}}"#), "400"),
        // not in the project
        (format!(r#"{{"directory":"{dir}","path":"{outside}"}}"#), "403"),
        (format!(r#"{{"directory":"{dir}","path":"{link}"}}"#), "403"),
        (format!(r#"{{"directory":"{dir}","path":"{up}"}}"#), "400"),
        (format!(r#"{{"directory":"{dir}","path":"{none}"}}"#), "404"),
    ] {
        assert_eq!(status(&open(&json)), wanted, "{json}");
    }
    assert_eq!(p.computer.opened.lock().unwrap().len(), opened, "nothing else reached the panel");
    // without the session, or from another web page, the panel is not touched either
    let r = p.send("POST /phone/preview HTTP/1.1\r\nHost: {host}\r\nContent-Length: 2\r\n\r\n{}");
    assert_eq!(status(&r), "401");
    let r = p.send(&format!("POST /phone/preview HTTP/1.1\r\nHost: {{host}}\r\nOrigin: https://evil.example\r\n{}Content-Length: 2\r\n\r\n{{}}", with_cookie(&cookie)));
    assert_eq!(status(&r), "403");
    assert_eq!(p.computer.opened.lock().unwrap().len(), opened);
}

#[test]
fn the_documents_of_the_conversations_project_go_to_the_phone_and_nothing_else() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let site = Site::new();
    let project = site.dir();
    let other = site.root.path().join("outside");
    std::fs::write(project.join("Relazione è finale.docx"), b"PK\x03\x04docx").unwrap();
    // the agent knows two projects
    // and lists a "global" one that is the whole disk
    p.computer.folders.lock().unwrap().extend([project.clone(), other.clone(), PathBuf::from("/")]);
    let enc = |path: &Path| files::percent(&path.to_string_lossy());
    let get = |directory: &Path, path: &Path, more: &str, method: &str| {
        p.send(&format!("{method} /phone/file?directory={}&path={}{more} HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", enc(directory), enc(path), with_cookie(&cookie)))
    };
    let doc = project.join("Relazione è finale.docx");

    let r = get(&project, &doc, "", "GET");
    assert_eq!(status(&r), "200", "{r}");
    assert_eq!(body(&r), "PK\u{3}\u{4}docx");
    assert!(r.contains("Content-Disposition: attachment; filename=\"Relazione _ finale.docx\"; filename*=UTF-8''Relazione%20%C3%A8%20finale.docx\r\n"), "{r}");
    assert!(r.contains("application/vnd.openxmlformats-officedocument.wordprocessingml.document") && r.contains("nosniff"));
    let r = get(&project, &doc, "&info=1", "GET");
    assert_eq!(serde_json::from_str::<serde_json::Value>(body(&r)).unwrap(), serde_json::json!({ "isDir": false, "size": 8 }));
    let r = get(&project, &project.join("sub").join("app.js"), "", "HEAD");
    assert_eq!(status(&r), "200");
    assert!(r.contains("Content-Length: 2") && body(&r).is_empty());

    // nothing outside the project of this conversation
    let secret = other.join("secret.txt");
    assert_eq!(status(&get(&project, &secret, "", "GET")), "403", "a file of another project");
    assert_eq!(status(&get(&other, &secret, "", "GET")), "200", "that project's own conversation can");
    assert_eq!(status(&get(site.root.path(), &doc, "", "GET")), "403", "a folder that is not a project");
    assert_eq!(status(&get(&project, &project.join("link").join("secret.txt"), "", "GET")), "403", "a link that leads out of the project");
    assert_eq!(status(&get(&project, &project.join("..").join("outside").join("secret.txt"), "", "GET")), "400");
    assert_eq!(status(&get(&project, Path::new("relative.docx"), "", "GET")), "400");
    assert_eq!(status(&get(&project, &project.join("none.docx"), "", "GET")), "404");
    assert_eq!(status(&get(Path::new("C:\\Windows"), Path::new("C:\\Windows\\win.ini"), "", "GET")), "403");
    // the log has the outcomes, never a name
    let log = p.log();
    assert!(log.contains("\"event\":\"file\"") && !log.contains("Relazione") && !log.contains("secret"));

    // only with the session, only to read
    let r = p.send(&format!("GET /phone/file?directory={}&path={} HTTP/1.1\r\nHost: {{host}}\r\n\r\n", enc(&project), enc(&doc)));
    assert_eq!(status(&r), "401");
    let r = p.send(&format!("POST /phone/file?directory={}&path={} HTTP/1.1\r\nHost: {{host}}\r\n{}Content-Length: 0\r\n\r\n", enc(&project), enc(&doc), with_cookie(&cookie)));
    assert_eq!(status(&r), "405");
    assert_eq!(status(&p.send(&format!("GET /phone/file HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(&cookie)))), "400");
}

#[test]
fn a_big_document_can_be_taken_in_parts() {
    let a = agent(OK);
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let site = Site::new();
    let pdf = site.dir().join("a.pdf");
    std::fs::write(&pdf, "0123456789").unwrap();
    p.computer.folders.lock().unwrap().push(site.dir());
    let path = files::percent(&pdf.to_string_lossy());
    let directory = files::percent(&site.dir().to_string_lossy());
    let r = p.send(&format!("GET /phone/file?directory={directory}&path={path} HTTP/1.1\r\nHost: {{host}}\r\n{}Range: bytes=7-\r\n\r\n", with_cookie(&cookie)));
    assert_eq!(status(&r), "206");
    assert!(r.contains("Content-Range: bytes 7-9/10\r\n") && body(&r) == "789" && r.contains("application/pdf"), "{r}");
    let r = p.send(&format!("GET /phone/file?directory={directory}&path={path} HTTP/1.1\r\nHost: {{host}}\r\n{}Range: bytes=10-\r\n\r\n", with_cookie(&cookie)));
    assert_eq!(status(&r), "416");
}

#[test]
fn the_web_ui_may_show_the_preview_port_in_a_frame() {
    let a = agent("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'\r\nContent-Length: 6\r\n\r\n<html>");
    let p = fixture(&a);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let r = p.send(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\n{}Accept: text/html\r\n\r\n", with_cookie(&cookie)));
    assert!(r.contains(&format!("Content-Security-Policy: default-src 'self'; frame-src 'self' http://127.0.0.1:{}\r\n", p.preview_port)), "{r}");
}
