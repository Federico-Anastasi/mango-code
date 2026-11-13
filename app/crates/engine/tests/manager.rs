//! The engine manager with the fake engine (`fake-engine`): model switch, streaming in pieces, GPUs released and
//! resumed, requests that wait. No GPUs.

use anyhow::{bail, Result};
use engine_cfg::{EnginePlan, Vendor, Gpu};
use mango_common::{tr, ProcSpec};
use engine::{http, Phase, EngineManager};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[allow(dead_code)] // each test file uses a part of it
mod support;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-engine");

fn gpu(i: u32) -> Gpu {
    Gpu { index: i, name: format!("GPU {i}"), vendor: Vendor::Nvidia, memory_mib: 8192, cuda_driver: Some((12, 6)), cc: Some((8, 6)) }
}

/// Two fake models: «a» uses GPUs 0 and 2, «b» all three. The same rules as the real plan: a model that needs a
/// released GPU doesn't start.
fn planner(log: PathBuf, save: bool, chunk_ms: u64, start_ms: u64, save_ms: u64) -> Box<engine::Planner> {
    Box::new(move |key: &str, port: u16, excluded: &[u32]| -> Result<EnginePlan> {
        let gpus: Vec<u32> = match key {
            "a" => vec![0, 2],
            "b" => vec![0, 1, 2],
            // The plan is fine, the program is not there: it does not start.
            "broken" => vec![1],
            // It splits itself over the GPUs that remain.
            "c" => [0, 1, 2].into_iter().filter(|i| !excluded.contains(i)).collect(),
            k => bail!("The requested model is not among Mango Code's («{k}»)"),
        };
        if gpus.is_empty() {
            bail!("no GPU left");
        }
        // A test makes the plan slow by writing how many milliseconds it takes: the hardware read of a busy computer.
        if let Some(ms) = std::fs::read_to_string(log.with_file_name("plan_ms")).ok().and_then(|v| v.trim().parse().ok()) {
            std::thread::sleep(Duration::from_millis(ms));
        }
        // A test makes the plan of a model refuse it by writing its key in a file: a choice that does not fit.
        if std::fs::read_to_string(log.with_file_name("refuse")).is_ok_and(|k| k.trim() == key) {
            bail!("«{key}» does not fit with these choices");
        }
        if let Some(i) = gpus.iter().find(|i| excluded.contains(i)) {
            bail!("it needs GPU {i}, which has been released");
        }
        let url = format!("http://127.0.0.1:{port}");
        let memory = log.with_file_name(format!("memory-{key}"));
        Ok(EnginePlan {
            key: key.into(),
            spec: ProcSpec {
                name: format!("engine-{key}"),
                exe: if key == "broken" { r"C:\does\not\exist.exe".into() } else { FAKE.into() },
                args: vec![
                    "-m".into(),
                    format!(r"C:\fake\{key}.gguf"),
                    "--port".into(),
                    port.to_string(),
                    "--cache-disk".into(),
                    memory.display().to_string(),
                ],
                env: vec![
                    ("FAKE_ENGINE_LOG".into(), log.display().to_string()),
                    ("FAKE_ENGINE_START_MS".into(), start_ms.to_string()),
                    ("FAKE_ENGINE_CHUNK_MS".into(), chunk_ms.to_string()),
                    ("FAKE_ENGINE_SAVE_MS".into(), save_ms.to_string()),
                ],
                env_remove: vec![],
                cwd: None,
                health_url: Some(format!("{url}/health")),
                ready_timeout_s: 20,
                shutdown_post: save.then(|| mango_common::PostCall { url: format!("{url}/slots/0?action=persist"), body: String::new(), timeout_s: 5 }),
                startup_post: None,
            },
            url,
            label: format!("Model {}", key.to_uppercase()),
            // A test changes the context the plan gives by writing it in a file: the user's choice.
            ctx: std::fs::read_to_string(log.with_file_name("context")).ok().and_then(|c| c.trim().parse().ok()).unwrap_or(4096),
            images: false,
            gpus_used: gpus.into_iter().map(gpu).collect(),
            gguf: format!(r"C:\fake\{key}.gguf").into(),
        })
    })
}

use support::{code_of, content_type, get, json_of, ok, post, text_of};

struct Fixture {
    m: EngineManager,
    port: u16,
    log: PathBuf,
    _dir: tempfile::TempDir,
}

/// The app's routes in the tests: they answer what they were asked.
struct Echo;

impl http::Control for Echo {
    fn handle(&self, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
        (200, json!({ "method": method, "path": path, "body": String::from_utf8_lossy(body) }))
    }
}

fn fixture() -> Fixture {
    fixture_with_chunk(30)
}

fn fixture_with_chunk(chunk_ms: u64) -> Fixture {
    fixture_slow(chunk_ms, 300)
}

fn fixture_slow(chunk_ms: u64, start_ms: u64) -> Fixture {
    fixture_full(chunk_ms, start_ms, 0)
}

/// `save_ms`: how long the conversation save lasts when an engine stops.
fn fixture_full(chunk_ms: u64, start_ms: u64, save_ms: u64) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let m = EngineManager::new(
        planner(log.clone(), true, chunk_ms, start_ms, save_ms),
        Box::new(|| vec![(0, 4000, 8192), (1, 10, 8192), (2, 3000, 8192)]),
        dir.path(),
    );
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    http::serve(m.clone(), port, Some(std::sync::Arc::new(Echo))).unwrap();
    Fixture { m, port, log, _dir: dir }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.m.stop();
    }
}

impl Fixture {
    fn url(&self, p: &str) -> String {
        format!("http://127.0.0.1:{}{p}", self.port)
    }

    /// A streaming conversation with model `key`: the text pieces, each with the instant it arrived.
    fn ask(&self, key: &str) -> Vec<(Instant, String)> {
        let r = ok(post(
            &self.url("/v1/chat/completions"),
            &[("Content-Type", "application/json")],
            &json!({ "model": key, "stream": true, "messages": [{ "role": "user", "content": "who are you?" }] }).to_string(),
        ));
        assert_eq!(content_type(&r), Some("text/event-stream"));
        let mut pieces = Vec::new();
        // A cut reply (the engine stopped halfway) ends the reading: the pieces that arrived stay.
        for line in BufReader::new(r.into_body().into_reader()).lines() {
            let Ok(line) = line else { break };
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if data == "[DONE]" {
                break;
            }
            let v: Value = serde_json::from_str(data).unwrap();
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                pieces.push((Instant::now(), t.to_string()));
            }
        }
        pieces
    }

    fn text(&self, key: &str) -> String {
        self.ask(key).into_iter().map(|p| p.1).collect()
    }

    fn control(&self, p: &str, body: Value) -> (u16, Value) {
        let r = post(&self.url(p), &[("Content-Type", "application/json")], &body.to_string());
        (code_of(&r), json_of(r))
    }

    fn routes_to_engine(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .map(|v| format!("{} {} {}", v["model"].as_str().unwrap(), v["method"].as_str().unwrap(), v["route"].as_str().unwrap()))
            // health and slot memory are asked by the manager itself, not by the requests
            .filter(|r| !r.contains("/health") && !r.ends_with("GET /slots"))
            .collect()
    }
}

/// The client that closes halfway through the reply (the «Stop» button): the manager closes towards the engine at
/// once too, and the engine stops generating. Even before the engine has written anything (while it reads the
/// prompt) what counts is that the connection to the engine drops: that's where the engine notices.
#[test]
fn the_client_closing_stops_the_engine() {
    use std::io::{Read, Write};
    let b = fixture_with_chunk(300);
    b.text("a"); // started
    let mut s = std::net::TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    let body = json!({ "model": "a", "stream": true, "messages": [] }).to_string();
    write!(s, "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut buf = [0u8; 4096];
    let n = s.read(&mut buf).unwrap();
    assert!(n > 0);
    let t0 = Instant::now();
    drop(s);
    let interrupted = || std::fs::read_to_string(&b.log).unwrap_or_default().contains("\"interrupted\"");
    while !interrupted() && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(interrupted(), "the engine kept writing for a client that was no longer there");
    assert!(t0.elapsed() < Duration::from_millis(1500), "{:?}", t0.elapsed());
}

#[test]
fn starts_the_requested_model_and_switches_when_another_is_needed() {
    let b = fixture();
    assert_eq!(b.m.state().phase, Phase::Stopped);
    assert_eq!(b.text("a"), "I am the engine a");
    let s = b.m.state();
    assert_eq!((s.phase, s.model.as_deref(), s.context), (Phase::Running, Some("a"), Some(4096)));
    assert_eq!(s.gpus.iter().map(|x| (x.index, x.memory_used_mib)).collect::<Vec<_>>(), [(0, Some(4000)), (2, Some(3000))]);
    assert_eq!(b.text("b"), "I am the engine b");
    assert_eq!(b.m.state().model.as_deref(), Some("b"));
    // Before stopping «a» the manager asked it to save the conversation.
    assert_eq!(
        b.routes_to_engine(),
        ["a POST /v1/chat/completions", "a POST /slots/0?action=persist", "b POST /v1/chat/completions"]
    );
}

#[test]
fn streaming_arrives_in_pieces() {
    let b = fixture();
    let pieces = b.ask("a");
    assert_eq!(pieces.len(), 5);
    // The fake engine sends a piece every 30 ms: if the manager accumulated them they would arrive together.
    let dt = pieces[4].0 - pieces[0].0;
    assert!(dt >= Duration::from_millis(40), "the pieces all arrived together ({dt:?})");
}

#[test]
fn unknown_model_and_routes_without_an_engine() {
    let b = fixture();
    // A model the plan refuses isn't retried: 422 (the agent retries 5xx), with the plan's sentence.
    let (status, v) = b.control("/v1/chat/completions", json!({ "model": "xyz", "messages": [] }));
    assert_eq!(status, 422);
    assert!(v["error"]["message"].as_str().unwrap().contains("xyz"), "{v}");
    assert_eq!(code_of(&get(&b.url("/health"), &[])), 503);
    b.text("a");
    assert_eq!(json_of(ok(get(&b.url("/props"), &[])))["model_path"], json!(r"C:\fake\a.gguf"));
}

#[test]
fn releasing_a_gpu_the_model_does_not_use_does_not_stop_it() {
    let b = fixture();
    b.text("a");
    let (status, v) = b.control("/engine/release", json!({ "gpus": [1] }));
    assert_eq!(status, 200, "{v}");
    assert_eq!((v["phase"].as_str(), v["released_gpus"].clone()), (Some("running"), json!([1])));
    assert_eq!(b.text("a"), "I am the engine a");
    // «b» needs GPU 1: it doesn't start until resumed.
    let (status, v) = b.control("/engine/model", json!({ "model": "b" }));
    assert_eq!(status, 422);
    assert!(v["error"]["message"].as_str().unwrap().contains("released"), "{v}");
}

#[test]
fn requests_wait_for_the_gpus_and_the_conversation_continues() {
    let b = fixture();
    b.text("a");
    let (status, v) = b.control("/engine/release", json!({}));
    assert_eq!(status, 200, "{v}");
    assert_eq!((v["phase"].as_str(), v["all_released"].as_bool()), (Some("released"), Some(true)));
    // Releasing saved the conversation before stopping.
    assert!(b.routes_to_engine().contains(&"a POST /slots/0?action=persist".to_string()));

    let t0 = Instant::now();
    let waited = std::thread::scope(|sc| {
        let h = sc.spawn(|| b.text("a"));
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(b.m.state().phase, Phase::Released, "the request must not restart by itself");
        let (status, v) = b.control("/engine/resume", json!({}));
        assert_eq!(status, 200, "{v}");
        assert_eq!(v["phase"].as_str(), Some("running"));
        h.join().unwrap()
    });
    assert_eq!(waited, "I am the engine a");
    assert!(t0.elapsed() >= Duration::from_millis(800));
}

#[test]
fn the_model_switch_waits_for_the_in_flight_request() {
    let b = fixture();
    b.text("a");
    let (end_a, start_b) = std::thread::scope(|sc| {
        let ha = sc.spawn(|| b.ask("a").last().unwrap().0);
        std::thread::sleep(Duration::from_millis(10));
        let hb = sc.spawn(|| b.ask("b").first().unwrap().0);
        (ha.join().unwrap(), hb.join().unwrap())
    });
    assert!(start_b > end_a, "«b» started while «a» was still answering");
}

/// A page that reaches the port through a name of its own pointing to 127.0.0.1 (DNS rebinding) sends no `Origin` on a
/// `GET`, but its `Host` is not ours: refused, the state stays unreadable.
#[test]
fn a_foreign_host_is_rejected() {
    use std::io::{Read, Write};
    let b = fixture();
    let ask = |host: &str| {
        let mut c = std::net::TcpStream::connect(("127.0.0.1", b.port)).unwrap();
        write!(c, "GET /engine HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
        let mut r = String::new();
        c.read_to_string(&mut r).unwrap();
        r.split(' ').nth(1).unwrap_or("").to_string()
    };
    assert_eq!(ask("rebind.example.com:8080"), "403");
    assert_eq!(ask("127.0.0.1.rebind.example.com"), "403");
    assert_eq!(ask(&format!("127.0.0.1:{}", b.port)), "200");
    assert_eq!(ask(&format!("localhost:{}", b.port)), "200");
}

#[test]
fn every_route_rejects_web_pages() {
    let b = fixture();
    assert_eq!(code_of(&get(&b.url("/engine"), &[("Origin", "https://example.com")])), 403);
    assert_eq!(code_of(&get(&b.url("/control/state"), &[("Origin", "https://example.com")])), 403);
    // The model too: a page sends a "simple" request (text/plain) that CORS doesn't stop.
    let r = post(&b.url("/v1/chat/completions"), &[("Origin", "https://example.com"), ("Content-Type", "text/plain")], &json!({ "model": "a", "messages": [] }).to_string());
    assert_eq!(code_of(&r), 403);
    assert_eq!(b.m.state().phase, Phase::Stopped, "the rejected request must not start the engine");
    let v = json_of(ok(get(&b.url("/engine"), &[])));
    assert_eq!(v["phase"], json!("stopped"));
}

/// What is under `/control/` goes to the app that started the manager, with the method, the path without the query and
/// the body; the engine does not start for it.
#[test]
fn the_control_routes_are_the_apps() {
    let b = fixture();
    let (status, v) = b.control("/control/model/use?x=1", json!({ "model": "a" }));
    assert_eq!(status, 200);
    assert_eq!(v, json!({ "method": "POST", "path": "/control/model/use", "body": json!({ "model": "a" }).to_string() }));
    assert_eq!(json_of(ok(get(&b.url("/control/state"), &[])))["method"], json!("GET"));
    assert_eq!(b.m.state().phase, Phase::Stopped);
}

/// Releasing a GPU of a model that also fits without it: `release` replies as soon as the GPU is free, not when the
/// model has restarted (loading takes tens of seconds, sometimes minutes). The model restarts on the remaining GPUs
/// at the first request.
#[test]
fn releasing_a_gpu_does_not_wait_for_the_model_to_restart() {
    let b = fixture_slow(30, 3000);
    b.text("c");
    assert_eq!(b.m.state().gpus.iter().map(|x| x.index).collect::<Vec<_>>(), [0, 1, 2]);
    let t0 = Instant::now();
    let (status, v) = b.control("/engine/release", json!({ "gpus": [0] }));
    assert_eq!(status, 200, "{v}");
    assert!(t0.elapsed() < Duration::from_millis(2000), "release waited for the load: {:?}", t0.elapsed());
    assert_eq!((v["phase"].as_str(), v["released_gpus"].clone(), v["gpus"].clone()), (Some("released"), json!([0]), json!([])));
    // The first request restarts it, without the released GPU.
    assert_eq!(b.text("c"), "I am the engine c");
    let s = b.m.state();
    assert_eq!((s.phase, s.gpus.iter().map(|x| x.index).collect::<Vec<_>>()), (Phase::Running, vec![1, 2]));
    // «resume» gives the GPU back: the model returns to all of them.
    b.control("/engine/resume", json!({}));
    assert_eq!(b.m.state().gpus.iter().map(|x| x.index).collect::<Vec<_>>(), [0, 1, 2]);
}

/// A model that fails to start on the GPUs that remain (the program does not open, the port is taken) is not «it does
/// not fit»: the request gets the real error at once instead of waiting for a `resume` that would not help.
#[test]
fn a_start_error_with_released_gpus_is_told_not_waited_for() {
    let b = fixture();
    b.text("c");
    b.control("/engine/release", json!({ "gpus": [0] }));
    let t0 = Instant::now();
    let r = post(&b.url("/v1/chat/completions"), &[("Content-Type", "application/json")], &json!({ "model": "broken", "messages": [] }).to_string());
    let code = code_of(&r);
    let body = text_of(r);
    assert!(t0.elapsed() < Duration::from_secs(10), "it waited: {:?}", t0.elapsed());
    assert_eq!(code, 503, "{body}");
    assert!(body.contains("exist.exe") && !body.contains("resume"), "the real cause, not the sentence about the released cards: {body}");
}

/// If the model doesn't fit without the GPU, requests wait for `resume` and the state says why.
#[test]
fn if_the_model_does_not_fit_without_the_gpu_requests_wait() {
    let b = fixture();
    b.text("a"); // uses GPUs 0 and 2
    b.control("/engine/release", json!({ "gpus": [0] }));
    let waited = std::thread::scope(|sc| {
        let h = sc.spawn(|| b.text("a"));
        std::thread::sleep(Duration::from_millis(800));
        let s = b.m.state();
        assert_eq!(s.phase, Phase::Released, "the request must not drop the state into error");
        assert!(s.error.as_deref().is_some_and(|e| e.contains("GPU 0")), "{:?}", s.error);
        b.control("/engine/resume", json!({}));
        h.join().unwrap()
    });
    assert_eq!(waited, "I am the engine a");
}

/// `release` with a generation in progress lets it finish (within the maximum time) and meanwhile the state is
/// «releasing»; new requests wait.
#[test]
fn release_waits_for_the_generation_in_progress_to_end() {
    let b = fixture_with_chunk(300);
    b.text("a");
    b.m.set_release_wait(Duration::from_secs(10));
    std::thread::scope(|sc| {
        let generation = sc.spawn(|| b.text("a"));
        std::thread::sleep(Duration::from_millis(400));
        let t0 = Instant::now();
        let release = sc.spawn(|| b.control("/engine/release", json!({})));
        std::thread::sleep(Duration::from_millis(300));
        let s = json_of(ok(get(&b.url("/engine"), &[])));
        assert_eq!((s["phase"].as_str(), s["requests_in_flight"].as_u64()), (Some("releasing"), Some(1)), "{s}");
        // The reply in progress arrives whole.
        assert_eq!(generation.join().unwrap(), "I am the engine a");
        let (status, v) = release.join().unwrap();
        assert_eq!((status, v["phase"].as_str()), (200, Some("released")), "{v}");
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    });
}

/// After the maximum time the generation in progress is cut, and `release` replies.
#[test]
fn release_cuts_the_generation_that_does_not_finish_in_the_maximum_time() {
    let b = fixture_with_chunk(1000);
    b.text("a");
    b.m.set_release_wait(Duration::from_millis(500));
    let (pieces, duration) = std::thread::scope(|sc| {
        let generation = sc.spawn(|| b.ask("a").len());
        std::thread::sleep(Duration::from_millis(200));
        let t0 = Instant::now();
        let (status, v) = b.control("/engine/release", json!({}));
        assert_eq!((status, v["phase"].as_str()), (200, Some("released")), "{v}");
        (generation.join().unwrap(), t0.elapsed())
    });
    assert!(duration >= Duration::from_millis(450) && duration < Duration::from_millis(2500), "{duration:?}");
    assert!(pieces < 5, "the reply had to stay halfway ({pieces} pieces)");
}

/// Every call that changes the state leaves a line in `manager.log`: route, body, outcome, duration and who made it.
#[test]
fn every_control_call_leaves_a_line_in_the_log() {
    let b = fixture();
    let call = |p: &str, body: Value| {
        code_of(&post(&b.url(p), &[("Content-Type", "application/json"), ("User-Agent", "attached-test/1.0")], &body.to_string()))
    };
    assert_eq!(call("/engine/model", json!({ "model": "a" })), 200);
    assert_eq!(call("/engine/release", json!({ "gpus": [1] })), 200);
    assert_eq!(call("/engine/model", json!({ "model": "xyz" })), 422);
    json_of(ok(get(&b.url("/engine"), &[]))); // reads aren't logged

    let lines: Vec<Value> = std::fs::read_to_string(b._dir.path().join("manager.log"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v.get("route").is_some()) // the memory lines have «event»
        .collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(lines.iter().map(|r| r["route"].as_str().unwrap()).collect::<Vec<_>>(), ["/engine/model", "/engine/release", "/engine/model"]);
    assert_eq!(lines.iter().map(|r| r["status"].as_u64().unwrap()).collect::<Vec<_>>(), [200, 200, 422]);
    assert_eq!(lines[1]["body"], json!(r#"{"gpus":[1]}"#));
    assert!(lines[2]["error"].as_str().unwrap().contains("xyz"), "{:?}", lines[2]);
    for r in &lines {
        assert_eq!(r["user_agent"], json!("attached-test/1.0"));
        assert!(r["address"].as_str().unwrap().starts_with("127.0.0.1:"), "{r}");
        assert!(r["duration_ms"].is_u64() && r["time"].as_str().unwrap().starts_with("20"), "{r}");
    }
}

/// A model that can't start (unknown, missing files) doesn't stop the running one: the manager makes the new one's
/// plan before touching the old one.
#[test]
fn a_model_that_does_not_start_does_not_stop_the_running_one() {
    let b = fixture();
    b.text("a");
    let (status, v) = b.control("/engine/model", json!({ "model": "xyz" }));
    assert_eq!(status, 422, "{v}");
    let s = b.m.state();
    assert_eq!((s.phase, s.model.as_deref()), (Phase::Running, Some("a")), "{s:?}");
    assert!(s.error.as_deref().is_some_and(|e| e.contains("xyz")), "{:?}", s.error);
    assert_eq!(b.text("a"), "I am the engine a");
    assert!(!b.routes_to_engine().iter().any(|r| r.contains("persist")), "the running engine was stopped");
}

/// A process that stays alive until the test closes it: whoever takes the GPUs on loan.
fn spawn_process() -> std::process::Child {
    std::process::Command::new("ping")
        .args(["-n", "60", "127.0.0.1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // DETACHED_PROCESS: no console at all. With CREATE_NO_WINDOW Windows still starts one, and killing the process while it starts leaves a
        // terminal window open on the screen with an error (the same as in `loan.rs`).
        .creation_flags(0x0000_0008)
        .spawn()
        .unwrap()
}

/// The loan is tied to the process that asks for it: when that process closes without having called `resume` (a
/// crash, an interrupted test), the manager resumes by itself and writes it in the log.
#[test]
fn the_loan_ends_when_whoever_asked_for_it_closes() {
    let b = fixture();
    b.text("a");
    let mut who = spawn_process();
    let (status, v) = b.control("/engine/release", json!({ "pid": who.id() }));
    assert_eq!((status, v["phase"].as_str()), (200, Some("released")), "{v}");
    assert_eq!(v["loans"][0]["pid"].as_u64(), Some(who.id() as u64), "{v}");
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(b.m.state().phase, Phase::Released, "the loan must not end while whoever asked for it is alive");
    who.kill().unwrap();
    let _ = who.wait();
    let t0 = Instant::now();
    while b.m.state().phase != Phase::Running && t0.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let s = b.m.state();
    assert_eq!((s.phase, s.loans.len()), (Phase::Running, 0), "{s:?}");
    let lines = std::fs::read_to_string(b._dir.path().join("manager.log")).unwrap();
    let ended = lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["event"] == "loan_ended");
    assert_eq!(ended.expect("no «loan_ended» line")["pid"].as_u64(), Some(who.id() as u64));
}

/// Without `pid` the loan belongs to the process that makes the call (here: the test itself); with `"pid": 0` it
/// belongs to no process and lasts until `resume`. The state says who has the GPUs and since when.
#[test]
fn the_loan_belongs_to_the_calling_process() {
    let b = fixture();
    b.text("a");
    let v = json_of(ok(post(&b.url("/engine/release"), &[("User-Agent", "loan-test/1.0")], "{}")));
    let p = &v["loans"][0];
    assert_eq!((p["pid"].as_u64(), p["who"].as_str()), (Some(std::process::id() as u64), Some("loan-test/1.0")), "{v}");
    assert!(p["since"].as_str().unwrap().starts_with("20"), "{v}");
    assert_eq!(p["gpus"], Value::Null, "all the GPUs");
    b.control("/engine/resume", json!({}));
    let (_, v) = b.control("/engine/release", json!({ "gpus": [1], "pid": 0 }));
    assert_eq!((v["loans"][0]["pid"].clone(), v["loans"][0]["gpus"].clone()), (Value::Null, json!([1])), "{v}");
}

/// The process is recognized from the connection even when it is another program: a `curl` that asks for the GPUs
/// and exits at once doesn't keep them (to keep them, a passing program sends `"pid": 0` or the process that will resume).
#[test]
fn whoever_asks_for_the_gpus_and_then_exits_gives_them_back() {
    let b = fixture();
    b.text("a");
    let st = std::process::Command::new("curl")
        .args(["-s", "-o", "NUL", "-X", "POST", "-d", "{}", &b.url("/engine/release")])
        .creation_flags(mango_common::CREATE_NO_WINDOW)
        .status()
        .unwrap();
    assert!(st.success());
    let t0 = Instant::now();
    while b.m.state().phase != Phase::Running && t0.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(b.m.state().phase, Phase::Running, "the loan of a closed process stayed");
    let lines = std::fs::read_to_string(b._dir.path().join("manager.log")).unwrap();
    let release = lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["route"] == "/engine/release").unwrap();
    assert!(release["user_agent"].as_str().unwrap().starts_with("curl/"), "{release}");
    assert!(lines.contains("\"loan_ended\""), "{lines}");
}

/// An engine that crashes doesn't stay "running" forever: the next request notices, restarts it and gets an answer;
/// the log says it crashed and with which code.
#[test]
fn a_crashed_engine_restarts_at_the_next_request() {
    let b = fixture();
    b.text("a");
    let _ = post(&b.url("/test/crash"), &[], ""); // the fake engine exits with code 3
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(b.text("a"), "I am the engine a");
    let lines = std::fs::read_to_string(b._dir.path().join("manager.log")).unwrap();
    let crash = lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["event"] == "crash");
    let crash = crash.expect("no «crash» line in the log");
    assert_eq!((crash["model"].as_str(), crash["code"].as_i64()), (Some("a"), Some(3)), "{crash}");
}

/// The log lines of a given memory event (`save`, `restore`), as «model token».
fn events(b: &Fixture, event: &str) -> Vec<String> {
    std::fs::read_to_string(b._dir.path().join("manager.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["event"] == event)
        .map(|v| {
            assert!(v["ms"].is_u64(), "{v}");
            format!("{} {}", v["model"].as_str().unwrap(), v["token"])
        })
        .collect()
}

/// At every stop (GPUs lent, model switch, shutdown) the conversation is saved, and at every start the engine
/// restarts from the memory: the log says how many tokens and in how long.
#[test]
fn the_memory_is_saved_and_restored_at_every_step() {
    let b = fixture();
    b.text("a"); // the fake engine holds 100 tokens per request
    b.text("a");
    b.control("/engine/release", json!({}));
    assert_eq!(events(&b, "save"), ["a 200"]);
    b.control("/engine/resume", json!({}));
    assert_eq!(events(&b, "restore"), ["a 0", "a 200"], "at the first start the memory is empty, after resume it isn't");
    b.text("a");
    b.text("b"); // model switch
    assert_eq!(events(&b, "save"), ["a 200", "a 300"]);
    assert_eq!(events(&b, "restore"), ["a 0", "a 200", "b 0"]);
    b.m.stop(); // app shutdown
    assert_eq!(events(&b, "save"), ["a 200", "a 300", "b 100"]);
}

/// A slow start has two possible causes (the model loads slowly, the saved conversation comes back slowly): the
/// `restore` line tells how long each took, not only the sum.
#[test]
fn the_restore_line_tells_the_load_from_the_restore() {
    let b = fixture_slow(30, 600);
    b.text("a");
    let lines = std::fs::read_to_string(b._dir.path().join("manager.log")).unwrap();
    let restore = lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["event"] == "restore").expect("no «restore» line in the log");
    let (load, back, total) = (restore["load_ms"].as_u64(), restore["restore_ms"].as_u64(), restore["ms"].as_u64().unwrap());
    assert!(load.is_some_and(|ms| ms >= 600), "the engine was not ready for 600 ms: {restore}");
    assert!(back.is_some_and(|ms| ms < 600), "the restore is not the load: {restore}");
    assert!(total >= load.unwrap() + back.unwrap(), "{restore}");
}

/// The engine starts with the logs folder as working folder: `llama.log` ends up there, not where the app started.
#[test]
fn the_engine_starts_in_the_logs_folder() {
    let b = fixture();
    b.text("a");
    assert!(b._dir.path().join("llama.log").exists());
}

/// `POST /tokenize` goes through the manager to the running engine. The fake engine counts one word per token
/// (words separated by spaces): the fixed rule used to test token-based measurements.
#[test]
fn the_token_count_goes_through_the_manager_and_in_the_fake_one_word_is_one_token() {
    let b = fixture();
    b.text("a");
    let r = ok(post(&b.url("/tokenize"), &[("Content-Type", "application/json")], &json!({ "content": "a  sentence of\nfive words" }).to_string()));
    assert_eq!(json_of(r)["tokens"].as_array().unwrap().len(), 5);
    let empty = ok(post(&b.url("/tokenize"), &[("Content-Type", "application/json")], &json!({ "content": "" }).to_string()));
    assert!(json_of(empty)["tokens"].as_array().unwrap().is_empty());
}

/// The manager closes the connection after every forwarded reply, and tells the client so even when the engine
/// doesn't (the fake one doesn't): otherwise a client that keeps connections open reuses an already closed one and
/// the request drops («socket closed unexpectedly»).
#[test]
fn the_forwarded_reply_says_the_connection_closes() {
    let b = fixture();
    b.text("a");
    let r = ok(post(&b.url("/tokenize"), &[("Content-Type", "application/json")], &json!({ "content": "a b" }).to_string()));
    assert_eq!(r.headers().get("connection").map(|v| v.to_str().unwrap().to_ascii_lowercase()).as_deref(), Some("close"));
    assert_eq!(json_of(r)["tokens"].as_array().unwrap().len(), 2);
}

/// `release` saves the conversation and stops the engine: until it has finished, a new request waits. If it
/// restarted at once (the released GPU is just one and the model fits without it) it would read from disk the
/// conversation from before the save, and two engines would be on the GPUs together.
#[test]
fn a_new_request_does_not_restart_the_engine_while_the_old_one_saves() {
    let b = fixture_full(30, 300, 1500);
    b.text("c"); // 100 tokens in memory
    std::thread::scope(|sc| {
        let release = sc.spawn(|| b.control("/engine/release", json!({ "gpus": [0], "pid": 0 })));
        std::thread::sleep(Duration::from_millis(400)); // the save is in progress
        let request = sc.spawn(|| b.text("c"));
        let (status, v) = release.join().unwrap();
        assert_eq!(status, 200, "{v}");
        assert_eq!(request.join().unwrap(), "I am the engine c");
    });
    assert_eq!(events(&b, "restore"), ["c 0", "c 100"], "the new engine restarted before the old one finished saving");
}

/// The same with `resume`: the engine restarted on the only GPUs left saves itself before a new one starts.
#[test]
fn a_new_request_does_not_start_an_engine_while_resume_saves_the_old_one() {
    let b = fixture_full(30, 300, 1500);
    b.text("c");
    b.control("/engine/release", json!({ "gpus": [0], "pid": 0 }));
    b.text("c"); // restarts on GPUs 1 and 2, with the earlier memory: it now has 200
    std::thread::scope(|sc| {
        let resume = sc.spawn(|| b.control("/engine/resume", json!({})));
        std::thread::sleep(Duration::from_millis(400)); // the reduced engine is saving
        let request = sc.spawn(|| b.text("c"));
        let (status, v) = resume.join().unwrap();
        assert_eq!(status, 200, "{v}");
        assert_eq!(request.join().unwrap(), "I am the engine c");
    });
    assert_eq!(events(&b, "restore"), ["c 0", "c 100", "c 200"], "an engine started while the old one was saving");
    assert_eq!(b.m.state().gpus.iter().map(|x| x.index).collect::<Vec<_>>(), [0, 1, 2]);
}

/// An HTTP request from text, without a client: the whole reply (headers and body).
fn raw_request(b: &Fixture, text: &str) -> String {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(text.as_bytes()).unwrap();
    let mut r = String::new();
    let _ = s.read_to_string(&mut r);
    r
}

/// A body `release` doesn't understand must not become "all the GPUs": indexes that don't fit in 32 bits (they used
/// to be truncated: 4294967297 was GPU 1), a body that isn't an object, a chunked body (`Transfer-Encoding:
/// chunked`, which the manager doesn't read and would see as empty).
#[test]
fn release_rejects_bodies_it_does_not_understand_instead_of_releasing_everything() {
    let b = fixture();
    b.text("a");
    let mut who = spawn_process();
    let cases = [
        ("index too large", json!({ "gpus": [4294967297u64] })),
        ("pid too large", json!({ "pid": who.id() as u64 + (1u64 << 32) })),
        ("body that isn't an object", json!([1])),
    ];
    for (name, body) in cases {
        let (status, v) = b.control("/engine/release", body);
        assert_eq!(status, 400, "{name}: {v}");
        let s = b.m.state();
        assert_eq!((s.phase, s.loans.len()), (Phase::Running, 0), "{name}: {s:?}");
    }
    let r = raw_request(
        &b,
        "POST /engine/release HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\ne\r\n{\"gpus\":[1]}\r\n0\r\n\r\n",
    );
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let s = b.m.state();
    assert_eq!((s.phase, s.loans.len()), (Phase::Running, 0), "the chunked body released the GPUs: {s:?}");
    let _ = who.kill();
    let _ = who.wait();
}

/// An engine that closes while loading because memory isn't enough: the error says so in a sentence and says what
/// to do; the log lines stay in the technical detail.
#[test]
fn an_engine_that_runs_out_of_memory_says_so_in_a_sentence() {
    let dir = tempfile::tempdir().unwrap();
    let m = EngineManager::new(
        Box::new(|key: &str, port: u16, _: &[u32]| -> Result<EnginePlan> {
            Ok(EnginePlan {
                key: key.into(),
                spec: ProcSpec {
                    name: "engine".into(),
                    exe: std::path::Path::new(&std::env::var("SystemRoot").unwrap()).join("System32").join("cmd.exe"),
                    args: vec!["/c".into(), "echo cudaMalloc failed: out of memory& exit 1".into()],
                    env: vec![],
                    env_remove: vec![],
                    cwd: None,
                    health_url: Some(format!("http://127.0.0.1:{port}/health")),
                    ready_timeout_s: 20,
                    shutdown_post: None,
                    startup_post: None,
                },
                url: format!("http://127.0.0.1:{port}"),
                label: "Model".into(),
                ctx: 4096,
                images: false,
                gpus_used: vec![gpu(0)],
                gguf: r"C:\fake\a.gguf".into(),
            })
        }),
        Box::new(Vec::new),
        dir.path(),
    );
    let e = format!("{:#}", m.start("a", &mut |_| {}).unwrap_err());
    // The sentences are asserted in the language the manager is using, whatever it is on this PC.
    let sentence = tr!("Il modello non è entrato in memoria mentre si caricava.", "The model did not fit in memory while loading.");
    let advice = tr!("scegli un modello più piccolo", "choose a smaller model");
    assert!(e.starts_with(&sentence) && e.contains(&advice), "{e}");
    assert!(e.contains(&tr!("dettaglio tecnico", "technical detail")) && e.contains("out of memory"), "{e}");
}

fn until(what: &str, limit: Duration, done: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !done() {
        assert!(t0.elapsed() < limit, "{what}: not within {limit:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl Fixture {
    /// The models whose fake engine process is alive: the ones started by this fixture carry its folder in their command line.
    fn engines_alive(&self) -> Vec<String> {
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='fake-engine.exe'\" | ForEach-Object CommandLine"])
            .creation_flags(mango_common::CREATE_NO_WINDOW)
            .output()
            .unwrap();
        let folder = self._dir.path().display().to_string();
        let mut keys: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.contains(&folder))
            .filter_map(|l| Some(l.split_once(r"C:\fake\")?.1.split_once(".gguf")?.0.to_string()))
            .collect();
        keys.sort();
        keys
    }

    fn loading(&self, key: &str) -> bool {
        let s = self.m.state();
        s.phase == Phase::Starting && s.model.as_deref() == Some(key)
    }

    fn running(&self, key: &str) -> bool {
        let s = self.m.state();
        s.phase == Phase::Running && s.model.as_deref() == Some(key)
    }
}

/// The chat requests reach the engine with the defaults of their model where they did not say them; the other routes
/// and what the request says stay as they came.
#[test]
fn a_chat_request_reaches_the_engine_with_the_defaults_of_its_model() {
    let b = fixture();
    b.m.set_request_defaults(Box::new(|key| Ok(json!({ "temperature": if key == "a" { 0.3 } else { 1.1 }, "chat_template_kwargs": { "enable_thinking": false } }).as_object().unwrap().clone())));
    let chat = |body: Value| {
        ok(post(&b.url("/v1/chat/completions"), &[("Content-Type", "application/json")], &body.to_string()));
        let lines = std::fs::read_to_string(&b.log).unwrap();
        lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|v| v["route"] == "/v1/chat/completions").last().unwrap()["body"].clone()
    };
    let got = chat(json!({ "model": "a", "messages": [] }));
    assert_eq!((got["temperature"].as_f64(), &got["chat_template_kwargs"]), (Some(0.3), &json!({ "enable_thinking": false })), "{got}");
    let got = chat(json!({ "model": "a", "messages": [], "temperature": 0.9 }));
    assert_eq!(got["temperature"].as_f64(), Some(0.9), "what the request says stays: {got}");
    assert_eq!(chat(json!({ "model": "b", "messages": [] }))["temperature"].as_f64(), Some(1.1));
}

/// The user's choices changed the plan of the running model: it is loaded again when its answer in progress has ended,
/// not before; with the same plan nothing happens. A model taken off the computer is stopped and forgotten.
#[test]
fn a_running_model_is_loaded_again_when_its_plan_changed_and_no_request_is_in_progress() {
    let b = fixture_slow(60, 0);
    b.text("a");
    let loads = || events(&b, "restore").len();
    assert_eq!(loads(), 1);
    b.m.reload_if_changed();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(loads(), 1, "the same plan: nothing to load again");

    std::fs::write(b._dir.path().join("context"), "2048").unwrap();
    let end_of_answer = std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.ask("a").last().unwrap().0);
        std::thread::sleep(Duration::from_millis(100));
        b.m.reload_if_changed();
        assert_eq!(b.m.state().context, Some(4096), "the answer in progress keeps its engine");
        answering.join().unwrap()
    });
    until("«a» loaded again", Duration::from_secs(5), || b.m.state().context == Some(2048) && b.running("a"));
    assert!(Instant::now() > end_of_answer);
    assert_eq!(loads(), 2);
    assert_eq!(b.text("a"), "I am the engine a");

    b.m.unload();
    let s = b.m.state();
    assert_eq!((s.phase, s.model), (Phase::Stopped, None));
    assert!(b.engines_alive().is_empty());
}

/// Stopping the engine while a model loads stops the load: the model does not come up afterwards.
#[test]
fn stopping_the_engine_stops_a_load_in_progress() {
    let b = fixture_slow(30, 4_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a") && b.engines_alive() == ["a"]);
    b.m.stop();
    assert_eq!(b.m.state().phase, Phase::Stopped);
    until("the process of «a» gone", Duration::from_secs(3), || b.engines_alive().is_empty());
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(b.m.state().phase, Phase::Stopped, "the stopped load must not end as running");
}

/// The user picks another model while one is still loading: that load stops, its process is gone, and the chosen
/// model starts at once instead of after the first has finished loading.
#[test]
fn choosing_another_model_stops_the_load_in_progress() {
    let b = fixture_slow(30, 4_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a") && b.engines_alive() == ["a"]);
    let state = serde_json::to_value(b.m.state()).unwrap();
    assert_eq!((state["loading"]["name"].as_str(), state["loading"]["context"].as_u64()), (Some("Model A"), Some(4096)), "{state}");
    assert_eq!(state["loading"]["gpus"], json!(["GPU 0", "GPU 2"]), "{state}");
    let t0 = Instant::now();
    b.m.choose("b");
    until("«b» running", Duration::from_secs(9), || b.running("b"));
    // «b» alone takes 4 s to load: after the rest of «a» it would have been almost 8.
    assert!(t0.elapsed() < Duration::from_millis(6_000), "{:?}", t0.elapsed());
    assert_eq!(b.engines_alive(), ["b"]);
    assert_eq!(serde_json::to_value(b.m.state()).unwrap()["loading"], Value::Null);
    // A load that was stopped has no conversation to save.
    assert!(!b.routes_to_engine().iter().any(|r| r.starts_with("a ")), "{:?}", b.routes_to_engine());
    assert_eq!(b.text("b"), "I am the engine b");
}

/// A request that was waiting for the model whose load the user stopped is told so, with an answer nobody retries:
/// retried, it would stop in turn the model the user has just picked.
#[test]
fn a_request_waiting_for_a_stopped_load_is_told_and_not_retried() {
    let b = fixture_slow(30, 3_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a"));
    let url = b.url("/v1/chat/completions");
    let waiting = std::thread::spawn(move || {
        let r = post(&url, &[("Content-Type", "application/json")], &json!({ "model": "a", "messages": [] }).to_string());
        (code_of(&r), json_of(r))
    });
    std::thread::sleep(Duration::from_millis(400));
    b.m.choose("b");
    let (code, v) = waiting.join().unwrap();
    assert_eq!(code, 422, "{v}");
    assert!(!v["error"]["message"].as_str().unwrap_or("").is_empty(), "{v}");
    until("«b» running", Duration::from_secs(8), || b.running("b"));
    assert_eq!(b.engines_alive(), ["b"]);
}

/// Only the user's choice stops a load. A request that names another model waits for the load to finish, as it
/// always did, and then switches.
#[test]
fn a_request_for_another_model_does_not_stop_a_load() {
    let b = fixture_slow(30, 1_500);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a"));
    assert_eq!(b.text("b"), "I am the engine b");
    // «a» was saved when it stopped: it had finished loading.
    assert_eq!(b.routes_to_engine(), ["a POST /slots/0?action=persist", "b POST /v1/chat/completions"]);
}

/// Picking the model that is already running, or already loading, starts nothing.
#[test]
fn choosing_the_model_already_there_does_nothing() {
    let b = fixture_slow(30, 1_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a"));
    b.m.choose("a");
    until("«a» running", Duration::from_secs(5), || b.running("a"));
    b.m.choose("a");
    std::thread::sleep(Duration::from_millis(500));
    assert!(b.running("a"));
    assert_eq!(b.engines_alive(), ["a"]);
    assert_eq!(b.routes_to_engine(), Vec::<String>::new(), "«a» was started once and never stopped");
}

/// A choice the plan refuses leaves the reason in the state, and the model that was running stays.
#[test]
fn a_choice_that_does_not_start_says_why() {
    let b = fixture();
    b.m.choose("ghost");
    until("the error", Duration::from_secs(3), || b.m.state().phase == Phase::Error);
    let s = b.m.state();
    assert_eq!(s.model.as_deref(), Some("ghost"));
    assert!(s.error.as_deref().unwrap_or("").contains("ghost"), "{s:?}");
}

impl Fixture {
    /// The user's choices give model plans this context from now on.
    fn context(&self, ctx: u32) {
        std::fs::write(self._dir.path().join("context"), ctx.to_string()).unwrap();
    }

    /// The user's choices no longer fit `key` (`None`: everything fits again).
    fn refuse(&self, key: Option<&str>) {
        let f = self._dir.path().join("refuse");
        match key {
            Some(k) => std::fs::write(f, k).unwrap(),
            None => drop(std::fs::remove_file(f)),
        }
    }

    /// Waits until a request is in progress.
    fn answering(&self) {
        until("the answer in progress", Duration::from_secs(3), || self.m.state().requests_in_flight == 1);
    }

    fn loads(&self) -> Vec<String> {
        events(self, "restore").into_iter().map(|e| e.split(' ').next().unwrap().to_string()).collect()
    }
}

/// A reload asked while «a» answered is not done once the user has picked «b» meanwhile, nor after the engine was
/// stopped: it never brings back the model before.
#[test]
fn a_pending_reload_never_brings_back_the_model_before() {
    let b = fixture_slow(80, 0);
    b.text("a");
    b.context(2048);
    std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.text("a"));
        b.answering();
        b.m.reload_if_changed();
        b.m.choose("b");
        answering.join().unwrap();
    });
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    std::thread::sleep(Duration::from_millis(1_500));
    assert!(b.running("b"), "{:?}", b.m.state());
    assert_eq!(b.loads(), ["a", "b"]);

    // the same with the engine stopped while the reload waits: nothing starts again
    b.context(1024);
    std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.ask("b"));
        b.answering();
        b.m.reload_if_changed();
        b.m.unload();
        answering.join().unwrap();
    });
    std::thread::sleep(Duration::from_millis(1_500));
    assert_eq!(b.m.state().phase, Phase::Stopped);
    assert!(b.engines_alive().is_empty());
    assert_eq!(b.loads(), ["a", "b"]);
}

/// The context changed while the model loaded, twice: the load ends with the plan it began with, then the model is
/// loaded once more with the last choice.
#[test]
fn a_choice_changed_while_the_model_loads_is_applied_when_the_load_ends() {
    let b = fixture_slow(30, 1_500);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a"));
    b.context(2048);
    b.m.reload_if_changed();
    b.context(1024);
    b.m.reload_if_changed();
    until("«a» running with the last context", Duration::from_secs(8), || b.running("a") && b.m.state().context == Some(1024));
    assert_eq!(b.loads(), ["a", "a"]);
    assert_eq!(b.engines_alive(), ["a"]);
}

/// A changed choice that does not fit leaves the model running and says why; back to the choice it runs with, the
/// failure is gone and nothing is loaded again. A choice changed and changed back while the model answers loads
/// nothing again either.
#[test]
fn going_back_to_the_choice_in_use_clears_the_failure_and_reloads_nothing() {
    let b = fixture_slow(80, 0);
    b.text("a");
    b.refuse(Some("a"));
    b.m.reload_if_changed();
    until("the failure", Duration::from_secs(3), || b.m.state().failed.is_some());
    assert!(b.running("a"));
    b.refuse(None);
    b.m.reload_if_changed();
    assert!(b.m.state().failed.is_none(), "{:?}", b.m.state());

    std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.text("a"));
        std::thread::sleep(Duration::from_millis(100));
        b.context(2048);
        b.m.reload_if_changed();
        b.context(4096);
        b.m.reload_if_changed();
        answering.join().unwrap();
    });
    std::thread::sleep(Duration::from_millis(1_000));
    assert!(b.running("a"));
    assert_eq!(b.loads(), ["a"], "the same plan: nothing loaded again");
}

/// A model picked while all the cards are lent is the one that starts when they come back: meanwhile the state says the
/// cards are lent, not that it loads.
#[test]
fn a_model_picked_while_the_cards_are_lent_waits_as_lent() {
    let b = fixture();
    b.text("a");
    assert_eq!(b.control("/engine/release", json!({})).0, 200);
    b.m.choose("b");
    std::thread::sleep(Duration::from_millis(500));
    let s = b.m.state();
    assert_eq!((s.phase, s.chosen.as_deref(), s.model.as_deref()), (Phase::Released, None, Some("b")), "{s:?}");
    b.m.resume(&mut |_| {}).unwrap();
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    assert_eq!(b.engines_alive(), ["b"]);
}

/// While a model is being taken off the computer nothing starts it: a request gets 422 with a sentence, a choice leaves
/// nothing picked, a reload does not run. Once the guard is dropped it starts again.
#[test]
fn a_model_being_removed_is_not_started() {
    let b = fixture();
    b.text("a");
    let removing = b.m.block_starts("b");
    let (code, v) = b.control("/v1/chat/completions", json!({ "model": "b", "messages": [] }));
    assert_eq!(code, 422, "{v}");
    assert!(v["error"]["message"].as_str().unwrap().contains("«b»"), "{v}");
    b.m.choose("b");
    std::thread::sleep(Duration::from_millis(300));
    let s = b.m.state();
    assert_eq!((s.chosen, s.failed.is_none()), (None, true));
    assert!(b.running("a"));

    let removing_a = b.m.block_starts("a");
    b.context(2048);
    b.m.reload_if_changed();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(b.loads(), ["a"], "the reload did not start «a» again");
    b.m.unload();
    assert_eq!(b.control("/v1/chat/completions", json!({ "model": "a", "messages": [] })).0, 422);
    assert!(b.engines_alive().is_empty());

    drop(removing);
    drop(removing_a);
    assert_eq!(b.text("b"), "I am the engine b");
}

/// «a» has to be loaded again and «b» is picked meanwhile, but «b» does not start: «a» stays and takes the changed choice.
#[test]
fn the_model_that_stays_after_a_failed_switch_takes_the_changed_choice() {
    let b = fixture_slow(80, 0);
    b.text("a");
    b.refuse(Some("b"));
    std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.text("a"));
        b.answering();
        b.context(2048);
        b.m.reload_if_changed();
        b.m.choose("b");
        answering.join().unwrap();
    });
    until("«a» with the new context", Duration::from_secs(5), || b.running("a") && b.m.state().context == Some(2048));
    assert_eq!(b.loads(), ["a", "a"]);
}

/// The guard stops nothing by itself: a model loading when it is taken comes up and answers, and so does a running one
/// whose choices changed, as it is. `/engine/model` and `resume` that would start a blocked model are refused; once the
/// guards are gone it starts again.
#[test]
fn a_model_being_removed_answers_while_it_runs_and_nothing_starts_it_again() {
    let b = fixture_slow(30, 1_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(3), || b.loading("a"));
    let removing = b.m.block_starts("a");
    until("«a» running", Duration::from_secs(5), || b.running("a"));
    assert_eq!(b.text("a"), "I am the engine a");

    b.context(2048);
    b.m.reload_if_changed();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(b.text("a"), "I am the engine a");
    assert_eq!((b.m.state().context, b.loads()), (Some(4096), vec!["a".to_string()]));

    let removing_b = b.m.block_starts("b");
    assert_eq!(b.control("/engine/model", json!({ "model": "b" })).0, 422);
    assert_eq!(b.control("/engine/release", json!({})).0, 200);
    assert!(b.m.resume(&mut |_| {}).unwrap_err().is::<engine::BeingRemoved>());
    assert!(b.engines_alive().is_empty());

    drop(removing);
    drop(removing_b);
    assert_eq!(b.text("a"), "I am the engine a");
    assert_eq!(b.m.state().context, Some(2048));
}

/// Two models picked one after the other while all the cards are lent: the last one starts when they come back.
#[test]
fn the_last_model_picked_while_the_cards_are_lent_is_the_one_that_starts() {
    let b = fixture();
    b.text("a");
    assert_eq!(b.control("/engine/release", json!({})).0, 200);
    b.m.choose("b");
    b.m.choose("c");
    until("«c» waits for the cards", Duration::from_secs(3), || {
        let s = b.m.state();
        s.chosen.is_none() && s.model.as_deref() == Some("c")
    });
    b.m.resume(&mut |_| {}).unwrap();
    until("«c» running", Duration::from_secs(5), || b.running("c"));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(b.engines_alive(), ["c"]);
}

/// A model picked while part of the cards is lent, and that does not fit on the rest: a request that starts another model
/// on the cards that remain does not take its place, and the picked one starts when the cards come back.
#[test]
fn a_request_on_the_cards_that_remain_does_not_replace_the_model_picked() {
    let b = fixture();
    b.text("a");
    assert_eq!(b.control("/engine/release", json!({ "gpus": [2] })).0, 200);
    b.m.choose("b");
    until("«b» waits for the cards", Duration::from_secs(3), || {
        let s = b.m.state();
        s.chosen.is_none() && s.failed.is_none() && s.model.as_deref() == Some("b")
    });
    assert_eq!(b.text("c"), "I am the engine c");
    b.m.resume(&mut |_| {}).unwrap();
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(b.engines_alive(), ["b"]);
}

/// «a» has to be loaded again while it answers; a model picked meanwhile is refused (it is being removed): the reload is
/// still done when the answer ends.
#[test]
fn a_reload_waits_for_a_picked_model_that_never_starts_and_then_runs() {
    let b = fixture_slow(80, 0);
    b.text("a");
    let _removing = b.m.block_starts("b");
    std::thread::scope(|sc| {
        let answering = sc.spawn(|| b.text("a"));
        b.answering();
        b.context(2048);
        b.m.reload_if_changed();
        b.m.choose("b");
        answering.join().unwrap();
    });
    until("«a» with the new context", Duration::from_secs(5), || b.running("a") && b.m.state().context == Some(2048));
}

/// The state never says «starting» without saying what loads: while the plan is made (slow here, as the hardware read of a
/// busy computer) the phase is still the one before.
#[test]
fn the_state_never_says_starting_without_what_loads() {
    let b = fixture_slow(30, 500);
    std::fs::write(b._dir.path().join("plan_ms"), "800").unwrap();
    b.m.choose("a");
    let t0 = Instant::now();
    let mut seen_loading = false;
    while t0.elapsed() < Duration::from_secs(4) && !b.running("a") {
        let s = b.m.state();
        if s.phase == Phase::Starting {
            assert!(s.loading.is_some(), "starting without loading: {s:?}");
            seen_loading = true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(seen_loading && b.running("a"), "{:?}", b.m.state());
}

// --- room beside the other programs -------------------------------------------------------------------------------

/// The memory used on the three GPUs as a test sets it: what the other programs hold, and an engine of ours until it lets go.
type Cards = std::sync::Arc<std::sync::Mutex<Vec<(u32, u64, u64)>>>;
type Count = std::sync::Arc<std::sync::atomic::AtomicUsize>;

fn cards(used: &[(u32, u64)]) -> Cards {
    std::sync::Arc::new(std::sync::Mutex::new(used.iter().map(|&(i, u)| (i, u, 8192)).collect()))
}

fn count(c: &Count) -> usize {
    c.load(std::sync::atomic::Ordering::SeqCst)
}

/// The fake models with the app's check reduced to a rule: a GPU of the model with more than 2 GB in use has no room for it.
/// The answer is the fixture and how many times the check was asked. `start_ms`: how long a model takes to load.
fn fixture_with_cards(used: Cards, start_ms: u64) -> (Fixture, Count) {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let read = used.clone();
    let m = EngineManager::new(planner(log.clone(), true, 30, start_ms, 0), Box::new(move || read.lock().unwrap().clone()), dir.path());
    let checks = Count::default();
    let counted = checks.clone();
    m.set_room_check(Box::new(move |key, _, used| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let gpus: &[u32] = if key == "a" { &[0, 2] } else { &[0, 1, 2] };
        let held: Vec<u32> = used.iter().filter(|u| u.1 > 2048 && gpus.contains(&u.0)).map(|u| u.0).collect();
        Ok((!held.is_empty()).then(|| engine_cfg::CardsTaken { sentence: format!("Another program holds GPU {held:?}."), cards: held }))
    }));
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    http::serve(m.clone(), port, Some(std::sync::Arc::new(Echo))).unwrap();
    (Fixture { m, port, log, _dir: dir }, checks)
}

/// GPU `gpu` gives back its memory (what an engine of ours held there) once the check has been asked again: the start
/// that follows the closing of an engine found it still held, and waits for it.
fn given_back_after_the_next_check(used: &Cards, gpu: usize, checks: &Count) -> std::thread::JoinHandle<()> {
    let (used, checks, before) = (used.clone(), checks.clone(), count(checks));
    std::thread::spawn(move || {
        until("the check asked again", Duration::from_secs(20), || count(&checks) > before);
        used.lock().unwrap()[gpu].1 = 300;
    })
}

/// Another program holds GPU 1. «a» does not use it and starts; «b» uses it and does not start: no engine is opened, the
/// state says which card in `taken` and keeps the detail in `reason`, and a request that names «b» gets 422, which the
/// agent does not retry. «Riprova» (`retry`) starts «b» anyway, without asking the check again.
#[test]
fn a_model_without_room_beside_another_program_does_not_start_until_retry() {
    let (b, checks) = fixture_with_cards(cards(&[(0, 300), (1, 4900), (2, 0)]), 300);
    b.m.choose("a");
    until("«a» running", Duration::from_secs(5), || b.running("a"));

    b.m.choose("b");
    until("«b» refused", Duration::from_secs(5), || b.m.state().failed.is_some());
    let s = b.m.state();
    let failed = s.failed.clone().unwrap();
    assert_eq!((failed.model.as_str(), failed.taken.as_deref()), ("b", Some("Another program holds GPU [1].")), "{s:?}");
    assert!(failed.reason.starts_with("Another program holds GPU [1].") && failed.reason.contains("4900"), "{}", failed.reason);
    assert_eq!(s.phase, Phase::Error, "«a» stopped for «b», as with any switch");
    assert!(b.engines_alive().is_empty(), "«b» was never opened");

    let (code, v) = b.control("/v1/chat/completions", json!({ "model": "b", "messages": [] }));
    assert_eq!(code, 422, "{v}");

    let asked = count(&checks);
    b.m.retry("b");
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    assert_eq!(count(&checks), asked, "«Riprova» does not ask again");
    assert_eq!(b.m.state().failed.map(|f| f.model), None);
}

/// Memory that cannot be read does not block the start: the model starts as before, and the log says it was not looked at.
#[test]
fn a_model_starts_as_before_when_the_memory_cannot_be_read() {
    let (b, checks) = fixture_with_cards(cards(&[]), 300);
    b.m.choose("b");
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    assert_eq!(count(&checks), 0);
    let log = std::fs::read_to_string(b._dir.path().join("manager.log")).unwrap();
    assert!(log.contains("\"event\":\"room\"") && log.contains("cannot be read"), "{log}");
}

/// The engine of «a» that the switch stops still holds GPU 0 when «b» looks: that is not another program, and «b» starts
/// once it is given back. A GPU the stopped engine did not use is another program's at once: the check is asked once.
#[test]
fn the_memory_of_the_engine_just_stopped_is_not_another_programs() {
    let used = cards(&[(0, 300), (1, 0), (2, 0)]);
    let (b, checks) = fixture_with_cards(used.clone(), 300);
    b.m.choose("a");
    until("«a» running", Duration::from_secs(5), || b.running("a"));
    used.lock().unwrap()[0].1 = 7000;
    let given_back = given_back_after_the_next_check(&used, 0, &checks);
    b.m.choose("b");
    until("«b» running", Duration::from_secs(20), || b.running("b"));
    given_back.join().unwrap();
    assert_eq!(b.m.state().failed.map(|f| f.model), None);

    b.m.choose("a");
    until("«a» running", Duration::from_secs(5), || b.running("a"));
    used.lock().unwrap()[1].1 = 4900;
    let asked = count(&checks);
    b.m.choose("b");
    until("«b» refused", Duration::from_secs(20), || b.m.state().failed.is_some());
    assert_eq!(count(&checks), asked + 1, "GPU 1 was not «a»'s: nothing to wait for");
}

/// A load the user stops by picking another model closes its engine too: what it held on GPU 0 is not another program's,
/// and the model picked starts once it is given back.
#[test]
fn the_memory_of_a_load_that_was_stopped_is_not_another_programs() {
    let used = cards(&[(0, 300), (1, 0), (2, 0)]);
    let (b, checks) = fixture_with_cards(used.clone(), 4_000);
    b.m.choose("a");
    until("«a» loading", Duration::from_secs(5), || b.loading("a") && b.engines_alive() == ["a"]);
    used.lock().unwrap()[0].1 = 7000;
    let given_back = given_back_after_the_next_check(&used, 0, &checks);
    b.m.choose("b");
    until("«b» running", Duration::from_secs(30), || b.running("b"));
    given_back.join().unwrap();
    assert_eq!(b.m.state().failed.map(|f| f.model), None);
}

/// An engine that closed by itself: the request that starts it again finds its memory still on GPU 0, which is not another
/// program's, and gets its answer once it is given back.
#[test]
fn the_memory_of_an_engine_that_closed_by_itself_is_not_another_programs() {
    let used = cards(&[(0, 300), (1, 0), (2, 0)]);
    let (b, checks) = fixture_with_cards(used.clone(), 300);
    b.text("a");
    let _ = post(&b.url("/test/crash"), &[], ""); // the fake engine exits with code 3
    until("the engine of «a» gone", Duration::from_secs(10), || b.engines_alive().is_empty());
    used.lock().unwrap()[0].1 = 7000;
    let given_back = given_back_after_the_next_check(&used, 0, &checks);
    assert_eq!(b.text("a"), "I am the engine a");
    given_back.join().unwrap();
}

/// A model started with «Riprova» beside another program is in use: a change of its context loads it again, without the
/// check that would turn it off.
#[test]
fn a_model_in_use_is_loaded_again_beside_another_program() {
    let (b, checks) = fixture_with_cards(cards(&[(0, 300), (1, 4900), (2, 0)]), 300);
    b.m.retry("b");
    until("«b» running", Duration::from_secs(5), || b.running("b"));
    b.context(2048);
    b.m.reload_if_changed();
    until("«b» with the new context", Duration::from_secs(10), || b.running("b") && b.m.state().context == Some(2048));
    assert_eq!((count(&checks), b.m.state().failed.map(|f| f.model)), (0, None));
}
