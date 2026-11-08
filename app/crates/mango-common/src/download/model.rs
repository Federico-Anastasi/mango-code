//! Installing models from the catalog (`mango-models.json` plus the user's models, see `catalog`): the files in
//! `files` from Hugging Face, at a fixed revision, into `<models>/<path>`. Only the files the engine the model will
//! run on needs are downloaded (`catalog::file_for_engine`).

use super::{download, sha256_file, with_suffix, RemoteFile};
use crate::catalog::file_for_engine;
use crate::{tr, Paths};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

const HUGGING_FACE: &str = "https://huggingface.co";

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
/// download.
pub fn install_model(paths: &Paths, model: &str, engine: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    install_from(paths, HUGGING_FACE, model, engine, progress)
}

fn install_from(paths: &Paths, base: &str, model: &str, engine: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let mut cat: Catalog = serde_json::from_value(crate::catalog::read(paths)?.root)
        .with_context(|| tr!("il catalogo dei modelli non è valido", "the model catalog is not valid"))?;
    let m = cat
        .models
        .remove(model)
        .with_context(|| tr!("il modello «{model}» non è nel catalogo", "the model «{model}» is not in the catalog"))?;
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

    let mut to_do = Vec::new();
    for mf in m.files.iter().filter(|f| file_for_engine(f.engine.as_deref(), engine)) {
        let dest = paths.models.join(&mf.path);
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
        if !already_verified(&dest, &remote)? {
            to_do.push((dest, remote));
        }
    }

    let total: u64 = to_do.iter().map(|(_, r)| r.size).sum();
    let mut before = 0;
    for (dest, remote) in &to_do {
        download(remote, dest, &mut |done, _| progress(before + done, total))?;
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
        fs::write(&note, serde_json::to_string(&expected)?).with_context(|| tr!("non riesco a scrivere {}", "can't write {}", note.display()))?;
        return Ok(true);
    }
    Ok(false)
}

fn write_verified(dest: &Path, sha256: &str) -> Result<()> {
    let meta = fs::metadata(dest)?;
    let v = Verified { sha256: sha256.to_ascii_lowercase(), size: meta.len(), modified_ms: modified_ms(&meta)? };
    let note = note_path(dest);
    fs::write(&note, serde_json::to_string(&v)?).with_context(|| tr!("non riesco a scrivere {}", "can't write {}", note.display()))
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
        install_from(&paths, &s.url, "m", "llamacpp", &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(fs::read(paths.models.join("m-GGUF/m.gguf")).unwrap(), g);
        assert_eq!(fs::read(paths.models.join("other-GGUF/mm.gguf")).unwrap(), mm);
        assert_eq!(seen.last(), Some(&(1_900_000, 1_900_000)), "progress adds up the files");
        assert_eq!(s.requests().len(), 2);

        // second time: everything present and right, no requests
        let mut seen = Vec::new();
        install_from(&paths, &s.url, "m", "llamacpp", &mut |a, t| seen.push((a, t))).unwrap();
        assert_eq!(s.requests().len(), 2);
        assert!(seen.is_empty());
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

        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();

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

        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(paths.models.join("m-GGUF/m.gguf")).unwrap(), g);
        assert_eq!(s.requests().len(), 2);
    }

    #[test]
    fn a_file_modified_after_the_verification_is_reread() {
        let (g, mm) = (data(300_000, 1), data(200_000, 2));
        let s = server(&g, &mm);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);
        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();
        assert_eq!(s.requests().len(), 2);

        // same size, one byte changed later: the note no longer holds
        std::thread::sleep(std::time::Duration::from_millis(20));
        let p = paths.models.join("m-GGUF/m.gguf");
        let mut crooked = g.clone();
        crooked[5] ^= 1;
        fs::write(&p, &crooked).unwrap();

        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();

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
        install_from(&paths, &s.url, "v", "a", &mut |a, t| seen.push((a, t))).unwrap();

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

        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();

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

        install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(paths.models.join("m.gguf")).unwrap(), d);
    }

    #[test]
    fn clear_errors_for_an_unknown_model_no_files_and_a_server_that_lacks_the_file() {
        let (g, mm) = (data(1000, 1), data(1000, 2));
        let s = FakeServer::start([]);
        let tmp = tempfile::tempdir().unwrap();
        let paths = dist(tmp.path(), &g, &mm);

        let err = install_from(&paths, &s.url, "nonexistent", "llamacpp", &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("nonexistent") && err.contains(&tr!("catalogo", "catalog")), "{err}");

        let err = install_from(&paths, &s.url, "local", "llamacpp", &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("local") && err.contains(&tr!("non ha file", "has no files")), "{err}");

        let err = format!("{:#}", install_from(&paths, &s.url, "m", "llamacpp", &mut |_, _| {}).unwrap_err());
        assert!(err.contains("404"), "{err}");
        assert!(!paths.models.join("m-GGUF/m.gguf").exists());
    }
}
