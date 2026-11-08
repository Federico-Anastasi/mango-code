//! The engine manager with the fake engine (`fake-engine`): model switch, streaming in pieces, GPUs released and
//! resumed, requests that wait. No GPUs.

use anyhow::{bail, Result};
use engine_cfg::{EnginePlan, Vendor, Gpu};
use mango_common::{tr, ProcSpec};
use engine::{http, Phase, EngineManager};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, Instant};

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
            // It splits itself over the GPUs that remain.
            "c" => [0, 1, 2].into_iter().filter(|i| !excluded.contains(i)).collect(),
            k => bail!("The requested model is not among Mango Code's («{k}»)"),
        };
        if gpus.is_empty() {
            bail!("no GPU left");
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
                exe: FAKE.into(),
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
            ctx: 4096,
            images: false,
            gpus_used: gpus.into_iter().map(gpu).collect(),
            gguf: format!(r"C:\fake\{key}.gguf").into(),
        })
    })
}

fn json_of(r: ureq::Response) -> Value {
    serde_json::from_reader(r.into_reader()).unwrap()
}

struct Fixture {
    m: EngineManager,
    port: u16,
    log: PathBuf,
    _dir: tempfile::TempDir,
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
        Some(dir.path().join("model.txt")),
    );
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    http::serve(m.clone(), port).unwrap();
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
        let r = ureq::post(&self.url("/v1/chat/completions"))
            .set("Content-Type", "application/json")
            .send_string(&json!({ "model": key, "stream": true, "messages": [{ "role": "user", "content": "who are you?" }] }).to_string())
            .unwrap();
        assert_eq!(r.header("Content-Type"), Some("text/event-stream"));
        let mut pieces = Vec::new();
        // A cut reply (the engine stopped halfway) ends the reading: the pieces that arrived stay.
        for line in BufReader::new(r.into_reader()).lines() {
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
        let r = match ureq::post(&self.url(p)).set("Content-Type", "application/json").send_string(&body.to_string()) {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => panic!("{e}"),
        };
        (r.status(), json_of(r))
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
    write!(s, "POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
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
    // The last running model is remembered for the next start.
    assert_eq!(b.m.remembered().as_deref(), Some("b"));
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
    let r = ureq::get(&b.url("/health")).call();
    assert!(matches!(r, Err(ureq::Error::Status(503, _))));
    b.text("a");
    assert_eq!(json_of(ureq::get(&b.url("/props")).call().unwrap())["model_path"], json!(r"C:\fake\a.gguf"));
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
    assert_eq!(status, 500);
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

#[test]
fn every_route_rejects_web_pages() {
    let b = fixture();
    let r = ureq::get(&b.url("/engine")).set("Origin", "https://example.com").call();
    assert!(matches!(r, Err(ureq::Error::Status(403, _))));
    // The model too: a page sends a "simple" request (text/plain) that CORS doesn't stop.
    let r = ureq::post(&b.url("/v1/chat/completions"))
        .set("Origin", "https://example.com")
        .set("Content-Type", "text/plain")
        .send_string(&json!({ "model": "a", "messages": [] }).to_string());
    assert!(matches!(r, Err(ureq::Error::Status(403, _))));
    assert_eq!(b.m.state().phase, Phase::Stopped, "the rejected request must not start the engine");
    let v = json_of(ureq::get(&b.url("/engine")).call().unwrap());
    assert_eq!(v["phase"], json!("stopped"));
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
        let s = json_of(ureq::get(&b.url("/engine")).call().unwrap());
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
        let r = ureq::post(&b.url(p)).set("Content-Type", "application/json").set("User-Agent", "attached-test/1.0").send_string(&body.to_string());
        match r {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r.status(),
            Err(e) => panic!("{e}"),
        }
    };
    assert_eq!(call("/engine/model", json!({ "model": "a" })), 200);
    assert_eq!(call("/engine/release", json!({ "gpus": [1] })), 200);
    assert_eq!(call("/engine/model", json!({ "model": "xyz" })), 500);
    json_of(ureq::get(&b.url("/engine")).call().unwrap()); // reads aren't logged

    let lines: Vec<Value> = std::fs::read_to_string(b._dir.path().join("manager.log"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v.get("route").is_some()) // the memory lines have «event»
        .collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(lines.iter().map(|r| r["route"].as_str().unwrap()).collect::<Vec<_>>(), ["/engine/model", "/engine/release", "/engine/model"]);
    assert_eq!(lines.iter().map(|r| r["status"].as_u64().unwrap()).collect::<Vec<_>>(), [200, 200, 500]);
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
    assert_eq!(status, 500, "{v}");
    let s = b.m.state();
    assert_eq!((s.phase, s.model.as_deref()), (Phase::Running, Some("a")), "{s:?}");
    assert!(s.error.as_deref().is_some_and(|e| e.contains("xyz")), "{:?}", s.error);
    assert_eq!(b.text("a"), "I am the engine a");
    assert!(!b.routes_to_engine().iter().any(|r| r.contains("persist")), "the running engine was stopped");
}

/// A process that stays alive until the test closes it: whoever takes the GPUs on loan.
fn spawn_process() -> std::process::Child {
    std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap()
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
    let r = ureq::post(&b.url("/engine/release")).set("User-Agent", "loan-test/1.0").send_string("{}").unwrap();
    let v = json_of(r);
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
    let _ = ureq::post(&b.url("/test/crash")).call(); // the fake engine exits with code 3
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

/// The warm-up request (system prompt base) reaches the engine with its header: it's what tells it to answer at
/// once if the base is already on disk.
#[test]
fn the_warmup_request_reaches_the_engine_as_such() {
    let b = fixture();
    let r = ureq::post(&b.url("/v1/chat/completions"))
        .set("Content-Type", "application/json")
        .set("x-mango-warmup", "1")
        .send_string(&json!({ "model": "a", "messages": [] }).to_string())
        .unwrap();
    assert_eq!(r.status(), 200);
    let lines = std::fs::read_to_string(&b.log).unwrap();
    let chat = lines.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["route"] == "/v1/chat/completions").unwrap();
    assert_eq!(chat["headers"]["x-mango-warmup"], json!("1"), "{chat}");
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
    let r = ureq::post(&b.url("/tokenize"))
        .set("Content-Type", "application/json")
        .send_string(&json!({ "content": "a  sentence of\nfive words" }).to_string())
        .unwrap();
    assert_eq!(json_of(r)["tokens"].as_array().unwrap().len(), 5);
    let empty = ureq::post(&b.url("/tokenize")).set("Content-Type", "application/json").send_string(&json!({ "content": "" }).to_string()).unwrap();
    assert!(json_of(empty)["tokens"].as_array().unwrap().is_empty());
}

/// The manager closes the connection after every forwarded reply, and tells the client so even when the engine
/// doesn't (the fake one doesn't): otherwise a client that keeps connections open reuses an already closed one and
/// the request drops («socket closed unexpectedly»).
#[test]
fn the_forwarded_reply_says_the_connection_closes() {
    let b = fixture();
    b.text("a");
    let r = ureq::post(&b.url("/tokenize")).set("Content-Type", "application/json").send_string(&json!({ "content": "a b" }).to_string()).unwrap();
    assert_eq!(r.header("connection").map(str::to_ascii_lowercase).as_deref(), Some("close"));
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
        "POST /engine/release HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\ne\r\n{\"gpus\":[1]}\r\n0\r\n\r\n",
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
        None,
    );
    let e = format!("{:#}", m.start("a", &mut |_| {}).unwrap_err());
    // The sentences are asserted in the language the manager is using, whatever it is on this PC.
    let sentence = tr!("Il modello non è entrato in memoria mentre si caricava.", "The model did not fit in memory while loading.");
    let advice = tr!("scegli un modello più piccolo", "choose a smaller model");
    assert!(e.starts_with(&sentence) && e.contains(&advice), "{e}");
    assert!(e.contains(&tr!("dettaglio tecnico", "technical detail")) && e.contains("out of memory"), "{e}");
}
