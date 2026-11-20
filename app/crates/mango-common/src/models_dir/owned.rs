//! What in the models folder is Mango Code's own, and so travels when the folder is moved: the files of the catalog's models,
//! the files of the models the user added that are inside the folder, the files the user moved inside it, the dictation
//! models, and what the app writes next to them (the partial download, the note of a verified hash, the marks of a move).
//! Any other file in the folder is not ours: it stays where it is.

use super::{below, key};
use crate::catalog::read_unplaced;
use crate::{model_files, Paths};
use anyhow::Result;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

/// What the app writes next to a model file.
const COMPANIONS: [&str; 3] = [".part", ".verified", ".mango-copy"];

/// The mark a move leaves in the new folder (`relocate::MARKER`).
const MARK: &str = ".mango-moving";

/// The names, below the models folder, of the files that are ours.
#[derive(Debug, Clone, Default)]
pub struct Owned {
    bases: BTreeSet<String>,
}

impl Owned {
    /// The files below `folder` that belong to the models of `paths` and to the user's list, those the user moved in there,
    /// and `extra` (paths below the folder: the dictation models).
    pub fn of(paths: &Paths, folder: &Path, extra: &[PathBuf]) -> Result<Owned> {
        let catalog = read_unplaced(paths)?;
        let places = model_files::read(&paths.data)?;
        let mut owned = Owned::new(extra);
        for entry in catalog.root["models"].as_object().into_iter().flat_map(|m| m.values()) {
            for path in entry.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(|f| f.get("path")?.as_str()) {
                match places.get(path) {
                    Some(place) if place.own => owned.add(&place.at, folder),
                    Some(_) => {}
                    None => owned.add(Path::new(path), folder),
                }
            }
        }
        Ok(owned)
    }

    /// The files named by `bases`, relative to the models folder.
    pub fn new(bases: &[PathBuf]) -> Owned {
        Owned { bases: bases.iter().filter_map(|b| relative(b)).map(|b| key(&b)).collect() }
    }

    fn add(&mut self, path: &Path, folder: &Path) {
        let rel = match path.is_absolute() {
            true => below(path, folder),
            false => relative(path),
        };
        self.bases.extend(rel.map(|r| key(&r)));
    }

    /// Whether `rel` (below the models folder) is ours: a model file, or what the app writes next to one.
    pub fn has(&self, rel: &Path) -> bool {
        let name = key(rel);
        name == MARK || self.bases.contains(&name) || COMPANIONS.iter().any(|suffix| name.strip_suffix(suffix).is_some_and(|base| self.bases.contains(base)))
    }

    /// Whether anything ours is `folder` or below it (`folder` is below the models folder).
    pub fn under(&self, folder: &Path) -> bool {
        let folder = key(folder);
        self.bases.iter().any(|b| *b == folder || b.starts_with(&format!("{folder}\\")))
    }
}

/// A path as the catalog writes it (slashes of either kind) made relative; none when it climbs out with `..`.
fn relative(path: &Path) -> Option<PathBuf> {
    let text = path.to_string_lossy().replace('/', "\\");
    let parts: Vec<&str> = text.split('\\').filter(|p| !p.is_empty() && *p != ".").collect();
    let plain = !parts.is_empty() && Path::new(&text).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    plain.then(|| parts.iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(bases: &[&str]) -> Owned {
        Owned::new(&bases.iter().map(PathBuf::from).collect::<Vec<_>>())
    }

    /// A model file, its partial download, its note and the temporary names of a move are ours, whatever the capitals and
    /// slashes; a file beside them is not, and neither is another file that only looks like theirs.
    #[test]
    fn a_model_file_and_what_the_app_writes_next_to_it_are_ours() {
        let owned = owned(&["Org-GGUF/model.gguf", "whisper/ggml-small.bin"]);

        for ours in ["Org-GGUF/model.gguf", r"org-gguf\MODEL.gguf.part", "Org-GGUF/model.gguf.verified", "Org-GGUF/model.gguf.mango-copy", ".mango-moving", "whisper/ggml-small.bin"] {
            assert!(owned.has(Path::new(ours)), "{ours}");
        }
        for foreign in ["Org-GGUF/notes.txt", "model.gguf", "Org-GGUF/model.gguf.bak", "Org-GGUF/model.gguf.part.old", "whisper/other.bin", "Org-GGUF"] {
            assert!(!owned.has(Path::new(foreign)), "{foreign}");
        }
        assert!(owned.under(Path::new("Org-GGUF")) && owned.under(Path::new("whisper")) && !owned.under(Path::new("Org")), "folders that hold ours");
    }

    #[test]
    fn a_catalog_path_that_climbs_out_or_is_not_a_path_is_not_a_file_of_the_folder() {
        let owned = owned(&["../outside.gguf", "", "a/../b.gguf", "ok/a.gguf"]);
        assert!(!owned.has(Path::new("outside.gguf")) && !owned.has(Path::new("b.gguf")));
        assert!(owned.has(Path::new("ok/a.gguf")));
    }
}
