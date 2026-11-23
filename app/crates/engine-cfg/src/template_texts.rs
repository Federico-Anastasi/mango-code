//! Keeps `tests/templates/` honest: the texts there are the chat templates in the GGUF headers of real models, at the
//! revision the manifest pins. Only the header of each file is read (a range request), never the weights.
//!
//! `cargo test -p engine-cfg template_texts -- --ignored` checks that every committed text is what its source holds.
//! With `UPDATE_TEMPLATES=1` it takes the entries whose `revision` is empty (a new one, or one to refresh) from the latest
//! revision of their repo and writes the text and the manifest's `revision`, `file` and `sha256`; the rest of an entry
//! (tokens, expected outcomes) is the author's.

use crate::gguf::{ends_too_early, parse_header};
use anyhow::{bail, Context, Result};
use mango_common::download::hugging_face::{self, HfFile, Repo};
use mango_common::sha256_hex;
use serde_json::Value;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How much of the start of a file to read to get the header, by attempts: the first almost always is enough.
const STEPS: [usize; 3] = [8 << 20, 32 << 20, 128 << 20];

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("templates")
}

/// The file to read the header from when the manifest names none: the smallest whole file or first piece.
fn smallest(repo: &Repo) -> Result<&HfFile> {
    let first_piece = |f: &&HfFile| !hugging_face::is_encoder(f) && !f.path.contains("imatrix") && (!f.path.contains("-of-") || f.path.contains("-00001-of-"));
    repo.files.iter().filter(first_piece).min_by_key(|f| f.size).with_context(|| format!("no GGUF file in {}", repo.id))
}

fn template_of(repo: &Repo, file: &HfFile) -> Result<String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut data = Vec::new();
    for bytes in STEPS {
        data.extend(hugging_face::file_part(repo, file, data.len()..bytes, deadline)?);
        match parse_header(Cursor::new(&data), file.size) {
            Ok(h) => return h.strings.get("tokenizer.chat_template").cloned().with_context(|| format!("{} has no chat template", file.path)),
            Err(e) if ends_too_early(&e) => continue,
            Err(e) => return Err(e.context(file.path.clone())),
        }
    }
    bail!("the header of {} goes beyond {} bytes", file.path, STEPS[STEPS.len() - 1])
}

#[test]
#[ignore = "reads the headers of public GGUF files from Hugging Face"]
fn template_texts_are_what_their_sources_hold() {
    let update = std::env::var("UPDATE_TEMPLATES").is_ok_and(|v| v == "1");
    let manifest_file = folder().join("templates.json");
    let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(&manifest_file).unwrap()).unwrap();
    for entry in manifest["templates"].as_array_mut().unwrap() {
        let id = entry["id"].as_str().unwrap().to_string();
        let repo_id = entry["repo"].as_str().unwrap().to_string();
        let pinned = entry["revision"].as_str().filter(|r| !r.is_empty());
        let fetch_latest = update && pinned.is_none();
        let repo = hugging_face::repo(&repo_id, pinned).unwrap_or_else(|e| panic!("{id}: {repo_id}: {e:#}"));
        let named = entry["file"].as_str().filter(|f| !f.is_empty());
        let file = match named.and_then(|n| repo.files.iter().find(|f| f.path == n)) {
            Some(f) => f,
            None => smallest(&repo).unwrap_or_else(|e| panic!("{id}: {e:#}")),
        };
        let text = template_of(&repo, file).unwrap_or_else(|e| panic!("{id}: {e:#}"));
        let path = folder().join(format!("{id}.jinja"));
        let hash = sha256_hex(text.as_bytes());
        if fetch_latest {
            std::fs::write(&path, &text).unwrap();
            entry["revision"] = repo.revision.clone().into();
            entry["file"] = file.path.clone().into();
            entry["sha256"] = hash.into();
            continue;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(sha256_hex(committed.as_bytes()), hash, "{id}: the committed text is not the one in {repo_id}@{}", repo.revision);
        assert_eq!(entry["sha256"].as_str(), Some(hash.as_str()), "{id}: the manifest's hash is not the text's");
    }
    if update {
        std::fs::write(&manifest_file, serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
    }
}
