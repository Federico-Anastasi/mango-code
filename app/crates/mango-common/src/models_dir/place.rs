//! Putting one catalog model's files in a folder of the user's choosing, or back in the models folder.
//!
//! The same care as moving the whole folder (`relocate`): a preview that changes nothing; on the same volume a file is
//! renamed, on another one it is copied under a temporary name with its modification time, checked, and the old file
//! removed only after the new place is written down; links are never followed. A file that has a note of a verified hash
//! (`.verified`) or a partial download (`.part`) goes with it. Where the files are is `model_files`: the catalog reads it,
//! so the model starts, downloads and is removed at its place.

use super::relocate::{copy_file, drive_warning, engine_reads, identical, io_error, stuck_error, volume_root, Cancelled, Item, Method, Progress, Report, Stage};
use super::{below, prune_empty, Cancel};
use crate::catalog::read_unplaced;
use crate::download::{enough_space, recorded_hash};
use crate::model_files::{self, Place};
use crate::{free_space, tr, user_error, Paths};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// The note of a verified hash and the partial download, next to a file.
const COMPANIONS: [&str; 2] = [".verified", ".part"];

/// A file on the disk and where it goes.
#[derive(Debug, Clone)]
pub struct Pair {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// What putting a model's files somewhere takes.
#[derive(Debug, Clone)]
pub struct Plan {
    pub model: String,
    /// The files that are on the disk, with their notes and partial downloads: those that have to move.
    pub pairs: Vec<Pair>,
    /// Where each file of the model is from now on, by its path in the catalog (also those not on the disk yet).
    pub places: Vec<(String, PathBuf)>,
    /// Files of the model that are the user's own and stay where they are.
    pub staying: Vec<String>,
}

/// What a plan would do; nothing changes.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub model: String,
    pub files: u64,
    pub bytes: u64,
    pub free_bytes: u64,
    /// Every file is renamed (the same volume), instead of copied.
    pub same_volume: bool,
    /// Files of the model that stay where they are because they are the user's.
    pub staying: Vec<String>,
    pub warning: Option<String>,
    /// Why the files cannot go there, or there is nothing to do.
    pub refusal: Option<String>,
    /// Why they cannot be moved but could be used as they are there: not enough room.
    pub move_refusal: Option<String>,
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The files of `model` in the folder `to_dir` (a file called as it is in the catalog), or, without a folder, in the models
/// folder where the catalog puts them.
pub fn plan(paths: &Paths, model: &str, to_dir: Option<&Path>) -> Result<Plan> {
    let catalog = read_unplaced(paths)?;
    let entry = catalog.root["models"].get(model).filter(|m| m.get("cloud").is_none()).with_context(|| tr!("Questo modello non è nel catalogo.", "This model is not in the catalog."))?;
    let files: Vec<&Value> = entry.get("files").and_then(Value::as_array).into_iter().flatten().collect();
    if files.is_empty() || catalog.user.iter().any(|k| k == model) {
        bail!("{}", tr!("I file di questo modello li hai scelti tu: restano dove sono.", "The files of this model are ones you chose: they stay where they are."));
    }
    let known = model_files::read(&paths.data)?;
    let (mut pairs, mut places, mut staying) = (Vec::new(), Vec::new(), Vec::new());
    for catalog_path in files.iter().filter_map(|f| f.get("path")?.as_str()) {
        let here = match known.get(catalog_path) {
            Some(place) if !place.own => {
                staying.push(place.at.display().to_string());
                continue;
            }
            Some(place) => place.at.clone(),
            None => paths.models.join(catalog_path),
        };
        let there = match to_dir {
            Some(dir) => dir.join(file_name(catalog_path)),
            None => paths.models.join(catalog_path),
        };
        if !crate::models_dir::same(&here, &there) {
            for suffix in ["", COMPANIONS[0], COMPANIONS[1]] {
                let (from, to) = (with_suffix(&here, suffix), with_suffix(&there, suffix));
                if fs::symlink_metadata(&from).is_ok() {
                    pairs.push(Pair { from, to });
                }
            }
        }
        places.push((catalog_path.to_string(), there));
    }
    Ok(Plan { model: model.to_string(), pairs, places, staying })
}

/// What the plan would do. Nothing on the disk changes.
pub fn preview(paths: &Paths, plan: &Plan) -> Result<Preview> {
    let dest_dir = plan.pairs.first().and_then(|p| p.to.parent()).or_else(|| plan.places.first().and_then(|(_, to)| to.parent())).map(Path::to_path_buf).unwrap_or_else(|| paths.models.clone());
    let sizes: Vec<u64> = plan.pairs.iter().map(|p| fs::metadata(&p.from).map_or(0, |m| m.len())).collect();
    let same_volume = plan.pairs.iter().all(|p| {
        let target = p.to.parent().map(Path::to_path_buf).unwrap_or_default();
        matches!((volume_root(&p.from), volume_root(&target)), (Some(a), Some(b)) if a == b)
    });
    let copied: u64 = plan.pairs.iter().zip(&sizes).filter(|(p, _)| !same_volume_of(p)).map(|(_, size)| size).sum();
    let free_bytes = free_space(&dest_dir)?;
    let names: Vec<&str> = plan.places.iter().map(|(c, _)| file_name(c)).collect();
    let refusal = if plan.pairs.is_empty() && plan.places.iter().all(|(c, to)| known_place(paths, c).is_some_and(|at| crate::models_dir::same(&at, to))) {
        Some(tr!("Il modello è già lì.", "The model is already there."))
    } else if names.iter().enumerate().any(|(i, n)| names[..i].iter().any(|m| m.eq_ignore_ascii_case(n))) {
        Some(tr!("Due file del modello hanno lo stesso nome: non possono stare nella stessa cartella.", "Two files of the model have the same name: they cannot be in the same folder."))
    } else if plan.pairs.iter().any(|p| p.to.exists() && !identical_file(p)) {
        Some(tr!("Nella cartella c'è già un file con il nome di uno del modello.", "The folder already has a file with the name of one of the model's."))
    } else if !engine_reads(&dest_dir) {
        Some(tr!(
            "Il motore non riesce ad aprire i file in una cartella con lettere accentate o non latine nel nome. Scegline una con un nome semplice.",
            "The engine cannot open files in a folder whose name has accented or non-Latin letters. Choose one with a plain name."
        ))
    } else {
        None
    };
    let move_refusal = enough_space(copied, free_bytes, &dest_dir).err().map(|e| e.to_string()).filter(|_| copied > 0);
    Ok(Preview {
        model: plan.model.clone(),
        files: plan.pairs.len() as u64,
        bytes: sizes.iter().sum(),
        free_bytes,
        same_volume,
        staying: plan.staying.clone(),
        warning: drive_warning(&dest_dir),
        refusal,
        move_refusal,
    })
}

fn known_place(paths: &Paths, catalog_path: &str) -> Option<PathBuf> {
    Some(model_files::read(&paths.data).ok()?.get(catalog_path).map_or_else(|| paths.models.join(catalog_path), |p| p.at.clone()))
}

fn same_volume_of(pair: &Pair) -> bool {
    let target = pair.to.parent().map(Path::to_path_buf).unwrap_or_default();
    matches!((volume_root(&pair.from), volume_root(&target)), (Some(a), Some(b)) if a == b)
}

/// A file already at the destination that is the same file as the one to move (a copy an earlier try left).
fn identical_file(pair: &Pair) -> bool {
    let Ok(meta) = fs::metadata(&pair.from) else { return false };
    meta.modified().is_ok_and(|modified| identical(&pair.to, &Item { rel: PathBuf::new(), size: meta.len(), modified, hash: None }))
}

/// Puts the model's files where the plan says. The old places stay the model's until the new ones are written down;
/// `cancel` is looked at between two blocks.
pub fn run(paths: &Paths, plan: &Plan, cancel: &Cancel, progress: &mut dyn FnMut(&Progress)) -> Result<Report> {
    let found = preview(paths, plan)?;
    if let Some(why) = found.refusal.or(found.move_refusal) {
        let to = plan.pairs.first().map_or_else(|| paths.models.clone(), |p| p.to.clone());
        return Err(user_error(&why, to.display()));
    }
    run_with(paths, plan, false, found.free_bytes, cancel, progress)
}

/// `run`, with the room the new disk has and whether every file is copied even on the same volume (what a move to another
/// volume does), which is how that way is tried without another disk.
pub fn run_with(paths: &Paths, plan: &Plan, copy_all: bool, free: u64, cancel: &Cancel, progress: &mut dyn FnMut(&Progress)) -> Result<Report> {
    let copies: Vec<&Pair> = plan.pairs.iter().filter(|p| copy_all || !same_volume_of(p)).collect();
    let renames: Vec<&Pair> = plan.pairs.iter().filter(|p| !copies.iter().any(|c| std::ptr::eq(*c, *p))).collect();
    let items: Vec<(&Pair, Item)> = copies
        .iter()
        .map(|&pair| {
            let meta = fs::metadata(&pair.from).map_err(|e| io_error(tr!("Non riesco a leggere un file del modello.", "I can't read a model file."), &pair.from, e))?;
            Ok((pair, Item { rel: pair.from.clone(), size: meta.len(), modified: meta.modified()?, hash: recorded_hash(&pair.from) }))
        })
        .collect::<Result<_>>()?;
    let todo: u64 = items.iter().filter(|(p, item)| !identical(&p.to, item)).map(|(_, item)| item.size).sum();
    if let Some(dir) = items.first().and_then(|(p, _)| p.to.parent()) {
        enough_space(todo, free, dir)?;
    }

    let total_files = plan.pairs.len() as u64;
    let total_bytes: u64 = items.iter().map(|(_, i)| i.size + i.hash.as_ref().map_or(0, |_| i.size)).sum();
    let (mut done_bytes, mut copied_bytes) = (0u64, 0u64);
    for (i, (pair, item)) in items.iter().enumerate() {
        fs::create_dir_all(pair.to.parent().unwrap_or(Path::new(""))).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), &pair.to, e))?;
        let current = Some(pair.from.display().to_string());
        let mut tell = |stage: Stage, done: u64| progress(&Progress { stage, done_bytes: done, total_bytes, done_files: i as u64, total_files, current: current.clone() });
        if identical(&pair.to, item) {
            done_bytes += item.size + item.hash.as_ref().map_or(0, |_| item.size);
            tell(Stage::Copying, done_bytes);
            continue;
        }
        copied_bytes += copy_file(&pair.from, &pair.to, item, cancel, &mut done_bytes, &mut tell)?;
    }

    let mut moved: Vec<&Pair> = Vec::new();
    let undo = |moved: &[&Pair]| moved.iter().rev().filter(|p| fs::rename(&p.to, &p.from).is_err()).map(|p| p.from.display().to_string()).collect::<Vec<_>>();
    let outcome: Result<()> = (|| {
        for pair in &renames {
            if cancel.requested() {
                return Err(Cancelled.into());
            }
            progress(&Progress { stage: Stage::Moving, done_bytes: 0, total_bytes: 0, done_files: moved.len() as u64, total_files, current: Some(pair.from.display().to_string()) });
            fs::create_dir_all(pair.to.parent().unwrap_or(Path::new(""))).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), &pair.to, e))?;
            fs::rename(&pair.from, &pair.to).map_err(|e| io_error(tr!("Non riesco a spostare un file del modello.", "I can't move a model file."), &pair.from, e))?;
            moved.push(pair);
        }
        if !cancel.commit() {
            return Err(Cancelled.into());
        }
        let back_home = |catalog: &str, to: &Path| crate::models_dir::same(&paths.models.join(catalog), to);
        model_files::update(&paths.data, |all| {
            for (catalog, to) in &plan.places {
                match back_home(catalog, to) {
                    true => drop(all.remove(catalog)),
                    false => drop(all.insert(catalog.clone(), Place { at: to.clone(), own: true })),
                }
            }
        })
    })();
    if let Err(e) = outcome {
        let stuck = undo(&moved);
        return match stuck.is_empty() {
            true => Err(e),
            false => Err(stuck_error(&e, &stuck)),
        };
    }

    // The new places are written down: what was copied is the model's, and the old files go, one by one.
    let mut left = Vec::new();
    for (i, (pair, _)) in items.iter().enumerate() {
        progress(&Progress { stage: Stage::Removing, done_bytes: total_bytes, total_bytes, done_files: i as u64, total_files, current: Some(pair.from.display().to_string()) });
        if let Err(e) = fs::remove_file(&pair.from) {
            if e.kind() != std::io::ErrorKind::NotFound {
                left.push(pair.from.display().to_string());
            }
        }
    }
    // The folders of the models folder the files leave empty go too, up to the models folder itself; a link is never one of them.
    prune_empty(&paths.models, plan.pairs.iter().filter_map(|pair| below(&pair.from, &paths.models)));
    Ok(Report {
        method: if copies.is_empty() { Method::Rename } else { Method::Copy },
        files: total_files,
        bytes: plan.pairs.iter().map(|p| fs::metadata(&p.to).map_or(0, |m| m.len())).sum(),
        copied_bytes,
        left,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::sha256_file;
    use sha2::{Digest, Sha256};

    fn content(len: usize, seed: usize) -> Vec<u8> {
        (0..len).map(|i| ((i + seed) * 31 % 251) as u8).collect()
    }

    /// A catalog of two models that share an image encoder, one with its files, a note and a partial download, all in the
    /// models folder; plus a folder for the new place.
    struct Setup {
        _root: tempfile::TempDir,
        paths: Paths,
        fast: PathBuf,
    }

    const OLD: u64 = 1_704_164_645_678;

    impl Setup {
        fn new() -> Setup {
            let root = tempfile::tempdir().unwrap();
            let r = root.path();
            let paths = Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("models"), opencode: r.join("o"), data: r.join("data") };
            let (big, small, shared) = (content(6 << 20, 1), content(70_000, 2), content(50_000, 3));
            let hash = |b: &[u8]| crate::hex(&Sha256::digest(b));
            let file = |path: &str, bytes: &[u8]| serde_json::json!({ "path": path, "size": bytes.len(), "sha256": hash(bytes) });
            let catalog = serde_json::json!({ "models": {
                "big": { "label": "Big", "gguf": "Big-GGUF/big.gguf", "mmproj": "Shared/mm.gguf", "files": [ file("Big-GGUF/big.gguf", &big), file("Shared/mm.gguf", &shared) ] },
                "small": { "label": "Small", "gguf": "Small-GGUF/small.gguf", "mmproj": "Shared/mm.gguf", "files": [ file("Small-GGUF/small.gguf", &small), file("Shared/mm.gguf", &shared) ] },
                "other": { "label": "Other", "gguf": "Other/other.gguf", "files": [ file("Other/other.gguf", &small) ] }
            } });
            fs::create_dir_all(&paths.dist).unwrap();
            fs::create_dir_all(&paths.data).unwrap();
            fs::write(paths.dist.join("mango-models.json"), catalog.to_string()).unwrap();
            for (path, bytes) in [("Big-GGUF/big.gguf", &big), ("Small-GGUF/small.gguf", &small), ("Shared/mm.gguf", &shared), ("Other/other.gguf", &small)] {
                let at = paths.models.join(path);
                fs::create_dir_all(at.parent().unwrap()).unwrap();
                fs::write(&at, bytes).unwrap();
                let stamp = fs::File::options().write(true).open(&at).unwrap();
                stamp.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(OLD)).unwrap();
                fs::write(with_suffix(&at, ".verified"), serde_json::json!({ "sha256": hash(bytes), "size": bytes.len(), "modified_ms": OLD }).to_string()).unwrap();
            }
            fs::write(paths.models.join("Big-GGUF/big.gguf.part"), b"partial").unwrap();
            fs::create_dir_all(r.join("fast disk")).unwrap();
            Setup { fast: r.join("fast disk"), paths, _root: root }
        }

        fn run(&self, model: &str, to: Option<&Path>, copy_all: bool) -> Result<Report> {
            let plan = plan(&self.paths, model, to)?;
            run_with(&self.paths, &plan, copy_all, u64::MAX / 2, &Cancel::new(), &mut |_| {})
        }

        fn names(dir: &Path) -> Vec<String> {
            let mut all = Vec::new();
            let mut pending = vec![dir.to_path_buf()];
            while let Some(folder) = pending.pop() {
                for entry in fs::read_dir(&folder).unwrap().flatten() {
                    all.push(entry.path().strip_prefix(dir).unwrap().display().to_string());
                    if entry.file_type().unwrap().is_dir() {
                        pending.push(entry.path());
                    }
                }
            }
            all.sort();
            all
        }
    }

    /// The model's files go to the folder, with their notes and partial downloads; the other models' files are not touched,
    /// the encoder the two models share goes (both read it there), the catalog points at the new places, and the model
    /// is on the disk there.
    #[test]
    fn one_model_moves_and_the_others_stay_where_they_are() {
        let s = Setup::new();
        let others_before = (fs::read(s.paths.models.join("Small-GGUF/small.gguf")).unwrap(), fs::read(s.paths.models.join("Other/other.gguf")).unwrap());

        let report = s.run("big", Some(&s.fast), false).unwrap();

        assert_eq!((report.method, report.files, report.copied_bytes), (Method::Rename, 5, 0));
        assert_eq!(Setup::names(&s.fast), ["big.gguf", "big.gguf.part", "big.gguf.verified", "mm.gguf", "mm.gguf.verified"]);
        assert!(!s.paths.models.join("Big-GGUF").exists() && !s.paths.models.join("Shared").exists(), "the folders the files left are gone");
        assert_eq!((fs::read(s.paths.models.join("Small-GGUF/small.gguf")).unwrap(), fs::read(s.paths.models.join("Other/other.gguf")).unwrap()), others_before);
        let c = crate::catalog::read(&s.paths).unwrap();
        let at = s.fast.join("big.gguf").display().to_string();
        assert_eq!((c.root["models"]["big"]["gguf"].as_str(), c.root["models"]["big"]["files"][0]["relocated"].as_bool()), (Some(at.as_str()), Some(true)));
        assert_eq!(c.root["models"]["small"]["mmproj"], s.fast.join("mm.gguf").display().to_string(), "the model that shares the encoder reads it where it is now");
        assert_eq!(c.root["models"]["small"]["gguf"], "Small-GGUF/small.gguf");
        assert!(s.paths.models.join("Small-GGUF/small.gguf.verified").is_file());
        assert_eq!(crate::download::recorded_hash(&s.fast.join("big.gguf")).is_some(), true, "the note still holds");
    }

    /// The way to another volume, called directly: copied with the modification time, checked, the old files removed one by one
    /// after the new place is written down, the note valid, the partial download there.
    #[test]
    fn a_copy_to_another_volume_keeps_the_notes_valid_and_removes_the_old_files_last() {
        let s = Setup::new();
        let mut at_removal = None;
        let plan = plan(&s.paths, "big", Some(&s.fast)).unwrap();

        let report = run_with(&s.paths, &plan, true, u64::MAX / 2, &Cancel::new(), &mut |p| {
            if p.stage == Stage::Removing && at_removal.is_none() {
                at_removal = Some((model_files::read(&s.paths.data).unwrap().len(), s.paths.models.join("Big-GGUF/big.gguf").is_file()));
            }
        })
        .unwrap();

        assert_eq!(at_removal, Some((2, true)), "the places were written down while the old files were still there");
        assert!(report.copied_bytes >= 6 << 20 && report.left.is_empty(), "{report:?}");
        let new = s.fast.join("big.gguf");
        assert_eq!(fs::metadata(&new).unwrap().modified().unwrap(), std::time::UNIX_EPOCH + std::time::Duration::from_millis(OLD));
        assert_eq!(recorded_hash(&new).as_deref(), Some(sha256_file(&new).unwrap().as_str()));
        assert_eq!(fs::read(s.fast.join("big.gguf.part")).unwrap(), b"partial");
        assert!(!s.paths.models.join("Big-GGUF/big.gguf").exists());
        assert!(s.paths.models.join("Small-GGUF/small.gguf").is_file());
    }

    /// A move that is cancelled halfway, or that has not the room, leaves the model where it was and written down nowhere.
    #[test]
    fn a_cancelled_move_or_one_without_room_leaves_the_model_as_it_was() {
        let s = Setup::new();
        let before = Setup::names(&s.paths.models);
        let plan = plan(&s.paths, "big", Some(&s.fast)).unwrap();

        let error = run_with(&s.paths, &plan, true, 1 << 20, &Cancel::new(), &mut |_| {}).unwrap_err();
        assert!(error.is::<crate::download::NoSpace>(), "{error:#}");
        assert!(Setup::names(&s.fast).is_empty());

        let cancel = Cancel::new();
        let error = run_with(&s.paths, &plan, true, u64::MAX / 2, &cancel, &mut |p| {
            if p.done_bytes > 1 << 20 {
                cancel.request();
            }
        })
        .unwrap_err();
        assert!(error.is::<Cancelled>());
        assert_eq!(Setup::names(&s.paths.models), before);
        assert!(model_files::read(&s.paths.data).unwrap().is_empty());
        assert!(Setup::names(&s.fast).iter().all(|n| !n.ends_with(".mango-copy")), "{:?}", Setup::names(&s.fast));

        // The next try copies the whole model.
        let again = run_with(&s.paths, &plan, true, u64::MAX / 2, &Cancel::new(), &mut |_| {}).unwrap();
        assert!(again.copied_bytes < (6 << 20) + 200_000, "{again:?}");
        assert!(s.fast.join("big.gguf").is_file());
    }

    /// A locked file sends the renamed ones back and writes nothing down.
    #[test]
    fn a_locked_file_leaves_everything_in_its_place() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = Setup::new();
        let before = Setup::names(&s.paths.models);
        let _held = fs::OpenOptions::new().read(true).share_mode(1).open(s.paths.models.join("Shared/mm.gguf")).unwrap();

        let error = s.run("big", Some(&s.fast), false).unwrap_err();

        assert!(!error.is::<Cancelled>());
        assert_eq!(Setup::names(&s.paths.models), before);
        assert!(Setup::names(&s.fast).is_empty());
        assert!(model_files::read(&s.paths.data).unwrap().is_empty());
    }

    /// A cancel that cannot put every renamed file back is a failure that says so, not a plain cancel.
    #[test]
    fn a_cancel_that_leaves_a_file_in_the_new_place_is_a_failure_that_says_so() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = Setup::new();
        let plan = plan(&s.paths, "big", Some(&s.fast)).unwrap();
        let cancel = Cancel::new();
        let mut held = Vec::new();

        let error = run_with(&s.paths, &plan, false, u64::MAX / 2, &cancel, &mut |p| {
            if p.stage == Stage::Moving && p.done_files == 1 && held.is_empty() {
                let moved = Setup::names(&s.fast).into_iter().map(|n| s.fast.join(n)).find(|f| f.is_file()).unwrap();
                held.push(fs::OpenOptions::new().read(true).share_mode(1).open(moved).unwrap());
                assert!(cancel.request());
            }
        })
        .unwrap_err();

        assert!(!error.is::<Cancelled>(), "{error:#}");
        assert!(crate::user_phrase(&error).contains(&tr!("non è tornato", "did not go back")), "{error:#}");
    }

    /// A folder of the models folder that is a junction is not a folder the files left empty: it stays, whatever it points to.
    #[test]
    fn a_junction_that_the_files_leave_empty_is_not_removed() {
        use std::os::windows::process::CommandExt;
        let s = Setup::new();
        let behind = s._root.path().join("behind");
        fs::rename(s.paths.models.join("Big-GGUF"), &behind).unwrap();
        let link = s.paths.models.join("Big-GGUF");
        let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(&link).arg(&behind).creation_flags(crate::CREATE_NO_WINDOW).output().unwrap();
        assert!(made.status.success());

        s.run("big", Some(&s.fast), false).unwrap();

        assert!(fs::symlink_metadata(&link).is_ok_and(|m| crate::models_dir::is_link(&m)), "the junction is still there");
        assert!(behind.is_dir() && fs::read_dir(&behind).unwrap().next().is_none(), "and what it points to is empty, not removed");
        assert!(!s.paths.models.join("Shared").exists(), "a folder that was a plain one and is empty goes");
    }

    /// Back to the models folder: the files return to the catalog's paths and the model has no place of its own any more.
    #[test]
    fn a_model_goes_back_to_the_models_folder() {
        let s = Setup::new();
        s.run("big", Some(&s.fast), false).unwrap();

        s.run("big", None, false).unwrap();

        assert!(s.paths.models.join("Big-GGUF/big.gguf").is_file() && s.paths.models.join("Big-GGUF/big.gguf.part").is_file() && s.paths.models.join("Shared/mm.gguf").is_file());
        assert!(model_files::read(&s.paths.data).unwrap().is_empty());
        assert!(Setup::names(&s.fast).is_empty());
    }

    /// A file of the user's that is the very file of the model stays where it is; the preview says so, and refuses a folder
    /// that cannot be used.
    #[test]
    fn the_preview_changes_nothing_and_refuses_what_cannot_be_done() {
        let s = Setup::new();
        let before = Setup::names(&s.paths.models);

        let p = plan(&s.paths, "big", Some(&s.fast)).unwrap();
        let v = preview(&s.paths, &p).unwrap();
        assert_eq!((v.files, v.same_volume, v.refusal.is_none(), v.move_refusal.is_none()), (5, true, true, true));
        assert!(v.bytes > 6 << 20);
        assert_eq!(Setup::names(&s.paths.models), before);
        assert!(Setup::names(&s.fast).is_empty());

        fs::write(s.fast.join("big.gguf"), b"another file").unwrap();
        assert!(preview(&s.paths, &p).unwrap().refusal.is_some(), "a file with that name is there");
        fs::remove_file(s.fast.join("big.gguf")).unwrap();

        let accented = plan(&s.paths, "big", Some(&s.fast.join("Łukasz"))).unwrap();
        assert!(preview(&s.paths, &accented).unwrap().refusal.is_some(), "letters the engine cannot open");

        let home = plan(&s.paths, "big", None).unwrap();
        assert!(preview(&s.paths, &home).unwrap().refusal.is_some(), "it is already there");

        assert!(plan(&s.paths, "missing", Some(&s.fast)).is_err());
        let ours = s.paths.models.join("Other/other.gguf");
        model_files::update(&s.paths.data, |all| drop(all.insert("Other/other.gguf".into(), Place { at: ours.clone(), own: false }))).unwrap();
        let mine = plan(&s.paths, "other", Some(&s.fast)).unwrap();
        assert_eq!((mine.pairs.len(), mine.staying), (0, vec![ours.display().to_string()]));
    }
}
