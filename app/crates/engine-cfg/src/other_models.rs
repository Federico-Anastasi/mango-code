//! «Other models»: a GGUF chosen by the user (on Hugging Face or on the computer) becomes an entry of
//! `user-models.json`. Here lives what the app says before adding it: whether it fits in the PC's memory (the same
//! estimate as the recommended models, `general.rs`) and whether the model's conversation format holds up to what
//! Mango Code sends it (tools and a system message in the middle of the conversation).

use crate::catalog::{load_models, ModelCfg, ModelsFile};
use crate::general::{evaluate, Placement};
use crate::gguf::{ends_too_early, model_memory, parse_header, GgufHeader, GgufMemory};
use crate::hardware::{choose_build, Hardware};
use crate::user;
use anyhow::{bail, Result};
use mango_common::download::hugging_face::{self, image_encoder, variants, HfFile, Repo, Variant};
use mango_common::{tr, Paths};
use minijinja::value::{Kwargs, Serde};
use minijinja::{Environment, Error, ErrorKind};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Something to know about a model before adding it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Warning {
    /// The model won't work as an assistant (or the conversation will break with an error).
    pub severe: bool,
    pub text: String,
}

fn severe(text: String) -> Warning {
    Warning { severe: true, text }
}

fn caution(text: String) -> Warning {
    Warning { severe: false, text }
}

/// Two tools in the list; the first is the one called in the test conversation.
const CALLED_TOOL: &str = "read_file";
const LISTED_ONLY_TOOL: &str = "search_text";
const PARAMETER: &str = "test_path.txt";
const RESULT: &str = "TOOL_RESULT";
const REMINDER: &str = "MID_CONVERSATION_REMINDER";

/// How a conversation-format test goes.
enum Probe {
    /// The model wrote the conversation.
    Text(String),
    /// The template itself rejected the conversation (`raise_exception`), with its message.
    Rejects(String),
    /// The template uses something that can't be run here: it says nothing about the model.
    Unverifiable(String),
}

/// Tests the conversation format (the GGUF's Jinja template) with what Mango Code really sends: the list of tools,
/// a call already made with its result, and a system message in the middle of the conversation.
pub fn check_template(template: Option<&str>) -> Vec<Warning> {
    let Some(template) = template else {
        return vec![severe(tr!(
            "Il file non contiene il formato della conversazione: il motore ne userà uno generico e il modello probabilmente non saprà usare gli strumenti.",
            "The file doesn't contain the conversation format: the engine will use a generic one and the model probably won't know how to use tools."
        ))];
    };
    let mut warnings = Vec::new();
    let with_tools = probe(template, &conversation(false));
    match &with_tools {
        Probe::Rejects(m) => warnings.push(severe(tr!(
            "Il formato della conversazione di questo modello rifiuta una conversazione con gli strumenti («{m}»): Mango Code non potrà usarlo come assistente.",
            "This model's conversation format rejects a conversation with tools («{m}»): Mango Code won't be able to use it as an assistant."
        ))),
        Probe::Unverifiable(e) => warnings.push(caution(unverifiable(&tr!("gli strumenti", "tools"), e))),
        Probe::Text(t) => warnings.extend(tools_in_text(t)),
    }
    // If the first test can't even be written, the same cause would stop this one too.
    if matches!(with_tools, Probe::Text(_)) {
        match probe(template, &conversation(true)) {
            Probe::Rejects(m) => warnings.push(severe(tr!(
                "Il formato della conversazione di questo modello rifiuta un messaggio di sistema a metà conversazione («{m}»), che Mango Code manda per i promemoria: le conversazioni lunghe si interromperanno con un errore.",
                "This model's conversation format rejects a system message in the middle of the conversation («{m}»), which Mango Code sends for reminders: long conversations will break with an error."
            ))),
            Probe::Unverifiable(e) => {
                warnings.push(caution(unverifiable(&tr!("i messaggi di sistema a metà conversazione", "system messages in the middle of the conversation"), &e)))
            }
            Probe::Text(t) if !t.contains(REMINDER) => warnings.push(caution(tr!(
                "Il formato della conversazione di questo modello scarta i messaggi di sistema a metà conversazione: i promemoria di Mango Code non arriverebbero al modello.",
                "This model's conversation format discards system messages in the middle of the conversation: Mango Code's reminders wouldn't reach the model."
            ))),
            Probe::Text(_) => {}
        }
    }
    warnings
}

fn unverifiable(what: &str, error: &str) -> String {
    tr!(
        "Non sono riuscito a controllare come il modello gestisce {what} ({error}): provalo prima di fidarti.",
        "I couldn't check how the model handles {what} ({error}): try it before trusting it."
    )
}

/// What must appear in the text written by the template for tools to work.
fn tools_in_text(t: &str) -> Vec<Warning> {
    if !t.contains(LISTED_ONLY_TOOL) {
        return vec![severe(tr!(
            "Questo modello non sa chiamare gli strumenti: il suo formato della conversazione non li elenca al modello.",
            "This model can't call tools: its conversation format doesn't list them to the model."
        ))];
    }
    let mut v = Vec::new();
    // The name appears in the list and in the call already made.
    if t.matches(CALLED_TOOL).count() < 2 {
        v.push(severe(tr!(
            "Il formato della conversazione di questo modello ignora le chiamate agli strumenti già fatte: il modello non vedrebbe ciò che ha già provato.",
            "This model's conversation format ignores the tool calls already made: the model wouldn't see what it has already tried."
        )));
    } else if !t.contains(PARAMETER) {
        v.push(severe(tr!(
            "Il formato della conversazione di questo modello perde i parametri delle chiamate agli strumenti.",
            "This model's conversation format loses the parameters of the tool calls."
        )));
    }
    if !t.contains(RESULT) {
        v.push(severe(tr!(
            "Il formato della conversazione di questo modello ignora i risultati degli strumenti: il modello non saprebbe cosa è successo.",
            "This model's conversation format ignores the tool results: the model wouldn't know what happened."
        )));
    }
    v
}

/// The test conversation, as the agent sends it: a system message, a question, a call with its result, then (in the
/// middle, or as an answer) a message and the new question.
fn conversation(system_in_the_middle: bool) -> serde_json::Value {
    let message_after = if system_in_the_middle {
        json!({ "role": "system", "content": REMINDER })
    } else {
        json!({ "role": "assistant", "content": "ANSWER_ONE" })
    };
    json!({
        "messages": [
            { "role": "system", "content": "INITIAL_SYSTEM" },
            { "role": "user", "content": "QUESTION_ONE" },
            { "role": "assistant", "content": "", "tool_calls": [
                { "id": "call_1", "type": "function", "function": { "name": CALLED_TOOL, "arguments": { "path": PARAMETER } } }
            ] },
            { "role": "tool", "tool_call_id": "call_1", "name": CALLED_TOOL, "content": RESULT },
            message_after,
            { "role": "user", "content": "QUESTION_TWO" }
        ],
        "tools": [
            { "type": "function", "function": { "name": CALLED_TOOL, "description": "Reads a file.",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } },
            { "type": "function", "function": { "name": LISTED_ONLY_TOOL, "description": "Searches a text.",
                "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } } }
        ],
        "add_generation_prompt": true,
        "bos_token": "<s>",
        "eos_token": "</s>"
    })
}

// --- the analysis of a model -----------------------------------------------------------------------------------

/// What the app shows of a model before adding it: its quantizations (just one for a file on the computer), each
/// with the memory verdict, and the warnings about the conversation format.
#[derive(Debug, Clone, Serialize)]
pub struct Analysis {
    pub name: String,
    /// "hugging-face" or "local".
    pub source: String,
    /// It asks to accept terms, and the token, to download it.
    pub gated: bool,
    pub variants: Vec<Proposal>,
    pub warnings: Vec<Warning>,
}

impl Analysis {
    /// Proposes the quantization a link names (`:Q4_K_M`) or the file it points to, instead of the recommended one.
    /// If it isn't there, the earlier proposal stays.
    pub fn prefer(&mut self, quant: Option<&str>, path: Option<&str>) {
        let found = self.variants.iter().position(|v| {
            let in_file = |p: &str| v.entry["files"].as_array().is_some_and(|f| f.iter().any(|f| f["path"].as_str().is_some_and(|x| x.ends_with(p))));
            quant.is_some_and(|q| v.name.eq_ignore_ascii_case(q)) || path.is_some_and(in_file)
        });
        if let Some(i) = found {
            self.variants.iter_mut().enumerate().for_each(|(j, v)| v.recommended = i == j);
        }
    }
}

/// A quantization, ready to be added to the user's list.
#[derive(Debug, Clone, Serialize)]
pub struct Proposal {
    pub name: String,
    /// The key in the user's list: the same quantization of the same repo always has the same one.
    pub key: String,
    pub bytes: u64,
    /// Where it would run on the PC; `None` if it doesn't fit.
    pub placement: Option<Placement>,
    pub reason: String,
    /// The one to propose: Q4_K_M if it fits, otherwise the largest that fits.
    pub recommended: bool,
    /// The `user-models.json` entry.
    pub entry: Value,
    /// The same quantization with the image encoder, if the repo has one.
    pub with_images: Option<WithImages>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WithImages {
    pub bytes: u64,
    pub placement: Option<Placement>,
    pub reason: String,
    pub entry: Value,
}

/// What of a GGUF's header a user model needs.
struct Info {
    memory: GgufMemory,
    template: Option<String>,
}

impl Info {
    fn from_header(h: &GgufHeader) -> Result<Info> {
        let memory = model_memory(h).map_err(|e| user(&tr!("Non riesco a calcolare quanta memoria chiede questo modello.", "I can't work out how much memory this model needs."), format!("{e:#}")))?;
        Ok(Info { memory, template: h.strings.get("tokenizer.chat_template").cloned() })
    }

    fn memory_json(&self) -> Value {
        json!({ "kv_kib_token": self.memory.kv_kib_token, "state_mib": self.memory.state_mib })
    }
}

/// How much to read from the start of a remote file to get the header, by attempts: the first almost always is enough.
const STEPS: [usize; 3] = [8 << 20, 32 << 20, 128 << 20];

/// Analyzes the GGUF files of a Hugging Face repo: reads the start of a single file (the model's structure is the
/// same in every quantization) and gives the verdict for each.
pub fn analyze_hugging_face(paths: &Paths, hw: &Hardware, repo: &Repo) -> Result<Analysis> {
    analyze_repo(paths, hw, repo, &|file, bytes| hugging_face::file_start(repo, file, bytes))
}

fn analyze_repo(paths: &Paths, hw: &Hardware, repo: &Repo, start: &dyn Fn(&HfFile, usize) -> Result<Vec<u8>>) -> Result<Analysis> {
    let quantizations = variants(repo);
    // A whole file is better: in a split model the first piece's header has only its own tensors.
    let Some(sample) = quantizations.iter().find(|v| v.files.len() == 1).or(quantizations.first()) else {
        bail!(
            "{}",
            tr!(
                "Nel repo «{}» non ci sono file GGUF: Mango Code usa i modelli in formato GGUF.",
                "There are no GGUF files in the repo «{}»: Mango Code uses models in GGUF format.",
                repo.id
            )
        );
    };
    let info = Info::from_header(&remote_header(&sample.files[0], start, &STEPS)?)?;
    let encoder = image_encoder(repo);
    let catalog = load_models(paths)?;
    let name = repo_name(&repo.id);

    let mut proposals = Vec::new();
    for v in &quantizations {
        let key = format!("hf-{}-{}", slug(&repo.id), slug(&v.name));
        let entry = hf_entry(repo, &name, v, None, &info);
        let (placement, reason) = verdict(&catalog, hw, &key, &entry)?;
        let with_images = match &encoder {
            None => None,
            Some(e) => {
                let entry = hf_entry(repo, &name, v, Some(e), &info);
                let (placement, reason) = verdict(&catalog, hw, &key, &entry)?;
                Some(WithImages { bytes: v.bytes() + e.size, placement, reason, entry })
            }
        };
        proposals.push(Proposal { name: v.name.clone(), key, bytes: v.bytes(), placement, reason, recommended: false, entry, with_images });
    }
    // They are from the smallest: the last one that fits is the largest.
    let recommended = proposals.iter().position(|p| p.placement.is_some() && p.name.eq_ignore_ascii_case("Q4_K_M")).or_else(|| proposals.iter().rposition(|p| p.placement.is_some()));
    if let Some(i) = recommended {
        proposals[i].recommended = true;
    }
    Ok(Analysis { name, source: "hugging-face".into(), gated: repo.gated, variants: proposals, warnings: check_template(info.template.as_deref()) })
}

/// The header of a remote GGUF: the start of the file is requested, longer each time until the header is all there.
fn remote_header(file: &HfFile, start: &dyn Fn(&HfFile, usize) -> Result<Vec<u8>>, steps: &[usize]) -> Result<GgufHeader> {
    for &bytes in steps {
        let data = start(file, bytes)?;
        match parse_header(std::io::Cursor::new(&data), file.size) {
            Ok(h) => return Ok(h),
            // If the bytes received are those asked for, the header may go on beyond; if fewer, the file is over.
            Err(e) if ends_too_early(&e) && data.len() == bytes => continue,
            Err(e) => return Err(user(&tr!("«{}» non è un file GGUF valido.", "«{}» is not a valid GGUF file.", file.path), format!("{e:#}"))),
        }
    }
    bail!(
        "{}",
        tr!(
            "L'intestazione di «{}» è più grande del previsto: non riesco a leggerla.",
            "The header of «{}» is larger than expected: I can't read it.",
            file.path
        )
    )
}

/// Analyzes a GGUF that is already on the computer: it stays where it is, the user's list remembers its path.
pub fn analyze_local(paths: &Paths, hw: &Hardware, path: &Path) -> Result<Analysis> {
    let file_name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let name = path.file_stem().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    if is_piece(&name) {
        bail!(
            "{}",
            tr!(
                "«{file_name}» è un pezzo di un modello diviso in più file: i modelli divisi si aggiungono da Hugging Face.",
                "«{file_name}» is a piece of a model split into several files: split models are added from Hugging Face."
            )
        );
    }
    let file = std::fs::File::open(path).map_err(|e| user(&tr!("Non riesco ad aprire il file «{file_name}».", "I can't open the file «{file_name}»."), format!("{}: {e}", path.display())))?;
    let size = file.metadata().map_err(|e| user(&tr!("Non riesco a leggere il file «{file_name}».", "I can't read the file «{file_name}»."), e))?.len();
    let h = parse_header(std::io::BufReader::new(file), size)
        .map_err(|e| user(&tr!("«{file_name}» non è un file GGUF valido.", "«{file_name}» is not a valid GGUF file."), format!("{e:#}")))?;
    let info = Info::from_header(&h)?;

    let key = format!("local-{}", slug(&name));
    let p = path.display().to_string();
    let mut entry = json!({
        "label": name, "kind": "File on this computer", "gguf": p, "origin": "local",
        "files": [{ "path": p, "size": size }],
        "memory": info.memory_json(),
    });
    if let Some(c) = info.memory.ctx_max {
        entry["ctx"] = c.into();
    }
    let (placement, reason) = verdict(&load_models(paths)?, hw, &key, &entry)?;
    let proposal = Proposal { name: name.clone(), key, bytes: size, placement, reason, recommended: true, entry, with_images: None };
    Ok(Analysis { name, source: "local".into(), gated: false, variants: vec![proposal], warnings: check_template(info.template.as_deref()) })
}

/// Adds the model to the user's list (`user-models.json`), with the key it got from the analysis.
pub fn add(paths: &Paths, key: &str, entry: Value) -> Result<()> {
    let not_valid = || tr!("Il modello «{key}» non è valido.", "The model «{key}» is not valid.");
    let cfg: ModelCfg = serde_json::from_value(entry.clone()).map_err(|e| user(&not_valid(), e))?;
    if cfg.memory.is_none() || cfg.files.is_empty() {
        bail!("{}", user(&not_valid(), "the files or the memory it asks for are missing"));
    }
    mango_common::catalog::add_user(paths, key, entry)
}

/// Whether the model `entry` fits `hw`, where, and why.
fn verdict(catalog: &ModelsFile, hw: &Hardware, key: &str, entry: &Value) -> Result<(Option<Placement>, String)> {
    let cfg: ModelCfg = serde_json::from_value(entry.clone()).map_err(|e| user(&tr!("Non riesco a descrivere il modello.", "I can't describe the model."), e))?;
    let (context, reason) = evaluate(catalog, &cfg, key, hw, choose_build(hw));
    Ok((context.map(|c| c.placement), reason))
}

/// A Hugging Face model's entry: where it is downloaded from (repo, revision, files with hash) and what it asks of memory.
fn hf_entry(repo: &Repo, name: &str, v: &Variant, images: Option<&HfFile>, info: &Info) -> Value {
    // On disk the files live in `<owner>/<repo>/`; in the repo they may be in a folder.
    let file = |f: &HfFile| {
        let mut o = json!({ "path": format!("{}/{}", repo.id, f.path), "size": f.size, "sha256": f.sha256 });
        if f.path.contains('/') {
            o["name"] = f.path.clone().into();
        }
        o
    };
    let mut files: Vec<Value> = v.files.iter().map(file).collect();
    let mut entry = json!({
        "label": format!("{name} · {}", v.name), "quant": v.name, "kind": "Hugging Face", "origin": "hugging-face",
        "gguf": files[0]["path"], "repo": repo.id, "revision": repo.revision, "memory": info.memory_json(),
    });
    if let Some(c) = info.memory.ctx_max {
        entry["ctx"] = c.into();
    }
    if let Some(e) = images {
        let e = file(e);
        entry["mmproj"] = e["path"].clone();
        files.push(e);
    }
    entry["files"] = files.into();
    entry
}

/// «Qwen3-4B» from «Qwen/Qwen3-4B-GGUF».
fn repo_name(id: &str) -> String {
    let name = id.rsplit('/').next().unwrap_or(id);
    ["-GGUF", "_GGUF", "-gguf", "_gguf"].iter().find_map(|s| name.strip_suffix(s)).unwrap_or(name).to_string()
}

/// Lowercase letters, digits and hyphens: for keys.
fn slug(text: &str) -> String {
    let s: String = text.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

/// `model-00002-of-00003`: a piece of a split model.
fn is_piece(name: &str) -> bool {
    let digits = |s: &str| s.len() == 5 && s.bytes().all(|b| b.is_ascii_digit());
    name.rsplit_once("-of-").is_some_and(|(before, total)| digits(total) && before.rsplit_once('-').is_some_and(|(_, n)| digits(n)))
}

fn probe(template: &str, context: &serde_json::Value) -> Probe {
    // `raise_exception` is the function templates use to reject a conversation: if it is what fails, we know from the
    // message it received, and not from how the rendering ends.
    let rejection: Arc<Mutex<Option<String>>> = Arc::default();
    let mut env = Environment::new();
    env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
    let r = rejection.clone();
    env.add_function("raise_exception", move |message: String| -> Result<String, Error> {
        *r.lock().unwrap() = Some(message.clone());
        Err(Error::new(ErrorKind::InvalidOperation, message))
    });
    env.add_function("strftime_now", |_format: String| "2026-01-01".to_string());
    // minijinja's doesn't accept the parameters Hugging Face templates pass (`ensure_ascii`...).
    env.add_filter("tojson", |value: minijinja::Value, _params: Kwargs| -> Result<String, Error> {
        serde_json::to_string(&value).map_err(|e| Error::new(ErrorKind::InvalidOperation, e.to_string()))
    });
    match env.render_str(template, Serde(context)) {
        Ok(t) => Probe::Text(t),
        Err(e) => match rejection.lock().unwrap().take() {
            Some(m) => Probe::Rejects(m),
            None => Probe::Unverifiable(e.to_string().lines().next().unwrap_or_default().to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mango(name: &str) -> String {
        let f = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher/chat-templates").join(name);
        std::fs::read_to_string(&f).unwrap_or_else(|e| panic!("{}: {e}", f.display()))
    }

    /// A ChatML format that knows tools and rejects a system message that isn't the first, like the original
    /// Qwen3.5 template.
    const LIKE_QWEN: &str = r#"
{%- if tools %}<|im_start|>system
# Tools
{%- for tool in tools %}
{{ tool | tojson }}
{%- endfor %}<|im_end|>
{% endif -%}
{%- for m in messages %}
{%- if m.role == 'system' and not loop.first %}{{- raise_exception('System message must be at the beginning.') }}{%- endif %}
{%- if m.role == 'system' %}<|im_start|>system
{{ m.content }}<|im_end|>
{% elif m.role == 'user' %}<|im_start|>user
{{ m.content }}<|im_end|>
{% elif m.role == 'assistant' %}<|im_start|>assistant
{{ m.content }}
{%- for call in m.tool_calls or [] %}
<tool_call>{{ call.function.name }} {{ call.function.arguments | tojson }}</tool_call>
{%- endfor %}<|im_end|>
{% elif m.role == 'tool' %}<|im_start|>user
<tool_response>{{ m.content }}</tool_response><|im_end|>
{% endif %}
{%- endfor %}
{%- if add_generation_prompt %}<|im_start|>assistant
{% endif %}"#;

    /// Like `LIKE_QWEN`, but the system message in the middle renders.
    fn tolerant_like_qwen() -> String {
        LIKE_QWEN.replace("{{- raise_exception('System message must be at the beginning.') }}", "")
    }

    #[test]
    fn mango_codes_templates_hold_tools_and_system_in_the_middle() {
        for name in ["qwen3.5-mango.jinja", "qwen3.6-mango.jinja", "qwen3.8-mango.jinja", "bonsai2-mango.jinja"] {
            assert_eq!(check_template(Some(&mango(name))), [], "{name}");
        }
    }

    #[test]
    fn a_tolerant_template_passes() {
        assert_eq!(check_template(Some(&tolerant_like_qwen())), []);
    }

    #[test]
    fn a_template_that_rejects_system_in_the_middle_is_severe_and_says_what_it_answers() {
        let a = check_template(Some(LIKE_QWEN));
        assert_eq!(a.len(), 1, "{a:?}");
        assert!(a[0].severe);
        assert!(a[0].text.contains(&tr!("messaggio di sistema", "system message")) && a[0].text.contains("System message must be at the beginning."), "{}", a[0].text);
    }

    #[test]
    fn a_template_without_tools_cannot_call_them() {
        let chatml = "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}<|im_start|>assistant\n";
        let a = check_template(Some(chatml));
        assert!(a.iter().any(|v| v.severe && v.text.contains(&tr!("non sa chiamare gli strumenti", "can't call tools"))), "{a:?}");
    }

    #[test]
    fn a_template_that_does_not_write_the_calls_or_the_results_is_severe() {
        // lists the tools but ignores tool_calls and the `tool` messages
        let t = "{% if tools %}{% for t in tools %}{{ t | tojson }}{% endfor %}{% endif %}{% for m in messages if m.role in ['system','user'] %}{{ m.content }}{% endfor %}";
        let a = check_template(Some(t));
        assert!(a.iter().any(|v| v.severe && v.text.contains(&tr!("chiamate", "calls"))), "{a:?}");
        assert!(a.iter().any(|v| v.severe && v.text.contains(&tr!("risultati", "results"))), "{a:?}");
    }

    #[test]
    fn a_template_that_discards_system_in_the_middle_warns_without_being_severe() {
        let t = tolerant_like_qwen().replace("{%- if m.role == 'system' %}", "{%- if m.role == 'system' and loop.first %}");
        let a = check_template(Some(&t));
        assert_eq!(a.len(), 1, "{a:?}");
        assert!(!a[0].severe && a[0].text.contains(&tr!("promemoria", "reminders")), "{}", a[0].text);
    }

    #[test]
    fn without_a_template_in_the_file_the_model_cannot_use_tools() {
        let a = check_template(None);
        assert_eq!(a.len(), 1);
        assert!(a[0].severe && a[0].text.contains(&tr!("formato della conversazione", "conversation format")), "{}", a[0].text);
    }

    // --- the analysis of a model ------------------------------------------------------------------------------

    use crate::gguf::test_util;
    use crate::hardware::fixture::pc;
    use crate::fixtures::Fake;
    use mango_common::download::hugging_face::{HfFile, Repo};
    use std::path::{Path, PathBuf};

    const GIB: u64 = 1 << 30;

    /// A GGUF like Qwen3-4B: 36 layers, 8 KV heads, 90 KiB cache per token, 40960 tokens of context.
    fn write_gguf(dir: &Path, name: &str, template: Option<&str>) -> PathBuf {
        let p = dir.join(name);
        let ints = [("llama.block_count", 36), ("llama.context_length", 40960), ("llama.embedding_length", 2560), ("llama.attention.head_count", 32), ("llama.attention.head_count_kv", 8)];
        let tensors: Vec<(String, u64)> = (0..36).map(|i| (format!("blk.{i}.attn_k.weight"), 500)).collect();
        let t: Vec<(&str, u64)> = tensors.iter().map(|(n, b)| (n.as_str(), *b)).collect();
        let strings: Vec<(&str, &str)> = template.map(|t| ("tokenizer.chat_template", t)).into_iter().collect();
        test_util::write_with(&p, "llama", &ints, &strings, &[], &t);
        p
    }

    fn f(path: &str, gib: f64) -> HfFile {
        HfFile { path: path.into(), size: (gib * GIB as f64) as u64, sha256: "a".repeat(64) }
    }

    fn test_repo() -> Repo {
        Repo {
            id: "Qwen/Qwen3-4B-GGUF".into(),
            revision: "b".repeat(40),
            gated: false,
            files: vec![f("Qwen3-4B-BF16.gguf", 8.0), f("Qwen3-4B-Q4_K_M.gguf", 2.5), f("Qwen3-4B-Q8_0.gguf", 4.3), f("mmproj-F16.gguf", 0.8)],
        }
    }

    /// The start of the test repo's files: always the same GGUF.
    fn analyze_test(t: &Fake, hw: &crate::hardware::Hardware, repo: &Repo, gguf: &Path) -> Analysis {
        let data = std::fs::read(gguf).unwrap();
        analyze_repo(&t.paths, hw, repo, &|_, n| Ok(data[..n.min(data.len())].to_vec())).unwrap()
    }

    #[test]
    fn quantizations_split_between_those_that_fit_and_those_that_do_not() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(t.paths.models.as_path(), "example.gguf", Some(&tolerant_like_qwen()));
        let a = analyze_test(&t, &pc(vec![], 8192), &test_repo(), &g);

        assert_eq!(a.name, "Qwen3-4B");
        assert_eq!(a.source, "hugging-face");
        assert_eq!(a.variants.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["Q4_K_M", "Q8_0", "BF16"], "from the smallest");
        assert_eq!(a.variants.iter().map(|v| v.placement).collect::<Vec<_>>(), [Some(Placement::Cpu), None, None], "{:#?}", a.variants);
        assert_eq!(a.variants.iter().map(|v| v.recommended).collect::<Vec<_>>(), [true, false, false]);
        let q4 = &a.variants[0];
        assert!(q4.reason.contains(&tr!("nella RAM", "in RAM")), "{q4:?}");
        assert!(a.variants[2].reason.contains(&tr!("non ci sta", "doesn't fit")), "{}", a.variants[2].reason);
        assert_eq!(a.warnings, [], "the test template holds");
    }

    /// A user model only says whether it fits and where: on the card if weights and cache fit, otherwise on the
    /// processor if RAM is enough, never split between the two.
    #[test]
    fn a_user_model_says_where_it_runs() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(t.paths.models.as_path(), "example.gguf", None);
        let card = pc(vec![crate::hardware::fixture::nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6))], 32_768);
        let a = analyze_test(&t, &card, &test_repo(), &g);
        assert_eq!(a.variants.iter().map(|v| v.placement).collect::<Vec<_>>(), [Some(Placement::Gpu), Some(Placement::Gpu), Some(Placement::Cpu)], "{:#?}", a.variants);
        assert!(a.variants[2].reason.contains(&tr!("gira sul processore", "runs on the processor")), "{}", a.variants[2].reason);
    }

    #[test]
    fn the_entry_says_where_it_downloads_from_and_what_it_asks_of_memory() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let a = analyze_test(&t, &pc(vec![], 8192), &test_repo(), &g);
        let v = &a.variants[0].entry;

        assert_eq!(v["label"], "Qwen3-4B · Q4_K_M");
        assert_eq!(v["quant"], "Q4_K_M");
        assert_eq!(v["repo"], "Qwen/Qwen3-4B-GGUF");
        assert_eq!(v["revision"], "b".repeat(40));
        assert_eq!(v["gguf"], "Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf");
        assert_eq!(v["ctx"], 40960);
        assert_eq!(v["memory"], json!({ "kv_kib_token": 90, "state_mib": 0 }));
        assert_eq!(v["files"], json!([{ "path": "Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf", "size": (2.5 * GIB as f64) as u64, "sha256": "a".repeat(64) }]));
        assert!(v.get("mmproj").is_none());
        assert_eq!(a.variants[0].key, "hf-qwen-qwen3-4b-gguf-q4-k-m");
        assert_eq!(a.warnings.len(), 1, "without a template in the file");

        // with images the encoder is downloaded along and weighs in the memory
        let im = a.variants[0].with_images.as_ref().unwrap();
        assert_eq!(im.entry["mmproj"], "Qwen/Qwen3-4B-GGUF/mmproj-F16.gguf");
        assert_eq!(im.entry["files"].as_array().unwrap().len(), 2);
        assert_eq!(im.bytes, a.variants[0].bytes + (0.8 * GIB as f64) as u64);
    }

    #[test]
    fn a_link_that_names_a_quantization_or_a_file_proposes_it_instead_of_the_recommended_one() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let mut a = analyze_test(&t, &pc(vec![], 8192), &test_repo(), &g);
        let proposed = |a: &Analysis| a.variants.iter().filter(|v| v.recommended).map(|v| v.name.clone()).collect::<Vec<_>>();
        assert_eq!(proposed(&a), ["Q4_K_M"]);

        a.prefer(Some("q8_0"), None);
        assert_eq!(proposed(&a), ["Q8_0"], "even if it doesn't fit: the user asked for that one");
        a.prefer(None, Some("Qwen3-4B-BF16.gguf"));
        assert_eq!(proposed(&a), ["BF16"]);
        a.prefer(Some("Q9_9"), None);
        assert_eq!(proposed(&a), ["BF16"], "a quantization that isn't there changes nothing");
    }

    #[test]
    fn files_in_a_repo_folder_and_pieces_are_downloaded_from_their_path() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let mut repo = test_repo();
        repo.files = vec![f("Q4_K_M/m-Q4_K_M-00001-of-00002.gguf", 1.0), f("Q4_K_M/m-Q4_K_M-00002-of-00002.gguf", 1.0)];
        let a = analyze_test(&t, &pc(vec![], 8192), &repo, &g);
        let v = &a.variants[0].entry;
        assert_eq!(v["gguf"], "Qwen/Qwen3-4B-GGUF/Q4_K_M/m-Q4_K_M-00001-of-00002.gguf");
        assert_eq!(v["files"][1]["name"], "Q4_K_M/m-Q4_K_M-00002-of-00002.gguf");
        assert_eq!(a.variants[0].bytes, 2 * GIB);
    }

    #[test]
    fn an_added_model_appears_among_the_users_with_the_memory_verdict() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let hw = pc(vec![], 8192);
        let a = analyze_test(&t, &hw, &test_repo(), &g);
        let (key, entry) = (a.variants[0].key.clone(), a.variants[0].entry.clone());

        add(&t.paths, &key, entry).unwrap();

        let c = crate::recommended(&t.paths, &hw).unwrap();
        let mine = c.iter().find(|c| c.model == key).expect("the added model is in the list");
        assert_eq!((mine.origin, mine.placement), (crate::Origin::User, a.variants[0].placement), "the app and the analysis say the same: {mine:?}");
        assert!(!mine.fastest, "the fastest is chosen among the recommended ones");
        assert_eq!(mine.bytes, (2.5 * GIB as f64) as u64);
        let (entries, _) = crate::catalog::catalog_for(&t.paths, &hw).unwrap();
        assert!(!entries.iter().find(|v| v.key == key).unwrap().weights, "the weights aren't on disk yet");
    }

    #[test]
    fn a_gguf_on_the_computer_is_added_where_it_is_and_counts_as_present() {
        let t = Fake::small();
        t.save();
        let elsewhere = tempfile::tempdir().unwrap();
        let g = write_gguf(elsewhere.path(), "My Model.Q4_K_M.gguf", Some(&tolerant_like_qwen()));
        let hw = pc(vec![], 8192);

        let a = analyze_local(&t.paths, &hw, &g).unwrap();

        assert_eq!((a.source.as_str(), a.name.as_str()), ("local", "My Model.Q4_K_M"));
        let v = &a.variants[0];
        assert!(v.placement.is_some() && v.with_images.is_none() && v.key == "local-my-model-q4-k-m", "{v:?}");
        add(&t.paths, &v.key, v.entry.clone()).unwrap();
        let (entries, _) = crate::catalog::catalog_for(&t.paths, &hw).unwrap();
        let mine = entries.iter().find(|x| x.key == v.key).unwrap();
        assert!(mine.weights && mine.missing.is_none(), "{mine:?}");
    }

    #[test]
    fn a_file_that_is_not_a_gguf_or_is_a_piece_is_refused_saying_why() {
        let t = Fake::small();
        t.save();
        let hw = pc(vec![], 8192);
        let d = tempfile::tempdir().unwrap();
        let no = d.path().join("no.gguf");
        std::fs::write(&no, b"nothing to see here, really nothing").unwrap();
        let e = analyze_local(&t.paths, &hw, &no).unwrap_err().to_string();
        assert!(e.contains("no.gguf") && e.contains("GGUF"), "{e}");

        let piece = write_gguf(d.path(), "m-00002-of-00003.gguf", None);
        let e = analyze_local(&t.paths, &hw, &piece).unwrap_err().to_string();
        assert!(e.contains(&tr!("diviso", "split")) && e.contains("Hugging Face"), "{e}");

        let e = analyze_local(&t.paths, &hw, &d.path().join("missing.gguf")).unwrap_err().to_string();
        assert!(e.contains("missing.gguf"), "{e}");
    }

    #[test]
    fn a_repo_without_ggufs_or_a_wrong_entry_are_clear_errors() {
        let t = Fake::small();
        t.save();
        let mut repo = test_repo();
        repo.files.clear();
        let e = analyze_repo(&t.paths, &pc(vec![], 8192), &repo, &|_, _| unreachable!()).unwrap_err().to_string();
        assert!(e.contains("Qwen/Qwen3-4B-GGUF") && e.contains("GGUF"), "{e}");

        let e = add(&t.paths, "hf-x", json!({ "gguf": "x.gguf" })).unwrap_err().to_string();
        assert!(e.contains("hf-x") && e.contains("label"), "{e}");
        assert!(!t.paths.data.join("user-models.json").exists());
    }

    #[test]
    fn a_start_too_short_for_the_header_is_reread_with_more_bytes() {
        let d = tempfile::tempdir().unwrap();
        let g = write_gguf(d.path(), "example.gguf", Some("{{ messages }}"));
        let data = std::fs::read(&g).unwrap();
        let file = HfFile { path: "m.gguf".into(), size: data.len() as u64, sha256: "a".repeat(64) };
        let requests = std::cell::RefCell::new(Vec::new());
        let start = |_: &HfFile, n: usize| {
            requests.borrow_mut().push(n);
            Ok(data[..n.min(data.len())].to_vec())
        };

        let h = remote_header(&file, &start, &[100, 200, 1 << 20]).unwrap();

        assert_eq!(*requests.borrow(), [100, 200, 1 << 20], "each round asks for more until the header is all there");
        assert_eq!(h.strings["tokenizer.chat_template"], "{{ messages }}");

        // a file that ends before the bytes asked for is a broken file: no insisting
        let e = remote_header(&file, &|_: &HfFile, _: usize| Ok(data[..100].to_vec()), &[1 << 20]).unwrap_err().to_string();
        assert!(e.contains("m.gguf") && e.contains("GGUF"), "{e}");
    }

    /// By hand: `cargo test -p engine-cfg --lib other_models::tests::with_real_hugging_face -- --ignored --nocapture`
    #[test]
    #[ignore = "uses the network: real search, file list and header on Hugging Face"]
    fn with_real_hugging_face_a_small_model_is_analyzed() {
        let search = std::env::var("MANGO_TEST_SEARCH").unwrap_or_else(|_| "Qwen3.5-4B".into());
        let results = hugging_face::search(&search).unwrap();
        println!("{results:#?}");
        let id = std::env::var("MANGO_TEST_REPO").unwrap_or_else(|_| results[0].id.clone());
        let repo = hugging_face::repo(&id, None).unwrap();
        let t = Fake::small();
        t.save();
        let a = analyze_hugging_face(&t.paths, &pc(vec![], 16_384), &repo).unwrap();
        println!("{} (gated: {}) {:#?}", a.name, a.gated, a.warnings);
        for v in &a.variants {
            println!("{:>12}  {:>6.2} GB  where={:?}  recommended={}  images={}", v.name, v.bytes as f64 / GIB as f64, v.placement, v.recommended, v.with_images.is_some());
        }
        println!("memory: {} ctx: {}", a.variants[0].entry["memory"], a.variants[0].entry["ctx"]);
        assert!(!a.variants.is_empty());
    }

    #[test]
    fn a_template_that_cannot_be_tested_gives_no_verdict() {
        let a = check_template(Some("{% if %}broken"));
        assert!(a.len() == 1 && !a[0].severe && a[0].text.contains(&tr!("Non sono riuscito", "I couldn't check")) && a[0].text.contains("syntax error"), "{a:?}");
    }
}
