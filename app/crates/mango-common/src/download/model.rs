//! Installing models from the catalog (`mango-models.json` plus the user's models, see `catalog`): the files in
//! `files` from Hugging Face, at a fixed revision, into `<models>/<path>`. Only the files the engine the model will
//! run on needs are downloaded (`catalog::file_for_engine`).

use super::{download_stoppable, hugging_face_url, part_path, sha256_file, with_suffix, RemoteFile};
use crate::catalog::file_for_engine;
use crate::{tr, user_text, Paths};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::UNIX_EPOCH;

#[derive(Deserialize)]
struct Catalog {
    models: BTreeMap<String, Model>,
}

#[derive(Deserialize)]
struct Model {
    repo: Option<String>,
    revision: Option<String>,
    #[serde(default)]
    files: Vec<ModelFile>,
}

/// A model file. Its own `repo` and `revision` are needed when they don't come from the model's repo.
#[derive(Deserialize)]
struct ModelFile {
    /// Where it lives in `<models>`; the file's name in the repo is the last piece, unless `name` says otherwise.
    path: String,
    /// The file's path in the repo, when it's in a folder of the repo.
    name: Option<String>,
    size: u64,
    /// Missing for a file on the user's computer, which isn't downloaded.
    #[serde(default)]
    sha256: String,
    repo: Option<String>,
    revision: Option<String>,
    /// The only engine that reads the file; without it, it serves all.
    engine: Option<String>,
}

/// The already verified hash of a file, written next to it: it saves rereading 18 GB every time. It holds as
/// long as size and modification time stay the same.
#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Verified {
    sha256: String,
    size: u64,
    modified_ms: u128,
}

/// Downloads the files of model `model` that `engine` needs (the engine folder: `llamacpp`, `prism`, `toq`) into
/// `paths.models` with the catalog's paths. A file already present and right (same size and hash) isn't downloaded
/// again; a different one is replaced. `progress(downloaded, total)` counts the bytes of the files still to
/// download. When `stop` becomes true the download ends with `Stopped` and what has arrived stays, to be resumed by the
/// next call or deleted with `discard_partial`.
pub fn install_model(paths: &Paths, model: &str, engine: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    install_from(paths, &hugging_face_url(), model, engine, stop, progress)
}

/// Deletes what an interrupted download of `model` for `engine` left behind (the `.part` files). A partial file that
/// another model uses too stays (`shared_with_others`): it may be arriving for that one.
pub fn discard_partial(paths: &Paths, model: &str, engine: &str, queued: &[String]) -> Result<()> {
    let (cat, m) = catalog_model(paths, model)?;
    let shared = shared_with_others(paths, &cat, &m, queued);
    for f in m.files.iter().filter(|f| file_for_engine(f.engine.as_deref(), engine) && !shared(&f.path)) {
        if let Some(dest) = inside(paths, &f.path) {
            remove_if_there(&part_path(&dest))?;
            remove_empty_folders(paths, &dest);
        }
    }
    Ok(())
}

/// Takes the files of `model` that `engine` reads off the disk, with what their download left next to them (the note
/// of the verified hash, a partial file), and the folders of the models folder they leave empty. A file that another
/// model uses too stays (`shared_with_others`). So does a file Mango Code never downloaded (`users_file`). The answer is
/// those of them that are on the disk.
pub fn remove_model(paths: &Paths, model: &str, engine: &str, queued: &[String]) -> Result<Vec<PathBuf>> {
    let (cat, m) = catalog_model(paths, model)?;
    let shared = shared_with_others(paths, &cat, &m, queued);
    let mut kept = Vec::new();
    for f in m.files.iter().filter(|f| file_for_engine(f.engine.as_deref(), engine)) {
        match inside(paths, &f.path).filter(|_| !f.sha256.is_empty()) {
            Some(dest) => {
                if !shared(&f.path) {
                    for file in [note_path(&dest), part_path(&dest), dest.clone()] {
                        remove_if_there(&file)?;
                    }
                    remove_empty_folders(paths, &dest);
                }
            }
            None => kept.extend(users_file(paths, &f.path, &f.sha256).filter(|p| p.is_file())),
        }
    }
    Ok(kept)
}

/// A file of the catalog that Mango Code never downloaded, so never deletes: one named without a hash (the user's own) or
/// with a path outside the models folder. The answer is where it is; `None` for a file Mango Code downloads, and for a
/// relative path with `..`, which is not followed, not even to say the file stays.
pub fn users_file(paths: &Paths, path: &str, sha256: &str) -> Option<PathBuf> {
    match inside(paths, path) {
        Some(_) if !sha256.is_empty() => None,
        _ => location(paths, path),
    }
}

/// The folders of `file` inside the models folder that are left empty, from the deepest up; the models folder stays,
/// and nothing outside it is touched. `remove_dir` takes only an empty folder: the first that still has something in it
/// ends the walk. One that is empty and still cannot go (open in File Explorer) ends it too, with a line in
/// `startup.log`: the files are gone already, the removal is not a failure for that.
fn remove_empty_folders(paths: &Paths, file: &Path) {
    let Ok(inner) = file.strip_prefix(&paths.models) else { return };
    for folder in inner.ancestors().skip(1).filter(|f| !f.as_os_str().is_empty()) {
        let folder = paths.models.join(folder);
        match fs::remove_dir(&folder) {
            Ok(()) => {}
            Err(e) if matches!(e.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::NotFound) => return,
            Err(e) => return crate::startup_log(paths, &format!("models: the empty folder {} stays: {e}", folder.display())),
        }
    }
}

/// Whether a file of `m` is another model's too, and that model needs it: it is among the downloads (`queued`: waiting,
/// paused, arriving), or it is on the disk. On the disk means a file of its own is there, whole or arriving, or all its
/// files are among those of `m` (then deleting them would take it away too).
/// The files are compared by where they are (`place`): a model of the user's can name with its absolute path a file that
/// a catalog model names relative to the models folder.
fn shared_with_others<'a>(paths: &'a Paths, cat: &'a Catalog, m: &'a Model, queued: &'a [String]) -> impl Fn(&str) -> bool + 'a {
    let mine: Vec<String> = m.files.iter().filter_map(|f| place(paths, &f.path)).collect();
    let on_disk = move |other: &Model| {
        let own: Vec<&ModelFile> = other.files.iter().filter(|f| place(paths, &f.path).is_none_or(|p| !mine.contains(&p))).collect();
        if own.is_empty() {
            return !other.files.is_empty();
        }
        own.iter().filter_map(|f| location(paths, &f.path)).any(|dest| dest.is_file() || part_path(&dest).is_file())
    };
    move |path: &str| {
        let Some(here) = place(paths, path) else { return false };
        cat.models
            .iter()
            .any(|(key, other)| other.files.iter().any(|f| place(paths, &f.path).as_ref() == Some(&here)) && (queued.contains(key) || on_disk(other)))
    }
}

/// Where a file of the catalog is: `<models>/<path>` for a relative path, the path itself for an absolute one (a model
/// of the user's); `None` for a relative path with `..`, which is not followed.
fn location(paths: &Paths, path: &str) -> Option<PathBuf> {
    inside(paths, path).or_else(|| Path::new(path).is_absolute().then(|| PathBuf::from(path)))
}

/// `location` as Windows compares it: `/` and `\` alike, the case of the letters ignored.
fn place(paths: &Paths, path: &str) -> Option<String> {
    let at = location(paths, path)?;
    Some(at.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>().join("/"))
}

/// The catalog without `model`, and `model`.
fn catalog_model(paths: &Paths, model: &str) -> Result<(Catalog, Model)> {
    let mut cat: Catalog = serde_json::from_value(crate::catalog::read(paths)?.root)
        .with_context(|| tr!("il catalogo dei modelli non è valido", "the model catalog is not valid"))?;
    let m = cat.models.remove(model).with_context(|| tr!("Questo modello non è nel catalogo.", "This model is not in the catalog."))?;
    Ok((cat, m))
}

/// `<models>/<path>`, only for a path made of plain names: an absolute one, or one with `..`, would reach outside the
/// models folder (a `user-models.json` written by hand can have them).
fn inside(paths: &Paths, path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    (p.components().count() > 0 && p.components().all(|c| matches!(c, Component::Normal(_)))).then(|| paths.models.join(p))
}

fn remove_if_there(file: &Path) -> Result<()> {
    match fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e).with_context(|| user_text(&tr!("Non riesco a togliere un file del modello: forse un altro programma lo sta usando.", "I can't remove a file of the model: another program may be using it."), file.display())),
        _ => Ok(()),
    }
}

fn install_from(paths: &Paths, base: &str, model: &str, engine: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let (_, m) = catalog_model(paths, model)?;
    if m.files.is_empty() {
        bail!(
            "{}",
            tr!(
                "il modello «{model}» non ha file da scaricare nel catalogo (non è pubblicato: va messo a mano in {})",
                "the model «{model}» has no files to download in the catalog (it isn't published: put it in {} by hand)",
                paths.models.display()
            )
        );
    }

    // The total counts every file, those already whole too: after a resume the bar goes on from where it was.
    let (mut to_do, mut total, mut before) = (Vec::new(), 0, 0);
    for mf in m.files.iter().filter(|f| file_for_engine(f.engine.as_deref(), engine)) {
        let dest = inside(paths, &mf.path).with_context(|| tr!("{}: un file del catalogo fuori dalla cartella dei modelli", "{}: a catalog file outside the models folder", mf.path))?;
        let name = mf.name.as_deref().or_else(|| mf.path.rsplit('/').next()).unwrap_or(&mf.path);
        let repo = mf
            .repo
            .as_deref()
            .or(m.repo.as_deref())
            .with_context(|| tr!("{}: nel catalogo manca il repo", "{}: the catalog has no repo", mf.path))?;
        let rev = mf
            .revision
            .as_deref()
            .or(m.revision.as_deref())
            .with_context(|| tr!("{}: nel catalogo manca la revisione", "{}: the catalog has no revision", mf.path))?;
        let remote = RemoteFile { url: format!("{base}/{repo}/resolve/{rev}/{name}"), size: mf.size, sha256: mf.sha256.clone() };
        total += remote.size;
        if already_verified(&dest, &remote)? {
            before += remote.size;
        } else {
            to_do.push((dest, remote));
        }
    }

    for (dest, remote) in &to_do {
        download_stoppable(remote, dest, stop, &mut |done, _| progress(before + done, total))?;
        write_verified(dest, &remote.sha256)?;
        before += remote.size;
    }
    Ok(())
}

/// `true` if `dest` is already the catalog's file. The size says no right away; if it matches, the hash is
/// computed just once (a file put there by hand, or downloaded by another tool) and recorded next to the file, so
/// the next times reading the note is enough.
fn already_verified(dest: &Path, f: &RemoteFile) -> Result<bool> {
    let Ok(meta) = fs::metadata(dest) else { return Ok(false) };
    if meta.len() != f.size {
        return Ok(false);
    }
    let note = note_path(dest);
    let expected = Verified { sha256: f.sha256.to_ascii_lowercase(), size: meta.len(), modified_ms: modified_ms(&meta)? };
    if fs::read_to_string(&note).ok().and_then(|t| serde_json::from_str::<Verified>(&t).ok()).is_some_and(|v| v == expected) {
        return Ok(true);
    }
    if sha256_file(dest)? == expected.sha256 {
        fs::write(&note, serde_json::to_string(&expected)?).with_context(|| user_text(&tr!("Non riesco a scrivere nella cartella dei modelli.", "I can't write in the models folder."), note.display()))?;
        return Ok(true);
    }
    Ok(false)
}

fn write_verified(dest: &Path, sha256: &str) -> Result<()> {
    let meta = fs::metadata(dest)?;
    let v = Verified { sha256: sha256.to_ascii_lowercase(), size: meta.len(), modified_ms: modified_ms(&meta)? };
    let note = note_path(dest);
    fs::write(&note, serde_json::to_string(&v)?).with_context(|| user_text(&tr!("Non riesco a scrivere nella cartella dei modelli.", "I can't write in the models folder."), note.display()))
}

fn note_path(dest: &Path) -> std::path::PathBuf {
    with_suffix(dest, ".verified")
}

fn modified_ms(meta: &fs::Metadata) -> Result<u128> {
    Ok(meta.modified()?.duration_since(UNIX_EPOCH)?.as_millis())
}

#[cfg(test)]
mod tests {
    use super::super::fake_server::{FakeServer, Route};
    use super::*;
    use sha2::{Digest, Sha256};

    fn sha(d: &[u8]) -> String {
        Sha256::digest(d).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn data(n: usize, seed: usize) -> Vec<u8> {
        (0..n).map(|i| ((i + seed) * 17 % 253) as u8).collect()
    }

    /// A distribution with one model (`m`, two files, the second from another repo) and one without
    /// downloadable files (`local`).
    fn dist(tmp: &Path, gguf: &[u8], mmproj: &[u8]) -> Paths {
        let catalog = format!(
            r#"{{ "models": {{
                "m": {{ "repo": "acme/m-GGUF", "revision": "rev1",
                        "files": [
                          {{ "path": "m-GGUF/m.gguf", "size": {}, "sha256": "{}" }},
                          {{ "path": "other-GGUF/mm.gguf", "size": {}, "sha256": "{}", "repo": "acme/other", "revision": "rev2" }}
                        ] }},
                "local": {{ "label": "homemade" }}
            }} }}"#,
            gguf.len(), sha(gguf), mmproj.len(), sha(mmproj)
        );
        fs::create_dir_all(tmp.join("dist")).unwrap();
        fs::write(tmp.join("dist").join("mango-models.json"), format!("\u{feff}{catalog}")).unwrap();
        Paths { dist: tmp.join("dist"), engines: tmp.join("engines"), models: tmp.join("models"), opencode: tmp.join("oc"), data: tmp.join("data") }
    }

    fn server(gguf: &[u8], mmproj: &[u8]) -> FakeServer {
        FakeServer::start([
            ("/acme/m-GGUF/resolve/rev1/m.gguf", Route::file(gguf.to_vec())),
            ("/acme/other/resolve/rev2/mm.gguf", Route::file(mmproj.to_vec())),
        ])
    }

    #[test]
    fn downloads_the_files_to_the_catalog_paths_and_does_not_download_them_again() {
        let (g, mm) = (data(1_500_000, 0), data(400_000, 5));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);

        let mut seen = Vec::new();
        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(fs::read(paths.models.join("m-GGUF/m.gguf")).unwrap(), g);
        assert_eq!(fs::read(paths.models.join("other-GGUF/mm.gguf")).unwrap(), mm);
        assert_eq!(seen.last(), Some(&(1_900_000, 1_900_000)), "progress adds up the files");
        assert_eq!(s.requests().len(), 2);

        // second time: everything present and right, no requests
        let mut seen = Vec::new();
        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |a, t| seen.push((a, t))).unwrap();
        assert_eq!(s.requests().len(), 2);
        assert!(seen.is_empty());
    }

    /// A download stopped halfway keeps what has arrived: the next call goes on from there, and `discard_partial`
    /// deletes it instead.
    #[test]
    fn a_stopped_download_resumes_from_where_it_was_or_is_discarded() {
        use std::sync::atomic::Ordering;
        let (g, mm) = (data(1_500_000, 0), data(400_000, 5));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        let part = paths.models.join("m-GGUF/m.gguf.part");

        let stop = AtomicBool::new(false);
        let err = install_from(&paths, &s.url, "m", "llamacpp", &stop, &mut |done, _| stop.store(done >= 300_000, Ordering::SeqCst)).unwrap_err();
        assert!(err.is::<super::super::Stopped>(), "{err:#}");
        let arrived = fs::metadata(&part).unwrap().len();
        assert!((300_000..1_500_000).contains(&arrived), "{arrived}");

        let mut first = None;
        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |done, _| {
            first.get_or_insert(done);
        })
        .unwrap();
        assert_eq!(first, Some(arrived), "the download goes on from the bytes that had arrived");
        assert_eq!(fs::read(paths.models.join("m-GGUF/m.gguf")).unwrap(), g);

        // A second model file stopped at once, then discarded: nothing of it is left.
        fs::remove_file(paths.models.join("other-GGUF/mm.gguf")).unwrap();
        let stop = AtomicBool::new(false);
        install_from(&paths, &s.url, "m", "llamacpp", &stop, &mut |_, _| stop.store(true, Ordering::SeqCst)).unwrap_err();
        assert!(paths.models.join("other-GGUF/mm.gguf.part").is_file());
        discard_partial(&paths, "m", "llamacpp", &[]).unwrap();
        assert!(!paths.models.join("other-GGUF/mm.gguf.part").exists());
        assert!(paths.models.join("m-GGUF/m.gguf").is_file(), "a whole file is not a partial one");
    }

    /// Taking a model off the disk deletes its files and what their download left; a file another model uses too
    /// stays, and so does one the catalog names without a hash (it is the user's own, never downloaded).
    #[test]
    fn removing_a_model_deletes_its_files_but_not_a_shared_one_nor_one_of_the_users() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "0".repeat(64);
        let catalog = format!(
            r#"{{ "models": {{
                "m": {{ "files": [ {{ "path": "m/m.gguf", "size": 1, "sha256": "{hash}" }}, {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "n": {{ "files": [ {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "mine": {{ "files": [ {{ "path": "mine/own.gguf", "size": 1 }} ] }}
            }} }}"#
        );
        fs::create_dir_all(tmp.path().join("dist")).unwrap();
        fs::write(tmp.path().join("dist").join("mango-models.json"), catalog).unwrap();
        let paths = Paths { dist: tmp.path().join("dist"), engines: tmp.path().join("engines"), models: tmp.path().join("models"), opencode: tmp.path().join("oc"), data: tmp.path().join("data") };
        for rel in ["m/m.gguf", "m/m.gguf.verified", "m/m.gguf.part", "shared/mm.gguf", "mine/own.gguf"] {
            fs::create_dir_all(paths.models.join(rel).parent().unwrap()).unwrap();
            fs::write(paths.models.join(rel), b"x").unwrap();
        }

        remove_model(&paths, "m", "llamacpp", &[]).unwrap();
        for rel in ["m/m.gguf", "m/m.gguf.verified", "m/m.gguf.part"] {
            assert!(!paths.models.join(rel).exists(), "{rel}");
        }
        assert!(paths.models.join("shared/mm.gguf").is_file(), "«n» reads it too");

        assert_eq!(remove_model(&paths, "mine", "llamacpp", &[]).unwrap(), [paths.models.join("mine/own.gguf")], "the answer names the files that stay");
        assert!(paths.models.join("mine/own.gguf").is_file(), "the user's own file is not Mango Code's to delete");
        // already gone: nothing to do, no error
        assert!(remove_model(&paths, "m", "llamacpp", &[]).unwrap().is_empty());
        assert!(remove_model(&paths, "ghost", "llamacpp", &[]).is_err());
    }

    /// The folders a removal or a cancel leaves empty go too, up to the models folder, which stays; a folder with
    /// something else in it stays.
    #[test]
    fn the_folders_left_empty_go_and_the_others_stay() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "0".repeat(64);
        let catalog = format!(
            r#"{{ "models": {{
                "hf": {{ "files": [ {{ "path": "owner/repo/hf.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "a": {{ "files": [ {{ "path": "a/a.gguf", "size": 1, "sha256": "{hash}" }} ] }}
            }} }}"#
        );
        let paths = dist_with(tmp.path(), &catalog);
        let put = |rel: &str| {
            fs::create_dir_all(paths.models.join(rel).parent().unwrap()).unwrap();
            fs::write(paths.models.join(rel), b"x").unwrap();
        };

        put("owner/repo/hf.gguf");
        put("owner/repo/hf.gguf.verified");
        remove_model(&paths, "hf", "llamacpp", &[]).unwrap();
        assert!(!paths.models.join("owner").exists(), "both folders of the model were left empty");
        assert!(paths.models.is_dir(), "the models folder stays");

        put("a/a.gguf.part");
        discard_partial(&paths, "a", "llamacpp", &[]).unwrap();
        assert!(!paths.models.join("a").exists(), "a cancel leaves no empty folder");

        put("a/a.gguf");
        put("a/notes.txt");
        remove_model(&paths, "a", "llamacpp", &[]).unwrap();
        assert!(paths.models.join("a/notes.txt").is_file(), "a folder with something else in it stays");
    }

    /// A model of the user's that names with its absolute path (other separators, other case) a file of a catalog model
    /// inside the models folder: removing the catalog model leaves the file, which the other one reads.
    #[test]
    fn a_file_named_by_its_absolute_path_is_shared_too() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "0".repeat(64);
        let models = tmp.path().join("models");
        let absolute = models.join("Qwen-GGUF").join("QWEN.GGUF").display().to_string();
        let catalog = format!(
            r#"{{ "models": {{
                "m": {{ "files": [ {{ "path": "Qwen-GGUF/qwen.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "mine": {{ "files": [ {{ "path": {}, "size": 1 }} ] }}
            }} }}"#,
            serde_json::to_string(&absolute).unwrap()
        );
        let paths = dist_with(tmp.path(), &catalog);
        fs::create_dir_all(paths.models.join("Qwen-GGUF")).unwrap();
        fs::write(paths.models.join("Qwen-GGUF/qwen.gguf"), b"x").unwrap();

        remove_model(&paths, "m", "llamacpp", &[]).unwrap();
        assert!(paths.models.join("Qwen-GGUF/qwen.gguf").is_file(), "«mine» reads it");
    }

    /// An empty folder that cannot go (open in File Explorer) stays and says so in `startup.log`; a file outside the
    /// models folder does not make the walk touch the folders around it.
    #[cfg(windows)]
    #[test]
    fn an_empty_folder_that_cannot_go_is_logged_and_nothing_outside_the_models_folder_is_touched() {
        use std::os::windows::fs::OpenOptionsExt;
        const BACKUP_SEMANTICS: u32 = 0x0200_0000; // what lets Windows open a folder
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist_with(tmp.path(), r#"{ "models": {} }"#);
        let held = paths.models.join("held").join("repo");
        fs::create_dir_all(&held).unwrap();
        let open = fs::OpenOptions::new().read(true).share_mode(0).custom_flags(BACKUP_SEMANTICS).open(&held).unwrap();
        remove_empty_folders(&paths, &held.join("m.gguf"));
        assert!(held.is_dir());
        let log = fs::read_to_string(paths.logs().join("startup.log")).unwrap();
        assert!(log.contains(&format!("the empty folder {} stays", held.display())), "{log}");
        drop(open);

        let outside = tmp.path().join("outside").join("empty");
        fs::create_dir_all(&outside).unwrap();
        remove_empty_folders(&paths, &outside.join("x.gguf"));
        assert!(outside.is_dir(), "a folder outside the models folder is never removed");
    }

    /// `3.8` and `toq` share the image encoder. Removing `3.8` takes it too when `toq` is not on the disk, and leaves it
    /// when `toq` is there, whole or arriving.
    #[test]
    fn a_shared_file_goes_with_the_model_unless_the_other_one_is_on_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "0".repeat(64);
        let catalog = format!(
            r#"{{ "models": {{
                "a": {{ "files": [ {{ "path": "a/a.gguf", "size": 1, "sha256": "{hash}" }}, {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "b": {{ "files": [ {{ "path": "b/b.gguf", "size": 1, "sha256": "{hash}" }}, {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }}
            }} }}"#
        );
        let paths = dist_with(tmp.path(), &catalog);
        let put = |rel: &str| {
            fs::create_dir_all(paths.models.join(rel).parent().unwrap()).unwrap();
            fs::write(paths.models.join(rel), b"x").unwrap();
        };

        put("a/a.gguf");
        put("shared/mm.gguf");
        remove_model(&paths, "a", "llamacpp", &[]).unwrap();
        assert!(!paths.models.join("shared/mm.gguf").exists(), "«b» was never downloaded");

        for b in ["b/b.gguf.part", "b/b.gguf"] {
            put("a/a.gguf");
            put("shared/mm.gguf");
            put(b);
            remove_model(&paths, "a", "llamacpp", &[]).unwrap();
            assert!(paths.models.join("shared/mm.gguf").is_file(), "with {b} on the disk «b» reads it");
            assert!(!paths.models.join("a/a.gguf").exists());
            fs::remove_file(paths.models.join(b)).unwrap();
        }

        // «b» is among the downloads, nothing of it on the disk yet: the shared file stays for it.
        put("a/a.gguf");
        remove_model(&paths, "a", "llamacpp", &["b".to_string()]).unwrap();
        assert!(paths.models.join("shared/mm.gguf").is_file());
    }

    /// Cancelling `toq` while `3.8` downloads the image encoder they share: the shared partial file stays for `3.8`,
    /// the one of `toq` alone goes. Without the other model in the queue or on the disk, the shared one goes too.
    #[test]
    fn a_cancel_leaves_a_shared_partial_file_to_the_model_that_needs_it() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "0".repeat(64);
        let catalog = format!(
            r#"{{ "models": {{
                "a": {{ "files": [ {{ "path": "a/a.gguf", "size": 1, "sha256": "{hash}" }}, {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }},
                "b": {{ "files": [ {{ "path": "b/b.gguf", "size": 1, "sha256": "{hash}" }}, {{ "path": "shared/mm.gguf", "size": 1, "sha256": "{hash}" }} ] }}
            }} }}"#
        );
        let paths = dist_with(tmp.path(), &catalog);
        let put = |rel: &str| {
            fs::create_dir_all(paths.models.join(rel).parent().unwrap()).unwrap();
            fs::write(paths.models.join(rel), b"x").unwrap();
        };

        put("a/a.gguf.part");
        put("shared/mm.gguf.part");
        discard_partial(&paths, "a", "llamacpp", &["b".to_string()]).unwrap();
        assert!(!paths.models.join("a/a.gguf.part").exists());
        assert!(paths.models.join("shared/mm.gguf.part").is_file(), "«b» is downloading it");

        put("b/b.gguf");
        discard_partial(&paths, "a", "llamacpp", &[]).unwrap();
        assert!(paths.models.join("shared/mm.gguf.part").is_file(), "«b» is on the disk");

        fs::remove_file(paths.models.join("b/b.gguf")).unwrap();
        discard_partial(&paths, "a", "llamacpp", &[]).unwrap();
        assert!(!paths.models.join("shared/mm.gguf.part").exists(), "nobody needs it");
    }

    /// A hand-written `user-models.json` can name a file outside the models folder, with a hash too: it is not deleted,
    /// and the answer names it.
    #[test]
    fn a_file_outside_the_models_folder_is_never_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.gguf");
        fs::write(&outside, b"x").unwrap();
        let hash = "0".repeat(64);
        let catalog = format!(
            r#"{{ "models": {{ "u": {{ "files": [
                {{ "path": "../outside.gguf", "size": 1, "sha256": "{hash}" }},
                {{ "path": {}, "size": 1, "sha256": "{hash}" }}
            ] }} }} }}"#,
            serde_json::to_string(&outside.display().to_string()).unwrap()
        );
        let paths = dist_with(tmp.path(), &catalog);
        fs::create_dir_all(&paths.models).unwrap();

        let kept = remove_model(&paths, "u", "llamacpp", &[]).unwrap();

        assert!(outside.is_file());
        assert_eq!(kept, [outside.clone()], "the absolute path names the file; the one with «..» is not even looked at");
        discard_partial(&paths, "u", "llamacpp", &[]).unwrap();

        // The same rule says which files of a model are the user's before removing it.
        let absolute = outside.display().to_string();
        assert_eq!(users_file(&paths, &absolute, &hash), Some(outside.clone()));
        assert_eq!(users_file(&paths, "../outside.gguf", &hash), None);
        assert_eq!(users_file(&paths, "mine/own.gguf", ""), Some(paths.models.join("mine/own.gguf")));
        assert_eq!(users_file(&paths, "m/m.gguf", &hash), None, "Mango Code downloads it");
    }

    /// A resumed download whose first file is already whole: the bar starts from the bytes already on the disk, out of
    /// the whole model, and does not go back.
    #[test]
    fn after_a_resume_the_progress_counts_the_files_already_whole() {
        let (g, mm) = (data(300_000, 1), data(200_000, 2));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        fs::create_dir_all(paths.models.join("m-GGUF")).unwrap();
        fs::write(paths.models.join("m-GGUF/m.gguf"), &g).unwrap();

        let mut seen = Vec::new();
        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(seen.first(), Some(&(300_000, 500_000)));
        assert_eq!(seen.last(), Some(&(500_000, 500_000)));
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
    }

    #[test]
    fn a_hand_placed_right_file_is_not_downloaded_again_and_is_recorded() {
        let (g, mm) = (data(300_000, 1), data(200_000, 2));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        for (rel, d) in [("m-GGUF/m.gguf", &g), ("other-GGUF/mm.gguf", &mm)] {
            fs::create_dir_all(paths.models.join(rel).parent().unwrap()).unwrap();
            fs::write(paths.models.join(rel), d).unwrap();
        }

        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

        assert!(s.requests().is_empty());
        assert!(paths.models.join("m-GGUF/m.gguf.verified").is_file(), "the verified hash is recorded");
    }

    #[test]
    fn a_file_of_the_right_size_but_different_is_replaced() {
        let (g, mm) = (data(300_000, 1), data(200_000, 2));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        let mut crooked = g.clone();
        crooked[77] ^= 0xff;
        fs::create_dir_all(paths.models.join("m-GGUF")).unwrap();
        fs::write(paths.models.join("m-GGUF/m.gguf"), &crooked).unwrap();

        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(paths.models.join("m-GGUF/m.gguf")).unwrap(), g);
        assert_eq!(s.requests().len(), 2);
    }

    #[test]
    fn a_file_modified_after_the_verification_is_reread() {
        let (g, mm) = (data(300_000, 1), data(200_000, 2));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(s.requests().len(), 2);

        // same size, one byte changed later: the note no longer holds
        std::thread::sleep(std::time::Duration::from_millis(20));
        let p = paths.models.join("m-GGUF/m.gguf");
        let mut crooked = g.clone();
        crooked[5] ^= 1;
        fs::write(&p, &crooked).unwrap();

        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&p).unwrap(), g);
        assert_eq!(s.requests().len(), 3);
    }

    /// A file with `engine` serves only that engine: each PC downloads the weights its engine reads, plus the
    /// files common to all.
    #[test]
    fn only_the_engines_files_are_downloaded() {
        let (common, for_a, for_b) = (data(10_000, 1), data(20_000, 2), data(30_000, 3));
        let catalog = format!(
            r#"{{ "models": {{ "v": {{ "repo": "acme/v", "revision": "r",
                "files": [
                  {{ "path": "v/a.gguf", "size": {}, "sha256": "{}", "engine": "a" }},
                  {{ "path": "v/b.gguf", "size": {}, "sha256": "{}", "engine": "b" }},
                  {{ "path": "v/mm.gguf", "size": {}, "sha256": "{}" }}
                ] }} }} }}"#,
            for_a.len(), sha(&for_a), for_b.len(), sha(&for_b), common.len(), sha(&common)
        );
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &[], &[]);
        fs::write(paths.dist.join("mango-models.json"), catalog).unwrap();
        let s = FakeServer::start([
            ("/acme/v/resolve/r/a.gguf", Route::file(for_a.clone())),
            ("/acme/v/resolve/r/b.gguf", Route::file(for_b)),
            ("/acme/v/resolve/r/mm.gguf", Route::file(common.clone())),
        ]);

        let mut seen = Vec::new();
        install_from(&paths, &s.url, "v", "a", &AtomicBool::new(false), &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(fs::read(paths.models.join("v/a.gguf")).unwrap(), for_a);
        assert_eq!(fs::read(paths.models.join("v/mm.gguf")).unwrap(), common);
        assert!(!paths.models.join("v/b.gguf").exists(), "the other engine's file is not downloaded");
        assert_eq!(s.requests().len(), 2);
        assert_eq!(seen.last(), Some(&(30_000, 30_000)), "the total counts only the engine's files");
    }

    /// A distribution with only the catalog `catalog`.
    fn dist_with(tmp: &Path, catalog: &str) -> Paths {
        fs::create_dir_all(tmp.join("dist")).unwrap();
        fs::write(tmp.join("dist").join("mango-models.json"), catalog).unwrap();
        Paths { dist: tmp.join("dist"), engines: tmp.join("engines"), models: tmp.join("models"), opencode: tmp.join("oc"), data: tmp.join("data") }
    }

    #[test]
    fn a_file_in_a_folder_of_the_repo_is_downloaded_from_its_path() {
        let d = data(200_000, 3);
        let s = FakeServer::start([("/acme/m/resolve/rev1/Q4/m-00001.gguf", Route::file(d.clone()))]);
        let tmp = tempfile::tempdir().unwrap();
        let catalog = format!(
            r#"{{ "models": {{ "m": {{ "repo": "acme/m", "revision": "rev1",
                "files": [ {{ "path": "acme/m/Q4/m-00001.gguf", "name": "Q4/m-00001.gguf", "size": {}, "sha256": "{}" }} ] }} }} }}"#,
            d.len(),
            sha(&d)
        );
        let paths = dist_with(tmp.path(), &catalog);

        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(paths.models.join("acme/m/Q4/m-00001.gguf")).unwrap(), d);
    }

    #[test]
    fn a_model_already_on_disk_without_a_hash_does_not_break_the_catalog() {
        let d = data(100_000, 4);
        let s = FakeServer::start([("/acme/m/resolve/rev1/m.gguf", Route::file(d.clone()))]);
        let tmp = tempfile::tempdir().unwrap();
        let catalog = format!(
            r#"{{ "models": {{
                "m": {{ "repo": "acme/m", "revision": "rev1", "files": [ {{ "path": "m.gguf", "size": {}, "sha256": "{}" }} ] }},
                "local-mine": {{ "gguf": "C:\\elsewhere\\mine.gguf", "files": [ {{ "path": "C:\\elsewhere\\mine.gguf", "size": 123456 }} ] }}
            }} }}"#,
            d.len(),
            sha(&d)
        );
        let paths = dist_with(tmp.path(), &catalog);

        install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(paths.models.join("m.gguf")).unwrap(), d);
    }

    #[test]
    fn clear_errors_for_an_unknown_model_no_files_and_a_server_that_lacks_the_file() {
        let (g, mm) = (data(1000, 1), data(1000, 2));
        let s = FakeServer::start([]);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);

        let err = install_from(&paths, &s.url, "nonexistent", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap_err().to_string();
        assert_eq!(err, tr!("Questo modello non è nel catalogo.", "This model is not in the catalog."));

        let err = install_from(&paths, &s.url, "local", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("local") && err.contains(&tr!("non ha file", "has no files")), "{err}");

        let err = format!("{:#}", install_from(&paths, &s.url, "m", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap_err());
        assert!(err.contains("404"), "{err}");
        assert!(!paths.models.join("m-GGUF/m.gguf").exists());
    }
}
