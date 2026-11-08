//! "Open with Mango Code": the folder passed on the command line (`mango-code.exe "<folder>"`, as File Explorer
//! launches it) becomes the project open in the window. If the app is already open the second start
//! passes the folder to it and exits (single instance, see `run` in `lib.rs`).

use anyhow::Context;
use mango_common::tr;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// The first argument that is not an option (`--service`): the folder to open. The very first is the executable.
pub fn requested_folder(args: &[String]) -> Option<&str> {
    args.iter().skip(1).map(String::as_str).find(|a| !a.starts_with("--"))
}

/// The existing folder that `written` names, or the sentence for the user that says why it does not open.
pub fn validate(written: &str) -> Result<PathBuf, String> {
    let folder = Path::new(written);
    if !folder.exists() {
        return Err(tr!(
            "La cartella «{written}» non esiste. Controlla il percorso e riprova.",
            "The folder \"{written}\" does not exist. Check the path and try again."
        ));
    }
    if !folder.is_dir() {
        return Err(tr!(
            "«{written}» non è una cartella: scegli una cartella, non un file.",
            "\"{written}\" is not a folder: choose a folder, not a file."
        ));
    }
    std::fs::canonicalize(folder)
        .map(|real| crate::bridge::plain(&real))
        .map_err(|_| tr!("Non riesco ad aprire la cartella «{written}».", "Cannot open the folder \"{written}\"."))
}

/// The web UI page that opens `folder` as a project.
pub fn page(agent: &str, folder: &Path) -> anyhow::Result<Url> {
    let mut url = Url::parse(agent)?;
    url.query_pairs_mut().append_pair("project", &folder.to_string_lossy());
    Ok(url)
}

/// Brings the window to the front and opens `written` as a project. If the agent is not ready yet the folder
/// waits for the end of startup (`startup` in `lib.rs`); if it is not valid, a message and nothing else.
pub fn open(app: &AppHandle, written: &str) {
    crate::tray::show(app);
    let folder = match validate(written) {
        Ok(c) => c,
        Err(sentence) => {
            app.dialog().message(sentence).title("Mango Code").kind(MessageDialogKind::Error).show(|_| {});
            return;
        }
    };
    let state = app.state::<crate::AppState>();
    let mut waiting = state.folder.lock().unwrap();
    let Some(agent) = state.agent.lock().unwrap().clone() else {
        *waiting = Some(folder);
        return;
    };
    if let Err(e) = navigate(&state, &agent, &folder) {
        eprintln!("folder {} not opened: {e:#}", folder.display());
    }
}

fn navigate(state: &crate::AppState, agent: &str, folder: &Path) -> anyhow::Result<()> {
    let window = state.main.get().with_context(|| tr!("finestra principale sparita", "main window gone"))?;
    window.navigate(page(agent, folder)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_folder_is_the_first_argument_that_is_not_an_option() {
        assert_eq!(requested_folder(&args(&["mango-code.exe"])), None);
        assert_eq!(requested_folder(&args(&["mango-code.exe", "--service"])), None);
        assert_eq!(requested_folder(&args(&["mango-code.exe", r"C:\Work\site"])), Some(r"C:\Work\site"));
        assert_eq!(requested_folder(&args(&["mango-code.exe", "--service", r"C:\Work\site"])), Some(r"C:\Work\site"));
    }

    #[test]
    fn folder_that_does_not_exist_or_is_a_file() {
        let base = std::env::temp_dir().join(format!("mango-folder-{}", std::process::id()));
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("file.txt"), b"x").unwrap();

        // trailing `\.`, as in the File Explorer command, and the `..`: we get to the real folder, without the prefix
        let written = format!(r"{}\sub\..\sub\.", base.display());
        let real = validate(&written).unwrap();
        assert!(real.is_dir() && real.ends_with("sub"), "{}", real.display());
        assert!(!real.to_string_lossy().starts_with(r"\\?\"));

        let missing = base.join("not-there");
        let sentence = validate(&missing.to_string_lossy()).unwrap_err();
        assert!(sentence.contains(&tr!("non esiste", "does not exist")) && sentence.contains("not-there"), "{sentence}");
        let sentence = validate(&base.join("file.txt").to_string_lossy()).unwrap_err();
        assert!(sentence.contains(&tr!("non è una cartella", "is not a folder")), "{sentence}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_page_carries_the_encoded_folder() {
        let url = page("http://127.0.0.1:4096", Path::new(r"C:\Work\the site & co")).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:4096/?project=C%3A%5CWork%5Cthe+site+%26+co");
        let (_, value) = url.query_pairs().next().unwrap();
        assert_eq!(value, r"C:\Work\the site & co");
    }
}
