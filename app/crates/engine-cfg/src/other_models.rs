//! «Other models»: a GGUF chosen by the user (on Hugging Face or on the computer) becomes an entry of
//! `user-models.json`. Here lives what the app says before adding it: whether it fits in the PC's memory (the same
//! estimate as the recommended models, `general.rs`) and whether the model's conversation format holds up to what
//! Mango Code sends it (tools and a system message in the middle of the conversation).

use crate::catalog::{load_models, ModelCfg, ModelsFile, Origin};
use crate::choices::Scope;
use crate::general::{evaluate, Placement, AUTO_CTX};
use crate::speed::{cpu_speed, Speed};
use crate::gguf::{ends_too_early, model_memory, not_gguf, parse_header, parse_piece, read_header, GgufHeader, GgufMemory};
use crate::hardware::{choose_build, Hardware};
use crate::split::MIN_CTX;
use crate::user;
use anyhow::{bail, Result};
use mango_common::download::hugging_face::{self, image_encoder, is_encoder, piece, variants, HfFile, Reference, Repo, Variant};
use mango_common::{tr, Paths};
use minijinja::value::{Kwargs, Serde};
use minijinja::{Environment, Error, ErrorKind};
use serde::Serialize;
use serde_json::{json, Value};
use std::ops::Range;
use std::path::{Path, PathBuf};
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
    /// Mango Code doesn't know this kind of model yet: the memory of every quantization is estimated from the size of
    /// its files, with a small context, and a warning says so.
    pub estimated: bool,
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
    /// The context it would run with; `None` if it doesn't fit.
    pub context: Option<u32>,
    /// The cards it would take, by name; none on the processor or if it doesn't fit.
    pub gpus: Vec<String>,
    /// How fast it would write, if it runs on the processor. The model is taken as dense: all its weights are read for each
    /// token, so a MoE from outside the catalog is said slower than it is.
    pub speed: Option<Speed>,
    pub reason: String,
    /// The one to propose (`recommend`): on the cards the largest that fits with 64,000 tokens of context, never F16,
    /// BF16 or F32; on the processor Q4_K_M or the nearest below it that fits.
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
    /// The context it would run with: the encoder takes memory, so it can be smaller than without images.
    pub context: Option<u32>,
    pub gpus: Vec<String>,
    pub speed: Option<Speed>,
    pub reason: String,
    pub entry: Value,
}

/// What of a GGUF's header a user model needs.
struct Info {
    memory: GgufMemory,
    template: Option<String>,
}

impl Info {
    fn from_header(h: &GgufHeader) -> Info {
        Info { memory: model_memory(h), template: h.strings.get("tokenizer.chat_template").cloned() }
    }

    /// The entry's `memory`; an estimate keeps what the header lacked, for whoever reads the file.
    fn memory_json(&self) -> Value {
        let mut m = json!({ "kv_kib_token": self.memory.kv_kib_token, "state_mib": self.memory.state_mib });
        if let Some(missing) = &self.memory.estimated {
            m["estimated"] = missing.as_str().into();
        }
        m
    }

    /// The context the entry gives the model: its own or, with an estimated memory, the smallest the agent works with.
    fn ctx(&self) -> Option<u32> {
        match self.memory.estimated {
            Some(_) => Some(self.memory.ctx_max.map_or(MIN_CTX, |c| c.min(MIN_CTX))),
            None => self.memory.ctx_max,
        }
    }

    /// What to know before adding it: that the memory is estimated, if it is, and how the conversation format holds.
    fn warnings(&self) -> Vec<Warning> {
        let estimate = self.memory.estimated.as_ref().map(|_| {
            caution(tr!(
                "Non conosco ancora questo tipo di modello: la memoria è stimata dal peso del file, con un margine prudente e un contesto piccolo.",
                "I don't know this kind of model yet: its memory is estimated from the file's size, with a safe margin and a small context."
            ))
        });
        estimate.into_iter().chain(check_template(self.template.as_deref())).collect()
    }
}

/// A model of Mango Code's catalog, already tuned: a link to its repo leads to it instead of an analysis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tested {
    pub key: String,
    pub label: String,
}

/// The catalog's model whose repo the link names, if any. Only a link to the repo itself: one that names a quantization,
/// a file or a branch asks for something the catalog doesn't have, and is analyzed. A repo the catalog takes only a
/// file from (the image encoder of another model) is a repo like any other. Hugging Face takes a name in any case; the
/// user's models don't count.
pub fn tested(paths: &Paths, link: &Reference) -> Result<Option<Tested>> {
    if link.quant.is_some() || link.path.is_some() || link.revision.is_some() {
        return Ok(None);
    }
    let catalog = load_models(paths)?;
    let found = catalog
        .local()
        .filter(|k| catalog.origin(k) == Origin::Recommended)
        .filter_map(|k| Some((k, catalog.models.get(k)?)))
        .find(|(_, m)| m["repo"].as_str().is_some_and(|r| r.eq_ignore_ascii_case(&link.repo)));
    Ok(found.map(|(key, m)| Tested { key: key.to_string(), label: m["label"].as_str().unwrap_or(key).to_string() }))
}

/// How much to read from the start of a remote file to get the header, by attempts: the first almost always is enough.
const STEPS: [usize; 3] = [8 << 20, 32 << 20, 128 << 20];
/// The same for a piece after the first of a split model, which has only its tensor table: a few KiB.
const PIECE_STEPS: [usize; 4] = [256 << 10, 8 << 20, 32 << 20, 128 << 20];
/// The most the headers of a link may take to arrive, all together: beyond it the analysis stops and says so.
const LINK_TIME: std::time::Duration = std::time::Duration::from_secs(120);

/// Analyzes the GGUF files of a Hugging Face repo: reads the start of a single file (the model's structure is the
/// same in every quantization) and gives the verdict for each.
pub fn analyze_hugging_face(paths: &Paths, hw: &Hardware, repo: &Repo) -> Result<Analysis> {
    let deadline = std::time::Instant::now() + LINK_TIME;
    analyze_repo(paths, hw, repo, &|file, bytes| hugging_face::file_part(repo, file, bytes, deadline))
}

fn analyze_repo(paths: &Paths, hw: &Hardware, repo: &Repo, start: &dyn Fn(&HfFile, Range<usize>) -> Result<Vec<u8>>) -> Result<Analysis> {
    let quantizations = variants(repo);
    // A whole file asks for one header; a split model for one per piece, as each piece has only its own tensors.
    let Some(sample) = quantizations.iter().find(|v| v.files.len() == 1).or(quantizations.first()) else {
        bail!(
            "{}",
            tr!(
                "In «{}» non ci sono file GGUF: Mango Code usa solo i modelli in formato GGUF. Spesso ce n'è una versione GGUF in un altro repo, col nome che finisce in -GGUF: cercala per nome.",
                "There are no GGUF files in «{}»: Mango Code only uses models in GGUF format. There is often a GGUF version in another repo, with a name ending in -GGUF: search for it by name.",
                repo.id
            )
        );
    };
    let mut header = remote_header(paths, &sample.files[0], start, &STEPS, true)?;
    for f in &sample.files[1..] {
        header.add_piece(remote_header(paths, f, start, &PIECE_STEPS, false)?);
    }
    let info = Info::from_header(&header);
    let encoder = image_encoder(&repo.files);
    let catalog = load_models(paths)?;
    let scope = crate::choices::read(paths)?.computer_scope();
    let name = repo_name(&repo.id);

    let mut proposals = Vec::new();
    for v in &quantizations {
        let key = format!("hf-{}-{}", slug(&repo.id), slug(&v.name));
        let entry = hf_entry(repo, &name, v, None, &info);
        let (placement, context, gpus, reason) = verdict(&catalog, hw, &scope, &entry)?;
        let with_images = match &encoder {
            None => None,
            Some(e) => {
                let entry = hf_entry(repo, &name, v, Some(e), &info);
                let (placement, context, gpus, reason) = verdict(&catalog, hw, &scope, &entry)?;
                Some(WithImages { bytes: v.bytes() + e.size, placement, context, gpus, speed: speed_on(placement, v.bytes()), reason, entry })
            }
        };
        proposals.push(Proposal { name: v.name.clone(), key, bytes: v.bytes(), placement, context, gpus, speed: speed_on(placement, v.bytes()), reason, recommended: false, entry, with_images });
    }
    recommend(&mut proposals);
    Ok(Analysis { name, source: "hugging-face".into(), gated: repo.gated, estimated: info.memory.estimated.is_some(), variants: proposals, warnings: info.warnings() })
}

/// Marks the quantization to propose. On the cards: the largest that fits with the context «Automatico» wants
/// (`AUTO_CTX`, or the model's own if smaller), otherwise the largest that fits; never F16, BF16 or F32, which are for
/// whoever chooses them. If none fits there, on the processor speed counts more than quality: Q4_K_M, or the nearest
/// below it that fits (by size, or, without a Q4_K_M, by the bits in the name); if none is below, the smallest that
/// fits. They come from the smallest.
fn recommend(proposals: &mut [Proposal]) {
    let fits = |p: &Proposal, place| p.placement == Some(place);
    let on_cards = |p: &Proposal| fits(p, Placement::Gpu) && !is_float(&p.name);
    let roomy = |p: &Proposal| {
        let target = p.entry["ctx"].as_u64().and_then(|c| u32::try_from(c).ok()).unwrap_or(u32::MAX);
        p.context.is_some_and(|c| c >= AUTO_CTX.min(target))
    };
    let chosen = if proposals.iter().any(on_cards) {
        proposals.iter().rposition(|p| on_cards(p) && roomy(p)).or_else(|| proposals.iter().rposition(on_cards))
    } else {
        let q4 = proposals.iter().find(|p| p.name.eq_ignore_ascii_case("Q4_K_M")).map(|p| p.bytes);
        let at_most_q4 = |p: &Proposal| q4.map_or_else(|| four_bits_or_less(&p.name), |bytes| p.bytes <= bytes);
        proposals.iter().rposition(|p| fits(p, Placement::Cpu) && at_most_q4(p)).or_else(|| proposals.iter().position(|p| fits(p, Placement::Cpu)))
    };
    // Only F16, BF16 or F32 fit on the cards and nothing on the processor: the smallest of them.
    if let Some(i) = chosen.or_else(|| proposals.iter().position(|p| p.placement.is_some())) {
        proposals[i].recommended = true;
    }
}

/// F16, BF16, F32: the weights as they were trained, not quantized.
fn is_float(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(upper.strip_prefix("UD-").unwrap_or(&upper), "F16" | "BF16" | "F32")
}

/// «Q4_K_S», «IQ3_M», «UD-Q2_K_XL», «MXFP4»: a quantization of 4 bits a weight or fewer.
fn four_bits_or_less(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let n = upper.strip_prefix("UD-").unwrap_or(&upper);
    n == "MXFP4" || ["IQ", "TQ", "Q"].iter().find_map(|p| n.strip_prefix(p)).and_then(|r| r.chars().next()?.to_digit(10)).is_some_and(|bits| bits <= 4)
}

/// The header of a remote GGUF: the start of the file is requested, longer each time until the header is all there; each
/// time only the bytes after those already here. `whole`: the file is a model or its first piece; otherwise a later
/// piece, which has only its tensors.
fn remote_header(paths: &Paths, file: &HfFile, start: &dyn Fn(&HfFile, Range<usize>) -> Result<Vec<u8>>, steps: &[usize], whole: bool) -> Result<GgufHeader> {
    let mut data = Vec::new();
    for &bytes in steps {
        let asked = data.len()..bytes;
        let part = start(file, asked.clone())?;
        // If the bytes received are those asked for, the header may go on beyond; if fewer, the file is over.
        let all_there = part.len() == asked.len();
        data.extend(part);
        let read = std::io::Cursor::new(&data);
        match if whole { parse_header(read, file.size) } else { parse_piece(read, file.size) } {
            Ok(h) => return Ok(h),
            Err(e) if ends_too_early(&e) && all_there => continue,
            Err(e) => return Err(unreadable(&file.path, e)),
        }
    }
    let largest = steps.last().copied().unwrap_or(0);
    mango_common::startup_log(paths, &format!("other models: the header of {} goes beyond {largest} bytes: not read", file.path));
    bail!("{}", tr!("Questo file è fatto in un modo che non riesco a leggere: «{}».", "This file is made in a way I can't read: «{}».", file.path))
}

/// A file whose header can't be read: not a GGUF at all, or a damaged one.
fn unreadable(name: &str, e: anyhow::Error) -> anyhow::Error {
    let phrase = if not_gguf(&e) {
        tr!("«{name}» non è un file GGUF: Mango Code usa solo i modelli in formato GGUF.", "«{name}» is not a GGUF file: Mango Code only uses models in GGUF format.")
    } else {
        tr!("«{name}» è rovinato o incompleto: non riesco a leggere com'è fatto il modello.", "«{name}» is damaged or incomplete: I can't read how the model is made.")
    };
    user(&phrase, format!("{e:#}"))
}

/// Analyzes a GGUF that is already on the computer, wherever it is: it stays there, the user's list remembers its path.
/// A piece of a split model brings all its pieces, which must be next to it; an image encoder next to it
/// (`mmproj*.gguf`) is offered as the version with images.
pub fn analyze_local(paths: &Paths, hw: &Hardware, path: &Path) -> Result<Analysis> {
    let pieces = local_pieces(path)?;
    let (mut header, size) = read_local(&pieces[0], true)?;
    let mut sizes = vec![size];
    for p in &pieces[1..] {
        let (h, size) = read_local(p, false)?;
        header.add_piece(h);
        sizes.push(size);
    }
    let file_name = shown_name(path);
    if header.arch == "clip" {
        bail!(
            "{}",
            tr!(
                "«{file_name}» è il file che legge le immagini, non il modello: scegli il file del modello.",
                "«{file_name}» is the file that reads images, not the model: choose the model's file."
            )
        );
    }
    let info = Info::from_header(&header);
    let first = shown_name(&pieces[0]);
    let name = piece(&first).map_or_else(|| first.strip_suffix(".gguf").unwrap_or(&first).to_string(), |(base, _, _)| base.to_string());
    let bytes: u64 = sizes.iter().sum();
    let key = format!("local-{}", slug(&name));
    let entry = |encoder: Option<&HfFile>| {
        let mut files: Vec<Value> = pieces.iter().zip(&sizes).map(|(p, size)| json!({ "path": p.display().to_string(), "size": size })).collect();
        let mut entry = json!({ "label": name, "kind": "File on this computer", "gguf": pieces[0].display().to_string(), "origin": "local", "memory": info.memory_json() });
        if let Some(c) = info.ctx() {
            entry["ctx"] = c.into();
        }
        if let Some(e) = encoder {
            entry["mmproj"] = e.path.as_str().into();
            files.push(json!({ "path": e.path, "size": e.size }));
        }
        entry["files"] = files.into();
        entry
    };
    let (catalog, scope) = (load_models(paths)?, crate::choices::read(paths)?.computer_scope());
    let with_images = match local_encoder(paths, &pieces, &header) {
        None => None,
        Some(e) => {
            let entry = entry(Some(&e));
            let (placement, context, gpus, reason) = verdict(&catalog, hw, &scope, &entry)?;
            Some(WithImages { bytes: bytes + e.size, placement, context, gpus, speed: speed_on(placement, bytes), reason, entry })
        }
    };
    let entry = entry(None);
    let (placement, context, gpus, reason) = verdict(&catalog, hw, &scope, &entry)?;
    let proposal = Proposal { name: name.clone(), key, bytes, placement, context, gpus, speed: speed_on(placement, bytes), reason, recommended: true, entry, with_images };
    Ok(Analysis { name, source: "local".into(), gated: false, estimated: info.memory.estimated.is_some(), variants: vec![proposal], warnings: info.warnings() })
}

/// The name of a file, as the user sees it.
fn shown_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// The files of the model `path` belongs to: itself, or all the pieces of the split model in order, which must be in the
/// same folder.
fn local_pieces(path: &Path) -> Result<Vec<PathBuf>> {
    let file_name = shown_name(path);
    let Some((base, _, total)) = piece(&file_name) else { return Ok(vec![path.to_path_buf()]) };
    let dir = path.parent().unwrap_or(Path::new(""));
    let pieces: Vec<PathBuf> = (1..=total).map(|n| dir.join(format!("{base}-{n:05}-of-{total:05}.gguf"))).collect();
    let missing: Vec<String> = pieces.iter().filter(|p| !p.is_file()).map(|p| shown_name(p)).collect();
    if !missing.is_empty() {
        bail!(
            "{}",
            tr!(
                "«{file_name}» è un pezzo di un modello diviso in {total} file, e nella stessa cartella mancano {}. Metti tutti i pezzi insieme e riprova.",
                "«{file_name}» is a piece of a model split into {total} files, and {} are missing from the same folder. Put all the pieces together and try again.",
                missing.join(", ")
            )
        );
    }
    Ok(pieces)
}

/// The header of a file on the computer and its size. `whole`: a model or its first piece; otherwise a later piece.
fn read_local(path: &Path, whole: bool) -> Result<(GgufHeader, u64)> {
    let name = shown_name(path);
    let file = std::fs::File::open(path).map_err(|e| user(&tr!("Non riesco ad aprire il file «{name}».", "I can't open the file «{name}»."), format!("{}: {e}", path.display())))?;
    let size = file.metadata().map_err(|e| user(&tr!("Non riesco a leggere il file «{name}».", "I can't read the file «{name}»."), e))?.len();
    let read = std::io::BufReader::new(file);
    let header = if whole { parse_header(read, size) } else { parse_piece(read, size) };
    Ok((header.map_err(|e| unreadable(&name, e))?, size))
}

/// The image encoder next to the model's files, if there is one: a `*mmproj*.gguf` that really is one (architecture
/// `clip`) and is shown to be made for this model (`made_for`: another model's would break the engine), F16 if there are
/// several. One that isn't shown to match is left out and the log says why. A folder that can't be listed has none.
fn local_encoder(paths: &Paths, pieces: &[PathBuf], model: &GgufHeader) -> Option<HfFile> {
    let dir = pieces[0].parent()?;
    let model_file = shown_name(&pieces[0]);
    let encoders: Vec<HfFile> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| {
            let e = e.ok()?;
            let f = HfFile { path: e.path().display().to_string(), size: e.metadata().ok()?.len(), sha256: String::new() };
            if !is_encoder(&f) || !f.path.to_ascii_lowercase().ends_with(".gguf") {
                return None;
            }
            let encoder = read_header(&e.path()).ok().filter(|h| h.arch == "clip")?;
            let encoder_file = shown_name(&e.path());
            match made_for(&encoder, &encoder_file, model, &model_file) {
                Ok(()) => Some(f),
                Err(why) => {
                    mango_common::startup_log(paths, &format!("other models: {encoder_file} next to {model_file} not offered for images: {why}"));
                    None
                }
            }
        })
        .collect();
    image_encoder(&encoders)
}

/// Whether an image encoder is shown to be made for the model: as wide (its `clip.vision.projection_dim` is the model's
/// `embedding_length`) and of the same family, which the width alone doesn't prove: the same `general.basename` or
/// `general.name`, or a file named after the model's (`named_after`). `Err`: why not, for the log.
fn made_for(encoder: &GgufHeader, encoder_file: &str, model: &GgufHeader, model_file: &str) -> std::result::Result<(), String> {
    let projection = encoder.ints.get("clip.vision.projection_dim").copied();
    let width = model.ints.get(&format!("{}.embedding_length", model.arch)).copied();
    if projection.is_none() || projection != width {
        return Err(format!("its projection is {projection:?}, the model's width {width:?}"));
    }
    let same = |k: &str| encoder.strings.get(k).filter(|v| !v.is_empty()).is_some_and(|v| model.strings.get(k) == Some(v));
    if same("general.basename") || same("general.name") || named_after(encoder_file, model_file) {
        return Ok(());
    }
    Err("as wide as the model, but nothing shows it is made for it: name, basename and file name differ".into())
}

/// The encoder's file is named after the model's: without «mmproj» and its quantization, its name is the start of the
/// model's file name (`mmproj-Qwen3.8-27B-Uncensored-f16` and `Qwen3.8-27B-Uncensored-IQ4_XS`,
/// `Ternary-Bonsai-2-27B-mmproj-Q8_0` and `Ternary-Bonsai-2-27B-Q2_0`). A generic name (`mmproj-F16`) says nothing.
fn named_after(encoder_file: &str, model_file: &str) -> bool {
    let encoder = encoder_file.to_ascii_lowercase().replace("mmproj", "");
    let mut parts: Vec<&str> = encoder.strip_suffix(".gguf").unwrap_or(&encoder).split('-').filter(|p| !p.is_empty()).collect();
    if parts.last().is_some_and(|q| hugging_face::is_quantization(q)) {
        parts.pop();
    }
    let name = parts.join("-");
    let model = model_file.to_ascii_lowercase();
    !name.is_empty() && model.strip_prefix(&name).is_some_and(|rest| rest == ".gguf" || rest.starts_with(['-', '_']))
}

/// Adds the model to the user's list (`user-models.json`), with the key it got from the analysis.
pub fn add(paths: &Paths, key: &str, entry: Value) -> Result<()> {
    let not_valid = || tr!("Il modello «{key}» non è valido.", "The model «{key}» is not valid.");
    let cfg: ModelCfg = serde_json::from_value(entry.clone()).map_err(|e| user(&not_valid(), e))?;
    let Some(memory) = cfg.memory.filter(|_| !cfg.files.is_empty()) else {
        bail!("{}", user(&not_valid(), "the files or the memory it asks for are missing"));
    };
    mango_common::catalog::add_user(paths, key, entry)?;
    let line = match memory.estimated {
        Some(missing) => format!("other models: {key} added, its memory is estimated: {missing}"),
        None => format!("other models: {key} added"),
    };
    mango_common::startup_log(paths, &line);
    Ok(())
}

/// The band of a model of `weights` bytes, if it runs on the processor.
fn speed_on(placement: Option<Placement>, weights: u64) -> Option<Speed> {
    (placement == Some(Placement::Cpu)).then(|| cpu_speed(weights))
}

/// Whether the model `entry` fits `hw` (without the cards the user leaves out, which `scope` names), where, with what
/// context, on which cards, and why.
fn verdict(catalog: &ModelsFile, hw: &Hardware, scope: &Scope, entry: &Value) -> Result<(Option<Placement>, Option<u32>, Vec<String>, String)> {
    let cfg: ModelCfg = serde_json::from_value(entry.clone()).map_err(|e| user(&tr!("Non riesco a descrivere il modello.", "I can't describe the model."), e))?;
    let located = evaluate(catalog, &cfg, hw, choose_build(hw), scope, &[]);
    let gpus = located.fit.as_ref().map(|f| f.gpus.iter().map(|g| g.name.clone()).collect()).unwrap_or_default();
    Ok((located.fit.as_ref().map(|f| f.placement), located.fit.map(|f| f.ctx), gpus, located.reason))
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
    if let Some(c) = info.ctx() {
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

    /// A hybrid of 4 layers like Qwen3.5 (attention and DeltaNet): with layers 0 and 2 recurrent, 8 KiB of cache per
    /// token and 7 MiB of state.
    const HYBRID: [(&str, u32); 9] = [
        ("qwen35.block_count", 4),
        ("qwen35.context_length", 65536),
        ("qwen35.attention.head_count_kv", 4),
        ("qwen35.attention.key_length", 256),
        ("qwen35.attention.value_length", 256),
        ("qwen35.ssm.state_size", 128),
        ("qwen35.ssm.inner_size", 6144),
        ("qwen35.ssm.conv_kernel", 4),
        ("qwen35.ssm.group_count", 16),
    ];

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

    /// The bytes `r` of `data`, as far as it goes: what a server sends for a range.
    fn part(data: &[u8], r: Range<usize>) -> Vec<u8> {
        data[r.start.min(data.len())..r.end.min(data.len())].to_vec()
    }

    /// The start of the test repo's files: always the same GGUF.
    fn analyze_test(t: &Fake, hw: &crate::hardware::Hardware, repo: &Repo, gguf: &Path) -> Analysis {
        let data = std::fs::read(gguf).unwrap();
        analyze_repo(&t.paths, hw, repo, &|_, r| Ok(part(&data, r))).unwrap()
    }

    /// The encoder takes memory: with images the context is its own, smaller where the memory is tight.
    #[test]
    fn with_images_the_context_is_the_one_with_the_encoder() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let a = analyze_test(&t, &pc(vec![], 9728), &test_repo(), &g);
        let v = &a.variants[0];
        assert_eq!((v.context, v.with_images.as_ref().unwrap().context), (Some(40960), Some(32768)));
        let a = analyze_test(&t, &pc(vec![], 9216), &test_repo(), &g);
        let im = a.variants[0].with_images.as_ref().unwrap();
        assert_eq!((im.placement, im.context), (None, None), "with images it does not fit");
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
        // on the processor it says how fast it writes (a model from outside the catalog is taken as dense); where it fits nowhere, nothing
        assert_eq!(a.variants.iter().map(|v| v.speed.is_some()).collect::<Vec<_>>(), [true, false, false], "{:#?}", a.variants);
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
        let cards: Vec<_> = a.variants.iter().map(|v| v.gpus.len()).collect();
        assert_eq!(cards, [1, 1, 0], "the cards it takes, none on the processor");

        // the largest takes both cards: the line says how many, so its context does not look random
        let nvidia = |i, name| crate::hardware::fixture::nvidia(i, name, 8192, (8, 6), (12, 6));
        let two = pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060 Ti"), nvidia(1, "NVIDIA GeForce RTX 3070")], 32_768);
        let a = analyze_test(&t, &two, &test_repo(), &g);
        assert_eq!(a.variants[0].gpus, ["NVIDIA GeForce RTX 3060 Ti"]);
        assert_eq!(a.variants[2].gpus, ["NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce RTX 3070"], "{:#?}", a.variants[2]);
        assert_eq!(a.variants[0].with_images.as_ref().unwrap().gpus, ["NVIDIA GeForce RTX 3060 Ti"]);
    }

    /// On the cards the largest quantization that fits is proposed (the one larger still, only on the processor, would
    /// be slower). On the processor speed counts more: Q4_K_M even when larger ones fit, or without it the nearest
    /// below, or without any below the smallest.
    #[test]
    fn the_largest_quantization_is_proposed_on_the_cards_and_q4_k_m_on_the_processor() {
        let t = Fake::small();
        t.save();
        let g = write_gguf(&t.paths.models, "example.gguf", None);
        let proposed = |hw: &Hardware, files: Vec<HfFile>| {
            let repo = Repo { files, ..test_repo() };
            analyze_test(&t, hw, &repo, &g).variants.iter().filter(|v| v.recommended).map(|v| v.name.clone()).collect::<Vec<_>>()
        };
        let card = pc(vec![crate::hardware::fixture::nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6), (12, 6))], 32_768);
        let (cpu, small) = (pc(vec![], 32_768), pc(vec![], 1024));
        let contexts: Vec<_> = analyze_test(&t, &card, &test_repo(), &g).variants.iter().map(|v| v.context).collect();
        // the test model holds 40,960 tokens, less than 64,000: that is the context «Automatico» wants of it
        assert_eq!(contexts, [Some(40_960), Some(32_768), Some(40_960)]);
        assert_eq!(proposed(&card, test_repo().files), ["Q4_K_M"], "Q8_0 fits the 8 GB card too, but with less context");
        let big = pc(vec![crate::hardware::fixture::nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (12, 6))], 32_768);
        assert_eq!(proposed(&big, test_repo().files), ["Q8_0"], "BF16 fits the card too, but is never proposed");
        assert_eq!(proposed(&cpu, test_repo().files), ["Q4_K_M"], "Q8_0 and BF16 fit too, but are slower");
        let without_q4 = || vec![f("m-IQ3_M.gguf", 1.8), f("m-Q4_K_S.gguf", 2.3), f("m-Q5_K_M.gguf", 2.9), f("m-Q8_0.gguf", 4.3)];
        assert_eq!(proposed(&cpu, without_q4()), ["Q4_K_S"], "the nearest below Q4_K_M");
        // 7,800 MiB of RAM: 4,096 stay to Windows; IQ3_M (1,843 MiB) with its cache at 32k (1,530) fits, Q4_K_M (2,560) doesn't
        let with_q4 = vec![f("m-IQ3_M.gguf", 1.8), f("m-Q4_K_M.gguf", 2.5), f("m-Q8_0.gguf", 4.3)];
        assert_eq!(proposed(&pc(vec![], 7_800), with_q4), ["IQ3_M"], "Q4_K_M doesn't fit: the nearest below");
        assert_eq!(proposed(&cpu, vec![f("m-Q8_0.gguf", 4.3), f("m-BF16.gguf", 8.0)]), ["Q8_0"], "none below: the smallest");
        assert_eq!(proposed(&small, test_repo().files), Vec::<String>::new(), "none fits: none proposed");
    }

    /// On the cards: the largest that keeps the context «Automatico» wants (64,000, or the model's own if smaller);
    /// if none keeps it, the largest; never F16, BF16 or F32 unless only those fit.
    #[test]
    fn on_the_cards_the_largest_with_the_automatic_context_is_proposed_never_unquantized() {
        let p = |name: &str, gib: u64, context: Option<u32>, ctx: u32| Proposal {
            name: name.into(),
            key: name.into(),
            bytes: gib * GIB,
            placement: context.map(|_| Placement::Gpu),
            context,
            gpus: Vec::new(),
            speed: None,
            reason: String::new(),
            recommended: false,
            entry: json!({ "ctx": ctx }),
            with_images: None,
        };
        let proposed = |mut v: Vec<Proposal>| {
            recommend(&mut v);
            v.iter().filter(|p| p.recommended).map(|p| p.name.clone()).collect::<Vec<_>>()
        };
        let full = 131_072;
        assert_eq!(proposed(vec![p("Q4_K_M", 3, Some(131_072), full), p("Q6_K", 4, Some(65_536), full), p("Q8_0", 5, Some(40_960), full)]), ["Q6_K"]);
        assert_eq!(proposed(vec![p("Q4_K_M", 3, Some(49_152), full), p("Q8_0", 5, Some(36_864), full)]), ["Q8_0"], "none keeps 64,000: the largest");
        assert_eq!(proposed(vec![p("Q4_K_M", 3, Some(full), full), p("Q8_0", 5, Some(full), full), p("BF16", 9, Some(full), full), p("F32", 18, Some(full), full)]), ["Q8_0"]);
        assert_eq!(proposed(vec![p("BF16", 9, Some(full), full), p("F32", 18, None, full)]), ["BF16"], "only an unquantized one fits");
        assert_eq!(proposed(vec![p("Q4_K_M", 3, Some(32_768), 32_768), p("Q8_0", 5, Some(32_768), 32_768)]), ["Q8_0"], "an estimated model wants 32,768");
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

    /// A link to a repo of the catalog leads to its model, by the model's repo and not by the name. A repo the catalog
    /// takes only a file from, a link to a quantization, a file or a branch, and a user's model are analyzed instead.
    #[test]
    fn a_link_to_a_repo_of_the_catalog_leads_to_its_tested_model() {
        let mut t = Fake::small();
        t.catalog["models"]["4b"]["repo"] = "unsloth/Qwen3.5-4B-GGUF".into();
        t.catalog["order"] = json!(["4b", "big"]);
        t.catalog["models"]["big"] = json!({
            "label": "Big", "gguf": "big.gguf", "repo": "unsloth/Big-MTP-GGUF",
            "files": [ { "path": "big.gguf", "size": 1 }, { "path": "mmproj.gguf", "size": 1, "repo": "unsloth/Big-GGUF" } ],
            "memory": { "kv_kib_token": 32, "state_mib": 53 } });
        t.save();
        let mine = json!({ "label": "Mine", "gguf": "mine.gguf", "repo": "someone/Mine-GGUF", "files": [ { "path": "mine.gguf", "size": 1 } ], "memory": { "kv_kib_token": 32, "state_mib": 53 } });
        mango_common::catalog::add_user(&t.paths, "hf-mine", mine).unwrap();
        let tested = |text: &str| tested(&t.paths, &hugging_face::parse_reference(text).unwrap()).unwrap().map(|m| (m.key, m.label));
        let qwen = Some(("4b".to_string(), "Qwen3.5-4B".to_string()));

        assert_eq!(tested("https://huggingface.co/unsloth/Qwen3.5-4B-GGUF"), qwen);
        assert_eq!(tested("Unsloth/qwen3.5-4b-gguf"), qwen, "in any case");
        assert_eq!(tested("https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/main"), qwen, "the main branch is the repo");
        assert_eq!(tested("unsloth/Big-MTP-GGUF"), Some(("big".into(), "Big".into())));
        for other in [
            "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/blob/main/Qwen3.5-4B-Q8_0.gguf",
            "hf.co/unsloth/Qwen3.5-4B-GGUF:Q8_0",
            "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/tree/another-branch",
            "unsloth/Big-GGUF",
            "Qwen/Qwen3.5-4B-GGUF",
            "someone/Mine-GGUF",
        ] {
            assert_eq!(tested(other), None, "{other}");
        }
    }

    #[test]
    fn files_in_a_repo_folder_and_pieces_are_downloaded_from_their_path() {
        let t = Fake::small();
        t.save();
        // each piece with its own tensors: the first the metadata and two layers, the second the other two
        let d = tempfile::tempdir().unwrap();
        let (first, second) = (d.path().join("1.gguf"), d.path().join("2.gguf"));
        test_util::write_with(&first, "qwen35", &HYBRID, &[], &[], &[("blk.0.ssm_out.weight", 300), ("blk.1.attn_k.weight", 500)]);
        test_util::write_with(&second, "", &[("split.no", 1)], &[], &[], &[("blk.2.ssm_out.weight", 400), ("blk.3.attn_k.weight", 600)]);
        let data = [std::fs::read(&first).unwrap(), std::fs::read(&second).unwrap()];
        let mut repo = test_repo();
        repo.files = vec![f("Q4_K_M/m-Q4_K_M-00001-of-00002.gguf", 1.0), f("Q4_K_M/m-Q4_K_M-00002-of-00002.gguf", 1.0)];
        let asked = std::cell::RefCell::new(Vec::new());
        let a = analyze_repo(&t.paths, &pc(vec![], 8192), &repo, &|file, r| {
            asked.borrow_mut().push((file.path.clone(), r.end));
            let piece = &data[usize::from(file.path.contains("00002-of"))];
            Ok(part(piece, r))
        })
        .unwrap();
        assert_eq!(*asked.borrow(), [("Q4_K_M/m-Q4_K_M-00001-of-00002.gguf".to_string(), STEPS[0]), ("Q4_K_M/m-Q4_K_M-00002-of-00002.gguf".to_string(), PIECE_STEPS[0])], "every piece, the later ones from 256 KiB");
        // like the whole hybrid: 2 attention layers (8 KiB), 2 recurrent ones (7 MiB); without the second piece's tensors its
        // recurrent layer would count as attention
        assert_eq!(a.variants[0].entry["memory"], json!({ "kv_kib_token": 8, "state_mib": 7 }));
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
    fn a_file_that_is_not_a_gguf_is_damaged_or_misses_pieces_is_refused_saying_why() {
        let t = Fake::small();
        t.save();
        let hw = pc(vec![], 8192);
        let d = tempfile::tempdir().unwrap();
        let no = d.path().join("no.gguf");
        std::fs::write(&no, b"nothing to see here, really nothing").unwrap();
        let e = analyze_local(&t.paths, &hw, &no).unwrap_err().to_string();
        assert!(e.starts_with(&tr!("«no.gguf» non è un file GGUF", "«no.gguf» is not a GGUF file")), "{e}");

        // a GGUF cut short: damaged, not «not a GGUF»
        let cut = write_gguf(d.path(), "cut.gguf", None);
        let start = std::fs::read(&cut).unwrap()[..300].to_vec();
        std::fs::write(&cut, start).unwrap();
        let e = analyze_local(&t.paths, &hw, &cut).unwrap_err().to_string();
        assert!(e.starts_with(&tr!("«cut.gguf» è rovinato o incompleto", "«cut.gguf» is damaged or incomplete")), "{e}");

        let piece = write_gguf(d.path(), "m-00002-of-00003.gguf", None);
        let e = analyze_local(&t.paths, &hw, &piece).unwrap_err().to_string();
        assert!(e.contains(&tr!("diviso in 3 file", "split into 3 files")) && e.contains("m-00001-of-00003.gguf, m-00003-of-00003.gguf"), "{e}");

        let e = analyze_local(&t.paths, &hw, &d.path().join("missing.gguf")).unwrap_err().to_string();
        assert!(e.contains("missing.gguf"), "{e}");
    }

    /// Any piece of a split model on the computer brings the whole model: the first piece is the one the engine opens,
    /// every piece is in the files and its tensors count (here the recurrent layer of the second piece).
    #[test]
    fn a_split_model_on_the_computer_counts_as_one_whatever_piece_is_chosen() {
        let t = Fake::small();
        t.save();
        let d = tempfile::tempdir().unwrap();
        let first = d.path().join("Hybrid-Q4_K_M-00001-of-00002.gguf");
        test_util::write_with(&first, "qwen35", &HYBRID, &[("tokenizer.chat_template", tolerant_like_qwen().as_str())], &[], &[("blk.0.ssm_out.weight", 300), ("blk.1.attn_k.weight", 500)]);
        let second = d.path().join("Hybrid-Q4_K_M-00002-of-00002.gguf");
        test_util::write_with(&second, "", &[("split.no", 1)], &[], &[], &[("blk.2.ssm_out.weight", 400), ("blk.3.attn_k.weight", 600)]);
        let sizes = [&first, &second].map(|p| std::fs::metadata(p).unwrap().len());

        let a = analyze_local(&t.paths, &pc(vec![], 8192), &second).unwrap();

        assert_eq!(a.name, "Hybrid-Q4_K_M");
        let v = &a.variants[0];
        assert_eq!(v.key, "local-hybrid-q4-k-m");
        assert_eq!(v.bytes, sizes[0] + sizes[1]);
        assert_eq!(v.entry["gguf"], first.display().to_string());
        assert_eq!(v.entry["files"], json!([{ "path": first.display().to_string(), "size": sizes[0] }, { "path": second.display().to_string(), "size": sizes[1] }]));
        // like the whole hybrid: 2 attention layers (8 KiB), 2 recurrent ones (7 MiB)
        assert_eq!(v.entry["memory"], json!({ "kv_kib_token": 8, "state_mib": 7 }));
        assert!(!a.estimated && a.warnings.is_empty(), "{a:?}");
    }

    /// An image encoder (`clip`) written for the tests.
    fn write_encoder(path: &Path, projection: u32, strings: &[(&str, &str)]) {
        test_util::write_with(path, "clip", &[("clip.vision.projection_dim", projection)], strings, &[], &[("v.patch_embd.weight", 1000)]);
    }

    /// The image encoder next to the model is offered as the version with images only if it is shown to be made for it:
    /// as wide, and named after it. Another model's encoder (another projection, or the same width with another name)
    /// is not, and the log says why; nor is a file only named like one. The encoder chosen as the model is refused.
    #[test]
    fn an_image_encoder_next_to_the_file_is_offered_with_images_only_if_it_matches_the_model() {
        let t = Fake::small();
        t.save();
        let d = tempfile::tempdir().unwrap();
        let g = write_gguf(d.path(), "Model-Q4_K_M.gguf", None);
        let encoder = d.path().join("mmproj-Model-F16.gguf");
        write_encoder(&encoder, 2560, &[]);
        let wide = d.path().join("mmproj-Wide-F16.gguf");
        write_encoder(&wide, 4096, &[]);
        let same_width = d.path().join("Other-mmproj-F16.gguf");
        write_encoder(&same_width, 2560, &[("general.name", "Other")]);
        std::fs::write(d.path().join("mmproj-notes.gguf"), b"not a model").unwrap();
        let hw = pc(vec![], 8192);

        let a = analyze_local(&t.paths, &hw, &g).unwrap();

        let v = &a.variants[0];
        let im = v.with_images.as_ref().expect("the encoder next to it");
        let size = std::fs::metadata(&encoder).unwrap().len();
        assert_eq!(im.entry["mmproj"], encoder.display().to_string());
        assert_eq!(im.entry["files"][1], json!({ "path": encoder.display().to_string(), "size": size }));
        assert_eq!(im.bytes, v.bytes + size);
        assert!(v.entry.get("mmproj").is_none());
        let log = std::fs::read_to_string(t.paths.logs().join("startup.log")).unwrap();
        assert!(log.contains("mmproj-Wide-F16.gguf next to Model-Q4_K_M.gguf not offered") && log.contains("Some(4096)") && log.contains("Some(2560)"), "{log}");
        assert!(log.contains("Other-mmproj-F16.gguf next to Model-Q4_K_M.gguf not offered for images: as wide as the model, but nothing shows"), "{log}");

        // the other models' encoders alone: no version with images
        std::fs::remove_file(&encoder).unwrap();
        assert!(analyze_local(&t.paths, &hw, &g).unwrap().variants[0].with_images.is_none());

        let e = analyze_local(&t.paths, &hw, &wide).unwrap_err().to_string();
        assert!(e.contains(&tr!("legge le immagini, non il modello", "reads images, not the model")), "{e}");
    }

    /// A generic encoder name (`mmproj-F16.gguf`, as in the Hugging Face repos) is shown to match by the family the two
    /// headers name (`general.basename` or `general.name`), not by its file name.
    #[test]
    fn a_generic_encoder_matches_by_the_family_its_header_names() {
        let t = Fake::small();
        t.save();
        let hw = pc(vec![], 8192);
        for (family, offered) in [("Kin", true), ("Stranger", false)] {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("Kin-Q4_K_M.gguf");
            let ints = [("llama.block_count", 1), ("llama.embedding_length", 2048), ("llama.attention.head_count", 16), ("llama.attention.head_count_kv", 4)];
            test_util::write_with(&p, "llama", &ints, &[("general.basename", "Kin")], &[], &[("blk.0.attn_k.weight", 100)]);
            write_encoder(&d.path().join("mmproj-F16.gguf"), 2048, &[("general.basename", family)]);
            let a = analyze_local(&t.paths, &hw, &p).unwrap();
            assert_eq!(a.variants[0].with_images.is_some(), offered, "{family}");
        }
    }

    #[test]
    fn an_encoder_named_after_the_model_matches_without_the_quantizations() {
        assert!(named_after("mmproj-Qwen3.8-27B-Uncensored-f16.gguf", "Qwen3.8-27B-Uncensored-IQ4_XS.gguf"));
        assert!(named_after("Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", "Ternary-Bonsai-2-27B-Q2_0.gguf"));
        assert!(!named_after("mmproj-F16.gguf", "Qwen3.5-9B-Q4_K_M.gguf"), "a generic name says nothing");
        assert!(!named_after("mmproj-Qwen3-f16.gguf", "Qwen3.5-9B-Q4_K_M.gguf"), "Qwen3 is not Qwen3.5");
    }

    /// A GGUF the count doesn't know all of (here without the attention heads): instead of a refusal, the memory is
    /// estimated, the context is the smallest the agent works with, a warning says so in words and the technical detail
    /// stays in the entry. Added, the model's verdict says it is estimated.
    #[test]
    fn a_model_the_count_does_not_know_is_estimated_and_can_be_added() {
        let t = Fake::small();
        t.save();
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("Newarch-Q4_K_M.gguf");
        let ints = [("newarch.block_count", 4), ("newarch.context_length", 262_144), ("newarch.embedding_length", 2048)];
        let tensors = [("blk.0.attn_k.weight", 100), ("blk.1.attn_k.weight", 100), ("blk.2.attn_k.weight", 100), ("blk.3.attn_k.weight", 100)];
        test_util::write_with(&p, "newarch", &ints, &[("tokenizer.chat_template", tolerant_like_qwen().as_str())], &[], &tensors);
        let hw = pc(vec![], 8192);

        let a = analyze_local(&t.paths, &hw, &p).unwrap();

        assert!(a.estimated);
        assert_eq!(a.warnings.len(), 1, "{a:?}");
        let w = &a.warnings[0];
        assert!(!w.severe && w.text.starts_with(&tr!("Non conosco ancora questo tipo di modello", "I don't know this kind of model yet")), "{w:?}");
        assert!(!w.text.contains("newarch"), "the technical detail isn't in the sentence: {}", w.text);
        let v = &a.variants[0];
        // 4 layers x (4096 + 4096) x 2 bytes = 64 KiB per token: K and V twice as wide as the model
        assert_eq!(v.entry["memory"]["kv_kib_token"], 64);
        assert!(v.entry["memory"]["estimated"].as_str().is_some_and(|e| e.contains("newarch.attention.head_count")), "{}", v.entry);
        assert_eq!(v.entry["ctx"], MIN_CTX, "not the 262,144 the model says");
        assert!(v.placement.is_some(), "{v:?}");

        add(&t.paths, &v.key, v.entry.clone()).unwrap();
        let log = std::fs::read_to_string(t.paths.logs().join("startup.log")).unwrap();
        assert!(log.contains(&format!("{} added, its memory is estimated: newarch.attention.head_count", v.key)), "the technical detail is in the log: {log}");
        let view = crate::models_view(&t.paths, &hw).unwrap().into_iter().find(|m| m.key == v.key).unwrap();
        assert!(view.verdict.estimated && view.verdict.fits, "{view:?}");
        assert_eq!(view.verdict.place.unwrap().context, MIN_CTX);
        assert!(crate::models_view(&t.paths, &hw).unwrap().iter().filter(|m| m.key != v.key).all(|m| !m.verdict.estimated));
        // also where the app reads the list of models
        let (entries, _) = crate::catalog::catalog_for(&t.paths, &hw).unwrap();
        assert_eq!(entries.iter().map(|e| (e.key.as_str(), e.estimated)).collect::<Vec<_>>(), [("4b", false), (v.key.as_str(), true)]);
        let recommendations = crate::recommended(&t.paths, &hw).unwrap();
        assert_eq!(recommendations.iter().map(|r| r.estimated).collect::<Vec<_>>(), [false, true]);
    }

    #[test]
    fn a_model_the_count_does_not_know_is_estimated_from_hugging_face_too() {
        let t = Fake::small();
        t.save();
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("odd.gguf");
        test_util::write_with(&p, "odd", &[("odd.block_count", 2), ("odd.embedding_length", 1024)], &[], &[], &[("blk.0.attn_k.weight", 10), ("blk.1.attn_k.weight", 10)]);
        let a = analyze_test(&t, &pc(vec![], 8192), &test_repo(), &p);
        assert!(a.estimated && a.warnings[0].text.starts_with(&tr!("Non conosco ancora", "I don't know")), "{a:?}");
        assert!(a.variants.iter().all(|v| v.entry["ctx"] == MIN_CTX && v.entry["memory"]["estimated"].is_string()), "{:#?}", a.variants);
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
        let start = |_: &HfFile, r: Range<usize>| {
            requests.borrow_mut().push(r.clone());
            Ok(part(&data, r))
        };

        let t = Fake::small();
        let h = remote_header(&t.paths, &file, &start, &[100, 200, 1 << 20], true).unwrap();

        assert_eq!(*requests.borrow(), [0..100, 100..200, 200..1 << 20], "each round asks for the bytes after those it has, until the header is all there");
        assert_eq!(h.strings["tokenizer.chat_template"], "{{ messages }}");

        // a file that ends before the bytes asked for is a broken file: no insisting
        let e = remote_header(&t.paths, &file, &|_: &HfFile, _: Range<usize>| Ok(data[..100].to_vec()), &[1 << 20], true).unwrap_err().to_string();
        assert!(e.starts_with(&tr!("«m.gguf» è rovinato", "«m.gguf» is damaged")), "{e}");
        let e = remote_header(&t.paths, &file, &|_: &HfFile, _: Range<usize>| Ok(b"<!DOCTYPE html><html>".to_vec()), &[1 << 20], true).unwrap_err().to_string();
        assert!(e.starts_with(&tr!("«m.gguf» non è un file GGUF", "«m.gguf» is not a GGUF file")), "{e}");

        // a header longer than the last attempt: a sentence without numbers, the detail in the log
        let e = remote_header(&t.paths, &file, &start, &[100, 200], true).unwrap_err().to_string();
        assert_eq!(e, tr!("Questo file è fatto in un modo che non riesco a leggere: «m.gguf».", "This file is made in a way I can't read: «m.gguf»."));
        let log = std::fs::read_to_string(t.paths.logs().join("startup.log")).unwrap();
        assert!(log.contains("the header of m.gguf goes beyond"), "{log}");
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

    /// By hand: `MANGO_TEST_GGUF=<file.gguf> cargo test -p engine-cfg --lib other_models::tests::with_a_real_local_file -- --ignored --nocapture`
    #[test]
    #[ignore = "reads a real GGUF from the disk: MANGO_TEST_GGUF says which"]
    fn with_a_real_local_file_the_model_is_analyzed() {
        let path = std::env::var("MANGO_TEST_GGUF").expect("MANGO_TEST_GGUF");
        let t = Fake::small();
        t.save();
        let a = analyze_local(&t.paths, &pc(vec![], 16_384), Path::new(&path)).unwrap();
        println!("{} {:#?}", a.name, a.warnings);
        let v = &a.variants[0];
        println!("{:.2} GB  where={:?}  memory: {} ctx: {}  images: {:?}", v.bytes as f64 / GIB as f64, v.placement, v.entry["memory"], v.entry["ctx"], v.with_images.as_ref().map(|i| &i.entry["mmproj"]));
    }

    /// Ling 3.0 Tiny's numbers in the real catalog: what the real file and the real repo must give.
    fn ling_in_the_catalog() -> Value {
        let f = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher/mango-models.json");
        let catalog: Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();
        catalog["models"]["ling"].clone()
    }

    /// By hand: `MANGO_TEST_GGUF=<Ling-3.0-tiny-Q4_K_M.gguf> cargo test -p engine-cfg --lib other_models::tests::the_real_ling -- --ignored --nocapture`
    #[test]
    #[ignore = "reads the real Ling 3.0 Tiny from the disk: MANGO_TEST_GGUF says where"]
    fn the_real_ling_file_is_counted_like_the_catalog() {
        let path = std::env::var("MANGO_TEST_GGUF").expect("MANGO_TEST_GGUF");
        let t = Fake::small();
        t.save();
        let a = analyze_local(&t.paths, &pc(vec![], 16_384), Path::new(&path)).unwrap();
        let v = &a.variants[0];
        println!("{} estimated={} {:?} memory={} ctx={} where={:?}", a.name, a.estimated, a.warnings, v.entry["memory"], v.entry["ctx"], v.placement);
        let ling = ling_in_the_catalog();
        assert!(!a.estimated, "{a:?}");
        assert_eq!(v.entry["memory"], ling["memory"]);
        assert_eq!(v.bytes, ling["files"][0]["size"]);
    }

    /// By hand, with the network: `HF_TOKEN= cargo test -p engine-cfg --lib other_models::tests::the_real_ling_link -- --ignored --nocapture`
    /// (an empty `HF_TOKEN` leaves out any token saved on the PC).
    #[test]
    #[ignore = "uses the network: Ling 3.0 Tiny on Hugging Face, as a user pastes it"]
    fn the_real_ling_link_in_every_form_gives_the_catalogs_numbers() {
        let ling = ling_in_the_catalog();
        let repo = ling["repo"].as_str().unwrap();
        let file = ling["gguf"].as_str().unwrap().rsplit('/').next().unwrap();
        let t = Fake::small();
        t.save();
        let hw = pc(vec![], 16_384);
        for text in [
            format!("https://huggingface.co/{repo}"),
            repo.to_string(),
            format!(" hf.co/{repo}/ "),
            format!("https://huggingface.co/{repo}/blob/main/{file}"),
            format!("https://huggingface.co/{repo}/resolve/main/{file}?download=true"),
        ] {
            let r = hugging_face::parse_reference(&text).unwrap_or_else(|| panic!("{text:?}"));
            let mut a = analyze_hugging_face(&t.paths, &hw, &hugging_face::repo(&r.repo, r.revision.as_deref()).unwrap()).unwrap();
            a.prefer(r.quant.as_deref(), r.path.as_deref());
            let proposed: Vec<_> = a.variants.iter().filter(|v| v.recommended).map(|v| v.name.as_str()).collect();
            println!("{text:?}: {} quantizations, proposed {proposed:?}, estimated={}", a.variants.len(), a.estimated);
            assert!(!a.estimated);
            assert!(a.variants.iter().all(|v| v.entry["memory"] == ling["memory"]), "{:#?}", a.variants);
            if r.path.is_some() {
                assert_eq!(proposed, ["Q4_K_M"], "the file of the link");
            }
        }
    }

    /// By hand, with the network: `HF_TOKEN= cargo test -p engine-cfg --lib other_models::tests::real_refusals -- --ignored --nocapture`
    #[test]
    #[ignore = "uses the network: a repo that isn't there and a gated one, without a token"]
    fn real_refusals_of_hugging_face_say_why_in_words() {
        let missing = hugging_face::repo("nobody-zz9/nothing-zz9-GGUF", None).unwrap_err().to_string();
        println!("{missing}");
        assert!(missing.starts_with(&tr!("Non trovo questo modello", "I can't find this model")), "{missing}");
        let t = Fake::small();
        t.save();
        let gated = hugging_face::repo("google/gemma-3-1b-it-qat-q4_0-gguf", None).unwrap();
        assert!(gated.gated);
        let e = analyze_hugging_face(&t.paths, &pc(vec![], 16_384), &gated).unwrap_err().to_string();
        println!("{e}");
        assert!(e.starts_with(&tr!("Questo modello chiede di accettare", "This model asks you to accept")), "{e}");
    }

    /// By hand, with the network: `HF_TOKEN=hf_not_a_real_token cargo test -p engine-cfg --lib other_models::tests::real_invalid -- --ignored --nocapture`.
    /// Hugging Face ignores a bad token for what is public (the search and Ling work), and refuses it with 401 for a
    /// model that isn't there or is gated: there the sentence is about the token.
    #[test]
    #[ignore = "uses the network, with the invalid token HF_TOKEN gives"]
    fn real_invalid_token_is_said_where_hugging_face_refuses_it() {
        assert!(!hugging_face::search("Ling").unwrap().is_empty());
        let t = Fake::small();
        t.save();
        let gated = hugging_face::repo("google/gemma-3-1b-it-qat-q4_0-gguf", None).unwrap();
        let refused = [hugging_face::repo("nobody-zz9/nothing-zz9-GGUF", None).unwrap_err(), analyze_hugging_face(&t.paths, &pc(vec![], 16_384), &gated).unwrap_err()];
        for e in refused {
            println!("{e}");
            assert!(e.to_string().starts_with(&tr!("Il tuo token di Hugging Face non è valido o è scaduto", "Your Hugging Face token is not valid or has expired")), "{e}");
        }
    }

    #[test]
    fn a_template_that_cannot_be_tested_gives_no_verdict() {
        let a = check_template(Some("{% if %}broken"));
        assert!(a.len() == 1 && !a[0].severe && a[0].text.contains(&tr!("Non sono riuscito", "I couldn't check")) && a[0].text.contains("syntax error"), "{a:?}");
    }
}
