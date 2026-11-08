//! A fake `llama-server`, to test the engine manager and the integration without GPUs.
//!
//! Arguments like the real ones (only `-m` and `--port` are used). Routes:
//! * `GET /health` → 200 `{"status":"ok"}` (503 for `FAKE_ENGINE_START_MS` after start);
//! * `GET /props` → `{"model_path": <-m>}`;
//! * `POST /v1/chat/completions` → the base warm-up (`X-Mango-Warmup`) answers «Ready.»; without a script it
//!   answers «I am the engine <name of the -m file>»;
//!   with `FAKE_ENGINE_SCRIPT` (JSON file: a list of steps) it answers step number N, where N is the number of tool
//!   results already in the conversation. A step is `{"text": "..."}` (said in pieces, one word per piece) or
//!   `{"tool": "<name>", "arguments": {...}}` (a tool call). When streaming (`"stream": true`) one piece every
//!   `FAKE_ENGINE_CHUNK_MS` (default 30). Like the real engine, every reply carries `usage`: the tokens read
//!   (`prompt_tokens`, of which `prompt_tokens_details.cached_tokens` already cached) and written
//!   (`completion_tokens`, of which `reasoning_tokens` of reasoning); a step sets them with `"token": {"prompt": N,
//!   "completion": M, "cache": K, "reasoning": R}`, without it they are all zero;
//!   two forms of step are outside the numbering: `{"summary": "..."}` answers the requests that offer no tools
//!   (the conversation summary, the title), `{"if": "...", "text": "..."}` those in which that text appears (usually
//!   the summary, after it has entered the conversation);
//! * `POST /test/crash` → the process exits with code 3 (an engine crash);
//! * `POST /tokenize` `{"content": "..."}` → `{"tokens": [...]}` with one token per word (separated by spaces): the
//!   fixed rule used to test token-based measurements;
//! * `POST /detokenize` `{"tokens": [...]}` → `{"content": "..."}`: one word per token;
//! * every `/v1/chat/completions` reply also carries `timings`, like the real engine: `prompt_n` = the words of the
//!   messages, `prompt_per_second` 1000, `predicted_n` = `max_tokens`, `predicted_per_second` =
//!   `FAKE_ENGINE_DECODE_TOK_S` (default 10): changing the variable between two starts pretends a faster or slower
//!   tune (the `mango-tune` tests);
//! * on-disk memory like the real one, in small (`--cache-disk <folder>`): every completion adds 100 tokens to the
//!   slot's memory; `POST /slots/0?action=persist` writes it to `<folder>/fake.json` (`saved` false if it hasn't
//!   changed), at start it's reloaded; `GET /slots` → `[{"id": 0, "n_cache_tokens": N}]`.
//!
//! * like official llama.cpp, `POST /slots/0?action=save` and `?action=restore` with `{"filename": "x.bin"}` write
//!   and reread the slot's memory in `<--slot-save-path>/x.bin` (`n_saved`, `n_written`, `n_restored`); a file that
//!   isn't there gives 400.
//!
//! `FAKE_ENGINE_SAVE_MS` makes the save (`persist`, `save`) last that long before writing the file.
//!
//! Like ik_llama.cpp at start it creates `llama.log` in its working folder.
//!
//! Every request is appended to `FAKE_ENGINE_LOG` (if set) as a JSON line `{model, method, route, body, headers}`.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
    // (tokens in the slot, tokens already on disk)
    let memory_file = value("--cache-disk").map(|d| std::path::Path::new(&d).join("fake.json"));
    let slot_save_path = value("--slot-save-path").map(std::path::PathBuf::from);
    let on_disk: u64 = memory_file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["token"].as_u64())
        .unwrap_or(0);
    let memory = Arc::new(Mutex::new((on_disk, on_disk)));
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
                let line = json!({ "model": name, "method": req.method().as_str(), "route": req.url(), "body": v, "headers": headers });
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
                    let words = v["content"].as_str().unwrap_or("").split_whitespace().count();
                    let _ = req.respond(Response::from_string(json!({ "tokens": vec![0; words] }).to_string()).with_header(json_h));
                }
                (Method::Post, "/detokenize") => {
                    let words = vec!["word"; v["tokens"].as_array().map_or(0, Vec::len)].join(" ");
                    let _ = req.respond(Response::from_string(json!({ "content": words }).to_string()).with_header(json_h));
                }
                (Method::Get, "/slots") => {
                    let n = memory.lock().unwrap().0;
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
                        let _ = std::fs::write(&file, json!({ "token": m.0 }).to_string());
                        Some(json!({ "id_slot": 0, "filename": v["filename"], "n_saved": m.0, "n_written": m.0 * 10 }))
                    } else {
                        std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|j| j["token"].as_u64()).map(|n| {
                            *m = (n, n);
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
                    let written = m.0 != m.1;
                    if let (true, Some(f)) = (written, &memory_file) {
                        let _ = std::fs::create_dir_all(f.parent().unwrap());
                        let _ = std::fs::write(f, json!({ "token": m.0 }).to_string());
                    }
                    m.1 = m.0;
                    let r = json!({ "id_slot": 0, "saved": written, "n_saved": if written { m.0 } else { 0 }, "n_cache_tokens": m.0,
                                    "n_written": if written { m.0 * 10 } else { 0 }, "timings": { "save_ms": 1.0 } });
                    let _ = req.respond(Response::from_string(r.to_string()).with_header(json_h));
                }
                (Method::Post, "/v1/chat/completions") => {
                    memory.lock().unwrap().0 += 100;
                    // The base warm-up (X-Mango-Warmup header) isn't a conversation: a short text, like the token a
                    // real engine writes, without consuming the script.
                    let warmup = req.headers().iter().any(|h| h.field.equiv("x-mango-warmup"));
                    let step = match &script {
                        _ if warmup => json!({ "text": "Ready." }),
                        None => json!({ "text": format!("I am the engine {name}") }),
                        Some(c) => {
                            // Two forms of step are outside the numbering: `{"summary": "...", "token": {...}}` answers
                            // the requests that offer no tools (the conversation summary, the title);
                            // `{"if": "...", "text": "...", "token": {...}}` answers the requests in which that text appears
                            // (usually the summary, after it has entered the conversation).
                            let (special, steps): (Vec<&Value>, Vec<&Value>) = c.iter().partition(|p| p["summary"].is_string() || p["if"].is_string());
                            let no_tools = v["tools"].as_array().map_or(true, |t| t.is_empty());
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
    if let Some(name) = step["tool"].as_str() {
        let arguments = step["arguments"].to_string();
        return vec![
            delta(json!({ "tool_calls": [{ "index": 0, "id": "call_fake", "type": "function", "function": { "name": name, "arguments": arguments } }] }), None),
            delta(json!({}), Some("tool_calls")),
        ];
    }
    let text = step["text"].as_str().unwrap_or("");
    let mut v: Vec<Value> = text.split_inclusive(' ').map(|p| delta(json!({ "content": p }), None)).collect();
    v.push(delta(json!({}), Some("stop")));
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
    let message = match step["tool"].as_str() {
        Some(name) => json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "call_fake", "type": "function", "function": { "name": name, "arguments": step["arguments"].to_string() } }] }),
        None => json!({ "role": "assistant", "content": step["text"] }),
    };
    let finish = if step["tool"].is_string() { "tool_calls" } else { "stop" };
    json!({ "choices": [{ "index": 0, "message": message, "finish_reason": finish }], "usage": usage })
}
