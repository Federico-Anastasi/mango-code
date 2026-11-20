//! The system prompt of a new conversation, read once and kept on disk (`engine::prefix`), with the fake engine: what each
//! conversation makes the engine read, in the tokens of the fake engine (one per word).

use anyhow::{bail, Result};
use engine::EngineManager;
use engine_cfg::{EnginePlan, Gpu, SlotCache, Vendor};
use mango_common::ProcSpec;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

#[allow(dead_code)] // each test file uses a part of it
mod support;
use support::{code_of, json_of, ok, post, serve};

const FAKE: &str = env!("CARGO_BIN_EXE_fake-engine");
/// The words of the stable part of the prompts in these tests: above the minimum a prefix must have to be kept.
const STABLE_WORDS: usize = 700;

struct Fixture {
    m: EngineManager,
    port: u16,
    dir: tempfile::TempDir,
}

fn planner(dir: PathBuf, hybrid: bool, read_ms: u64) -> Box<engine::Planner> {
    Box::new(move |key: &str, port: u16, _: &[u32]| -> Result<EnginePlan> {
        if !["a", "b"].contains(&key) {
            bail!("unknown model {key}");
        }
        let url = format!("http://127.0.0.1:{port}");
        let slots = dir.join("slots");
        std::fs::create_dir_all(&slots)?;
        Ok(EnginePlan {
            key: key.into(),
            spec: ProcSpec {
                name: format!("engine-{key}"),
                exe: FAKE.into(),
                args: vec!["-m".into(), format!(r"C:\fake\{key}.gguf"), "--port".into(), port.to_string(), "--slot-save-path".into(), slots.display().to_string()],
                env: vec![
                    ("FAKE_ENGINE_LOG".into(), dir.join("requests.jsonl").display().to_string()),
                    ("FAKE_ENGINE_HYBRID".into(), if hybrid { "1" } else { "0" }.into()),
                    ("FAKE_ENGINE_READ_MS".into(), read_ms.to_string()),
                    ("FAKE_ENGINE_CHUNK_MS".into(), "1".into()),
                ],
                env_remove: vec![],
                cwd: None,
                health_url: Some(format!("{url}/health")),
                ready_timeout_s: 20,
                shutdown_post: None,
                startup_post: None,
            },
            url,
            label: key.into(),
            ctx: 65536,
            images: false,
            gpus_used: vec![Gpu { index: 0, name: "GPU 0".into(), vendor: Vendor::Nvidia, memory_mib: 8192, cuda_driver: Some((12, 6)), cc: Some((8, 6)) }],
            gguf: format!(r"C:\fake\{key}.gguf").into(),
            slots: Some(SlotCache { folder: slots, memory: dir.join("memory"), model: key.into(), signature: "test".into() }),
        })
    })
}

fn fixture() -> Fixture {
    fixture_with(false, 0)
}

fn fixture_with(hybrid: bool, read_ms: u64) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let m = EngineManager::new(planner(dir.path().to_path_buf(), hybrid, read_ms), Box::new(Vec::new), dir.path());
    let port = serve(&m, None);
    Fixture { m, port, dir }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.m.stop();
    }
}

fn words(prefix: &str, n: usize) -> String {
    (0..n).map(|i| format!("{prefix}{i}")).collect::<Vec<_>>().join(" ")
}

/// The part of a conversation's request that the tests vary.
struct Chat {
    model: String,
    /// The text that is the same in every conversation, and the working folder that ends the system prompt.
    stable: String,
    folder: String,
    question: String,
    /// What follows the first question: the answer and the next question, as a conversation that goes on.
    later: Vec<Value>,
    marker: bool,
}

fn chat(model: &str, stable: &str, folder: &str, question: &str) -> Chat {
    Chat { model: model.into(), stable: stable.into(), folder: folder.into(), question: question.into(), later: Vec::new(), marker: true }
}

impl Fixture {
    fn url(&self, p: &str) -> String {
        format!("http://127.0.0.1:{}{p}", self.port)
    }

    fn send(&self, c: &Chat) -> u16 {
        let mut messages = vec![
            json!({ "role": "system", "content": format!("{}\n<env> Working directory: {} </env>", c.stable, c.folder) }),
            json!({ "role": "user", "content": c.question }),
        ];
        messages.extend(c.later.iter().cloned());
        let body = json!({
            "model": c.model, "stream": false, "messages": messages,
            "tools": [{ "type": "function", "function": { "name": "echo", "description": "echo back what you give it" } }],
        });
        let length = c.stable.len().to_string();
        let mut headers = vec![("Content-Type", "application/json")];
        if c.marker {
            headers.push((engine::prefix::STABLE_PROMPT, length.as_str()));
        }
        code_of(&post(&self.url("/v1/chat/completions"), &headers, &body.to_string()))
    }

    /// What the engine read, in order: `(route, tokens read, tokens in the prompt)`.
    fn reads(&self) -> Vec<(String, u64, u64)> {
        std::fs::read_to_string(self.dir.path().join("requests.jsonl.reads"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .map(|v| (v["route"].as_str().unwrap().to_string(), v["reread"].as_u64().unwrap(), v["prompt_tokens"].as_u64().unwrap()))
            .collect()
    }

    /// The tokens the last conversation request read.
    fn last_chat(&self) -> u64 {
        self.reads().into_iter().rev().find(|r| r.0 == "/v1/chat/completions").unwrap().1
    }

    fn primed(&self) -> usize {
        self.reads().iter().filter(|r| r.0 == "/completion").count()
    }

    fn files(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.dir.path().join("slots"))
            .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    fn prefix_files(&self) -> Vec<String> {
        self.files().into_iter().filter(|f| f.contains(".prefix-")).collect()
    }

    /// The `prefix` events of the manager's log, as `(action, tokens)` or the error.
    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("manager.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v["event"] == "prefix")
            .collect()
    }

    fn control(&self, p: &str, body: Value) -> Value {
        json_of(ok(post(&self.url(p), &[("Content-Type", "application/json")], &body.to_string())))
    }
}

/// The first conversation reads the system prompt (the wait the user would have had anyway) and keeps it on disk; the
/// conversations after it, in other folders and on other days, read only what is theirs.
#[test]
fn a_new_conversation_reads_only_what_is_its_own() {
    // A hybrid model cannot cut its slot back to the prompt: a second conversation in the same session needs the file too.
    for hybrid in [false, true] {
        let b = fixture_with(hybrid, 0);
        let s = words("rule", STABLE_WORDS);
        assert_eq!(b.send(&chat("a", &s, "C:/one", "first question")), 200);
        let reads = b.reads();
        assert_eq!(reads[0].0, "/completion");
        assert_eq!(reads[0].1, STABLE_WORDS as u64, "the system prompt is read once, as the conversation would have read it");
        assert!(reads[1].1 + (STABLE_WORDS as u64) >= reads[1].2 && reads[1].1 < 60, "the request itself reads the rest only: {reads:?}");
        assert_eq!(b.prefix_files().len(), 1, "{:?}", b.files());

        for (folder, question) in [("C:/two", "second question"), ("C:/two", "third question, same folder")] {
            assert_eq!(b.send(&chat("a", &s, folder, question)), 200);
            assert_eq!(b.primed(), 1, "hybrid {hybrid}: no second reading");
            assert!(b.last_chat() < 60, "hybrid {hybrid}: only the folder, the tools and the question are read: {:?}", b.reads());
        }
        assert_eq!(b.prefix_files().len(), 1, "the same file serves every folder");
    }
}

/// A conversation that goes on does not touch the slot: it has everything it needs there.
#[test]
fn a_conversation_that_goes_on_does_not_touch_the_slot() {
    let b = fixture();
    let s = words("rule", STABLE_WORDS);
    b.send(&chat("a", &s, "C:/one", "first question"));
    let mut next = chat("a", &s, "C:/one", "first question");
    next.later = vec![json!({ "role": "assistant", "content": "I am the engine a" }), json!({ "role": "user", "content": "another question" })];
    assert_eq!(b.send(&next), 200);
    assert_eq!(b.primed(), 1);
    assert!(b.last_chat() < 30, "{:?}", b.reads());
    assert!(b.events().iter().all(|e| e["action"] != "restored"), "{:?}", b.events());
}

/// A restart, a model that goes and comes back, the cards lent and given back: the new engine starts from the file.
#[test]
fn after_a_restart_and_after_another_model_the_prompt_comes_from_the_disk() {
    for hybrid in [false, true] {
        let b = fixture_with(hybrid, 0);
        let s = words("rule", STABLE_WORDS);
        b.send(&chat("a", &s, "C:/one", "first question"));
        let file = b.prefix_files();
        assert_eq!(file.len(), 1);

        // Another model takes the engine; the first one comes back.
        let other = words("other", STABLE_WORDS);
        assert_eq!(b.send(&chat("b", &other, "C:/one", "hello")), 200);
        assert_eq!(b.prefix_files().len(), 2, "each model has its own file: {:?}", b.files());
        let primed = b.primed();
        assert_eq!(b.send(&chat("a", &s, "C:/one", "back again")), 200);
        assert_eq!(b.primed(), primed, "hybrid {hybrid}: the prompt was not read again");
        assert!(b.last_chat() < 60, "hybrid {hybrid}: {:?}", b.reads());
        assert!(b.events().iter().any(|e| e["action"] == "restored" && e["model"] == "a"), "{:?}", b.events());

        // The cards lent and given back: the engine restarts.
        b.control("/engine/release", json!({ "pid": 0 }));
        b.control("/engine/resume", json!({}));
        assert_eq!(b.send(&chat("a", &s, "C:/two", "after the loan")), 200);
        assert_eq!(b.primed(), primed, "hybrid {hybrid}");
        assert!(b.last_chat() < 60, "hybrid {hybrid}: {:?}", b.reads());
        assert!(b.prefix_files().contains(&file[0]) && b.prefix_files().len() == 2, "no new file for the same prompt: {:?}", b.files());
    }
}

/// Another system prompt (another instructions file) is another file, and the first is still there.
#[test]
fn another_system_prompt_has_its_own_file() {
    let b = fixture();
    let (s, t) = (words("rule", STABLE_WORDS), words("project", STABLE_WORDS));
    b.send(&chat("a", &s, "C:/one", "q"));
    b.send(&chat("a", &t, "C:/one", "q"));
    assert_eq!(b.prefix_files().len(), 2);
    assert_eq!(b.primed(), 2);
    b.send(&chat("a", &s, "C:/one", "q again"));
    assert_eq!(b.primed(), 2, "the first one came back from its file");
    assert!(b.last_chat() < 60, "{:?}", b.reads());
}

/// Without the header, or with a prompt too short to matter, or with a header that says nothing true, the request goes
/// through as it is and nothing is kept.
#[test]
fn what_is_not_a_conversation_of_the_app_or_is_too_short_is_left_alone() {
    let b = fixture();
    let s = words("rule", STABLE_WORDS);
    let mut c = chat("a", &s, "C:/one", "q");
    c.marker = false;
    assert_eq!(b.send(&c), 200);
    assert_eq!(b.send(&chat("a", &words("short", 100), "C:/one", "q")), 200);
    let r = post(
        &b.url("/v1/chat/completions"),
        &[("Content-Type", "application/json"), (engine::prefix::STABLE_PROMPT, "999999")],
        &json!({ "model": "a", "messages": [{ "role": "system", "content": s }, { "role": "user", "content": "q" }] }).to_string(),
    );
    assert_eq!(code_of(&r), 200);
    assert_eq!((b.prefix_files(), b.primed()), (vec![], 0), "{:?}", b.events());
}

/// A request without the header can leave anything in the slot: the next new conversation does not trust what the slot holds.
#[test]
fn a_request_of_another_kind_makes_the_next_conversation_restore_the_prompt() {
    let b = fixture();
    let s = words("rule", STABLE_WORDS);
    b.send(&chat("a", &s, "C:/one", "q"));
    let mut other = chat("a", "You write a title.", "C:/one", "a long conversation");
    other.marker = false;
    b.send(&other);
    let primed = b.primed();
    b.send(&chat("a", &s, "C:/one", "q2"));
    assert_eq!(b.primed(), primed);
    assert!(b.last_chat() < 60, "{:?}", b.reads());
    assert!(b.events().iter().any(|e| e["action"] == "restored"), "{:?}", b.events());
}

/// A file the engine cannot restore is removed and the prompt is read again, and the conversation is answered all the same.
#[test]
fn a_file_that_cannot_be_restored_is_replaced_and_the_request_answers() {
    let b = fixture();
    let s = words("rule", STABLE_WORDS);
    b.send(&chat("a", &s, "C:/one", "q"));
    let file = b.dir.path().join("slots").join(&b.prefix_files()[0]);
    b.send(&chat("b", &words("other", STABLE_WORDS), "C:/one", "q"));
    std::fs::write(&file, b"not a state").unwrap();
    let primed = b.primed();
    assert_eq!(b.send(&chat("a", &s, "C:/one", "q2")), 200);
    assert_eq!(b.primed(), primed + 1, "read again");
    let events = b.events();
    assert!(events.iter().any(|e| e["restore_error"].is_string()), "{events:?}");
    assert!(std::fs::read(&file).unwrap().len() > 20, "the file is a state again");
}

/// «Stop» while the system prompt is being read: the manager lets the engine go at once and the next request does not wait
/// for the reading to end.
#[test]
fn the_stop_button_does_not_wait_for_the_prompt_to_be_read() {
    use std::io::Write;
    let b = fixture_with(false, 20);
    // The engine is up, so that what is slow is the reading.
    b.control("/engine/model", json!({ "model": "a" }));
    let body = json!({
        "model": "a",
        "messages": [{ "role": "system", "content": format!("{}\n<env> Working directory: C:/one </env>", words("rule", STABLE_WORDS)) }, { "role": "user", "content": "q" }],
    })
    .to_string();
    let stable = words("rule", STABLE_WORDS).len();
    let mut s = std::net::TcpStream::connect(("127.0.0.1", b.port)).unwrap();
    write!(s, "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n{}: {stable}\r\nContent-Length: {}\r\n\r\n{body}", engine::prefix::STABLE_PROMPT, body.len()).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    drop(s);
    let t0 = std::time::Instant::now();
    let mut other = chat("a", "A short instruction.", "C:/two", "hello");
    other.marker = false;
    assert_eq!(b.send(&other), 200);
    assert!(t0.elapsed() < Duration::from_secs(5), "waited {:?} for a reading that nobody wanted", t0.elapsed());
}

/// Two conversations at once, with different prompts, take their turns on the one slot: both are answered and both prompts
/// are kept.
#[test]
fn two_conversations_at_once_take_turns() {
    let b = fixture_with(false, 1);
    let (s, t) = (words("rule", STABLE_WORDS), words("project", STABLE_WORDS));
    let codes = std::thread::scope(|sc| {
        let one = sc.spawn(|| b.send(&chat("a", &s, "C:/one", "q")));
        let two = sc.spawn(|| b.send(&chat("a", &t, "C:/two", "q")));
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(codes, (200, 200));
    assert_eq!(b.prefix_files().len(), 2, "{:?}", b.events());
}

/// The files that are too old go when an engine starts; those that are not stay.
#[test]
fn an_engine_that_starts_removes_the_slot_files_that_are_too_old() {
    let b = fixture();
    let slots = b.dir.path().join("slots");
    std::fs::create_dir_all(&slots).unwrap();
    let old = slots.join("gone-model.bin");
    std::fs::write(&old, vec![0u8; 100]).unwrap();
    std::fs::File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - Duration::from_secs(25 * 3600)).unwrap();
    std::fs::write(slots.join("recent-model.bin"), b"x").unwrap();
    b.send(&chat("a", &words("rule", STABLE_WORDS), "C:/one", "q"));
    assert!(!old.exists() && slots.join("recent-model.bin").exists(), "{:?}", b.files());
}

/// The last conversation is saved when the engine stops, and only if there was one: an engine that ran nothing leaves the
/// file of the last time alone, and what it saves replaces that file whole.
#[test]
fn the_last_conversation_is_saved_only_if_there_was_one() {
    let b = fixture();
    let last = b.dir.path().join("slots").join("a.bin");
    std::fs::create_dir_all(last.parent().unwrap()).unwrap();
    let good = json!({ "tokens": [11, 12, 13] }).to_string();
    std::fs::write(&last, &good).unwrap();
    b.control("/engine/model", json!({ "model": "a" }));
    b.control("/engine/model", json!({ "model": "b" }));
    assert_eq!(std::fs::read_to_string(&last).unwrap(), good, "nothing ran: nothing saved");
    assert!(b.m.state().model.as_deref() == Some("b"));
    b.send(&chat("b", &words("other", STABLE_WORDS), "C:/one", "q"));
    b.control("/engine/model", json!({ "model": "a" }));
    assert!(b.files().contains(&"b.bin".to_string()), "something ran: saved {:?}", b.files());
    assert!(!b.files().iter().any(|f| f.ends_with(".next.bin")), "{:?}", b.files());
}

/// A restore of the last conversation that fails removes the file, and the engine answers.
#[test]
fn a_last_conversation_that_cannot_be_restored_is_removed() {
    let b = fixture();
    let last = b.dir.path().join("slots").join("a.bin");
    std::fs::create_dir_all(last.parent().unwrap()).unwrap();
    std::fs::write(&last, b"damaged").unwrap();
    b.control("/engine/model", json!({ "model": "a" }));
    assert!(!last.exists());
    let log = std::fs::read_to_string(b.dir.path().join("manager.log")).unwrap();
    assert!(log.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).any(|v| v["event"] == "restore" && v["error"].is_string()), "{log}");
}
