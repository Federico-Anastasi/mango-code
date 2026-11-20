//! Where the files of a catalog model are when they are not in the models folder: `<data>\model-files.json`, a map from the
//! path a file has in the catalog to where it is on the disk. The catalog (`catalog::read`) applies it, so every reader of
//! a model's paths (the engine's plan, the downloads, the sizes, the removal) finds the file where it is.
//!
//! A place is Mango Code's own (`own`: the user moved the downloaded file there; removing the model deletes it, and a
//! download goes there) or the user's (a file chosen on the computer that is the very file of a catalog model; it is never
//! deleted and never downloaded).

use crate::{tr, user_error, user_text};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "model-files.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub at: PathBuf,
    pub own: bool,
}

/// The catalog path of each file that is somewhere else, and where.
pub type Places = BTreeMap<String, Place>;

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct File {
    files: Places,
}

pub fn read(data: &Path) -> Result<Places> {
    let file = data.join(FILE);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Places::new()),
        Err(e) => return Err(user_error(&unreadable(), format!("{}: {e}", file.display()))),
    };
    serde_json::from_str::<File>(text.trim_start_matches('\u{feff}')).map(|f| f.files).map_err(|e| user_error(&invalid(), format!("{}: {e}", file.display())))
}

/// One update at a time: the file is read, changed and written through a temporary name that two updates would share.
static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Changes the map and saves it whole or not at all; an empty map removes the file. A map that cannot be read is not
/// written over.
pub fn update(data: &Path, change: impl FnOnce(&mut Places)) -> Result<()> {
    let _one = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let mut places = read(data)?;
    let before = places.clone();
    change(&mut places);
    if places == before {
        return Ok(());
    }
    let file = data.join(FILE);
    let saved = match places.is_empty() {
        true => match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
        false => std::fs::create_dir_all(data).and_then(|_| crate::write_durable(&file, serde_json::to_string_pretty(&File { files: places })?)),
    };
    saved.map_err(|e| anyhow::Error::new(e).context(user_text(&tr!("Non riesco a salvare dove stanno i file dei modelli.", "I can't save where the model files are."), file.display())))
}

fn unreadable() -> String {
    tr!("Non riesco a leggere dove stanno i file dei modelli ({FILE}).", "I can't read where the model files are ({FILE}).")
}

fn invalid() -> String {
    tr!("Il file che dice dove stanno i file dei modelli ({FILE}) non è valido: correggilo o toglilo.", "The file that says where the model files are ({FILE}) is not valid: fix it or remove it.")
}

/// Points the files of `model` (an entry of the catalog) at the places in `places`. The name a file has in its repo stays
/// (a download asks for that name, whatever the file is called here); a file of the user's has no hash: Mango Code never
/// downloads or deletes it.
pub(crate) fn apply(model: &mut Value, places: &Places) {
    let at = |path: &str| places.get(path).map(|p| p.at.display().to_string());
    for field in ["gguf", "mmproj"] {
        if let Some(at) = model.get(field).and_then(Value::as_str).and_then(at) {
            model[field] = at.into();
        }
    }
    for field in ["diffusion", "encoder", "vae"] {
        if let Some(at) = model.pointer(&format!("/image/{field}")).and_then(Value::as_str).and_then(at) {
            model["image"][field] = at.into();
        }
    }
    let listed = model.get_mut("files").and_then(Value::as_array_mut).into_iter().flatten();
    for file in listed.filter_map(Value::as_object_mut) {
        let Some(path) = file.get("path").and_then(Value::as_str).map(str::to_string) else { continue };
        let Some(place) = places.get(&path) else { continue };
        file.entry("name").or_insert_with(|| path.rsplit('/').next().unwrap_or(&path).into());
        file.insert("path".into(), place.at.display().to_string().into());
        match place.own {
            true => file.insert("relocated".into(), true.into()),
            false => file.remove("sha256"),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn place(at: &str, own: bool) -> Place {
        Place { at: PathBuf::from(at), own }
    }

    #[test]
    fn the_map_is_saved_whole_and_an_empty_one_removes_the_file() {
        let data = tempfile::tempdir().unwrap();
        assert!(read(data.path()).unwrap().is_empty());

        update(data.path(), |p| drop(p.insert("A/a.gguf".into(), place(r"D:\fast\a.gguf", true)))).unwrap();
        update(data.path(), |p| drop(p.insert("B/b.gguf".into(), place(r"E:\mine\b.gguf", false)))).unwrap();
        assert_eq!(read(data.path()).unwrap().len(), 2);
        assert!(!data.path().join("model-files.json.tmp").exists());

        update(data.path(), |p| p.clear()).unwrap();
        assert!(!data.path().join(FILE).exists());
    }

    /// Updates made at the same time do not lose one another and do not trip over the temporary file they are written through.
    #[test]
    fn updates_made_at_the_same_time_are_all_kept() {
        let data = tempfile::tempdir().unwrap();
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let data = data.path().to_path_buf();
                std::thread::spawn(move || (0..10).for_each(|j| update(&data, |p| drop(p.insert(format!("M{i}/f{j}.gguf"), place(r"D:\x.gguf", true)))).unwrap()))
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(read(data.path()).unwrap().len(), 160);
    }

    #[test]
    fn a_map_that_cannot_be_understood_is_an_error_and_is_not_written_over() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join(FILE), "{ not json").unwrap();
        assert!(read(data.path()).is_err());
        assert!(update(data.path(), |p| drop(p.insert("A".into(), place("D:\\a", true)))).is_err());
        assert_eq!(std::fs::read_to_string(data.path().join(FILE)).unwrap(), "{ not json");
    }

    /// The model's paths point at the places; its own files keep their hash and are marked, the user's lose it; the name in
    /// the repo stays; a file that is not in the map, or another model's, is not touched.
    #[test]
    fn the_catalog_entry_points_at_the_places() {
        let mut model = json!({
            "gguf": "G/m.gguf", "mmproj": "G/mm.gguf",
            "files": [
                { "path": "G/m.gguf", "size": 10, "sha256": "aa" },
                { "path": "G/mm.gguf", "size": 5, "sha256": "bb", "name": "sub/mm.gguf" },
                { "path": "G/other.gguf", "size": 5, "sha256": "cc" }
            ]
        });
        let places = Places::from([("G/m.gguf".into(), place(r"D:\fast\m.gguf", true)), ("G/mm.gguf".into(), place(r"E:\mine\mm.gguf", false))]);

        apply(&mut model, &places);

        assert_eq!((model["gguf"].as_str(), model["mmproj"].as_str()), (Some(r"D:\fast\m.gguf"), Some(r"E:\mine\mm.gguf")));
        assert_eq!(model["files"][0], json!({ "path": r"D:\fast\m.gguf", "size": 10, "sha256": "aa", "name": "m.gguf", "relocated": true }));
        assert_eq!(model["files"][1], json!({ "path": r"E:\mine\mm.gguf", "size": 5, "name": "sub/mm.gguf" }));
        assert_eq!(model["files"][2], json!({ "path": "G/other.gguf", "size": 5, "sha256": "cc" }));
    }

    #[test]
    fn the_files_of_a_model_that_makes_pictures_are_pointed_at_too() {
        let mut model = json!({ "image": { "diffusion": "p-d.gguf", "encoder": "p-e.gguf", "vae": "p-v.safetensors", "steps": 4 }, "files": [ { "path": "p-d.gguf", "size": 1, "sha256": "aa" } ] });
        apply(&mut model, &Places::from([("p-d.gguf".into(), place(r"D:\p-d.gguf", true))]));
        assert_eq!(model["image"], json!({ "diffusion": r"D:\p-d.gguf", "encoder": "p-e.gguf", "vae": "p-v.safetensors", "steps": 4 }));
    }
}
