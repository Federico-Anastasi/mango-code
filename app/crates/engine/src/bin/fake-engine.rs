//! A fake `llama-server`, to test the engine manager and the integration without GPUs.
//!
//! Arguments like the real ones (only `-m` and `--port` are used; `--version` says a version and exits, as the check of
//! a downloaded engine wants). Routes:
//! * `GET /health` → 200 `{"status":"ok"}` (503 for `FAKE_ENGINE_START_MS` after start);
//! * `GET /props` → `{"model_path": <-m>}`;
//! * `POST /v1/chat/completions` → without a script it answers «I am the engine <name of the -m file>»;
//!   with `FAKE_ENGINE_SCRIPT` (JSON file: a list of steps) it answers step number N, where N is the number of tool
//!   results already in the conversation. A step is `{"text": "..."}` (said in pieces, one word per piece) or
//!   `{"tool": "<name>", "arguments": {...}}` (a tool call); a text step may end with `"finish": "length"` (an answer
//!   cut by the length limit) instead of `stop`. When streaming (`"stream": true`) one piece every
//!   `FAKE_ENGINE_CHUNK_MS` (default 30). Like the real engine, every reply carries `usage`: the tokens read
//!   (`prompt_tokens`, of which `prompt_tokens_details.cached_tokens` already cached) and written
//!   (`completion_tokens`, of which `reasoning_tokens` of reasoning); a step sets them with `"token": {"prompt": N,
//!   "completion": M, "cache": K, "reasoning": R}`, without it they are all zero;
//!   any step may carry `"reasoning": "..."`, said before the text or the call as `reasoning_content`, like a model that thinks;
//!   two forms of step are outside the numbering: `{"summary": "..."}` answers the requests that offer no tools
//!   (the conversation summary, the title), `{"if": "...", "text": "..."}` those in which that text appears (usually
//!   the summary, after it has entered the conversation);
//! * with `FAKE_ENGINE_STRICT=1`, `POST /v1/chat/completions` and `POST /apply-template` answer 500 with a `Jinja Exception`, like
//!   llama-server with the strictest chat template of real models (see `strict_rejection`), to every request such a template would
//!   refuse; without it the engine accepts any conversation;
//! * `POST /test/crash` → the process exits with code 3 (an engine crash);
//! * `POST /tokenize` `{"content": "..."}` → `{"tokens": [...]}` with one token per word (separated by spaces), its
//!   number a hash of the word: the fixed rule used to test token-based measurements;
//! * `POST /detokenize` `{"tokens": [...]}` → `{"content": "..."}`: one word per token;
//! * every `/v1/chat/completions` reply also carries `timings`, like the real engine: `prompt_n` = the words of the
//!   messages, `prompt_per_second` 1000, `predicted_n` = `max_tokens`, `predicted_per_second` =
//!   `FAKE_ENGINE_DECODE_TOK_S` (default 10): changing the variable between two starts pretends a faster or slower
//!   tune (the `mango-tune` tests);
//! * the slot's memory is a list of tokens, like the real engine's (one token per word; the chat template is a fixed
//!   one, see `render`): a request reads the tokens its prompt has beyond those the slot already holds and then adds
//!   the tokens it writes. With `FAKE_ENGINE_HYBRID=1` the model is a hybrid one: a slot that holds more than the common
//!   start of the new prompt cannot be cut back, and the whole prompt is read again. What each request read goes, as a
//!   JSON line `{route, reread, prompt_tokens}`, in `<FAKE_ENGINE_LOG>.reads`; `FAKE_ENGINE_READ_MS` makes every token
//!   read last that many milliseconds (a slow processor).
//! * `POST /apply-template` → `{"prompt": ...}`: the messages and tools of a chat request as text, and `POST /completion`
//!   with `prompt` (tokens or text) and `n_predict: 0` reads the prompt into the slot and writes nothing.
//! * on-disk memory like the real one, in small (`--cache-disk <folder>`): `POST /slots/0?action=persist` writes the
//!   slot's size to `<folder>/fake.json` (`saved` false if it hasn't changed), at start it's reloaded;
//!   `GET /slots` → `[{"id": 0, "n_cache_tokens": N}]`.
//!
//! * like official llama.cpp, `POST /slots/0?action=save` and `?action=restore` with `{"filename": "x.bin"}` write
//!   and reread the slot's tokens in `<--slot-save-path>/x.bin` (`n_saved`, `n_written`, `n_restored`); a file that
//!   isn't there or isn't one of its own gives 400.
//!
//! `FAKE_ENGINE_SAVE_MS` makes the save (`persist`, `save`) last that long before writing the file.
//!
//! Like ik_llama.cpp at start it creates `llama.log` in its working folder.
//!
//! Every request is appended to `FAKE_ENGINE_LOG` (if set) as a JSON line `{model, model_path, method, route, body, headers}`
//! (`model_path` is the `-m` it was started with).

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Like the real one, for the check of a downloaded engine: it starts and says its version.
    if args.iter().any(|a| a == "--version") {
        println!("version: 0 (fake-engine)");
        return;
    }
    let value = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let model = value("-m").unwrap_or_default();
    let port: u16 = value("--port").and_then(|p| p.parse().ok()).expect("--port");
    let name = std::path::Path::new(&model).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ms = |var: &str, def: u64| std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(def);
    let start = Duration::from_millis(ms("FAKE_ENGINE_START_MS", 0));
    let chunk = Duration::from_millis(ms("FAKE_ENGINE_CHUNK_MS", 30));
    let save = Duration::from_millis(ms("FAKE_ENGINE_SAVE_MS", 0));
    let decode_tok_s: f64 = std::env::var("FAKE_ENGINE_DECODE_TOK_S").ok().and_then(|v| v.parse().ok()).unwrap_or(10.0);
    let log = std::env::var("FAKE_ENGINE_LOG").ok();
    let script: Option<Vec<Value>> = std::env::var("FAKE_ENGINE_SCRIPT")
        .ok()
        .map(|f| serde_json::from_str(&std::fs::read_to_string(&f).expect("script")).expect("script JSON"));
    let _ = std::fs::write("llama.log", "");
    let strict = std::env::var("FAKE_ENGINE_STRICT").is_ok_and(|v| v == "1");
    let hybrid = std::env::var("FAKE_ENGINE_HYBRID").is_ok_and(|v| v == "1");
    let read_ms: f64 = std::env::var("FAKE_ENGINE_READ_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let memory_file = value("--cache-disk").map(|d| std::path::Path::new(&d).join("fake.json"));
    let slot_save_path = value("--slot-save-path").map(std::path::PathBuf::from);
    let on_disk: u64 = memory_file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["token"].as_u64())
        .unwrap_or(0);
    let memory = Arc::new(Mutex::new(Slot { tokens: vec![0; on_disk as usize], saved: on_disk as usize }));
    let t0 = Instant::now();
    let server = Server::http(("127.0.0.1", port)).expect("port");

    for mut req in server.incoming_requests() {
        let (model, name, log, script) = (model.clone(), name.clone(), log.clone(), script.clone());
        let (memory, memory_file, slot_save_path) = (memory.clone(), memory_file.clone(), slot_save_path.clone());
        std::thread::spawn(move || {
            let path = req.url().split('?').next().unwrap_or("").to_string();
            let mut body = Vec::new();
            let _ = req.as_reader().read_to_end(&mut body);
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if let Some(f) = &log {
                let headers: serde_json::Map<String, Value> =
                    req.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), json!(h.value.as_str()))).collect();
                let line = json!({ "model": name, "model_path": model, "method": req.method().as_str(), "route": req.url(), "body": v, "headers": headers });
                write_line(f, &line);
            }
            let json_h = Header::from_bytes("Content-Type", "application/json").unwrap();
            match (req.method(), path.as_str()) {
                (Method::Get, "/health") => {
                    let ready = t0.elapsed() >= start;
                    let r = Response::from_string(if ready { r#"{"status":"ok"}"# } else { r#"{"status":"loading"}"# })
                        .with_status_code(if ready { 200 } else { 503 })
                        .with_header(json_h);
                    let _ = req.respond(r);
                }
                (Method::Get, "/props") => {
                    let _ = req.respond(Response::from_string(json!({ "model_path": model }).to_string()).with_header(json_h));
                }
                (Method::Post, "/test/crash") => std::process::exit(3),
                (Method::Post, "/tokenize") => {
                    let tokens = tokenize(v["content"].as_str().unwrap_or(""));
                    let _ = req.respond(Response::from_string(json!({ "tokens": tokens }).to_string()).with_header(json_h));
                }
                (Method::Post, "/apply-template") => {
                    let r = match (v["messages"].as_array(), strict.then(|| strict_rejection(&v)).flatten()) {
                        (Some(_), Some(message)) => jinja_exception(message).with_header(json_h),
                        (Some(_), None) => Response::from_string(json!({ "prompt": render(&v, true) }).to_string()).with_header(json_h),
                        (None, _) => Response::from_string(r#"{"error":{"message":"messages is required"}}"#).with_status_code(400).with_header(json_h),
                    };
                    let _ = req.respond(r);
                }
                (Method::Post, "/completion") => {
                    let tokens: Vec<u64> = match &v["prompt"] {
                        Value::Array(a) => a.iter().filter_map(Value::as_u64).collect(),
                        Value::String(t) => tokenize(t),
                        _ => Vec::new(),
                    };
                    let reread = read_prompt(&mut memory.lock().unwrap(), &tokens, hybrid);
                    std::thread::sleep(Duration::from_secs_f64(reread as f64 * read_ms / 1000.0));
                    note_read(&log, "/completion", reread, tokens.len());
                    let r = json!({ "content": "", "tokens_evaluated": tokens.len(), "timings": { "prompt_n": reread, "cache_n": tokens.len() - reread.min(tokens.len()) } });
                    let _ = req.respond(Response::from_string(r.to_string()).with_header(json_h));
                }
                (Method::Post, "/detokenize") => {
                    let words = vec!["word"; v["tokens"].as_array().map_or(0, Vec::len)].join(" ");
                    let _ = req.respond(Response::from_string(json!({ "content": words }).to_string()).with_header(json_h));
                }
                (Method::Get, "/slots") => {
                    let n = memory.lock().unwrap().tokens.len();
                    let _ = req.respond(Response::from_string(json!([{ "id": 0, "n_cache_tokens": n }]).to_string()).with_header(json_h));
                }
                (Method::Post, "/slots/0") if req.url().contains("action=save") || req.url().contains("action=restore") => {
                    let file = match (&slot_save_path, v["filename"].as_str()) {
                        (Some(d), Some(n)) => d.join(n),
                        _ => {
                            let _ = req.respond(Response::from_string(r#"{"error":{"message":"--slot-save-path or filename is missing"}}"#).with_status_code(400).with_header(json_h));
                            return;
                        }
                    };
                    let mut m = memory.lock().unwrap();
                    let r = if req.url().contains("action=save") {
                        std::thread::sleep(save);
                        let _ = std::fs::write(&file, json!({ "tokens": m.tokens }).to_string());
                        Some(json!({ "id_slot": 0, "filename": v["filename"], "n_saved": m.tokens.len(), "n_written": m.tokens.len() * 10 }))
                    } else {
                        let tokens = std::fs::read_to_string(&file)
                            .ok()
                            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                            .and_then(|j| j["tokens"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<u64>>()));
                        tokens.map(|tokens| {
                            let n = tokens.len();
                            *m = Slot { saved: n, tokens };
                            json!({ "id_slot": 0, "filename": v["filename"], "n_restored": n, "n_read": n * 10 })
                        })
                    };
                    let _ = match r {
                        Some(r) => req.respond(Response::from_string(r.to_string()).with_header(json_h)),
                        None => req.respond(Response::from_string(r#"{"error":{"message":"failed to restore slot"}}"#).with_status_code(400).with_header(json_h)),
                    };
                }
                (Method::Post, "/slots/0") => {
                    // A slow save: the file appears at the end, like on a busy disk.
                    std::thread::sleep(save);
                    let mut m = memory.lock().unwrap();
                    let n = m.tokens.len();
                    let written = n != m.saved;
                    if let (true, Some(f)) = (written, &memory_file) {
                        let _ = std::fs::create_dir_all(f.parent().unwrap());
                        let _ = std::fs::write(f, json!({ "token": n }).to_string());
                    }
                    m.saved = n;
                    let r = json!({ "id_slot": 0, "saved": written, "n_saved": if written { n } else { 0 }, "n_cache_tokens": n,
                                    "n_written": if written { n * 10 } else { 0 }, "timings": { "save_ms": 1.0 } });
                    let _ = req.respond(Response::from_string(r.to_string()).with_header(json_h));
                }
                (Method::Post, "/v1/chat/completions") => {
                    if let Some(message) = strict.then(|| strict_rejection(&v)).flatten() {
                        let _ = req.respond(jinja_exception(message).with_header(json_h));
                        return;
                    }
                    let prompt = tokenize(&render(&v, true));
                    let reread = read_prompt(&mut memory.lock().unwrap(), &prompt, hybrid);
                    std::thread::sleep(Duration::from_secs_f64(reread as f64 * read_ms / 1000.0));
                    note_read(&log, "/v1/chat/completions", reread, prompt.len());
                    let step = match &script {
                        None => json!({ "text": format!("I am the engine {name}") }),
                        Some(c) => {
                            // Two forms of step are outside the numbering: `{"summary": "...", "token": {...}}` answers
                            // the requests that offer no tools (the conversation summary, the title);
                            // `{"if": "...", "text": "...", "token": {...}}` answers the requests in which that text appears
                            // (usually the summary, after it has entered the conversation).
                            let (special, steps): (Vec<&Value>, Vec<&Value>) = c.iter().partition(|p| p["summary"].is_string() || p["if"].is_string());
                            let no_tools = v["tools"].as_array().is_none_or(|t| t.is_empty());
                            let messages = v["messages"].to_string();
                            let special = special.into_iter().find(|p| match (p["summary"].as_str(), p["if"].as_str()) {
                                (Some(_), _) => no_tools,
                                (_, Some(cond)) => messages.contains(cond),
                                _ => false,
                            });
                            match special {
                                Some(p) if p["summary"].is_string() => json!({ "text": p["summary"], "token": p["token"] }),
                                Some(p) => p.clone(),
                                None => {
                                    let done = v["messages"].as_array().map(|m| m.iter().filter(|x| x["role"] == "tool").count()).unwrap_or(0);
                                    steps.get(done).map(|p| (*p).clone()).unwrap_or_else(|| json!({ "text": "End of the script." }))
                                }
                            }
                        }
                    };
                    let written = tokenize(&format!("{} {END}", step["text"].as_str().map_or_else(|| step["tool"].to_string(), str::to_string)));
                    memory.lock().unwrap().tokens.extend(written);
                    let usage = usage(&step);
                    let mut events = events(&step);
                    // Like llama-server: the counts after the last piece, in a block without choices.
                    events.push(json!({ "choices": [], "usage": usage }));
                    if v.get("stream").and_then(Value::as_bool) == Some(true) {
                        // Chunked, like llama-server: the final empty chunk tells the client it's over.
                        let mut w = req.into_writer();
                        let _ = w.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
                        let mut send = |s: &str| w.write_all(format!("{:x}\r\n{s}\r\n", s.len()).as_bytes()).and_then(|_| w.flush()).is_ok();
                        for (i, ev) in events.iter().enumerate() {
                            if !send(&format!("data: {ev}\n\n")) {
                                // The client closed (the «Stop» button): like llama-server, generation stops.
                                if let Some(f) = &log {
                                    let line = json!({ "model": name, "method": "-", "route": "interrupted", "chunks": i, "after_ms": t0.elapsed().as_millis() as u64 });
                                    write_line(f, &line);
                                }
                                break;
                            }
                            std::thread::sleep(chunk);
                        }
                        send("data: [DONE]\n\n");
                        let _ = w.write_all(b"0\r\n\r\n").and_then(|_| w.flush());
                    } else {
                        let mut r = whole_reply(&step, usage);
                        r["timings"] = timings(&v, decode_tok_s);
                        let _ = req.respond(Response::from_string(r.to_string()).with_header(json_h));
                    }
                }
                _ => {
                    let _ = req.respond(Response::from_string(r#"{"error":"route"}"#).with_status_code(404));
                }
            }
        });
    }
}

/// What the strictest chat templates of real models refuse in a conversation, as llama-server reports it: a system message
/// that is not the first (Qwen 3.5 and 3.6), a conversation without a user message and a role they don't know (Qwen 3.5),
/// user and assistant turns that don't alternate once tool calls and results are left out (Mistral Nemo), a result with no
/// call before it and an assistant message that has both text and reasoning next to its calls (gpt-oss).
fn strict_rejection(request: &Value) -> Option<&'static str> {
    let messages = request["messages"].as_array()?;
    let role = |m: &Value| m["role"].as_str().unwrap_or_default().to_string();
    let has_calls = |m: &Value| m["tool_calls"].as_array().is_some_and(|c| !c.is_empty());
    if messages.iter().skip(1).any(|m| role(m) == "system") {
        return Some("System message must be at the beginning.");
    }
    if messages.iter().any(|m| !matches!(role(m).as_str(), "system" | "user" | "assistant" | "tool")) {
        return Some("Unexpected message role.");
    }
    if !messages.iter().any(|m| role(m) == "user") {
        return Some("No user query found in messages.");
    }
    let turns = messages.iter().filter(|m| role(m) != "system" && role(m) != "tool" && !has_calls(m));
    if turns.enumerate().any(|(i, m)| (role(m) == "user") != (i % 2 == 0)) {
        return Some("After the optional system message, conversation roles must alternate user/assistant/user/assistant/...");
    }
    let mut calls_before = false;
    for m in messages {
        match role(m).as_str() {
            "tool" if !calls_before => return Some("Message has tool role, but there was no previous assistant message with a tool call!"),
            "assistant" if has_calls(m) => {
                calls_before = true;
                if !text_of(&m["content"]).is_empty() && m["reasoning_content"].as_str().is_some_and(|r| !r.is_empty()) {
                    return Some("Cannot pass both content and thinking in an assistant message with tool calls!");
                }
            }
            _ => {}
        }
    }
    None
}

/// The reply of llama-server to a request whose template raised an exception.
fn jinja_exception(message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = json!({ "error": { "code": 500, "message": format!("Error: Jinja Exception: {message}"), "type": "server_error" } });
    Response::from_string(body.to_string()).with_status_code(500)
}

/// The tokens in the slot, and how many of them are in the on-disk memory file.
struct Slot {
    tokens: Vec<u64>,
    saved: usize,
}

const END: &str = "<|end|>";

/// One token per word, its number a hash of the word (never 0).
fn tokenize(text: &str) -> Vec<u64> {
    text.split_whitespace().map(|w| w.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3)) | 1).collect()
}

/// The text of a message's content, whether it is a string or a list of parts.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(t) => t.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// The chat template of the fake engine: `<|role|> content <|end|>` for every message, the tools right after the system
/// message's text (where Qwen's template puts them) and, with `generation`, the opening of the answer.
fn render(request: &Value, generation: bool) -> String {
    let tools = request["tools"].as_array().filter(|t| !t.is_empty()).map(|t| Value::Array(t.clone()).to_string());
    let mut out = String::new();
    let mut tools_done = tools.is_none();
    for m in request["messages"].as_array().into_iter().flatten() {
        let role = m["role"].as_str().unwrap_or("user");
        let mut text = text_of(&m["content"]);
        if text.is_empty() && m["tool_calls"].is_array() {
            text = m["tool_calls"].to_string();
        }
        out.push_str(&format!("<|{role}|> {text}"));
        if role == "system" && !tools_done {
            out.push_str(&format!(" <|tools|> {}", tools.as_deref().unwrap_or("")));
            tools_done = true;
        }
        out.push_str(&format!(" {END} "));
    }
    if generation {
        out.push_str("<|assistant|>");
    }
    out
}

/// What the slot does with a new prompt: it keeps the start the two have in common and reads the rest (at least the last
/// token); a hybrid model that holds more than that start reads all of it. Returns the tokens read. The slot ends
/// holding the prompt.
fn read_prompt(slot: &mut Slot, prompt: &[u64], hybrid: bool) -> usize {
    let common = slot.tokens.iter().zip(prompt).take_while(|(a, b)| a == b).count();
    let kept = if hybrid && common < slot.tokens.len() { 0 } else { common.min(prompt.len().saturating_sub(1)) };
    let reread = prompt.len() - kept;
    slot.tokens = prompt.to_vec();
    reread
}

/// What a request read, for the tests: a line of `<FAKE_ENGINE_LOG>.reads`.
fn note_read(log: &Option<String>, route: &str, reread: usize, prompt: usize) {
    if let Some(f) = log {
        write_line(&format!("{f}.reads"), &json!({ "route": route, "reread": reread, "prompt_tokens": prompt }));
    }
}

/// A line in the log, written with a single call: requests arrive together (a conversation and the token
/// measurements) and lines written in pieces would get mixed up.
fn write_line(file: &str, line: &Value) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

/// The streaming events (OpenAI format) of a script step.
fn events(step: &Value) -> Vec<Value> {
    let delta = |d: Value, finish: Option<&str>| json!({ "choices": [{ "index": 0, "delta": d, "finish_reason": finish }] });
    let mut v: Vec<Value> = step["reasoning"].as_str().into_iter().flat_map(|r| r.split_inclusive(' ')).map(|p| delta(json!({ "reasoning_content": p }), None)).collect();
    if let Some(name) = step["tool"].as_str() {
        let arguments = step["arguments"].to_string();
        v.push(delta(json!({ "tool_calls": [{ "index": 0, "id": "call_fake", "type": "function", "function": { "name": name, "arguments": arguments } }] }), None));
        v.push(delta(json!({}), Some("tool_calls")));
        return v;
    }
    let text = step["text"].as_str().unwrap_or("");
    v.extend(text.split_inclusive(' ').map(|p| delta(json!({ "content": p }), None)));
    v.push(delta(json!({}), Some(step["finish"].as_str().unwrap_or("stop"))));
    v
}

/// The tokens of a request, as the step declares them (zero if it says nothing: a context that never fills up).
fn usage(step: &Value) -> Value {
    let t = &step["token"];
    let n = |key: &str| t[key].as_u64().unwrap_or(0);
    json!({ "prompt_tokens": n("prompt"), "completion_tokens": n("completion"), "total_tokens": n("prompt") + n("completion"),
            "prompt_tokens_details": { "cached_tokens": n("cache") },
            "completion_tokens_details": { "reasoning_tokens": n("reasoning") } })
}

/// The `timings` of a request (see the file header).
fn timings(request: &Value, decode_tok_s: f64) -> Value {
    let words: usize = request["messages"].as_array().map_or(0, |m| m.iter().map(|x| x["content"].as_str().map_or(0, |c| c.split_whitespace().count())).sum());
    json!({ "prompt_n": words, "prompt_per_second": 1000.0, "predicted_n": request["max_tokens"].as_u64().unwrap_or(0), "predicted_per_second": decode_tok_s })
}

fn whole_reply(step: &Value, usage: Value) -> Value {
    let mut message = match step["tool"].as_str() {
        Some(name) => json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "call_fake", "type": "function", "function": { "name": name, "arguments": step["arguments"].to_string() } }] }),
        None => json!({ "role": "assistant", "content": step["text"] }),
    };
    if step["reasoning"].is_string() {
        message["reasoning_content"] = step["reasoning"].clone();
    }
    let finish = if step["tool"].is_string() { "tool_calls" } else { step["finish"].as_str().unwrap_or("stop") };
    json!({ "choices": [{ "index": 0, "message": message, "finish_reason": finish }], "usage": usage })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calls() -> Value {
        json!([{ "id": "call_1", "type": "function", "function": { "name": "read", "arguments": "{}" } }])
    }

    #[test]
    fn a_conversation_with_tools_passes() {
        let request = json!({ "messages": [
            { "role": "system", "content": "Rules." },
            { "role": "user", "content": "Read it." },
            { "role": "assistant", "content": "", "tool_calls": calls(), "reasoning_content": "I will read it." },
            { "role": "tool", "tool_call_id": "call_1", "content": "text" },
            { "role": "assistant", "content": "Done." },
            { "role": "user", "content": "And then?" },
        ] });
        assert_eq!(strict_rejection(&request), None);
    }

    #[test]
    fn what_the_strictest_templates_refuse_is_refused() {
        let user = json!({ "role": "user", "content": "Hi." });
        let system = json!({ "role": "system", "content": "Rules." });
        let assistant = json!({ "role": "assistant", "content": "Hello." });
        let result = json!({ "role": "tool", "tool_call_id": "call_1", "content": "text" });
        let developer = json!({ "role": "developer", "content": "x" });
        let mixed = json!({ "role": "assistant", "content": "Reading.", "reasoning_content": "Thinking.", "tool_calls": calls() });
        let cases = [
            (vec![&system, &system, &user], "System message must be at the beginning."),
            (vec![&system, &user, &system], "System message must be at the beginning."),
            (vec![&system], "No user query found in messages."),
            (vec![&developer, &user], "Unexpected message role."),
            (vec![&system, &user, &user], "After the optional system message, conversation roles must alternate user/assistant/user/assistant/..."),
            (vec![&system, &assistant, &user], "After the optional system message, conversation roles must alternate user/assistant/user/assistant/..."),
            (vec![&user, &result], "Message has tool role, but there was no previous assistant message with a tool call!"),
            (vec![&user, &mixed, &result], "Cannot pass both content and thinking in an assistant message with tool calls!"),
        ];
        for (messages, said) in cases {
            assert_eq!(strict_rejection(&json!({ "messages": messages })), Some(said));
        }
    }
}
