//! The requests the agent really sends (`tests/requests/`, captured by the integration test `capture-requests`) rendered
//! with the original chat templates of real models (`tests/templates/`, see `templates.json`).
//!
//! A request has to render without the template rejecting it, and nothing the agent sent may be lost on the way: every
//! message, tool, call and result must be in the text, the system messages before the first user message, every result
//! after its call, and the text must end where the assistant starts. What a template legitimately refuses or leaves out
//! is declared in its manifest entry (`expect`); anything else is a failure of Mango Code's request.

use engine_cfg::chat_template::{probe, Probe};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const IMAGE_MARKER: &str = "<__media__>";

fn folder(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(name)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn json_of(path: &Path) -> Value {
    serde_json::from_str(&read(path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// What a template can legitimately not write, so the check of it is skipped (`expect.drops` in the manifest).
#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
enum Part {
    System,
    /// The system messages are written, but not before the first user message.
    SystemLate,
    Tools,
    Calls,
    Results,
    Reasoning,
    Images,
    /// The assistant's turn is not opened when the conversation ends with a tool's results: the model goes on from them.
    OpeningAfterResults,
}

impl Part {
    fn named(name: &str) -> Part {
        match name {
            "system" => Part::System,
            "system-late" => Part::SystemLate,
            "tools" => Part::Tools,
            "calls" => Part::Calls,
            "results" => Part::Results,
            "reasoning" => Part::Reasoning,
            "images" => Part::Images,
            "opening-after-results" => Part::OpeningAfterResults,
            other => panic!("the manifest drops «{other}», which is not a part of a request"),
        }
    }
}

/// A short piece of `text` that a template leaves as it is: its first line, up to the first character that a template
/// may escape.
fn snippet(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default();
    let line: String = line.chars().take(48).take_while(|c| !matches!(c, '"' | '\\')).collect();
    line.trim_end().to_string()
}

/// The text of a message's content as the engine hands it to a template: the parts of a list joined, a picture as the
/// marker the engine puts where it goes.
fn flatten(content: &Value) -> String {
    match content {
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => p["text"].as_str().map(str::to_string),
                Some("image_url") => Some(IMAGE_MARKER.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn arguments_of(call: &Value) -> Value {
    call["function"]["arguments"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or_default()
}

fn scalar_values(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(snippet(s)),
        Value::Number(n) => out.push(n.to_string()),
        Value::Array(a) => a.iter().for_each(|v| scalar_values(v, out)),
        Value::Object(o) => o.values().for_each(|v| scalar_values(v, out)),
        _ => {}
    }
}

/// What has to be in the rendered text, and how many times at least: the same piece in two messages counts twice, and an
/// argument that a result repeats counts once more.
fn signals(request: &Value) -> BTreeMap<(Option<Part>, String), usize> {
    let messages = request["messages"].as_array().unwrap();
    let results: Vec<String> = messages.iter().filter(|m| m["role"] == "tool").map(|m| flatten(&m["content"])).collect();
    let mut all = BTreeMap::new();
    let mut add = |part: Option<Part>, text: String, times: usize| {
        if !text.is_empty() {
            *all.entry((part, text)).or_insert(0) += times;
        }
    };
    for tool in request["tools"].as_array().into_iter().flatten() {
        add(Some(Part::Tools), tool["function"]["name"].as_str().unwrap().to_string(), 1);
        add(Some(Part::Tools), snippet(tool["function"]["description"].as_str().unwrap_or_default()), 1);
    }
    for m in messages {
        let content = flatten(&m["content"]);
        let part = match m["role"].as_str().unwrap_or_default() {
            "system" => Some(Part::System),
            "tool" => Some(Part::Results),
            _ => None,
        };
        add(part, snippet(&content), 1);
        add(Some(Part::Images), IMAGE_MARKER.to_string(), content.matches(IMAGE_MARKER).count());
        if let Some(reasoning) = m["reasoning_content"].as_str() {
            add(Some(Part::Reasoning), snippet(reasoning), 1);
        }
        for call in m["tool_calls"].as_array().into_iter().flatten() {
            add(Some(Part::Calls), call["function"]["name"].as_str().unwrap().to_string(), 1);
            let mut values = Vec::new();
            scalar_values(&arguments_of(call), &mut values);
            for v in values {
                let repeated = results.iter().filter(|r| r.contains(&v)).count();
                add(Some(Part::Calls), v, 1 + repeated);
            }
        }
    }
    all
}

struct Template {
    id: String,
    text: String,
    bos_token: String,
    eos_token: String,
    /// What the template writes to start the assistant's turn.
    opening: String,
    /// The field the engine puts a message's reasoning in for this template, if not `reasoning_content`.
    reasoning_field: Option<String>,
    /// Whether the template takes a system message at all; if not, the engine puts it in the first user message.
    system_role: bool,
    drops: Vec<Part>,
    /// (scenarios, the message the template rejects them with)
    rejects: Vec<(Vec<String>, String)>,
}

fn templates() -> Vec<Template> {
    let manifest = json_of(&folder("templates").join("templates.json"));
    let strings = |v: &Value| v.as_array().into_iter().flatten().map(|s| s.as_str().unwrap().to_string()).collect::<Vec<_>>();
    manifest["templates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let id = t["id"].as_str().unwrap().to_string();
            let expect = &t["expect"];
            let text = read(&folder("templates").join(format!("{id}.jinja")));
            let hello = serde_json::json!({
                "messages": [{ "role": "system", "content": "S" }, { "role": "user", "content": "U" }],
                "add_generation_prompt": true, "bos_token": t["bos_token"], "eos_token": t["eos_token"],
            });
            Template {
                system_role: matches!(probe(&text, &hello), Probe::Text(_)),
                text,
                bos_token: t["bos_token"].as_str().unwrap().to_string(),
                eos_token: t["eos_token"].as_str().unwrap().to_string(),
                opening: expect["opening"].as_str().unwrap_or_else(|| panic!("{id}: the manifest does not say how the assistant's turn opens")).to_string(),
                reasoning_field: expect["reasoning_field"].as_str().map(str::to_string),
                drops: strings(&expect["drops"]).iter().map(|d| Part::named(d)).collect(),
                rejects: expect["rejects"].as_array().into_iter().flatten().map(|r| (strings(&r["scenarios"]), r["message"].as_str().unwrap().to_string())).collect(),
                id,
            }
        })
        .collect()
}

fn scenarios() -> BTreeMap<String, Value> {
    let mut found = BTreeMap::new();
    for entry in std::fs::read_dir(folder("requests")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            found.insert(path.file_stem().unwrap().to_string_lossy().into_owned(), json_of(&path));
        }
    }
    found
}

/// How the engine hands a message to a template when it has to guess what the template reads: an assistant message that
/// only calls tools has `null` or an empty content, and the arguments of a call are an object or the text the model wrote.
#[derive(Clone, Copy)]
struct Shape {
    null_content: bool,
    object_arguments: bool,
}

/// The request as a template receives it: the content of every message as one text, the reasoning where the template
/// reads it, and the calls in the given shape.
fn messages_for_the_template(request: &Value, t: &Template, shape: Shape) -> Vec<Value> {
    let mut messages: Vec<Value> = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let mut m = m.clone();
            let content = flatten(&m["content"]);
            let only_calls = content.is_empty() && m["tool_calls"].as_array().is_some_and(|c| !c.is_empty());
            m["content"] = if only_calls && shape.null_content { Value::Null } else { content.into() };
            if shape.object_arguments {
                for call in m["tool_calls"].as_array_mut().into_iter().flatten() {
                    call["function"]["arguments"] = arguments_of(call);
                }
            }
            let reasoning = m.as_object_mut().unwrap().remove("reasoning_content").filter(|r| r.as_str().is_some_and(|r| !r.is_empty()));
            if let Some(reasoning) = reasoning {
                m[t.reasoning_field.as_deref().unwrap_or("reasoning_content")] = reasoning;
            }
            m
        })
        .collect();
    // A template without a system role gets the system message at the start of the first user message.
    if !t.system_role {
        let (system, rest): (Vec<Value>, Vec<Value>) = messages.into_iter().partition(|m| m["role"] == "system");
        messages = rest;
        let prefix: String = system.iter().map(|m| format!("{}

", m["content"].as_str().unwrap_or_default())).collect();
        if let Some(user) = messages.iter_mut().find(|m| m["role"] == "user") {
            user["content"] = format!("{prefix}{}", user["content"].as_str().unwrap_or_default()).into();
        }
    }
    messages
}

fn context(request: &Value, t: &Template, thinking: Option<bool>, shape: Shape) -> Value {
    let mut context = Map::new();
    context.insert("messages".into(), messages_for_the_template(request, t, shape).into());
    context.insert("tools".into(), request["tools"].clone());
    context.insert("add_generation_prompt".into(), true.into());
    context.insert("bos_token".into(), t.bos_token.clone().into());
    context.insert("eos_token".into(), t.eos_token.clone().into());
    if let Some(on) = thinking {
        context.insert("enable_thinking".into(), on.into());
    }
    Value::Object(context)
}

/// Renders the request the way the engine does: in the shape the template can read (the first of these that it does not
/// fail on for a reason other than rejecting the conversation).
fn render(request: &Value, t: &Template, thinking: Option<bool>) -> Probe {
    let mut failure = None;
    for (null_content, object_arguments) in [(true, false), (true, true), (false, false), (false, true)] {
        match probe(&t.text, &context(request, t, thinking, Shape { null_content, object_arguments })) {
            Probe::Unverifiable(e) => {
                failure.get_or_insert(e);
            }
            done => return done,
        }
    }
    Probe::Unverifiable(failure.unwrap())
}

/// What is wrong with a rendering of `request`: the kind of problem and the piece of the request it is about.
fn problems(request: &Value, t: &Template, rendered: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for ((part, text), needed) in signals(request) {
        if part.is_some_and(|p| t.drops.contains(&p)) {
            continue;
        }
        let written = rendered.matches(&text).count();
        if written < needed {
            found.push((format!("{} missing from the text", part.map_or("a message".to_string(), |p| format!("{p:?}"))), format!("«{text}» {written}/{needed}")));
        }
    }

    let messages = request["messages"].as_array().unwrap();
    let first_user = messages.iter().find(|m| m["role"] == "user").and_then(|m| rendered.find(&snippet(&flatten(&m["content"]))));
    if !t.drops.contains(&Part::System) && !t.drops.contains(&Part::SystemLate) {
        for m in messages.iter().filter(|m| m["role"] == "system") {
            if let (Some(system), Some(user)) = (rendered.find(&snippet(&flatten(&m["content"]))), first_user) {
                if system > user {
                    found.push(("a system message after the first user message".to_string(), String::new()));
                }
            }
        }
    }

    // The i-th result after the first argument of the i-th call.
    if found.iter().all(|(kind, _)| !kind.starts_with("Calls")) && !t.drops.contains(&Part::Calls) && !t.drops.contains(&Part::Results) {
        let calls = messages.iter().flat_map(|m| m["tool_calls"].as_array().into_iter().flatten());
        for (i, (call, result)) in calls.zip(messages.iter().filter(|m| m["role"] == "tool")).enumerate() {
            let mut values = Vec::new();
            scalar_values(&arguments_of(call), &mut values);
            let result = snippet(&flatten(&result["content"]));
            if values.first().and_then(|v| rendered.find(v.as_str())).is_some_and(|at| !rendered[at..].contains(&result)) {
                found.push(("a result before its call".to_string(), format!("«{result}» of call {i}")));
            }
        }
    }

    let last = messages.last().unwrap();
    let after_results = last["role"] == "tool" && t.drops.contains(&Part::OpeningAfterResults);
    if !after_results {
        match (rendered.rfind(&t.opening), rendered.rfind(&snippet(&flatten(&last["content"])))) {
            (None, _) => found.push(("the assistant's turn is not opened".to_string(), format!("{:?} is not in the text", t.opening))),
            (Some(opening), Some(last)) if opening < last => found.push(("the assistant's turn opens before the last message".to_string(), String::new())),
            _ => {}
        }
    }
    found
}

#[test]
fn every_template_is_the_text_its_manifest_names() {
    let manifest = json_of(&folder("templates").join("templates.json"));
    let ids: Vec<&str> = manifest["templates"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    for t in manifest["templates"].as_array().unwrap() {
        let id = t["id"].as_str().unwrap();
        let text = read(&folder("templates").join(format!("{id}.jinja")));
        assert_eq!(mango_common::sha256_hex(text.as_bytes()), t["sha256"].as_str().unwrap(), "{id}: the text is not the one the manifest hashed");
        for field in ["repo", "revision", "file", "license"] {
            assert!(t[field].as_str().is_some_and(|v| !v.is_empty()), "{id}: the manifest does not say its {field}");
        }
        let permissive = matches!(t["license"].as_str(), Some("apache-2.0" | "mit"));
        match t["license_file"].as_str() {
            Some(name) => assert!(folder("templates").join(name).is_file(), "{id}: the license file {name} is not there"),
            None => assert!(permissive, "{id}: a license that is not Apache-2.0 or MIT needs its text in `license_file`"),
        }
    }
    for file in std::fs::read_dir(folder("templates")).unwrap() {
        let path = file.unwrap().path();
        if path.extension().is_some_and(|e| e == "jinja") {
            let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
            assert!(ids.contains(&stem.as_str()), "{stem}.jinja is in no entry of the manifest");
        }
    }
}

#[test]
fn the_agents_requests_render_with_the_original_templates_of_real_models() {
    let scenarios = scenarios();
    for name in ["first-turn", "tool-result", "long-with-reminders", "after-summary", "summary-request", "images", "reasoning"] {
        assert!(scenarios.contains_key(name), "the request fixture {name} is missing");
    }
    // (template, kind of problem) -> the pieces it is about and the scenarios it happens in, each with the thinking settings
    let mut failures: BTreeMap<(String, String), (BTreeSet<String>, BTreeMap<String, BTreeSet<&str>>)> = BTreeMap::new();
    for t in templates() {
        let mut rejected_as_declared = vec![false; t.rejects.len()];
        for (scenario, request) in &scenarios {
            for (label, thinking) in [("unset", None), ("on", Some(true)), ("off", Some(false))] {
                let declared = t.rejects.iter().position(|(scenarios, _)| scenarios.iter().any(|s| s == scenario || s == "*"));
                let wrong: Vec<(String, String)> = match (render(request, &t, thinking), declared) {
                    (Probe::Rejects(m), Some(i)) if m.contains(&t.rejects[i].1) => {
                        rejected_as_declared[i] = true;
                        Vec::new()
                    }
                    (Probe::Rejects(m), Some(i)) => vec![("rejects with another message than the manifest's".into(), format!("«{m}», not «{}»", t.rejects[i].1))],
                    (Probe::Rejects(m), None) => vec![("rejects the request".into(), format!("«{m}»"))],
                    (Probe::Unverifiable(e), _) => vec![("cannot be rendered here".into(), e)],
                    (Probe::Text(_), Some(i)) => vec![("renders what the manifest says it rejects".into(), format!("«{}»", t.rejects[i].1))],
                    (Probe::Text(text), None) => problems(request, &t, &text),
                };
                for (kind, detail) in wrong {
                    let (details, at) = failures.entry((t.id.clone(), kind)).or_default();
                    details.insert(detail);
                    at.entry(scenario.clone()).or_default().insert(label);
                }
            }
        }
        for (i, hit) in rejected_as_declared.iter().enumerate() {
            assert!(hit, "{}: the manifest declares a rejection with «{}» that never happens", t.id, t.rejects[i].1);
        }
    }
    let report: Vec<String> = failures
        .iter()
        .map(|((id, kind), (details, scenarios))| {
            let at: Vec<String> = scenarios
                .iter()
                .map(|(s, labels)| if labels.len() == 3 { s.clone() } else { format!("{s} (thinking {})", labels.iter().copied().collect::<Vec<_>>().join("/")) })
                .collect();
            let some: Vec<&str> = details.iter().map(String::as_str).filter(|d| !d.is_empty()).take(2).collect();
            let more = if details.len() > 2 { format!(" and {} more", details.len() - 2) } else { String::new() };
            format!("{id}: {kind}: {}{more}\n    in {}", some.join("; "), at.join(", "))
        })
        .collect();
    assert!(report.is_empty(), "{} things go wrong between the agent's requests and the templates:\n{}", report.len(), report.join("\n"));
}

/// An HTTP/1.1 request to the engine on the local port; returns (status, body).
fn http(port: u16, path: &str, body: &str) -> std::io::Result<(u16, String)> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(60)))?;
    let method = if body.is_empty() { "GET" } else { "POST" };
    write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())?;
    let mut r = String::new();
    s.read_to_string(&mut r)?;
    let (head, rest) = r.split_once("\r\n\r\n").unwrap_or((&r, ""));
    Ok((head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0), rest.to_string()))
}

/// The engine, stopped when this goes out of scope (also on a panic).
struct Engine(std::process::Child);

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The judge: the real engine decides whether each template accepts each request (`/apply-template`, the route the app's
/// proxy uses) and minijinja has to agree. Needs a `llama-server` of the processor's build (never a graphics card's) and
/// any tiny GGUF, which the engine only needs to start: `MANGO_TEST_LLAMA_SERVER` and `MANGO_TEST_TINY_GGUF`.
#[test]
#[ignore = "starts llama-server on the processor with a tiny model"]
fn the_engine_accepts_what_minijinja_accepts() {
    use std::os::windows::process::CommandExt;
    let (exe, model) = (std::env::var("MANGO_TEST_LLAMA_SERVER").expect("MANGO_TEST_LLAMA_SERVER"), std::env::var("MANGO_TEST_TINY_GGUF").expect("MANGO_TEST_TINY_GGUF"));
    let mut scenarios = scenarios();
    // A model without a multimodal projector refuses a picture before the template is even looked at.
    scenarios.remove("images");
    let mut disagreements = Vec::new();
    for t in templates() {
        let port = mango_common::free_port(18_300).unwrap();
        let file = folder("templates").join(format!("{}.jinja", t.id));
        let child = std::process::Command::new(&exe)
            .args(["--jinja", "--chat-template-file"])
            .arg(&file)
            .args(["-m", &model, "--host", "127.0.0.1", "--port", &port.to_string(), "-ngl", "0", "-c", "512", "--no-warmup"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let _engine = Engine(child);
        let start = std::time::Instant::now();
        while !http(port, "/health", "").is_ok_and(|(s, _)| s == 200) {
            assert!(start.elapsed().as_secs() < 120, "{}: the engine is not ready in 120 s", t.id);
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        for (scenario, request) in &scenarios {
            for (label, thinking) in [("unset", None), ("on", Some(true)), ("off", Some(false))] {
                let mut body = request.clone();
                if let Some(on) = thinking {
                    body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": on });
                }
                let (status, reply) = http(port, "/apply-template", &body.to_string()).unwrap();
                let mini = matches!(render(request, &t, thinking), Probe::Text(_));
                if (status == 200) != mini {
                    let said = if status == 200 { "accepts".to_string() } else { reply.rsplit("Error: ").next().unwrap_or(&reply).chars().take(120).collect::<String>() };
                    disagreements.push(format!("{} {scenario} (thinking {label}): the engine {} ({status}: {said}), minijinja {}", t.id, if status == 200 { "accepts" } else { "rejects" }, if mini { "accepts" } else { "rejects" }));
                }
            }
        }
    }
    assert!(disagreements.is_empty(), "{} disagreements:\n{}", disagreements.len(), disagreements.join("\n"));
}

/// Ling's own template takes the first request of Mango Harness 2 as the agent sends it, with thinking on: the system
/// message, the user's text and every tool reach the prompt.
#[test]
fn ling_takes_mango_harness_2s_first_request() {
    let ling = templates().into_iter().find(|t| t.id == "ling").expect("the manifest has Ling's template");
    let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/opencode/test/mango-harness/examples");
    let mut seen = 0;
    for entry in std::fs::read_dir(&examples).unwrap() {
        let path = entry.unwrap().path();
        let example = json_of(&path);
        let messages = example["messages"].as_array().unwrap();
        let request = serde_json::json!({ "messages": messages[..2], "tools": example["tools"] });
        let Probe::Text(rendered) = render(&request, &ling, Some(true)) else { panic!("{}: Ling's template does not render it", path.display()) };
        for message in &messages[..2] {
            let text = message["content"].as_str().unwrap();
            assert!(rendered.contains(text), "{}: the {} message is not in the prompt", path.display(), message["role"]);
        }
        for tool in example["tools"].as_array().unwrap() {
            let name = tool["function"]["name"].as_str().unwrap();
            assert!(rendered.contains(name), "{}: the tool {name} is not in the prompt", path.display());
        }
        seen += 1;
    }
    assert_eq!(seen, 2, "the two requests");
}
