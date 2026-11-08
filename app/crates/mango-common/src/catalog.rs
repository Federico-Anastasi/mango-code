//! The model catalog as the app sees it: the recommended models of `<dist>/mango-models.json` plus, if it exists,
//! the user's own from `<data>/user-models.json` (same format as the entries of `models`). The user's models are
//! added to the Mango Code catalog and don't replace it: a key that is already taken is an error.

use crate::{tr, user_error, Paths};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The user's models file, in the app's data dir.
pub const USER_FILE: &str = "user-models.json";

/// The merged catalog: the root of `mango-models.json` with the user's entries also in `models`.
#[derive(Debug)]
pub struct ModelCatalog {
    pub root: Value,
    /// The keys that come from the user's file, in alphabetical order.
    pub user: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserModelsFile {
    models: BTreeMap<String, Value>,
}

/// A model file with `engine` in the catalog serves only that engine (weights in a format only it reads, or the
/// variant for the general engine); without it, it serves every engine.
pub fn file_for_engine(file_engine: Option<&str>, engine: &str) -> bool {
    file_engine.is_none_or(|m| m == engine)
}

pub fn read(paths: &Paths) -> Result<ModelCatalog> {
    let f = paths.dist.join("mango-models.json");
    let txt = std::fs::read_to_string(&f).map_err(|e| {
        user_error(
            &tr!("Non riesco a leggere l'elenco dei modelli di Mango Code. Reinstalla l'applicazione.", "I can't read the Mango Code model list. Reinstall the application."),
            format!("{}: {e}", f.display()),
        )
    })?;
    let mut root: Value = serde_json::from_str(txt.trim_start_matches('\u{feff}')).map_err(|e| {
        user_error(
            &tr!("L'elenco dei modelli di Mango Code è danneggiato. Reinstalla l'applicazione.", "The Mango Code model list is damaged. Reinstall the application."),
            format!("{}: {e}", f.display()),
        )
    })?;

    let fu = paths.data.join(USER_FILE);
    let Some(txt) = (match std::fs::read_to_string(&fu) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(user_error(&cannot_read_user_list(), format!("{}: {e}", fu.display()))),
    }) else {
        return Ok(ModelCatalog { root, user: Vec::new() });
    };
    let user: UserModelsFile = serde_json::from_str(txt.trim_start_matches('\u{feff}'))
        .map_err(|e| user_error(&invalid_user_list(), format!("{}: {e}", fu.display())))?;
    let models: &mut Map<String, Value> = root.get_mut("models").and_then(Value::as_object_mut).ok_or_else(|| {
        user_error(
            &tr!("L'elenco dei modelli di Mango Code è danneggiato. Reinstalla l'applicazione.", "The Mango Code model list is damaged. Reinstall the application."),
            format!("{}: missing «models»", f.display()),
        )
    })?;
    let keys: Vec<String> = user.models.keys().cloned().collect();
    for (key, entry) in user.models {
        if models.contains_key(&key) {
            return Err(user_error(&key_taken(&key), format!("{}: key «{key}» already in the catalog", fu.display())));
        }
        models.insert(key, entry);
    }
    Ok(ModelCatalog { root, user: keys })
}

/// Adds (or replaces) the entry `key` in the user's list. A key that is already a Mango Code model is an error,
/// and a list that can't be read is not overwritten.
pub fn add_user(paths: &Paths, key: &str, entry: Value) -> Result<()> {
    let mut list = read_user_list(paths)?;
    let root = read(paths)?.root;
    if root["models"].get(key).is_some() && !list.contains_key(key) {
        return Err(user_error(&key_taken(key), format!("key «{key}» already in the catalog")));
    }
    list.insert(key.to_string(), entry);
    write_user_list(paths, list)
}

/// Removes the entry `key` from the user's list (the weights on disk stay where they are).
pub fn remove_user(paths: &Paths, key: &str) -> Result<()> {
    let mut list = read_user_list(paths)?;
    if list.remove(key).is_none() {
        return Err(user_error(
            &tr!("«{key}» non è nel tuo elenco di modelli.", "«{key}» is not in your model list."),
            format!("{}: missing «{key}»", paths.data.join(USER_FILE).display()),
        ));
    }
    write_user_list(paths, list)
}

fn read_user_list(paths: &Paths) -> Result<BTreeMap<String, Value>> {
    let f = paths.data.join(USER_FILE);
    let txt = match std::fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(user_error(&cannot_read_user_list(), format!("{}: {e}", f.display()))),
    };
    let user: UserModelsFile =
        serde_json::from_str(txt.trim_start_matches('\u{feff}')).map_err(|e| user_error(&invalid_user_list(), format!("{}: {e}", f.display())))?;
    Ok(user.models)
}

/// Writes the list to a file next to it and renames it: either the old one is there, or the whole new one.
fn write_user_list(paths: &Paths, models: BTreeMap<String, Value>) -> Result<()> {
    let f = paths.data.join(USER_FILE);
    let tmp = paths.data.join(format!("{USER_FILE}.tmp"));
    let error = |e: &dyn std::fmt::Display| {
        user_error(
            &tr!("Non riesco a salvare il tuo elenco di modelli ({USER_FILE}).", "I can't save your model list ({USER_FILE})."),
            format!("{}: {e}", f.display()),
        )
    };
    std::fs::create_dir_all(&paths.data).map_err(|e| error(&e))?;
    std::fs::write(&tmp, serde_json::to_string_pretty(&serde_json::json!({ "models": models }))?).map_err(|e| error(&e))?;
    std::fs::rename(&tmp, &f).map_err(|e| error(&e))
}

fn cannot_read_user_list() -> String {
    tr!("Non riesco a leggere il tuo elenco di modelli ({USER_FILE}).", "I can't read your model list ({USER_FILE}).")
}

fn invalid_user_list() -> String {
    tr!(
        "Il tuo elenco di modelli ({USER_FILE}) non è valido: correggilo o toglilo.",
        "Your model list ({USER_FILE}) is not valid: fix it or remove it."
    )
}

fn key_taken(key: &str) -> String {
    tr!(
        "Nel tuo elenco di modelli «{key}» ha lo stesso nome di un modello di Mango Code: cambia la chiave.",
        "In your model list «{key}» has the same name as a Mango Code model: change the key."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(dist: &str, user: Option<&str>) -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        let p = Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("d") };
        std::fs::create_dir_all(&p.dist).unwrap();
        std::fs::create_dir_all(&p.data).unwrap();
        std::fs::write(p.dist.join("mango-models.json"), dist).unwrap();
        if let Some(u) = user {
            std::fs::write(p.data.join(USER_FILE), u).unwrap();
        }
        (dir, p)
    }

    const PUBLIC: &str = r#"{ "default": "a", "models": { "a": { "label": "A" } } }"#;

    /// The message part that says a key is taken / a list is invalid, in the current language.
    fn taken() -> String {
        tr!("stesso nome", "same name")
    }
    fn invalid() -> String {
        tr!("non è valido", "is not valid")
    }
    fn not_in_list() -> String {
        tr!("non è nel tuo elenco", "is not in your model list")
    }

    #[test]
    fn without_the_user_file_the_catalog_is_the_public_one() {
        let (_d, p) = paths(PUBLIC, None);
        let c = read(&p).unwrap();
        assert!(c.user.is_empty());
        assert_eq!(c.root["models"].as_object().unwrap().keys().collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn user_entries_are_added_and_recognized() {
        let (_d, p) = paths(PUBLIC, Some(r#"{ "models": { "z": { "label": "Z" }, "m": { "label": "M" } } }"#));
        let c = read(&p).unwrap();
        assert_eq!(c.user, ["m", "z"]);
        assert_eq!(c.root["models"]["a"]["label"], "A");
        assert_eq!(c.root["models"]["z"]["label"], "Z");
        assert_eq!(c.root["default"], "a", "the rest of the public catalog stays as it is");
    }

    #[test]
    fn a_key_already_in_the_public_catalog_is_an_error() {
        let (_d, p) = paths(PUBLIC, Some(r#"{ "models": { "a": { "label": "Mine" } } }"#));
        let e = read(&p).unwrap_err().to_string();
        assert!(e.contains("«a»") && e.contains(&taken()) && e.contains(USER_FILE), "{e}");
    }

    #[test]
    fn an_unreadable_user_file_or_one_with_unknown_fields_is_an_error() {
        for (txt, expected) in [("{ not json", USER_FILE), (r#"{ "models": {}, "default": "a" }"#, "default")] {
            let (_d, p) = paths(PUBLIC, Some(txt));
            let e = read(&p).unwrap_err().to_string();
            assert!(e.contains(&invalid()) && e.contains(expected), "{e}");
        }
    }

    #[test]
    fn adding_creates_the_file_replaces_the_same_key_and_keeps_the_others() {
        let (_d, p) = paths(PUBLIC, None);
        add_user(&p, "hf-one", serde_json::json!({ "label": "One" })).unwrap();
        add_user(&p, "hf-two", serde_json::json!({ "label": "Two" })).unwrap();
        add_user(&p, "hf-one", serde_json::json!({ "label": "One again" })).unwrap();
        let c = read(&p).unwrap();
        assert_eq!(c.user, ["hf-one", "hf-two"]);
        assert_eq!(c.root["models"]["hf-one"]["label"], "One again");
        assert_eq!(c.root["models"]["a"]["label"], "A");
        assert!(!p.data.join("user-models.json.tmp").exists());
    }

    #[test]
    fn adding_refuses_a_catalog_key_and_does_not_touch_an_unreadable_file() {
        let (_d, p) = paths(PUBLIC, None);
        let e = add_user(&p, "a", serde_json::json!({ "label": "X" })).unwrap_err().to_string();
        assert!(e.contains("«a»") && e.contains(&taken()), "{e}");
        assert!(!p.data.join(USER_FILE).exists());

        std::fs::write(p.data.join(USER_FILE), "{ not json").unwrap();
        assert!(add_user(&p, "hf-one", serde_json::json!({ "label": "One" })).unwrap_err().to_string().contains(&invalid()));
        assert_eq!(std::fs::read_to_string(p.data.join(USER_FILE)).unwrap(), "{ not json", "a file that can't be understood is not overwritten");
    }

    #[test]
    fn removing_leaves_the_other_entries_and_says_if_it_isnt_there() {
        let (_d, p) = paths(PUBLIC, Some(r#"{ "models": { "x": { "label": "X" }, "y": { "label": "Y" } } }"#));
        remove_user(&p, "x").unwrap();
        assert_eq!(read(&p).unwrap().user, ["y"]);
        let e = remove_user(&p, "x").unwrap_err().to_string();
        assert!(e.contains("«x»") && e.contains(&not_in_list()), "{e}");
        let e = remove_user(&p, "a").unwrap_err().to_string();
        assert!(e.contains(&not_in_list()), "Mango Code models are not removed: {e}");
        remove_user(&p, "y").unwrap();
        assert!(read(&p).unwrap().user.is_empty());
    }

    #[test]
    fn a_damaged_public_catalog_says_to_reinstall() {
        let (_d, p) = paths("{ not json", None);
        assert!(read(&p).unwrap_err().to_string().contains(&tr!("Reinstalla", "Reinstall")));
    }
}
