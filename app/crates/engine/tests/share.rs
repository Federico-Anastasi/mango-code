//! The engine shared with other PCs, with the fake engine: the key, the routes, the streaming, turning off. No GPUs, and
//! the ports only on 127.0.0.1 (the addresses of the networks are not touched).

use anyhow::{bail, Result};
use engine::share::{Share, SharedModel, State};
use engine::EngineManager;
use engine_cfg::{EnginePlan, Gpu, Vendor};
use mango_common::{tr, ProcSpec};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[allow(dead_code)] // each test file uses a part of it
mod support;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-engine");

fn planner(log: PathBuf) -> Box<engine::Planner> {
    Box::new(move |key: &str, port: u16, _excluded: &[u32]| -> Result<EnginePlan> {
        if key != "a" {
            bail!("{}", tr!("modello sconosciuto", "unknown model"));
        }
        let url = format!("http://127.0.0.1:{port}");
        Ok(EnginePlan {
            key: key.into(),
            spec: ProcSpec {
                name: "engine-a".into(),
                exe: FAKE.into(),
                args: vec!["-m".into(), r"C:\fake\a.gguf".into(), "--port".into(), port.to_string()],
                env: vec![("FAKE_ENGINE_LOG".into(), log.display().to_string()), ("FAKE_ENGINE_CHUNK_MS".into(), "20".into())],
                env_remove: vec![],
                cwd: None,
                health_url: Some(format!("{url}/health")),
                ready_timeout_s: 20,
                shutdown_post: None,
                startup_post: None,
            },
            url,
            label: "Model A".into(),
            ctx: 4096,
            images: false,
            gpus_used: vec![Gpu { index: 0, name: "GPU 0".into(), vendor: Vendor::Nvidia, memory_mib: 8192, cuda_driver: Some((12, 6)), cc: Some((8, 6)) }],
            gguf: r"C:\fake\a.gguf".into(),
        })
    })
}

struct Fixture {
    m: EngineManager,
    share: Share,
    port: u16,
    log: PathBuf,
    dir: tempfile::TempDir,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let m = EngineManager::new(planner(log.clone()), Box::new(Vec::new), dir.path());
    engine::http::serve(m.clone(), free_port(), None).unwrap();
    let port = free_port();
    let share = Share::new(dir.path(), m.clone(), port, true).unwrap();
    share.set_models(vec![SharedModel { key: "a".into(), label: "Model A".into(), context: 4096, images: false }]);
    Fixture { m, share, port, log, dir }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.share.set_enabled(false);
        self.m.stop();
    }
}

impl Fixture {
    fn on(&self) -> (State, String) {
        let state = self.share.set_enabled(true).unwrap();
        let code = state.home.as_ref().expect("an address while on").code.clone();
        let key = code.rsplit('/').next().unwrap().to_string();
        (state, key)
    }

    fn url(&self, p: &str) -> String {
        format!("http://127.0.0.1:{}{p}", self.port)
    }

    /// A request written by hand: (status, body). `extra`: header lines.
    fn raw(&self, method: &str, path: &str, extra: &str, body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{extra}Content-Length: {}\r\n\r\n{body}", self.port, body.len()).unwrap();
        let mut text = String::new();
        let _ = s.read_to_string(&mut text);
        let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (status, text.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn with_key(&self, method: &str, path: &str, key: &str, body: &str) -> (u16, String) {
        self.raw(method, path, &format!("Authorization: Bearer {key}\r\nContent-Type: application/json\r\n"), body)
    }
}

fn closed(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_err()
}

#[test]
fn off_by_default_and_the_port_is_closed() {
    let b = fixture();
    let s = b.share.state();
    assert!(!s.enabled && !s.listening && s.home.is_none() && s.away.is_none(), "{s:?}");
    assert!(closed(b.port));
    assert!(!b.dir.path().join("engine-share.json").exists());
}

#[test]
fn the_right_key_gets_the_models_and_the_streaming_reply() {
    let b = fixture();
    let (state, key) = b.on();
    assert_eq!(state.home.as_ref().unwrap().address, format!("127.0.0.1:{}", b.port));
    assert_eq!(state.home.unwrap().code, format!("mango://127.0.0.1:{}/{key}", b.port));
    assert_eq!(key.len(), 48);

    let (status, body) = b.with_key("GET", "/mango/models", &key, "");
    assert_eq!(status, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["models"], json!([{ "key": "a", "label": "Model A", "context": 4096, "images": false }]));

    let r = support::ok(support::post(
        &b.url("/v1/chat/completions"),
        &[("Authorization", &format!("Bearer {key}")), ("Content-Type", "application/json")],
        &json!({ "model": "a", "stream": true, "messages": [{ "role": "user", "content": "who are you?" }] }).to_string(),
    ));
    assert_eq!(support::content_type(&r), Some("text/event-stream"));
    let mut pieces = 0;
    for line in BufReader::new(r.into_body().into_reader()).lines() {
        let line = line.unwrap();
        let Some(data) = line.strip_prefix("data: ") else { continue };
        if data == "[DONE]" {
            break;
        }
        pieces += usize::from(serde_json::from_str::<Value>(data).unwrap()["choices"][0]["delta"]["content"].is_string());
    }
    assert!(pieces > 1, "the reply came whole, not in pieces: {pieces}");
    assert!(b.with_key("GET", "/mango/models", &key, "").1.contains("\"running\":\"a\""));

    // The key is for the manager: the engine never sees it.
    let log = std::fs::read_to_string(&b.log).unwrap();
    assert!(!log.contains(&key) && !log.to_lowercase().contains("authorization"), "{log}");
}

#[test]
fn without_the_right_key_nothing_passes() {
    let b = fixture();
    let (_, key) = b.on();
    let wrong = "0".repeat(48);
    for (key, path) in [(None, "/mango/models"), (Some(wrong.as_str()), "/mango/models"), (Some(wrong.as_str()), "/v1/models"), (Some(""), "/engine")] {
        let (status, body) = match key {
            Some(k) => b.with_key("GET", path, k, ""),
            None => b.raw("GET", path, "", ""),
        };
        assert_eq!(status, 401, "{path}: {body}");
        assert!(body.contains("chiave") || body.contains("key"), "{body}");
    }
    // A key that is the right one with something added or missing is not it.
    assert_eq!(b.with_key("GET", "/health", &format!("{key}0"), "").0, 401);
    assert_eq!(b.with_key("GET", "/health", &key[1..], "").0, 401);
    assert_eq!(b.with_key("GET", "/health", &key, "").0, 503, "the engine has not started yet: 503 says so, the key was right");
}

#[test]
fn only_the_shared_routes_pass_with_the_right_key() {
    let b = fixture();
    let (_, key) = b.on();
    b.with_key("POST", "/v1/chat/completions", &key, &json!({ "model": "a", "messages": [] }).to_string());
    for (method, path) in [("GET", "/health"), ("GET", "/props"), ("GET", "/slots"), ("GET", "/engine"), ("GET", "/metrics")] {
        let status = b.with_key(method, path, &key, "").0;
        assert!(matches!(status, 200 | 404), "{method} {path}: {status}");
    }
    // The loans of the GPUs, the engine's writes and the ways round them stay for the apps of this PC.
    for (method, path) in [
        ("POST", "/engine/release"),
        ("POST", "/engine/resume"),
        ("POST", "/engine/model"),
        ("POST", "/slots/0?action=erase"),
        ("POST", "/props"),
        ("POST", "/tokenize"),
        ("DELETE", "/v1/models"),
        ("GET", "/v1/../engine/release"),
        ("GET", "/v1/%2e%2e/engine"),
        ("GET", "//engine/release"),
        ("GET", "/Engine"),
        ("GET", "/"),
        ("GET", "/control/state"),
        ("POST", "/control/model/use"),
    ] {
        let (status, body) = b.with_key(method, path, &key, "{}");
        assert_eq!(status, 403, "{method} {path}: {body}");
    }
    assert!(b.m.state().loans.is_empty());
}

#[test]
fn a_web_page_and_a_name_are_refused_even_with_the_key() {
    let b = fixture();
    let (_, key) = b.on();
    let (status, _) = b.with_key("GET", "/mango/models", &key, "");
    assert_eq!(status, 200);
    assert_eq!(b.raw("GET", "/mango/models", &format!("Authorization: Bearer {key}\r\nOrigin: http://evil.example\r\n"), "").0, 403);
    let mut s = TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    write!(s, "GET /mango/models HTTP/1.1\r\nHost: pc.example:{}\r\nAuthorization: Bearer {key}\r\n\r\n", b.port).unwrap();
    let mut text = String::new();
    let _ = s.read_to_string(&mut text);
    assert!(text.starts_with("HTTP/1.1 403"), "{text}");
    // the sentence says what to do, without an example address
    assert!(text.contains(&mango_common::tr!("copia di nuovo il codice", "copy the code again")) && !text.contains("192.168"), "{text}");
}

#[test]
fn a_refused_request_is_answered_before_its_body_is_read() {
    let b = fixture();
    b.on();
    let mut s = TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // 200 MB announced, none sent: a manager that reads the body first would wait for them.
    write!(s, "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 200000000\r\n\r\n", b.port).unwrap();
    let t0 = Instant::now();
    let mut buf = [0u8; 64];
    s.read_exact(&mut buf[..12]).unwrap();
    assert_eq!(&buf[..12], b"HTTP/1.1 401");
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
}

#[test]
fn refusals_leave_a_line_in_the_log_without_the_key() {
    let b = fixture();
    let (_, key) = b.on();
    b.with_key("POST", "/engine/release", &key, "{}");
    b.with_key("GET", "/health", "0000", "");
    let text = std::fs::read_to_string(b.dir.path().join("manager.log")).unwrap();
    let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let refused: Vec<&Value> = lines.iter().filter(|v| v["event"] == "share refused").collect();
    assert_eq!(refused.iter().map(|v| v["outcome"].as_u64().unwrap()).collect::<Vec<_>>(), [403, 401]);
    assert_eq!(refused[0]["path"], "/engine/release");
    assert!(refused[0]["address"].as_str().unwrap().starts_with("127.0.0.1"));
    assert!(!text.contains(&key) && !text.contains("0000"), "{text}");
    assert!(lines.iter().any(|v| v["event"] == "share on"));
}

#[test]
fn turning_off_closes_the_port_and_the_connections_and_the_old_code_never_returns() {
    let b = fixture();
    let (_, key) = b.on();
    let mut open = TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    open.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(open, "GET /mango/models HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap(); // the head never ends

    let off = b.share.set_enabled(false).unwrap();
    assert!(!off.enabled && !off.listening && off.home.is_none(), "{off:?}");
    assert!(closed(b.port));
    let mut buf = [0u8; 8];
    assert!(matches!(open.read(&mut buf), Ok(0) | Err(_)), "the open connection stayed");
    assert!(!std::fs::read_to_string(b.dir.path().join("engine-share.json")).unwrap().contains(&key));

    let (_, again) = b.on();
    assert_ne!(again, key);
    assert_eq!(b.with_key("GET", "/mango/models", &key, "").0, 401);
    assert_eq!(b.with_key("GET", "/mango/models", &again, "").0, 200);
}

#[test]
fn a_new_key_drops_the_old_one_and_stays_on() {
    let b = fixture();
    let (_, key) = b.on();
    let state = b.share.new_key().unwrap();
    let next = state.home.unwrap().code.rsplit('/').next().unwrap().to_string();
    assert_ne!(next, key);
    assert_eq!(b.with_key("GET", "/mango/models", &key, "").0, 401);
    assert_eq!(b.with_key("GET", "/mango/models", &next, "").0, 200);
}

#[test]
fn a_new_key_with_sharing_off_says_so() {
    let b = fixture();
    let e = b.share.new_key().unwrap_err().to_string();
    assert!(e.contains("spenta") || e.contains("off"), "{e}");
}

#[test]
fn on_survives_a_restart_of_the_app_with_the_same_key() {
    let b = fixture();
    let (_, key) = b.on();
    // The app starts again: «on» in the file reopens a port with the same key.
    let again = Share::new(b.dir.path(), b.m.clone(), free_port(), true).unwrap();
    let state = again.state();
    assert!(state.enabled && state.listening, "{state:?}");
    assert!(state.home.as_ref().unwrap().code.ends_with(&key));
    again.set_enabled(false).unwrap();
}

#[test]
fn a_busy_port_is_told_not_hidden() {
    let b = fixture();
    let _taken = std::net::TcpListener::bind(("127.0.0.1", b.port)).unwrap();
    let s = b.share.set_enabled(true).unwrap();
    assert!(s.enabled && !s.listening && s.home.is_none(), "{s:?}");
    assert!(s.error.unwrap().contains(&b.port.to_string()));
}

#[test]
fn too_many_open_connections_are_closed_without_an_answer() {
    let b = fixture();
    b.on();
    let held: Vec<TcpStream> = (0..80).filter_map(|_| TcpStream::connect(("127.0.0.1", b.port)).ok()).collect();
    std::thread::sleep(Duration::from_millis(500));
    let mut refused = 0;
    for mut c in held {
        c.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let mut buf = [0u8; 1];
        refused += usize::from(matches!(c.read(&mut buf), Ok(0)));
    }
    assert!(refused >= 40, "only {refused} closed out of 80");
}

// --- the other side: the PC that uses the engine, with only the code -----------------------------------------------

use engine::remote::{self, Code, Failure};

/// The sentence is in the language of the machine that runs the test: it is looked for in both.
fn says(sentence: &str, it: &str, en: &str) -> bool {
    sentence.contains(it) || sentence.contains(en)
}

impl Fixture {
    /// The code the other PC would paste.
    fn code(&self) -> Code {
        Code::parse(&self.on().0.home.unwrap().code).unwrap()
    }
}

#[test]
fn the_code_the_settings_give_is_read_back_and_never_shows_its_key() {
    let b = fixture();
    let state = b.on().0;
    let home = state.home.unwrap();
    let code = Code::parse(&home.code).unwrap();
    assert_eq!(code.address, home.address);
    assert_eq!(code.base(), format!("http://{}", home.address));
    assert_eq!(home.code, format!("mango://{}/{}", code.address, code.key));
    // The surrounding spaces and line breaks of a paste are not part of it.
    assert_eq!(Code::parse(&format!("  {}\r\n", home.code)).unwrap(), code);
    assert!(!format!("{code:?}").contains(&code.key), "{code:?}");
}

#[test]
fn what_is_not_a_code_is_told_without_repeating_it() {
    let key = "0123456789abcdef".repeat(3);
    for bad in [
        "".to_string(),
        "hello".to_string(),
        format!("http://127.0.0.1:47098/{key}"),
        format!("mango://pc.example:47098/{key}"),
        format!("mango://127.0.0.1/{key}"),
        format!("mango://127.0.0.1:0/{key}"),
        format!("mango://127.0.0.1:70000/{key}"),
        format!("mango://300.0.0.1:47098/{key}"),
        format!("mango://127.0.0.1:47098/{}", &key[1..]),
        format!("mango://127.0.0.1:47098/{}", key.to_uppercase()),
        format!("mango://127.0.0.1:47098/{key}/extra"),
        format!("mango://127.0.0.1:47098/{key} mango://127.0.0.1:47098/{key}"),
    ] {
        let e = Code::parse(&bad).unwrap_err();
        assert!(matches!(e, Failure::BadCode), "{bad}");
        let sentence = e.to_string();
        assert!(says(&sentence, "Copia il codice", "Copy the code"), "{sentence}");
        assert!(!sentence.contains(&key) && !sentence.contains("pc.example"), "{sentence}");
    }
}

#[test]
fn the_right_code_gets_the_models_and_which_one_runs() {
    let b = fixture();
    let code = b.code();
    let offered = remote::verify(&code).unwrap();
    assert_eq!(offered.models.len(), 1);
    assert_eq!((offered.models[0].key.as_str(), offered.models[0].label.as_str(), offered.models[0].context), ("a", "Model A", 4096));
    assert_eq!(offered.running, None, "nothing is running yet");
    b.with_key("POST", "/v1/chat/completions", &code.key, &json!({ "model": "a", "messages": [{ "role": "user", "content": "hi" }] }).to_string());
    assert_eq!(remote::verify(&code).unwrap().running.as_deref(), Some("a"));
}

#[test]
fn a_wrong_key_or_sharing_turned_off_says_the_code_is_not_valid_or_the_sharing_is_off() {
    let b = fixture();
    let code = b.code();
    let renewed = b.share.new_key().unwrap();
    let e = remote::verify(&code).unwrap_err();
    assert!(matches!(e, Failure::Rejected), "{e:?}");
    assert_eq!(e.code(), "rejected");
    let sentence = e.to_string();
    assert!(says(&sentence, "non è valido", "not valid") && says(&sentence, "condivisione è spenta", "sharing is off"), "{sentence}");
    assert!(!sentence.contains(&code.key), "{sentence}");
    // The new code works.
    assert!(remote::verify(&Code::parse(&renewed.home.unwrap().code).unwrap()).is_ok());
}

#[test]
fn a_pc_that_does_not_answer_is_told_with_what_to_check() {
    let b = fixture();
    let code = b.code();
    b.share.set_enabled(false).unwrap();
    let e = remote::verify(&code).unwrap_err();
    assert!(matches!(e, Failure::Unreachable), "{e:?}");
    let sentence = e.to_string();
    assert!(says(&sentence, "non risponde", "does not answer") && says(&sentence, "è acceso?", "turned on?") && says(&sentence, "condivisione accesa", "sharing on"), "{sentence}");
    assert!(!sentence.contains(&code.key) && !sentence.contains("127.0.0.1"), "{sentence}");
}

/// The PC that uses the engine keeps knowing whether the other answers: a renewed key is an answer, sharing turned off is
/// not. The watch ends when nobody holds what it writes.
#[test]
fn whether_the_other_pc_answers_is_watched_while_its_engine_is_in_use() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let until = |what: &str, done: &dyn Fn() -> bool| {
        let t0 = Instant::now();
        while !done() {
            assert!(t0.elapsed() < Duration::from_secs(10), "{what}: not within 10 s");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let b = fixture();
    let code = b.code();
    let reachable = Arc::new(AtomicBool::new(false));
    let watching = remote::watch(code, Arc::downgrade(&reachable), Duration::from_millis(50), Duration::from_millis(50));
    until("it answers", &|| reachable.load(Ordering::SeqCst));
    b.share.new_key().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(reachable.load(Ordering::SeqCst), "a refused key is an answer");
    b.share.set_enabled(false).unwrap();
    until("it does not answer", &|| !reachable.load(Ordering::SeqCst));
    b.share.set_enabled(true).unwrap();
    until("it answers again", &|| reachable.load(Ordering::SeqCst));
    drop(reachable);
    let t0 = Instant::now();
    while !watching.is_finished() {
        assert!(t0.elapsed() < Duration::from_secs(10), "the watch goes on with nobody reading it");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A refused key slows the watch down (each ask is a refusal in the other PC's log), and an answer that changes brings it
/// back to its pace.
#[test]
fn a_refused_key_is_asked_again_seldom_until_the_answer_changes() {
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
    use std::sync::Arc;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let code = Code::parse(&format!("mango://{}/{}", listener.local_addr().unwrap(), "ab".repeat(24))).unwrap();
    let (status, asked) = (Arc::new(AtomicU16::new(401)), Arc::new(AtomicUsize::new(0)));
    let (s, a) = (status.clone(), asked.clone());
    std::thread::spawn(move || {
        for c in listener.incoming() {
            let mut c = c.unwrap();
            let mut head = String::new();
            let mut r = BufReader::new(c.try_clone().unwrap());
            while r.read_line(&mut head).unwrap() > 2 {}
            a.fetch_add(1, Ordering::SeqCst);
            let _ = write!(c, "HTTP/1.1 {} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}", s.load(Ordering::SeqCst));
        }
    });
    let until = |what: &str, done: &dyn Fn() -> bool| {
        let t0 = Instant::now();
        while !done() {
            assert!(t0.elapsed() < Duration::from_secs(10), "{what}: not within 10 s");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let reachable = Arc::new(AtomicBool::new(false));
    let _watching = remote::watch(code, Arc::downgrade(&reachable), Duration::from_millis(20), Duration::from_millis(600));
    until("the first ask", &|| asked.load(Ordering::SeqCst) == 1);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(asked.load(Ordering::SeqCst), 1, "a refused key is not asked again every 20 ms");
    assert!(reachable.load(Ordering::SeqCst), "a refused key is an answer");
    status.store(200, Ordering::SeqCst);
    until("the slow ask", &|| asked.load(Ordering::SeqCst) == 2);
    let t0 = Instant::now();
    until("the pace again", &|| asked.load(Ordering::SeqCst) >= 7);
    assert!(t0.elapsed() < Duration::from_millis(1000), "{:?} for five asks", t0.elapsed());
}

#[test]
fn a_pc_that_accepts_and_never_answers_is_given_up_after_five_seconds() {
    let silent = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let code = Code::parse(&format!("mango://{}/{}", silent.local_addr().unwrap(), "ab".repeat(24))).unwrap();
    let t0 = Instant::now();
    let e = remote::verify(&code).unwrap_err();
    assert!(matches!(e, Failure::Unreachable), "{e:?}");
    assert!((4..8).contains(&t0.elapsed().as_secs()), "{:?}", t0.elapsed());
}

#[test]
fn a_pc_with_no_model_ready_and_a_port_with_another_service_are_told_apart() {
    let b = fixture();
    let code = b.code();
    b.share.set_models(vec![]);
    let e = remote::verify(&code).unwrap_err();
    assert!(matches!(e, Failure::NoModels), "{e:?}");
    assert!(says(&e.to_string(), "non ha modelli pronti", "has no model ready"), "{e}");

    // Something else on that port: it is not Mango Code, and the sentence says what to do.
    let other = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = other.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut c, _) = other.accept().unwrap();
        let mut buf = [0u8; 512];
        let _ = c.read(&mut buf);
        let _ = write!(c, "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno");
    });
    let e = remote::verify(&Code::parse(&format!("mango://{address}/{}", "ab".repeat(24))).unwrap()).unwrap_err();
    assert!(matches!(e, Failure::NotMango(_)), "{e:?}");
    assert!(says(&e.to_string(), "non è Mango Code", "not Mango Code"), "{e}");
}

#[test]
fn the_code_is_kept_across_restarts_and_forgotten_for_good() {
    let dir = tempfile::tempdir().unwrap();
    assert!(remote::saved(dir.path()).unwrap().is_none());
    let code = Code::parse(&format!("mango://192.168.1.20:47098/{}", "cd".repeat(24))).unwrap();
    remote::save(dir.path(), &code).unwrap();
    assert_eq!(remote::saved(dir.path()).unwrap(), Some(code.clone()));
    remote::forget(dir.path()).unwrap();
    assert!(remote::saved(dir.path()).unwrap().is_none());
    assert!(!dir.path().join("remote-engine.json").exists());
    remote::forget(dir.path()).unwrap();

    // A file that does not read is told, with its path: the page can offer to go back to this PC's engine.
    std::fs::write(dir.path().join("remote-engine.json"), "{ not json").unwrap();
    let e = format!("{:#}", remote::saved(dir.path()).unwrap_err());
    assert!(e.contains("remote-engine.json"), "{e}");
    // …and a saved file that is not a code (edited by hand) is not trusted either.
    std::fs::write(dir.path().join("remote-engine.json"), r#"{"address":"pc.example:1","key":"x"}"#).unwrap();
    assert!(remote::saved(dir.path()).is_err());

    // A code that cannot be saved says so in a sentence without the path, which stays in the detail for the log.
    std::fs::remove_file(dir.path().join("remote-engine.json")).unwrap();
    std::fs::create_dir(dir.path().join("remote-engine.json")).unwrap();
    let e = remote::save(dir.path(), &code).unwrap_err();
    let phrase = mango_common::user_phrase(&e);
    assert!(says(&phrase, "Non riesco a salvare il codice", "I can't save the other PC's code") && !phrase.contains("remote-engine.json"), "{phrase}");
    assert!(format!("{e:#}").contains("remote-engine.json"), "{e:#}");
}
