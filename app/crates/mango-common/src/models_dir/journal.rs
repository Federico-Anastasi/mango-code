//! What a move of the models folder writes down before it touches a file, and what it does when the app comes back after a
//! move that stopped half way (the computer was switched off, the app was ended): the choice decides. If the new folder is
//! the models folder the move is finished (the files that did not move yet move, the places written down are brought to the
//! new folder, the old copies are removed); if it is not, it is put back (the files that moved go back).
//!
//! The choice is saved first and the places that point into the old folder after it, so the choice alone says how far the
//! move got; the places are rewritten by the same rule on both runs, so doing it twice is the same as doing it once.

use super::relocate::{identical, Item, Method};
use super::{below, chosen, current, default_dir, key, prune_empty, same, save};
use crate::catalog::update_user_list;
use crate::download::recorded_hash;
use crate::{model_files, tr, user_error};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const FILE: &str = "models-move.json";

/// A move under way: where from, where to, how, and which files (below the models folder) go.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub from: PathBuf,
    pub to: PathBuf,
    pub method: Method,
    pub files: Vec<String>,
    /// The new folder was made by this move.
    pub made: bool,
}

pub fn write(data: &Path, journal: &Journal) -> Result<()> {
    fs::create_dir_all(data)?;
    crate::write_durable(&data.join(FILE), serde_json::to_string_pretty(journal)?)
        .map_err(|e| user_error(&tr!("Non riesco a scrivere il diario dello spostamento.", "I can't write the journal of the move."), format!("{}: {e}", data.join(FILE).display())))
}

pub fn read(data: &Path) -> Result<Option<Journal>> {
    let file = data.join(FILE);
    match fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}')).map(Some).map_err(|e| {
            user_error(&tr!("Il diario di uno spostamento interrotto non è valido: toglilo.", "The journal of an interrupted move is not valid: remove it."), format!("{}: {e}", file.display()))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(user_error(&tr!("Non riesco a leggere il diario dello spostamento.", "I can't read the journal of the move."), format!("{}: {e}", file.display()))),
    }
}

pub fn clear(data: &Path) {
    let _ = fs::remove_file(data.join(FILE));
}

/// The names of `files` as they are compared.
fn moved_set(files: &[String]) -> BTreeSet<String> {
    files.iter().map(|f| key(Path::new(f))).collect()
}

/// Saves `to` as the models folder and points at it what pointed into `from`: the places of the files the user moved there
/// and the user's own models, for the files that moved (`moved`). Each is read back before this returns, so what is
/// removed after it was written down. A failure puts the choice and the places back as they were.
pub fn commit(data: &Path, from: &Path, to: &Path, moved: &[String]) -> Result<()> {
    let set = moved_set(moved);
    let before = chosen(data)?;
    let done = (|| -> Result<()> {
        save(data, to).map_err(|e| user_error(&tr!("Non riesco a salvare la scelta.", "I can't save the choice."), format!("{}: {e}", data.display())))?;
        if !same(&current(data)?, to) {
            return Err(user_error(&tr!("La scelta salvata non è quella attesa.", "The choice that was saved is not the one expected."), data.display()));
        }
        rewrite(data, from, to, &set)
    })();
    if done.is_err() {
        let _ = save(data, &before.unwrap_or_else(|| default_dir(data)));
        let _ = rewrite(data, to, from, &set);
    }
    done
}

/// Points at `to` the files of `moved` that are below `from`: the places of the user's moved files (`model-files.json`) and
/// the paths of the user's own models (`user-models.json`). Each file is read back and checked.
fn rewrite(data: &Path, from: &Path, to: &Path, moved: &BTreeSet<String>) -> Result<()> {
    let target = |path: &Path| below(path, from).filter(|rel| moved.contains(&key(rel))).map(|rel| to.join(rel));

    model_files::update(data, |places| places.values_mut().filter(|p| p.own).for_each(|p| p.at = target(&p.at).unwrap_or_else(|| p.at.clone())))?;
    if model_files::read(data)?.values().any(|p| p.own && target(&p.at).is_some()) {
        return Err(user_error(&tr!("Non riesco a salvare dove stanno i file dei modelli.", "I can't save where the model files are."), data.join(model_files::FILE).display()));
    }

    update_user_list(data, |list| list.values_mut().fold(false, |changed, entry| repoint(entry, &target) | changed))?;
    let mut left = 0;
    update_user_list(data, |list| {
        left = list.values().filter(|entry| repoint(&mut (*entry).clone(), &target)).count();
        false
    })?;
    if left > 0 {
        return Err(user_error(&tr!("Non riesco a salvare il tuo elenco di modelli.", "I can't save your model list."), data.join(crate::catalog::USER_FILE).display()));
    }
    Ok(())
}

/// The paths a user's model names (its weights, the encoder, the files and the pieces of a picture model), pointed at their
/// new place. Says whether one changed.
fn repoint(entry: &mut Value, target: &impl Fn(&Path) -> Option<PathBuf>) -> bool {
    let mut changed = false;
    let mut visit = |value: &mut Value| {
        if let Some(new) = value.as_str().map(Path::new).filter(|p| p.is_absolute()).and_then(target) {
            *value = new.display().to_string().into();
            changed = true;
        }
    };
    for field in ["gguf", "mmproj"] {
        entry.get_mut(field).into_iter().for_each(&mut visit);
    }
    for field in ["diffusion", "encoder", "vae"] {
        entry.pointer_mut(&format!("/image/{field}")).into_iter().for_each(&mut visit);
    }
    entry.get_mut("files").and_then(Value::as_array_mut).into_iter().flatten().filter_map(|f| f.get_mut("path")).for_each(&mut visit);
    changed
}

/// A move that was interrupted, finished or put back from its journal. Says what it did (for the log); none when there was
/// none. The journal goes once the folders agree with the choice. A failure leaves it for the next start.
pub fn recover(data: &Path) -> Result<Option<String>> {
    let Some(journal) = read(data)? else { return Ok(None) };
    let Journal { from, to, method, files, made } = &journal;
    let set = moved_set(files);
    let finished = same(&current(data)?, to);
    let path = |root: &Path, rel: &String| root.join(rel);
    let report = match (finished, method) {
        (true, Method::Rename) => {
            for rel in files.iter().filter(|r| fs::symlink_metadata(path(from, r)).is_ok() && fs::symlink_metadata(path(to, r)).is_err()) {
                fs::create_dir_all(path(to, rel).parent().unwrap_or(to))?;
                fs::rename(path(from, rel), path(to, rel))?;
            }
            rewrite(data, from, to, &set)?;
            prune_empty(from, files.iter().map(PathBuf::from));
            format!("the interrupted move to {} was finished", to.display())
        }
        (true, Method::Copy) => {
            rewrite(data, from, to, &set)?;
            // A file with its final name in the new folder was checked before it got that name: the original goes when it is the same size and time.
            let mut kept = 0;
            for rel in files {
                let (old, new) = (path(from, rel), path(to, rel));
                let Ok(meta) = fs::metadata(&old) else { continue };
                let gone = match rel.strip_suffix(".verified") {
                    Some(base) => path(to, &base.to_string()).is_file(),
                    None => identical(&new, &Item { rel: PathBuf::from(rel), size: meta.len(), modified: meta.modified()?, hash: recorded_hash(&old) }),
                };
                match gone {
                    true => fs::remove_file(&old)?,
                    false => kept += 1,
                }
            }
            prune_empty(from, files.iter().map(PathBuf::from));
            let _ = fs::remove_file(to.join(super::relocate::MARKER));
            format!("the interrupted move to {} was finished ({kept} old files kept)", to.display())
        }
        (false, Method::Rename) => {
            for rel in files.iter().rev().filter(|r| fs::symlink_metadata(path(to, r)).is_ok() && fs::symlink_metadata(path(from, r)).is_err()) {
                fs::create_dir_all(path(from, rel).parent().unwrap_or(from))?;
                fs::rename(path(to, rel), path(from, rel))?;
            }
            prune_empty(to, files.iter().map(PathBuf::from));
            if *made {
                let _ = fs::remove_dir(to);
            }
            format!("the interrupted move to {} was put back", to.display())
        }
        // The copies stay in the new folder with their mark: the next try goes on from them.
        (false, Method::Copy) => format!("the interrupted copy to {} was left for the next try", to.display()),
    };
    clear(data);
    Ok(Some(report))
}
