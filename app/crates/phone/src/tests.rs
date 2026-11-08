//! The phone port's tests: a fake agent on 127.0.0.1 that remembers the requests, the phone port on 127.0.0.1 (not on
//! all networks: no firewall warnings during the tests) and hand-written requests.

use super::*;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener};
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

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Fixture {
    t: Phone,
    port: u16,
    data: tempfile::TempDir,
}

fn fixture(agent: &Agent) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let port = free_port();
    let t = Phone::new(data.path(), &data.path().join("logs"), Ipv4Addr::LOCALHOST, port, agent.port).unwrap();
    Fixture { t, port, data }
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
    let t = Phone::new(p.data.path(), &p.data.path().join("logs"), Ipv4Addr::LOCALHOST, p.port, a.port).unwrap();
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
