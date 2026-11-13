//! The commands of "Another model", in the settings' Models section, through the bridge (`otherModels` and `token` of
//! `__MANGO_DESKTOP__`): search Hugging Face, analyze a link or a file on the computer, save the token, add a model to the
//! user's list or remove it. The logic is in `engine_cfg::other_models` and `mango_common::download::hugging_face`.

use engine_cfg::other_models::{self, Analysis, Tested};
use mango_common::credentials;
use mango_common::download::hugging_face::{self, SearchResult};
use mango_common::download::HF_CREDENTIAL;
use mango_common::{tr, Paths};
use serde::Serialize;

/// What the "search or paste a link" box finds.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Found {
    Results { results: Vec<SearchResult> },
    Analysis { repo: String, analysis: Box<Analysis> },
    /// The repo of a model of the catalog: it is already among the tested ones, tuned for Mango Code.
    Tested(Tested),
}

/// A link (or `owner/name`) opens the repo with its quantizations, or, a link to the repo alone, leads to the catalog's
/// model it is the repo of; anything else is a search by name.
fn open(paths: &Paths, text: &str) -> anyhow::Result<Found> {
    let Some(reference) = hugging_face::parse_reference(text) else {
        return Ok(Found::Results { results: hugging_face::search(text.trim())? });
    };
    if let Some(tested) = other_models::tested(paths, &reference)? {
        return Ok(Found::Tested(tested));
    }
    let repo = hugging_face::repo(&reference.repo, reference.revision.as_deref())?;
    let mut analysis = other_models::analyze_hugging_face(paths, &engine_cfg::detect()?, &repo)?;
    analysis.prefer(reference.quant.as_deref(), reference.path.as_deref());
    Ok(Found::Analysis { repo: repo.id, analysis: Box::new(analysis) })
}

/// Checks the token with Hugging Face, then saves it in the Windows Credential Manager.
fn save_token(token: &str) -> anyhow::Result<()> {
    let token = token.trim();
    anyhow::ensure!(!token.is_empty(), "{}", tr!("Incolla il token di Hugging Face.", "Paste the Hugging Face token."));
    hugging_face::verify_token(token)?;
    credentials::save(HF_CREDENTIAL, token)
}

/// The commands. They answer `{ code: "refused", message }` with the sentence for the user, the whole error in
/// `startup.log` (`downloads::refused`), and a change to the user's list makes the interface read the models again
/// (`catalog_revision`).
pub mod bridge {
    use super::{open, other_models, save_token, Analysis, Found};
    use crate::bridge::{err, BridgeError};
    use crate::downloads::{blocking, refused};
    use crate::AppState;
    use anyhow::Context;
    use mango_common::credentials;
    use mango_common::download::HF_CREDENTIAL;
    use mango_common::{tr, Paths};
    use serde_json::Value;
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager, Window};
    use tauri_plugin_dialog::DialogExt;

    fn paths(app: &AppHandle) -> anyhow::Result<Paths> {
        app.state::<AppState>().paths.get().cloned().with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))
    }

    /// A name searches Hugging Face; a link (or `owner/name`, a result of the search) gives the analysis of that repo,
    /// or the catalog's model it is the repo of.
    #[tauri::command]
    pub async fn other_models_search(app: AppHandle, text: String) -> Result<Found, BridgeError> {
        blocking(app, move |app| open(&paths(app)?, &text)).await
    }

    /// The analysis of a GGUF on the computer.
    #[tauri::command]
    pub async fn other_models_analyze(app: AppHandle, file: String) -> Result<Analysis, BridgeError> {
        blocking(app, move |app| other_models::analyze_local(&paths(app)?, &engine_cfg::detect()?, &PathBuf::from(file))).await
    }

    /// The Windows file picker for a GGUF; `None` if the user cancels.
    #[tauri::command]
    pub async fn other_models_pick_file(app: AppHandle, window: Window) -> Result<Option<String>, BridgeError> {
        let picked = app.dialog().file().set_parent(&window).add_filter("GGUF", &["gguf"]).blocking_pick_file();
        picked
            .map(|p| p.into_path().map(|p| p.display().to_string()).map_err(|e| err("io", tr!("percorso non valido: {e}", "invalid path: {e}"))))
            .transpose()
    }

    /// Puts a quantization of the analysis (`key`, its `entry`) in the user's list. A file on the computer is there at
    /// once: it arrived, and without a default saved it can become it (`keep_default`).
    #[tauri::command]
    pub async fn user_models_add(app: AppHandle, key: String, entry: Value) -> Result<(), BridgeError> {
        blocking(app, move |app| {
            let paths = paths(app)?;
            other_models::add(&paths, &key, entry)?;
            if let Some(catalog) = crate::choices_changed(app) {
                crate::keep_default(app, &paths, &catalog, crate::Keep::Arrived(&key));
            }
            Ok(())
        })
        .await
    }

    /// Takes a model that is not on the computer out of the user's list (`models.remove` takes one that is there).
    #[tauri::command]
    pub async fn user_models_remove(app: AppHandle, key: String) -> Result<(), BridgeError> {
        blocking(app, move |app| {
            let paths = paths(app)?;
            mango_common::catalog::remove_user(&paths, &key)?;
            engine_cfg::choices::forget_model(&paths, &key)?;
            crate::choices_changed(app);
            Ok(())
        })
        .await
    }

    /// Whether a Hugging Face token is saved.
    #[tauri::command]
    pub fn token_status(app: AppHandle) -> Result<bool, BridgeError> {
        credentials::read(HF_CREDENTIAL).map(|t| t.is_some()).map_err(|e| refused(&app, e))
    }

    /// Checks the token with Hugging Face and saves it in the Windows Credential Manager.
    #[tauri::command]
    pub async fn token_save(app: AppHandle, token: String) -> Result<(), BridgeError> {
        blocking(app, move |_| save_token(&token)).await
    }

    #[tauri::command]
    pub fn token_remove(app: AppHandle) -> Result<(), BridgeError> {
        credentials::remove(HF_CREDENTIAL).map_err(|e| refused(&app, e))
    }
}
