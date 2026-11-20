//! The phone port's tests: a fake agent on 127.0.0.1 that remembers the requests, the phone port on 127.0.0.1 (not on
//! all networks: no firewall warnings during the tests) and hand-written requests.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// A fake agent: for each connection it sends the request head on `received` and answers with `reply`; then it
/// closes, like the real agent with `Connection: close`, except for an event stream, which stays open.
struct Agent {
    port: u16,
    received: mpsc::Receiver<String>,
}

fn agent(reply: &'static str) -> Agent {
    agent_bytes(reply.as_bytes().to_vec())
}

fn agent_bytes(reply: Vec<u8>) -> Agent {
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
            let _ = c.write_all(&reply);
            if String::from_utf8_lossy(&reply).contains("text/event-stream") {
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
    owned: Mutex<Vec<u16>>,
}

impl Computer for FakeComputer {
    fn owned_ports(&self) -> Vec<u16> {
        self.owned.lock().unwrap().clone()
    }
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

/// Two ports free at the same time, so distinct.
fn free_ports() -> (u16, u16) {
    let (a, b) = (TcpListener::bind("127.0.0.1:0").unwrap(), TcpListener::bind("127.0.0.1:0").unwrap());
    (a.local_addr().unwrap().port(), b.local_addr().unwrap().port())
}

struct Fixture {
    t: Phone,
    port: u16,
    preview_port: u16,
    agent_port: u16,
    data: tempfile::TempDir,
    reports: Arc<FakeReports>,
    computer: Arc<FakeComputer>,
}

/// The ports are picked free and bound only when the phone is turned on (`on`), and another test may have taken one in
/// between: then the service is built again on other ports.
fn fixture(agent: &Agent) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let (port, preview_port) = free_ports();
    let reports = Arc::new(FakeReports { received: Mutex::new(Vec::new()) });
    let computer = Arc::new(FakeComputer { shown: Mutex::new(None), folders: Mutex::new(Vec::new()), opened: Mutex::new(Vec::new()), owned: Mutex::new(Vec::new()) });
    let t = Phone::new(data.path(), &data.path().join("logs"), true, port, preview_port, agent.port, reports.clone(), computer.clone()).unwrap();
    Fixture { t, port, preview_port, agent_port: agent.port, data, reports, computer }
}

impl Fixture {
    fn on(&mut self) -> State {
        for _ in 0..10 {
            let state = self.t.set_enabled(true).unwrap();
            if state.listening {
                return state;
            }
            self.t.set_enabled(false).unwrap();
            (self.port, self.preview_port) = free_ports();
            self.t = Phone::new(self.data.path(), &self.data.path().join("logs"), true, self.port, self.preview_port, self.agent_port, self.reports.clone(), self.computer.clone()).unwrap();
        }
        panic!("the ports never opened: {:?}", self.t.state());
    }

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
    let mut p = fixture(&a);
    assert!(p.on().listening);
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let r = p.send(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nAccept: text/html\r\n\r\n"));
    assert_eq!(status(&r), "200");
    assert!(r.contains("Cache-Control: no-cache\r\n"), "{r}");
}

#[test]
fn with_the_session_it_passes_to_the_agent_as_the_web_ui_without_cookie() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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

/// From the phone too the model is read and chosen: the routes of the control server reach the agent.
#[test]
fn the_model_routes_pass() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    for line in ["GET /mango/state", "GET /mango/models", "GET /mango/computer", "POST /mango/model/use", "POST /mango/model/retry"] {
        let r = p.send(&format!("{line} HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nContent-Length: 0\r\n\r\n"));
        assert_eq!(status(&r), "200", "{line}");
        assert!(a.received.recv_timeout(Duration::from_secs(5)).unwrap().starts_with(&format!("{line} ")), "{line}");
    }
}

#[test]
fn app_routes_methods_and_chunked_bodies_are_refused() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let with = |line: &str, others: &str| p.send(&format!("{line} HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n{others}\r\n"));
    assert_eq!(status(&with("POST /mango/reload", "")), "403");
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    p.on();
    assert_ne!(p.key(), key);
    let r = p.send(&format!("GET /phone?key={key} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"));
    assert_eq!(status(&r), "401");
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "401");
}

/// If `phone.json` cannot be written, nothing changes: the file and what the app shows say the same, and a restart does
/// not reopen the service with the key the user turned off.
#[test]
fn if_the_state_cannot_be_saved_turning_off_and_a_new_key_change_nothing() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let (key, cookie) = (p.key(), p.enter());
    // a folder where the file is written first: every save fails
    std::fs::create_dir(p.data.path().join("phone.json.tmp")).unwrap();
    assert!(p.t.new_key().is_err());
    assert_eq!(p.key(), key);
    assert!(p.t.set_enabled(false).is_err());
    let s = p.t.state();
    assert!(s.enabled && s.listening);
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "200", "the session is still valid: {r}");
    let saved = std::fs::read_to_string(p.data.path().join("phone.json")).unwrap();
    assert!(saved.contains(&key) && saved.contains("\"enabled\": true"), "{saved}");
    // the obstacle gone, it turns off
    std::fs::remove_dir(p.data.path().join("phone.json.tmp")).unwrap();
    assert!(!p.t.set_enabled(false).unwrap().enabled);
}

/// A line break or a NUL inside the URL, a name or a value would become lines of the request to the agent: refused
/// with 400, the agent sees nothing.
#[test]
fn control_characters_in_the_head_are_refused_before_the_agent() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    for (what, request) in [
        ("a line feed in a value", format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nX-A: b\nInjected: yes\r\n\r\n")),
        ("a carriage return in a value", format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nX-A: b\rInjected: yes\r\n\r\n")),
        ("a NUL in the URL", format!("GET /x\0y HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n")),
        ("a line feed in a name", format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\nX\nA: b\r\n\r\n")),
    ] {
        let r = p.send(&request);
        assert_eq!(status(&r), "400", "{what}: {r}");
    }
    assert!(a.received.try_recv().is_err(), "the agent received something");
    // and a normal request still goes through
    assert_eq!(status(&p.send(&format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"))), "200");
}

/// A connection that drips the head does not hold its thread beyond a time limit, and the open connections have a cap.
#[test]
fn slow_heads_and_too_many_connections_are_cut() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let started = std::time::Instant::now();
    let mut slow = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
    slow.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    slow.write_all(b"GET / HTTP/1.1\r\n").unwrap();
    let mut buf = [0u8; 512];
    // one byte at a time, never finishing: the reply (400) comes at the limit, not when the phone stops
    let reply = loop {
        if slow.write_all(b"X").is_err() {
            break String::new();
        }
        match slow.read(&mut buf) {
            Ok(n) if n > 0 => break String::from_utf8_lossy(&buf[..n]).into_owned(),
            _ => {}
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the head was never cut");
    };
    assert!(reply.starts_with("HTTP/1.1 400"), "{reply}");

    let idle: Vec<TcpStream> = (0..crate::http::MAX_CONNECTIONS).map(|_| TcpStream::connect(("127.0.0.1", p.port)).unwrap()).collect();
    std::thread::sleep(Duration::from_millis(300));
    let mut extra = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
    extra.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let _ = extra.write_all(b"GET /phone HTTP/1.1\r\n\r\n");
    assert!(matches!(extra.read(&mut buf), Ok(0) | Err(_)), "a connection over the cap was served");
    drop(idle);
}

/// Whoever is on the network cannot fill the disk through `phone.log`: the path of a refused request is cut, the file
/// is rotated, and the refusals of a minute are limited.
#[test]
fn the_log_does_not_grow_without_limit() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let long = "a".repeat(5000);
    for _ in 0..(crate::REFUSALS_PER_MINUTE + 50) {
        assert_eq!(status(&p.send(&format!("GET /{long} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"))), "401");
    }
    let log = p.log();
    let refused = log.lines().filter(|l| l.contains("\"refused\"")).count();
    assert_eq!(refused, crate::REFUSALS_PER_MINUTE, "{log}");
    assert!(log.lines().all(|l| l.len() < 600), "a line carries the whole path");
    assert!(log.contains("more refusals not written"), "{log}");
    // rotation: the old file stays as `phone.1.log`, the new one starts small
    let filler = "x".repeat(10_000);
    for _ in 0..(crate::LOG_MAX / 10_000 + 20) {
        p.t.d.log(serde_json::json!({ "event": "filler", "text": filler }));
    }
    let logs = p.data.path().join("logs");
    assert!(logs.join("phone.1.log").is_file());
    assert!(std::fs::metadata(logs.join("phone.log")).unwrap().len() < crate::LOG_MAX);
}

#[test]
fn turning_off_also_closes_the_open_events() {
    // The agent sends the head and an event, then keeps the stream open.
    let a = agent("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {}\n\n");
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.t.d.listener.lock().unwrap().take().unwrap().close();
    let t = Phone::new(p.data.path(), &p.data.path().join("logs"), true, p.port, p.preview_port, a.port, p.reports.clone(), p.computer.clone()).unwrap();
    assert!(t.state().listening);
    let r = p.send(&format!("GET /x HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "200");
}

#[test]
fn at_most_twenty_sessions() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
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

/// What a browser sends to open a page or a frame: the only requests whose HTML gets the script.
fn preview_page(p: &Fixture, cookie: &str, path: &str) -> String {
    p.send_preview(&format!(
        "GET {path} HTTP/1.1\r\nHost: {{host}}\r\nAccept: text/html\r\nSec-Fetch-Dest: document\r\nSec-Fetch-Mode: navigate\r\n{}\r\n",
        with_cookie(cookie)
    ))
}

/// A call a page makes with `fetch` or `XMLHttpRequest`: whatever the type it asks for, the reply is not a page.
fn preview_fetch(p: &Fixture, cookie: &str, path: &str, accept: &str) -> String {
    p.send_preview(&format!(
        "GET {path} HTTP/1.1\r\nHost: {{host}}\r\nAccept: {accept}\r\nSec-Fetch-Dest: empty\r\nSec-Fetch-Mode: cors\r\nAccept-Encoding: gzip\r\n{}\r\n",
        with_cookie(cookie)
    ))
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
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(site.join("link")).arg(root.path().join("outside")).creation_flags(mango_common::CREATE_NO_WINDOW).output().unwrap();
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
    let mut p = fixture(&a);
    assert!(TcpStream::connect(("127.0.0.1", p.preview_port)).is_err());
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    assert_eq!(status(&preview_get(&p, &cookie, "/")), "200");
    assert!(shown.received.recv().unwrap().contains(&format!("Host: localhost:{}\r\n", shown.port)));
}

#[test]
fn a_page_that_is_not_the_computers_is_never_relayed() {
    let a = agent(OK);
    let server = agent(OK);
    let mut p = fixture(&a);
    p.on();
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
    assert!(r.contains("<h1>") && r.contains(&mango_common::tr!("«Apri» sulla scheda del file", "“Open” on the file card")), "{r}");
    assert!(server.received.try_recv().is_err() && a.received.try_recv().is_err());
}

#[test]
fn a_server_that_does_not_answer_is_said_in_a_page() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://127.0.0.1:{}/", free_port()), None);
    let r = preview_get(&p, &cookie, "/");
    assert_eq!(status(&r), "502", "{r}");
    assert!(r.contains("text/html"));
}

#[test]
fn a_redirect_to_the_pages_own_address_comes_back_as_a_path() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let site = Site::new();
    p.show("file:///site/index.html", Some(&site.dir().join("index.html")));

    let r = preview_page(&p, &cookie, "/");
    assert_eq!(status(&r), "200", "{r}");
    assert!(r.contains("Content-Type: text/html") && body(&r) == format!("<html>{SCRIPT_TAG}home</html>") && r.contains("nosniff"), "{r}");
    let r = preview_get(&p, &cookie, "/style.css?v=2");
    assert!(r.contains("Content-Type: text/css") && body(&r) == "body{}", "{r}");
    assert_eq!(body(&preview_get(&p, &cookie, "/sub/app.js")), "1;");
    assert_eq!(body(&preview_page(&p, &cookie, "/sub/")), format!("<html>{SCRIPT_TAG}sub</html>"));
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    assert_eq!(body(&preview_page(&p, &cookie, "/")), format!("<html>{SCRIPT_TAG}home</html>"));

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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
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
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let r = p.send(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\n{}Accept: text/html\r\n\r\n", with_cookie(&cookie)));
    assert!(r.contains(&format!("Content-Security-Policy: default-src 'self'; frame-src 'self' blob: http://127.0.0.1:{}\r\n", p.preview_port)), "{r}");
}

#[test]
fn the_port_is_open_only_on_the_addresses_of_the_links() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    assert!(TcpStream::connect(("127.0.0.1", p.port)).is_ok());
    // a port on all the networks would answer on every address of the computer
    assert!(TcpStream::connect(("127.0.0.2", p.port)).is_err());
    assert!(TcpStream::connect(("127.0.0.2", p.preview_port)).is_err());
}

// ---------------------------------------------------------------- the computer's addresses in the pages (loopback relay)

const SCRIPT_TAG: &str = "<script src=\"/__mango_loopback.js\"></script>";

/// A fake server whose reply is an HTML page.
fn html_agent(page: &str) -> Agent {
    agent(Box::leak(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).into_boxed_str()))
}

fn loopback_get(p: &Fixture, cookie: &str, host: &str, port: u16, path: &str) -> String {
    preview_get(p, cookie, &format!("/__mango_loopback/{host}/{port}{path}"))
}

#[test]
fn the_page_of_the_computer_carries_a_script_that_sends_its_calls_to_the_phone_port() {
    let page = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    let shown = html_agent(page);
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nAccept: text/html\r\nAccept-Encoding: gzip, br\r\n{}\r\n", with_cookie(&cookie)));
    assert_eq!(status(&r), "200", "{r}");
    let expected = page.replace("<head>", &format!("<head>{SCRIPT_TAG}"));
    assert_eq!(body(&r), expected);
    assert!(r.contains(&format!("Content-Length: {}\r\n", expected.len())), "{r}");
    assert!(!r.contains("Transfer-Encoding") && !r.contains("Content-Encoding"), "{r}");
    // the page is asked for without compression, so that it can be read
    let asked = shown.received.recv().unwrap();
    assert!(asked.contains("Accept-Encoding: identity\r\n") && !asked.contains("gzip"), "{asked}");
}

#[test]
fn the_script_goes_where_a_page_can_take_it_first() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    for (page, expected) in [
        ("<HEAD data-x=\"1\"><title>x</title></HEAD>", format!("<HEAD data-x=\"1\">{SCRIPT_TAG}<title>x</title></HEAD>")),
        ("<!doctype html><html lang=\"it\"><body>hi</body></html>", format!("<!doctype html><html lang=\"it\">{SCRIPT_TAG}<body>hi</body></html>")),
        ("<!-- <head> --><body>hi</body>", format!("<!-- <head> -->{SCRIPT_TAG}<body>hi</body>")),
        ("hello", format!("{SCRIPT_TAG}hello")),
        ("<header>not the head</header>", format!("{SCRIPT_TAG}<header>not the head</header>")),
    ] {
        let shown = html_agent(page);
        p.show(&format!("http://127.0.0.1:{}/", shown.port), None);
        let r = preview_page(&p, &cookie, "/");
        assert_eq!(body(&r), expected, "{page}");
    }
}

#[test]
fn a_page_in_pieces_is_put_together_and_what_is_not_a_readable_page_passes_as_it_is() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();

    let chunked = agent("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\n<head>\r\n5\r\nhello\r\n0\r\n\r\n");
    p.show(&format!("http://127.0.0.1:{}/", chunked.port), None);
    let r = preview_page(&p, &cookie, "/");
    assert_eq!(body(&r), format!("<head>{SCRIPT_TAG}hello"), "{r}");
    assert!(r.contains("Content-Length: ") && !r.contains("Transfer-Encoding"), "{r}");

    // already compressed whatever was asked: its bytes are not touched
    let packed = agent("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: 11\r\nConnection: close\r\n\r\n<head>xxxxx");
    p.show(&format!("http://127.0.0.1:{}/", packed.port), None);
    let r = preview_page(&p, &cookie, "/");
    assert!(r.contains("Content-Encoding: gzip\r\n") && body(&r) == "<head>xxxxx" && !r.contains("__mango_loopback"), "{r}");

    for reply in [
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<head>",
        "HTTP/1.1 304 Not Modified\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<head>",
    ] {
        let other = agent(reply);
        p.show(&format!("http://127.0.0.1:{}/", other.port), None);
        let r = preview_page(&p, &cookie, "/");
        assert!(!r.contains("__mango_loopback"), "{r}");
    }

    // a page too big to hold passes untouched
    let big = format!("<head>{}", "x".repeat(5 * 1024 * 1024));
    let large = html_agent(&big);
    p.show(&format!("http://127.0.0.1:{}/", large.port), None);
    let r = preview_page(&p, &cookie, "/");
    assert_eq!(status(&r), "200");
    assert_eq!(body(&r), big);
}

#[test]
fn the_script_is_given_only_with_the_session() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    assert_eq!(status(&p.send_preview("GET /__mango_loopback.js HTTP/1.1\r\nHost: {host}\r\n\r\n")), "401");
    let r = preview_get(&p, &cookie, "/__mango_loopback.js");
    assert_eq!(status(&r), "200", "{r}");
    assert!(r.contains("Content-Type: text/javascript"), "{r}");
    for call in ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "localhost", "127.0.0.1"] {
        assert!(body(&r).contains(call), "{call}");
    }
    // it is the phone port's own: the panel shows nothing and the script is there all the same
    assert!(a.received.try_recv().is_err());
}

#[test]
fn a_page_reaches_every_port_of_the_computer_on_localhost_and_127_0_0_1() {
    let a = agent(OK);
    let shown = agent(OK);
    let api = agent("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"api\":true}");
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    let own = shown.port;
    for (host, port) in [("localhost", api.port), ("127.0.0.1", api.port), ("localhost", own), ("127.0.0.1", own)] {
        let r = p.send_preview(&format!(
            "GET /__mango_loopback/{host}/{port}/api/items?page=2&q=a%20b HTTP/1.1\r\nHost: {{host}}\r\nCookie: theme=dark; mango_phone={cookie}\r\nReferer: http://x/\r\n\r\n"
        ));
        assert_eq!(status(&r), "200", "{host}:{port}: {r}");
        let received = if port == api.port { api.received.recv().unwrap() } else { shown.received.recv().unwrap() };
        assert!(received.starts_with("GET /api/items?page=2&q=a%20b HTTP/1.1\r\n"), "{received}");
        assert!(received.contains(&format!("Host: {host}:{port}\r\n")), "{received}");
        // the server of the computer gets its own cookies and never the phone's session
        assert!(received.contains("Cookie: theme=dark\r\n") && !received.contains("mango_phone"), "{received}");
        assert!(!received.to_ascii_lowercase().contains("referer"), "{received}");
    }
    let r = loopback_get(&p, &cookie, "localhost", api.port, "/");
    assert_eq!(body(&r), "{\"api\":true}", "{r}");
    api.received.recv().unwrap();
    // a body goes through, and the Origin is the one the computer's browser would send: the shown page's
    let r = p.send_preview(&format!(
        "POST /__mango_loopback/127.0.0.1/{}/save HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://127.0.0.1:{}\r\n{}Content-Length: 5\r\n\r\nhello",
        api.port,
        p.preview_port,
        with_cookie(&cookie)
    ));
    assert_eq!(status(&r), "200", "{r}");
    let received = api.received.recv().unwrap();
    assert!(received.starts_with("POST /save HTTP/1.1\r\n") && received.ends_with("hello"), "{received}");
    assert!(received.contains(&format!("Origin: http://localhost:{own}\r\n")), "{received}");
    assert!(a.received.try_recv().is_err());
}

#[test]
fn a_call_to_the_computer_needs_the_phones_session_and_the_checks_of_the_port() {
    let a = agent(OK);
    let api = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let path = format!("/__mango_loopback/localhost/{}/api", api.port);
    for request in [
        format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\n\r\n"),
        format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone=made-up\r\n\r\n"),
        format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={}\r\n\r\n", p.key()),
    ] {
        assert_eq!(status(&p.send_preview(&request)), "401", "{request}");
    }
    let c = with_cookie(&cookie);
    assert_eq!(status(&p.send_preview(&format!("GET {path} HTTP/1.1\r\nHost: mango.example\r\n{c}\r\n"))), "403");
    assert_eq!(status(&p.send_preview(&format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\nOrigin: https://foreign-site.example\r\n{c}\r\n"))), "403");
    assert_eq!(status(&p.send_preview(&format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://127.0.0.1:{}\r\n{c}\r\n", p.port))), "403");
    assert_eq!(status(&p.send_preview(&format!("TRACE {path} HTTP/1.1\r\nHost: {{host}}\r\n{c}\r\n"))), "405");
    assert!(api.received.try_recv().is_err());
    // the main port has no such route: it goes to the agent like any other path
    let r = p.send(&format!("GET {path} HTTP/1.1\r\nHost: {{host}}\r\n{c}\r\n"));
    assert_eq!(status(&r), "200");
    assert!(a.received.recv().unwrap().starts_with(&format!("GET {path} ")) && api.received.try_recv().is_err());
}

#[test]
fn no_other_address_than_the_computers_own_loopback_is_ever_reached() {
    let a = agent(OK);
    let api = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let n = api.port;
    for path in [
        format!("/__mango_loopback/192.168.1.5/{n}/x"),
        format!("/__mango_loopback/example.com/{n}/x"),
        format!("/__mango_loopback/localhost.evil.com/{n}/x"),
        format!("/__mango_loopback/127.0.0.1.nip.io/{n}/x"),
        format!("/__mango_loopback/127.0.0.2/{n}/x"),
        format!("/__mango_loopback/0.0.0.0/{n}/x"),
        format!("/__mango_loopback/[::1]/{n}/x"),
        format!("/__mango_loopback/%6cocalhost/{n}/x"),
        format!("/__mango_loopback/LOCALHOST/{n}/x"),
        format!("/__mango_loopback/localhost@evil.com/{n}/x"),
        format!("/__mango_loopback/localhost:{n}/x"),
        "/__mango_loopback/localhost/0/x".to_string(),
        "/__mango_loopback/localhost/65536/x".to_string(),
        format!("/__mango_loopback/localhost/{n}x/x"),
        format!("/__mango_loopback/localhost/+{n}/x"),
        "/__mango_loopback/localhost//x".to_string(),
        "/__mango_loopback/localhost".to_string(),
        "/__mango_loopback/".to_string(),
        "/__mango_loopback".to_string(),
        format!("/__mango_loopback/localhost/{n}x"),
    ] {
        let r = preview_get(&p, &cookie, &path);
        assert!(["400", "404"].contains(&status(&r)), "{path}: {r}");
    }
    assert!(api.received.try_recv().is_err() && a.received.try_recv().is_err());
    // the same port, in the two names that are the loopback, does arrive
    assert_eq!(status(&loopback_get(&p, &cookie, "localhost", n, "")), "200");
    assert!(api.received.recv().unwrap().starts_with("GET / HTTP/1.1\r\n"));
}

#[test]
fn a_page_cannot_reach_the_agent_nor_any_port_of_the_app_through_the_route() {
    let a = agent(OK);
    let engine = agent(OK);
    let voice = agent(OK);
    let dev = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    *p.computer.owned.lock().unwrap() = vec![engine.port, voice.port];
    p.show("file:///site/index.html", Some(Path::new("C:/site/index.html")));
    let pp = p.preview_port;
    for (host, port) in [
        ("127.0.0.1", a.port),
        ("localhost", a.port),
        ("127.0.0.1", engine.port),
        ("localhost", voice.port),
        ("127.0.0.1", p.port),
        ("localhost", p.preview_port),
    ] {
        for path in ["/", "/session", "/mango/state", "/mango/reload"] {
            let r = loopback_get(&p, &cookie, host, port, path);
            assert_eq!(status(&r), "403", "{host}:{port}{path}: {r}");
        }
        // what a hostile page does: a call with the preview's own Origin, and a socket
        let r = p.send_preview(&format!(
            "POST /__mango_loopback/{host}/{port}/session HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://127.0.0.1:{pp}\r\n{}Content-Length: 2\r\n\r\n{{}}",
            with_cookie(&cookie)
        ));
        assert_eq!(status(&r), "403", "{host}:{port}: {r}");
        let r = p.send_preview(&format!(
            "GET /__mango_loopback/{host}/{port}/event HTTP/1.1\r\nHost: {{host}}\r\nOrigin: http://127.0.0.1:{pp}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n{}\r\n",
            with_cookie(&cookie)
        ));
        assert_eq!(status(&r), "403", "{host}:{port}: {r}");
    }
    assert!(a.received.try_recv().is_err() && engine.received.try_recv().is_err() && voice.received.try_recv().is_err());
    assert!(p.log().contains("a port of the app"), "{}", p.log());

    // the app's ports are asked at every call: one that starts later is shut at once, and the user's own servers stay open
    let later = agent(OK);
    assert_eq!(status(&loopback_get(&p, &cookie, "127.0.0.1", later.port, "/")), "200");
    later.received.recv().unwrap();
    p.computer.owned.lock().unwrap().push(later.port);
    assert_eq!(status(&loopback_get(&p, &cookie, "127.0.0.1", later.port, "/")), "403");
    assert!(later.received.try_recv().is_err());
    assert_eq!(status(&loopback_get(&p, &cookie, "127.0.0.1", dev.port, "/")), "200");
    assert!(dev.received.recv().unwrap().starts_with("GET / HTTP/1.1\r\n"));
}

#[test]
fn the_origin_of_a_call_is_the_one_the_computer_gives_the_page_the_panel_shows() {
    let a = agent(OK);
    let shown = agent(OK);
    let other = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let preview = format!("http://127.0.0.1:{}", p.preview_port);
    p.show(&format!("http://localhost:{}/", shown.port), None);
    let post = |host: &str, port: u16, origin: Option<&str>| {
        let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
        p.send_preview(&format!("POST /__mango_loopback/{host}/{port}/x HTTP/1.1\r\nHost: {{host}}\r\n{origin}{}Content-Length: 0\r\n\r\n", with_cookie(&cookie)))
    };
    let origin_of = |s: &Agent| s.received.recv().unwrap().lines().find(|l| l.starts_with("Origin:")).map(str::to_string);

    // every server of the computer, the page's own under either name or another one, sees the page's origin on the
    // computer, as the computer's browser would send it: a server that lets that page call it lets the phone too
    let page = format!("Origin: http://localhost:{}", shown.port);
    assert_eq!(status(&post("127.0.0.1", other.port, Some(&preview))), "200");
    assert_eq!(origin_of(&other), Some(page.clone()));
    assert_eq!(status(&post("localhost", shown.port, Some(&preview))), "200");
    assert_eq!(origin_of(&shown), Some(page.clone()));
    assert_eq!(status(&post("127.0.0.1", shown.port, Some(&preview))), "200");
    assert_eq!(origin_of(&shown), Some(page));
    // no Origin from the page, none made up
    assert_eq!(status(&post("127.0.0.1", other.port, None)), "200");
    assert_eq!(origin_of(&other), None);
}

#[test]
fn a_redirect_from_a_server_of_the_computer_stays_in_the_route() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let redirect = |location: &str| {
        let reply = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        agent(Box::leak(reply.into_boxed_str()))
    };
    let location = |r: &str| r.lines().find_map(|l| l.strip_prefix("Location: ")).unwrap_or("").to_string();
    let anywhere = agent(OK).port;
    for (host, written, expected) in [
        ("localhost", "http://127.0.0.1:4000/api/".to_string(), "/__mango_loopback/127.0.0.1/4000/api/".to_string()),
        ("localhost", "http://localhost:4000".to_string(), "/__mango_loopback/localhost/4000/".to_string()),
        ("localhost", "HTTP://LocalHost/a?b=1#top".to_string(), "/__mango_loopback/localhost/80/a?b=1#top".to_string()),
        ("localhost", "//127.0.0.1:4000/a".to_string(), "/__mango_loopback/127.0.0.1/4000/a".to_string()),
        ("localhost", format!("http://localhost:{anywhere}/back"), format!("/__mango_loopback/localhost/{anywhere}/back")),
        // an address of the server itself stays in the same place
        ("127.0.0.1", "/login?next=%2F".to_string(), "/__mango_loopback/127.0.0.1/{port}/login?next=%2F".to_string()),
        // not an address of the computer, or relative to the request: left as it is
        ("localhost", "login".to_string(), "login".to_string()),
        ("localhost", "?page=2".to_string(), "?page=2".to_string()),
        ("localhost", "http://example.com/x".to_string(), "http://example.com/x".to_string()),
        ("localhost", "https://localhost:3000/".to_string(), "https://localhost:3000/".to_string()),
        ("localhost", "http://localhost.evil.com:3000/".to_string(), "http://localhost.evil.com:3000/".to_string()),
        ("localhost", "http://127.0.0.2:3000/".to_string(), "http://127.0.0.2:3000/".to_string()),
    ] {
        let server = redirect(&written);
        let r = loopback_get(&p, &cookie, host, server.port, "/start");
        assert_eq!(status(&r), "302", "{written}: {r}");
        assert_eq!(location(&r), expected.replace("{port}", &server.port.to_string()), "{written}");
    }

    // the page the panel shows: another address of the computer goes through the route too
    for (written, expected) in [
        ("http://localhost:4000/api/", "/__mango_loopback/localhost/4000/api/"),
        ("/same", "/same"),
        ("http://example.com/", "http://example.com/"),
    ] {
        let page = redirect(written);
        p.show(&format!("http://localhost:{}/", page.port), None);
        let r = preview_get(&p, &cookie, "/start");
        assert_eq!(location(&r), expected, "{written}: {r}");
    }
}
#[test]
fn a_web_socket_to_a_port_of_the_computer_passes_both_ways() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, asked) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut c, _) = l.accept().unwrap();
        let mut head = Vec::new();
        let mut b = [0u8; 1024];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = c.read(&mut b).unwrap();
            head.extend_from_slice(&b[..n]);
        }
        tx.send(String::from_utf8_lossy(&head).into_owned()).unwrap();
        c.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n").unwrap();
        let n = c.read(&mut b).unwrap();
        c.write_all(&b[..n]).unwrap();
    });
    // the panel shows another server: the socket goes where its address says
    let shown = agent(OK);
    p.show(&format!("http://127.0.0.1:{}/", shown.port), None);
    let mut c = TcpStream::connect(("127.0.0.1", p.preview_port)).unwrap();
    c.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    write!(
        c,
        "GET /__mango_loopback/localhost/{port}/live?room=1 HTTP/1.1\r\nHost: 127.0.0.1:{pp}\r\nOrigin: http://127.0.0.1:{pp}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n{}\r\n",
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
    let received = asked.recv().unwrap();
    assert!(received.starts_with("GET /live?room=1 HTTP/1.1\r\n") && received.contains(&format!("Host: localhost:{port}\r\n")), "{received}");
    assert!(received.contains(&format!("Origin: http://127.0.0.1:{}\r\n", shown.port)) && !received.contains("mango_phone"), "{received}");
    assert!(shown.received.try_recv().is_err());
}

#[test]
fn a_socket_without_the_session_is_refused() {
    let a = agent(OK);
    let api = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let r = p.send_preview(&format!(
        "GET /__mango_loopback/localhost/{}/live HTTP/1.1\r\nHost: {{host}}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        api.port
    ));
    assert_eq!(status(&r), "401", "{r}");
    assert!(api.received.try_recv().is_err());
}

#[test]
fn a_local_page_carries_the_script_too_and_other_files_do_not() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let site = Site::new();
    let dir = site.dir();
    std::fs::write(dir.join("with-head.html"), "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>é</body></html>").unwrap();
    std::fs::write(dir.join("latin.html"), b"<html><body>caf\xe9</body></html>").unwrap();
    std::fs::write(dir.join("big.html"), format!("<html>{}", "x".repeat(5 * 1024 * 1024))).unwrap();
    p.show("file:///site/with-head.html", Some(&dir.join("with-head.html")));

    let r = preview_page(&p, &cookie, "/");
    let expected = format!("<!doctype html><html><head>{SCRIPT_TAG}<meta charset=\"utf-8\"></head><body>é</body></html>");
    assert_eq!(body(&r), expected, "{r}");
    assert!(r.contains(&format!("Content-Length: {}\r\n", expected.len())) && r.contains("nosniff"), "{r}");

    // only a whole page that can be read is changed: a part, the head of a request, a page that is not UTF-8 or too big, and every other file
    let r = p.send_preview(&format!("GET /with-head.html HTTP/1.1\r\nHost: {{host}}\r\n{}Range: bytes=0-5\r\n\r\n", with_cookie(&cookie)));
    assert!(status(&r) == "206" && body(&r) == "<!doct", "{r}");
    let r = p.send_preview(&format!("HEAD /with-head.html HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(&cookie)));
    assert!(status(&r) == "200" && body(&r).is_empty() && !r.contains(&format!("Content-Length: {}\r\n", expected.len())), "{r}");
    assert!(!preview_page(&p, &cookie, "/latin.html").contains("__mango_loopback"));
    let r = preview_page(&p, &cookie, "/big.html");
    assert!(status(&r) == "200" && !r.contains("__mango_loopback"), "{}", &r[..200]);
    assert!(!preview_get(&p, &cookie, "/style.css").contains("__mango_loopback"));
    assert!(!std::fs::read_to_string(dir.join("with-head.html")).unwrap().contains("__mango_loopback"));
}

#[test]
fn only_a_page_opened_by_the_browser_gets_the_script_not_the_fragments_a_page_asks_for() {
    let page = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    let shown = html_agent(page);
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    let with_script = page.replace("<head>", &format!("<head>{SCRIPT_TAG}"));

    // a fragment (an htmx swap, a template fetched by a script) is the server's own, whatever it accepts: the compression it asked for stays
    for accept in ["text/html", "*/*", "text/html,application/xhtml+xml"] {
        let r = preview_fetch(&p, &cookie, "/fragment", accept);
        assert_eq!(body(&r), page, "{accept}: {r}");
        assert!(!r.contains("__mango_loopback"), "{r}");
        assert!(shown.received.recv().unwrap().contains("Accept-Encoding: gzip\r\n"));
    }
    // a page, a frame (the web UI shows the panel's page in one) and a browser that sends no Sec-Fetch headers but asks for HTML
    assert_eq!(body(&preview_page(&p, &cookie, "/")), with_script);
    let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nSec-Fetch-Dest: iframe\r\nSec-Fetch-Mode: navigate\r\n{}\r\n", with_cookie(&cookie)));
    assert_eq!(body(&r), with_script, "{r}");
    let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nAccept: text/html,*/*;q=0.8\r\n{}\r\n", with_cookie(&cookie)));
    assert_eq!(body(&r), with_script, "{r}");
    // but nothing says it is a page: it is not one
    let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nAccept: */*\r\n{}\r\n", with_cookie(&cookie)));
    assert_eq!(body(&r), page, "{r}");
    // a script, an image or a worker asked for by the page are not documents either
    for dest in ["script", "image", "worker", "style", "empty"] {
        let r = p.send_preview(&format!("GET / HTTP/1.1\r\nHost: {{host}}\r\nAccept: text/html\r\nSec-Fetch-Dest: {dest}\r\n{}\r\n", with_cookie(&cookie)));
        assert_eq!(body(&r), page, "{dest}: {r}");
    }

    // a local file is the same
    let site = Site::new();
    let dir = site.dir();
    p.show("file:///site/index.html", Some(&dir.join("index.html")));
    assert_eq!(body(&preview_page(&p, &cookie, "/")), format!("<html>{SCRIPT_TAG}home</html>"));
    assert_eq!(body(&preview_fetch(&p, &cookie, "/", "text/html")), "<html>home</html>");
}

/// A server that sends the start of an HTML page without a length and keeps the connection open until the sender is dropped.
fn held_page(start: &'static str) -> (u16, mpsc::Sender<()>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let (hold, held) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let Ok((mut c, _)) = l.accept() else { return };
        let mut b = [0u8; 4096];
        let _ = c.read(&mut b);
        let _ = c.write_all(start.as_bytes());
        let _ = held.recv();
    });
    (port, hold)
}

#[test]
fn a_page_that_does_not_end_is_not_waited_for() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let (port, hold) = held_page("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head></head><body>first part");
    p.show(&format!("http://127.0.0.1:{port}/"), None);
    let mut c = TcpStream::connect(("127.0.0.1", p.preview_port)).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    let started = Instant::now();
    write!(
        c,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/html\r\nSec-Fetch-Dest: document\r\n{}\r\n",
        p.preview_port,
        with_cookie(&cookie)
    )
    .unwrap();
    let mut read = Vec::new();
    let mut b = [0u8; 1024];
    while !String::from_utf8_lossy(&read).contains("first part") {
        let n = c.read(&mut b).unwrap();
        assert!(n > 0, "closed before the page came: {}", String::from_utf8_lossy(&read));
        read.extend_from_slice(&b[..n]);
    }
    // the page arrives as it is, within the short time a page is held, while the server still holds the connection open
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let r = String::from_utf8_lossy(&read);
    assert!(r.starts_with("HTTP/1.1 200") && !r.contains("__mango_loopback"), "{r}");
    // and what comes later still follows
    drop(hold);
    let mut rest = Vec::new();
    let _ = c.read_to_end(&mut rest);
}

#[test]
fn a_page_in_another_character_set_than_utf_8_is_not_changed() {
    let a = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    let utf16 = |bom: &[u8], text: &str| [bom.to_vec(), text.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat();
    let page = utf16(&[0xFF, 0xFE], "<html><head></head></html>");
    let declared = [format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-16le\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", page.len()).into_bytes(), page.clone()].concat();
    let without = [format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", page.len()).into_bytes(), page.clone()].concat();
    let latin = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=ISO-8859-1\r\nContent-Length: 22\r\nConnection: close\r\n\r\n<head></head>caf\xe9 caf\xe9".to_vec();
    for (name, reply, bytes) in [("declared", declared, page.clone()), ("bom only", without, page), ("latin-1", latin, b"<head></head>caf\xe9 caf\xe9".to_vec())] {
        let server = agent_bytes(reply);
        p.show(&format!("http://127.0.0.1:{}/", server.port), None);
        let mut c = TcpStream::connect(("127.0.0.1", p.preview_port)).unwrap();
        write!(c, "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/html\r\nSec-Fetch-Dest: document\r\n{}\r\n", p.preview_port, with_cookie(&cookie)).unwrap();
        let mut got = Vec::new();
        c.read_to_end(&mut got).unwrap();
        let at = got.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(&got[at..], bytes.as_slice(), "{name}");
        assert!(!String::from_utf8_lossy(&got[..at]).to_ascii_lowercase().contains("transfer-encoding"), "{name}");
    }
}

fn fetch_site_of(s: &Agent) -> Option<String> {
    s.received.recv().unwrap().lines().find(|l| l.to_ascii_lowercase().starts_with("sec-fetch-site:")).map(str::to_string)
}

#[test]
fn a_call_to_another_server_says_what_the_computer_would_say_about_where_the_page_comes_from() {
    let a = agent(OK);
    let shown = agent(OK);
    let other = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    // the phone's browser says `same-origin`: the call goes to its own port
    let call = |host: &str, port: u16, site: Option<&str>| {
        let site = site.map(|s| format!("Sec-Fetch-Site: {s}\r\nSec-Fetch-Mode: cors\r\n")).unwrap_or_default();
        let r = p.send_preview(&format!("GET /__mango_loopback/{host}/{port}/x HTTP/1.1\r\nHost: {{host}}\r\n{site}{}\r\n", with_cookie(&cookie)));
        assert_eq!(status(&r), "200", "{r}");
    };
    call("localhost", shown.port, Some("same-origin"));
    assert_eq!(fetch_site_of(&shown).as_deref(), Some("Sec-Fetch-Site: same-origin"));
    call("localhost", other.port, Some("same-origin"));
    assert_eq!(fetch_site_of(&other).as_deref(), Some("Sec-Fetch-Site: same-site"));
    call("127.0.0.1", other.port, Some("same-origin"));
    assert_eq!(fetch_site_of(&other).as_deref(), Some("Sec-Fetch-Site: cross-site"));
    call("127.0.0.1", shown.port, Some("same-origin"));
    assert_eq!(fetch_site_of(&shown).as_deref(), Some("Sec-Fetch-Site: cross-site"));
    // a browser that sends none: none is made up
    call("localhost", other.port, None);
    assert_eq!(fetch_site_of(&other), None);
    // a page that is a file of the computer comes from no server: everything is another site
    p.show("file:///site/index.html", Some(Path::new("C:/site/index.html")));
    call("localhost", other.port, Some("same-origin"));
    assert_eq!(fetch_site_of(&other).as_deref(), Some("Sec-Fetch-Site: cross-site"));
    // what the page asks of its own server by a relative address is the page's own: it stays as the browser said
    p.show(&format!("http://localhost:{}/", shown.port), None);
    let r = preview_fetch(&p, &cookie, "/x", "*/*");
    assert_eq!(status(&r), "200", "{r}");
    assert!(shown.received.recv().unwrap().contains("Sec-Fetch-Dest: empty\r\n"));
}

#[test]
fn a_server_of_the_computer_cannot_replace_the_phones_session_with_its_cookies() {
    let a = agent(OK);
    let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nSet-Cookie: theme=dark; Path=/\r\nSet-Cookie: mango_phone=forged; Path=/\r\nset-cookie: mango_phone=; Max-Age=0\r\nSet-Cookie: x_mango_phone=1\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi";
    let shown = agent(reply);
    let other = agent(reply);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", shown.port), None);
    for r in [preview_page(&p, &cookie, "/"), loopback_get(&p, &cookie, "127.0.0.1", other.port, "/")] {
        assert_eq!(status(&r), "200", "{r}");
        let head = r.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
        assert!(head.contains("set-cookie: theme=dark; path=/\r\n") && head.contains("set-cookie: x_mango_phone=1"), "{r}");
        assert!(!head.contains("mango_phone=forged") && !head.contains("set-cookie: mango_phone"), "{r}");
    }
}

#[test]
fn a_page_that_is_a_download_does_not_get_the_script() {
    let a = agent(OK);
    let page = "<html><head></head><body>report</body></html>";
    let attachment = agent(Box::leak(
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Disposition: attachment; filename=\"r.html\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).into_boxed_str(),
    ));
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    p.show(&format!("http://localhost:{}/", attachment.port), None);
    let r = preview_page(&p, &cookie, "/");
    assert_eq!(body(&r), page, "{r}");
    assert!(r.to_ascii_lowercase().contains("content-disposition: attachment"), "{r}");
}

#[test]
fn the_phone_cannot_be_shown_a_page_of_the_app_either() {
    let a = agent(OK);
    let engine = agent(OK);
    let mut p = fixture(&a);
    p.on();
    let cookie = p.enter();
    *p.computer.owned.lock().unwrap() = vec![engine.port];
    for port in [a.port, engine.port, p.port, p.preview_port] {
        p.show(&format!("http://127.0.0.1:{port}/"), None);
        for path in ["/", "/session", "/mango/state", "/mango/reload", "/mango//Processes/"] {
            let r = preview_fetch(&p, &cookie, path, "*/*");
            assert_eq!(status(&r), "403", "{port}{path}: {r}");
        }
    }
    assert!(a.received.try_recv().is_err() && engine.received.try_recv().is_err());
    // what the panel shows is told to the phone as a page it cannot have, not as the app's address
    p.show(&format!("http://127.0.0.1:{}/", engine.port), None);
    let r = p.send(&format!("GET /phone/preview HTTP/1.1\r\nHost: {{host}}\r\n{}\r\n", with_cookie(&cookie)));
    let told = serde_json::from_str::<serde_json::Value>(body(&r)).unwrap();
    assert_eq!(told["page"]["local"], false, "{r}");
    assert_eq!(told["page"]["label"], "", "{r}");
    // and the phone cannot ask the panel to open one
    let opened = p.computer.opened.lock().unwrap().len();
    let origin = format!("http://127.0.0.1:{}", p.port);
    for port in [a.port, engine.port, p.port, p.preview_port] {
        let json = format!("{{\"url\":\"http://localhost:{port}/\"}}");
        let r = p.send(&format!("POST /phone/preview HTTP/1.1\r\nHost: {{host}}\r\nOrigin: {origin}\r\n{}Content-Length: {}\r\n\r\n{json}", with_cookie(&cookie), json.len()));
        assert_eq!(status(&r), "403", "{port}: {r}");
    }
    assert_eq!(p.computer.opened.lock().unwrap().len(), opened);
    // a server of the user's is shown and opened as before
    let dev = agent(OK);
    let json = format!("{{\"url\":\"http://localhost:{}/\"}}", dev.port);
    let r = p.send(&format!("POST /phone/preview HTTP/1.1\r\nHost: {{host}}\r\nOrigin: {origin}\r\n{}Content-Length: {}\r\n\r\n{json}", with_cookie(&cookie), json.len()));
    assert_eq!(status(&r), "200", "{r}");
    assert_eq!(status(&preview_fetch(&p, &cookie, "/", "*/*")), "200");
}

#[test]
fn when_the_agent_changes_its_port_the_phone_follows_it() {
    let first = agent(OK);
    let p = fixture(&first);
    p.t.set_enabled(true).unwrap();
    let cookie = p.enter();
    let second = agent(OK);
    p.t.set_agent_port(second.port);
    let r = p.send(&format!("GET /session HTTP/1.1\r\nHost: {{host}}\r\nCookie: mango_phone={cookie}\r\n\r\n"));
    assert_eq!(status(&r), "200", "{r}");
    let received = second.received.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(received.contains(&format!("Host: 127.0.0.1:{}\r\n", second.port)), "{received}");
    assert!(first.received.try_recv().is_err());
}
