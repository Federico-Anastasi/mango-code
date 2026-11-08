//! The commands of the "Other models" section of the choice page: search Hugging Face, analyze a link or
//! a file on the computer, save the token, add a model to the user's list or remove it. The logic is in
//! `engine_cfg::other_models` and `mango_common::download::hugging_face`; here only the connection to the page.

use crate::AppState;
use engine_cfg::other_models::{self, Analysis};
use mango_common::credentials;
use mango_common::download::hugging_face::{self, SearchResult};
use mango_common::download::HF_CREDENTIAL;
use mango_common::{tr, Paths};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

/// What the "search or paste a link" box finds.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Found {
    Results { results: Vec<SearchResult> },
    Analysis { repo: String, analysis: Box<Analysis> },
}

/// A link (or `owner/name`) opens the repo with its quantizations; anything else is a search by name.
#[tauri::command]
pub async fn other_models_open(state: State<'_, AppState>, text: String) -> Result<Found, String> {
    let paths = paths(&state)?;
    work(move || {
        let Some(reference) = hugging_face::parse_reference(&text) else {
            return Ok(Found::Results { results: hugging_face::search(text.trim())? });
        };
        let repo = hugging_face::repo(&reference.repo, reference.revision.as_deref())?;
        let mut analysis = other_models::analyze_hugging_face(&paths, &engine_cfg::detect()?, &repo)?;
        analysis.prefer(reference.quant.as_deref(), reference.path.as_deref());
        Ok(Found::Analysis { repo: repo.id, analysis: Box::new(analysis) })
    })
    .await
}

/// A GGUF already on the computer, chosen from the page.
#[tauri::command]
pub async fn other_models_local(state: State<'_, AppState>, path: String) -> Result<Analysis, String> {
    let paths = paths(&state)?;
    work(move || other_models::analyze_local(&paths, &engine_cfg::detect()?, &PathBuf::from(path))).await
}

/// Puts the model in the user's list and makes the page read the choice again, with the new model already ticked.
#[tauri::command]
pub async fn other_models_add(state: State<'_, AppState>, key: String, entry: Value) -> Result<(), String> {
    let paths = paths(&state)?;
    let k = key.clone();
    work(move || other_models::add(&paths, &k, entry)).await?;
    state.choice.reassess(Some(key))
}

#[tauri::command]
pub async fn other_models_remove(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let paths = paths(&state)?;
    work(move || mango_common::catalog::remove_user(&paths, &key)).await?;
    state.choice.reassess(None)
}

/// Whether there is a Hugging Face token saved by the app.
#[tauri::command]
pub fn other_models_token_status() -> Result<bool, String> {
    credentials::read(HF_CREDENTIAL).map(|t| t.is_some()).map_err(|e| format!("{e:#}"))
}

/// Checks the token with Hugging Face and saves it in the Windows Credential Manager.
#[tauri::command]
pub async fn other_models_token_save(token: String) -> Result<(), String> {
    work(move || {
        let token = token.trim();
        anyhow::ensure!(!token.is_empty(), "{}", tr!("Incolla il token di Hugging Face.", "Paste the Hugging Face token."));
        hugging_face::verify_token(token)?;
        credentials::save(HF_CREDENTIAL, token)
    })
    .await
}

#[tauri::command]
pub fn other_models_token_remove() -> Result<(), String> {
    credentials::remove(HF_CREDENTIAL).map_err(|e| format!("{e:#}"))
}

fn paths(state: &AppState) -> Result<Paths, String> {
    state.paths.get().cloned().ok_or_else(|| tr!("percorsi non ancora noti", "paths not known yet"))
}

/// Runs a job that waits for the network or the disk outside the command thread.
async fn work<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))
}
