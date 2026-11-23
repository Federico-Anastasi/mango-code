//! The system prompt of a new conversation, read once and kept on disk, for an official llama.cpp engine (the profiles'
//! engines keep their own memory, `--cache-disk`).
//!
//! The first request of a conversation carries the system prompt (the app's instructions, the tools) and, last, the
//! working folder and the date. The agent says how many bytes of the system message come before them
//! (`STABLE_PROMPT`); the engine is asked for the conversation's tokens with and without what comes after, and what the
//! two have in common is the *prefix*: the tokens every conversation with this model, whatever its folder or day, starts
//! with. It is read once (`/completion` with `n_predict: 0`) and the slot saved as `<model>.prefix-<key>.bin`; a new
//! conversation, a restart, another model that comes and goes, restore it and read only what is theirs.
//!
//! The key is made of what decides the prefix's tokens: the engine, model and cache type (`SlotCache::signature`), the
//! stable text, the tools and the template's variables. It is computed from the request, without asking the engine.
//!
//! Every new conversation starts from the file: a hybrid model cannot cut its slot back to the prompt, and a restore
//! (well under a second) keeps the file in use. One conversation at a time uses the slot (`Slot::turn`): the turn lasts
//! until the reply is over, so a restore or a save never lands in the middle of another conversation. Nothing here fails a request: an error is written in the log,
//! the file it touched is removed, and the request goes on to the engine as it came.

use crate::EngineManager;
use anyhow::{bail, Context, Result};
use engine_cfg::{memory, SlotCache};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;

use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant, SystemTime};

/// The header with the bytes of the system message that come before the working folder and the date.
pub const STABLE_PROMPT: &str = "X-Mango-Stable-Prompt";

/// A prefix shorter than this is not worth a file.
const MIN_PREFIX_TOKENS: usize = 512;
/// The calls that only ask the engine to compute something.
const QUICK: Duration = Duration::from_secs(30);
/// The calls that move a state between the engine and the disk: seconds for a big conversation, the rest is margin for
/// slow disks.
const STATE: Duration = Duration::from_secs(120);

/// The slot of one running engine process: what is known of its content and the turn of whoever uses it.
pub(crate) struct Slot {
    cache: SlotCache,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// A conversation has been served since the engine started: the slot holds something worth saving.
    dirty: bool,
}

/// The right to use the slot, until the reply is over.
pub(crate) struct Turn<'a> {
    state: MutexGuard<'a, State>,
    cache: &'a SlotCache,
}

impl Slot {
    pub(crate) fn new(cache: SlotCache) -> Slot {
        Slot { cache, state: Mutex::new(State::default()) }
    }

    pub(crate) fn turn(&self) -> Turn<'_> {
        Turn { state: self.state.lock().unwrap_or_else(|e| e.into_inner()), cache: &self.cache }
    }

    /// A conversation has been served (or is being served: the engine is stopping while one is in progress, and saves what
    /// it has).
    fn dirty(&self) -> bool {
        match self.state.try_lock() {
            Ok(s) => s.dirty,
            Err(TryLockError::WouldBlock) => true,
            Err(TryLockError::Poisoned(e)) => e.into_inner().dirty,
        }
    }
}

/// The connection of the request closed while the engine was at work for it.
#[derive(Debug)]
struct ClientGone;

impl std::fmt::Display for ClientGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the client closed the connection")
    }
}

impl std::error::Error for ClientGone {}

/// A conversation request, read for what the prefix needs.
struct Chat {
    body: Value,
    stable: usize,
    key: String,
    /// The request opens the conversation: a system prompt and the first message.
    first: bool,
}

impl Chat {
    /// `None` if the request is not one the prefix can be made of: not JSON, no system message, a message that is not
    /// text, a byte count that does not fall on a character.
    fn read(body: &[u8], stable: usize, signature: &str) -> Option<Chat> {
        let body: Value = serde_json::from_slice(body).ok()?;
        let messages = body["messages"].as_array()?;
        let first_message = messages.first().filter(|m| m["role"] == "system")?;
        let system = first_message["content"].as_str()?;
        if stable > system.len() || !system.is_char_boundary(stable) {
            return None;
        }
        let first = messages.len() == 2 && messages[1]["role"] == "user";
        let key = mango_common::sha256_hex(format!("{signature}\n{}\n{}\n{}", &system[..stable], body["tools"], body["chat_template_kwargs"]).as_bytes());
        Some(Chat { body, stable, key, first })
    }

    /// The tokens of the conversation's start as the engine's template makes them, with the whole system prompt and with
    /// the stable part only, each followed by a different first message: where they stop being equal is the prefix's end.
    fn tokens(&self, url: &str) -> Result<(Vec<Value>, Vec<Value>)> {
        let system = self.body["messages"][0]["content"].as_str().unwrap_or_default();
        let render = |system_text: &str, first: &str| -> Result<Vec<Value>> {
            let mut body = self.body.clone();
            let object = body.as_object_mut().context("the request is not an object")?;
            for field in ["stream", "stream_options", "max_tokens", "n_predict"] {
                object.remove(field);
            }
            body["messages"] = json!([{ "role": "system", "content": system_text }, { "role": "user", "content": first }]);
            let prompt = ask(url, "/apply-template", &body, Some(QUICK), None)?["prompt"].as_str().context("the engine gave no prompt")?.to_string();
            let tokens = ask(url, "/tokenize", &json!({ "content": prompt, "add_special": true, "parse_special": true }), Some(QUICK), None)?;
            tokens["tokens"].as_array().cloned().context("the engine gave no tokens")
        };
        Ok((render(system, "a")?, render(&system[..self.stable], "b")?))
    }
}

/// Before a conversation request goes to the engine: if it opens a conversation whose system prompt the slot does not
/// start with, the prompt is restored from its file or, the first time, read and saved. Called with the slot's turn
/// taken, which the caller keeps until the reply is over. `client` is the request's connection: if it closes while the
/// prompt is being read (the «Stop» button), the engine is told at once and the answer is `false`: nobody is waiting for
/// the request any more.
pub(crate) fn prepare(turn: &mut Turn, m: &EngineManager, url: &str, stable: Option<&str>, body: &[u8], client: &TcpStream) -> bool {
    turn.state.dirty = true;
    let chat = stable.and_then(|s| s.trim().parse().ok()).and_then(|n| Chat::read(body, n, &turn.cache.signature));
    let Some(chat) = chat.filter(|c| c.first) else {
        return true;
    };
    let t0 = Instant::now();
    let mut line = json!({ "event": "prefix", "model": turn.cache.model });
    let outcome = keep(turn.cache, url, &chat, client, &mut line);
    let gone = outcome.as_ref().is_err_and(|e| e.is::<ClientGone>());
    if let Err(e) = outcome {
        line["error"] = format!("{e:#}").into();
    }
    line["ms"] = (t0.elapsed().as_millis() as u64).into();
    m.log(line);
    !gone
}

/// The slot starts with the chat's prefix: restored from its file, or read and saved, unless it is too short to keep.
fn keep(cache: &SlotCache, url: &str, chat: &Chat, client: &TcpStream, line: &mut Value) -> Result<()> {
    let file = memory::prefix_file(&cache.model, &chat.key[..16]);
    let path = cache.folder.join(&file);
    if path.is_file() {
        match ask(url, "/slots/0?action=restore", &json!({ "filename": file }), Some(STATE), None) {
            Ok(v) if v["n_restored"].as_u64().is_some_and(|n| n > 0) => {
                touch(&path);
                line["action"] = "restored".into();
                line["token"] = v["n_restored"].clone();
                return Ok(());
            }
            other => {
                line["restore_error"] = match other {
                    Ok(v) => format!("restored {}", v["n_restored"]),
                    Err(e) => format!("{e:#}"),
                }
                .into();
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    let (with_all, with_stable) = chat.tokens(url)?;
    let end = with_all.iter().zip(&with_stable).take_while(|(a, b)| a == b).count().saturating_sub(1);
    if end < MIN_PREFIX_TOKENS {
        line["action"] = "too short".into();
        line["token"] = end.into();
        return Ok(());
    }
    // The prompt is read now, as the conversation would read it a moment later, so that the slot can be saved at its end.
    ask(url, "/completion", &json!({ "prompt": &with_all[..end], "n_predict": 0, "cache_prompt": true, "id_slot": 0 }), None, Some(client))?;
    let saved = ask(url, "/slots/0?action=save", &json!({ "filename": file }), Some(STATE), None);
    let n = saved.as_ref().ok().and_then(|v| v["n_saved"].as_u64()).unwrap_or(0) as usize;
    if saved.is_err() || n + 1 < end || n > end {
        let _ = std::fs::remove_file(&path);
        return Err(saved.err().unwrap_or_else(|| anyhow::anyhow!("the engine saved {n} tokens of {end}")));
    }
    line["action"] = "read".into();
    line["token"] = end.into();
    line["bytes"] = saved.map(|v| v["n_written"].clone()).unwrap_or(Value::Null);
    match memory::trim_slots(&cache.memory, &cache.folder, Some(&path)) {
        Ok(removed) if !removed.is_empty() => line["removed"] = removed.len().into(),
        Ok(_) => {}
        Err(e) => line["trim_error"] = format!("{e:#}").into(),
    }
    Ok(())
}

/// The last conversation comes back as the engine starts: the log line's fields. A file the engine cannot restore is
/// removed.
pub(crate) fn restore_last(cache: &SlotCache, url: &str) -> Value {
    let path = cache.folder.join(memory::last_file(&cache.model));
    if !path.is_file() {
        return json!({ "token": 0 });
    }
    match ask(url, "/slots/0?action=restore", &json!({ "filename": memory::last_file(&cache.model) }), Some(STATE), None) {
        Ok(v) => {
            touch(&path);
            json!({ "token": v["n_restored"] })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            json!({ "error": format!("{e:#}") })
        }
    }
}

/// The open conversation is saved as the engine stops: the log line. Only if a conversation has been served since the
/// start (an engine that ran nothing leaves the file of the last time as it is), in a file of its own that replaces the
/// last one only once the engine says it saved tokens.
pub(crate) fn save_last(slot: &Slot, url: &str) -> Value {
    let cache = &slot.cache;
    let mut line = json!({ "event": "save", "model": cache.model });
    if !slot.dirty() {
        line["written"] = false.into();
        line["reason"] = "no conversation since the start".into();
        return line;
    }
    let t0 = Instant::now();
    let (next, last) = (cache.folder.join(memory::pending_file(&cache.model)), cache.folder.join(memory::last_file(&cache.model)));
    match ask(url, "/slots/0?action=save", &json!({ "filename": memory::pending_file(&cache.model) }), Some(STATE), None) {
        Ok(v) => {
            let n = v["n_saved"].as_u64().unwrap_or(0);
            line["token"] = n.into();
            line["bytes"] = v["n_written"].clone();
            line["written"] = false.into();
            if n > 0 {
                match std::fs::rename(&next, &last) {
                    Ok(()) => line["written"] = true.into(),
                    Err(e) => line["error"] = format!("{}: {e}", last.display()).into(),
                }
            }
            let _ = std::fs::remove_file(&next);
            if let Err(e) = memory::trim_slots(&cache.memory, &cache.folder, Some(&last)) {
                line["trim_error"] = format!("{e:#}").into();
            }
        }
        Err(e) => {
            line["error"] = format!("{e:#}").into();
            let _ = std::fs::remove_file(&next);
        }
    }
    line["ms"] = (t0.elapsed().as_millis() as u64).into();
    line
}

/// The files too old and those over the space budget go (`memory::trim_slots`): when an engine starts.
pub(crate) fn trim(cache: &SlotCache) -> Option<String> {
    match memory::trim_slots(&cache.memory, &cache.folder, None) {
        Ok(removed) if removed.is_empty() => None,
        Ok(removed) => Some(format!("{} slot files removed", removed.len())),
        Err(e) => Some(format!("{e:#}")),
    }
}

fn touch(path: &std::path::Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// A POST of JSON to the engine and its JSON reply; an error status is an error with the engine's words. `cancel`: the
/// connection of the request this serves: if it closes first the engine's is closed too (the engine then stops the work)
/// and the error is `ClientGone`. No `limit`: as long as it takes (a prompt read on a processor).
fn ask(url: &str, path: &str, body: &Value, limit: Option<Duration>, cancel: Option<&TcpStream>) -> Result<Value> {
    let host = url.trim_start_matches("http://");
    let mut engine = TcpStream::connect(host).with_context(|| format!("connection to {host}"))?;
    let body = body.to_string();
    engine.write_all(format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())?;
    // The reply is read on a thread of its own and the client watched on another: whichever ends first is the answer.
    // On Windows closing the engine's connection from another thread does not end a read in progress.
    let (done, ended) = std::sync::mpsc::channel::<Option<std::io::Result<Vec<u8>>>>();
    if let Some(client) = cancel {
        let (client, done) = (client.try_clone()?, done.clone());
        std::thread::Builder::new().name("engine-watchdog".into()).spawn(move || {
            let mut b = [0u8; 1];
            if let Ok(0) | Err(_) = client.peek(&mut b) {
                let _ = done.send(None);
            }
        })?;
    }
    let mut reader = engine.try_clone()?;
    std::thread::Builder::new().name("engine-reply".into()).spawn(move || {
        let mut reply = Vec::new();
        let _ = done.send(Some(reader.read_to_end(&mut reply).map(|_| reply)));
    })?;
    let first = match limit {
        Some(l) => ended.recv_timeout(l).ok(),
        None => ended.recv().ok(),
    };
    let reply = match first {
        Some(Some(read)) => read.with_context(|| format!("{path}: the engine stopped answering"))?,
        Some(None) => {
            // the engine notices the closed connection and stops the work
            let _ = engine.shutdown(std::net::Shutdown::Both);
            return Err(ClientGone.into());
        }
        None => {
            let _ = engine.shutdown(std::net::Shutdown::Both);
            bail!("{path}: the engine did not answer in {} s", limit.map_or(0, |l| l.as_secs()))
        }
    };
    let (head, text) = match reply.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => (String::from_utf8_lossy(&reply[..i]).into_owned(), reply[i + 4..].to_vec()),
        None => bail!("{path}: the engine closed without answering"),
    };
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).context("the engine's reply has no status")?;
    let text = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(&text) } else { text };
    let value: Value = serde_json::from_slice(&text).unwrap_or(Value::Null);
    if status != 200 {
        bail!("{path} answered {status}: {}", value["error"]["message"].as_str().unwrap_or_default());
    }
    Ok(value)
}

/// The body of a reply sent in chunks.
fn dechunk(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = body.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&body[..i]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 || body.len() < i + 2 + size {
            break;
        }
        out.extend_from_slice(&body[i + 2..i + 2 + size]);
        body = body.get(i + 2 + size + 2..).unwrap_or_default();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn body(system: &str, rest: Vec<Value>) -> Vec<u8> {
        let mut messages = vec![json!({ "role": "system", "content": system })];
        messages.extend(rest);
        json!({ "messages": messages, "tools": [{ "name": "echo" }] }).to_string().into_bytes()
    }

    fn user(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }

    /// The key is made of what comes before the working folder: the folder, the day and the question are not in it.
    #[test]
    fn the_key_follows_the_stable_text_the_tools_and_the_signature() {
        let key = |system: &str, stable: usize, signature: &str| Chat::read(&body(system, vec![user("q")]), stable, signature).unwrap().key;
        let base = key("rules\n<env>C:/a</env>", 5, "s");
        assert_eq!(base, key("rules\n<env>C:/b, another day</env>", 5, "s"), "the folder and the day are not in it");
        assert_ne!(base, key("other\n<env>C:/a</env>", 5, "s"), "the text is");
        assert_ne!(base, key("rules\n<env>C:/a</env>", 5, "another engine"), "the signature is");
        let with_tools = |tools: Value| {
            let mut v: Value = serde_json::from_slice(&body("rules\n<env>C:/a</env>", vec![user("q")])).unwrap();
            v["tools"] = tools;
            Chat::read(v.to_string().as_bytes(), 5, "s").unwrap().key
        };
        assert_ne!(with_tools(json!([{ "name": "echo" }])), with_tools(json!([{ "name": "read" }])), "the tools are");
    }

    /// What the module does not understand it leaves alone.
    #[test]
    fn what_is_not_a_prompt_with_a_boundary_is_not_read() {
        let read = |b: Vec<u8>, stable: usize| Chat::read(&b, stable, "s").is_some();
        assert!(read(body("rules", vec![user("q")]), 5), "the whole text is stable: no folder");
        assert!(!read(body("rules", vec![user("q")]), 6), "more than the text has");
        assert!(!read(body("àb", vec![user("q")]), 1), "the middle of a character");
        assert!(read(body("àb", vec![user("q")]), 2));
        assert!(!read(b"not json".to_vec(), 1));
        assert!(!read(json!({ "messages": [user("q")] }).to_string().into_bytes(), 1), "no system message");
        assert!(!read(json!({ "messages": [{ "role": "system", "content": [{ "type": "text", "text": "x" }] }] }).to_string().into_bytes(), 1), "not a text");
    }

    /// A conversation opens with one message; one that goes on has the answers and the next questions.
    #[test]
    fn only_the_first_request_of_a_conversation_is_the_first() {
        let first = |rest: Vec<Value>| Chat::read(&body("rules", rest), 5, "s").unwrap().first;
        assert!(first(vec![user("q")]));
        assert!(!first(vec![user("q"), json!({ "role": "assistant", "content": "a" }), user("q2")]));
        assert!(!first(vec![json!({ "role": "assistant", "content": "a" })]));
        assert!(!first(vec![json!({ "role": "system", "content": "more rules" }), user("q")]), "the prompt is one message");
    }

    /// An engine that does not answer is let go when the request that asked for the work is gone: the «Stop» button must
    /// not wait for a prompt to be read to its end.
    #[test]
    fn the_connection_to_the_engine_closes_with_the_clients() {
        let engine = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", engine.local_addr().unwrap());
        let (client_end, other_end) = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
            (l.accept().unwrap().0, c)
        };
        let silent = std::thread::spawn(move || {
            let (mut s, _) = engine.accept().unwrap();
            let mut b = [0u8; 1024];
            let _ = s.read(&mut b);
            // never answers, and does not notice that the other end is closed
            std::thread::sleep(Duration::from_secs(3));
            drop(s);
        });
        let started = Instant::now();
        let closer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(other_end);
        });
        let r = ask(&url, "/completion", &json!({}), None, Some(&client_end));
        assert!(r.unwrap_err().is::<ClientGone>());
        assert!(started.elapsed() < Duration::from_millis(2500), "{:?}", started.elapsed());
        closer.join().unwrap();
        silent.join().unwrap();
        assert!(started.elapsed() > Duration::from_millis(200));
    }

    #[test]
    fn a_reply_in_chunks_is_read() {
        assert_eq!(dechunk(b"5\r\n{\"a\":\r\n3\r\n 1}\r\n0\r\n\r\n"), b"{\"a\": 1}");
    }
}
