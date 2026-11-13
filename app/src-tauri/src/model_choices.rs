//! The user's choices about the models and the computer, from the app's window: the
//! model to load when the app opens, where a model runs and with what context, which cards the models use, and taking a
//! model off the computer. The choices are saved in `<data>\choices.json` (`engine_cfg::choices`); every plan and every
//! verdict reads them. After each change the interface is told the catalog changed and, if the plan of the running model
//! is no longer the same, the model is loaded again as soon as it has no answer in progress.

use crate::bridge::BridgeError;
use crate::downloads::{blocking, Downloads};
use crate::AppState;
use anyhow::{Context, Result};
use engine::EngineManager;
use engine_cfg::choices::{self, Choices, SmallModels};
use engine_cfg::Hardware;
use mango_common::{tr, user_text, Paths};
use tauri::{AppHandle, Manager};

fn paths(app: &AppHandle) -> Result<Paths> {
    app.state::<AppState>().paths.get().cloned().with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))
}

fn hardware() -> Result<engine_cfg::Hardware> {
    engine_cfg::detect().with_context(|| tr!("Non riesco a guardare l'hardware di questo computer.", "Cannot look at the hardware of this computer."))
}

/// The model to load when the app opens; none = the first on disk.
#[tauri::command]
pub async fn models_set_default(app: AppHandle, key: Option<String>) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        // The model is one of the local models of the catalog.
        if let Some(key) = &key {
            engine_cfg::download_of(&paths, key, &hardware()?)?;
        }
        choices::set_default(&paths, key.as_deref())?;
        crate::choices_changed(app);
        Ok(())
    })
    .await
}

/// Where a model runs, with what context, how it writes and whether it reasons.
#[tauri::command]
pub async fn models_set_choices(app: AppHandle, key: String, choices: Choices) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        choices::set_model(&paths(app)?, &key, choices)?;
        crate::choices_changed(app);
        Ok(())
    })
    .await
}

/// A card, by name, is used by the models or left to the rest of the computer.
#[tauri::command]
pub async fn computer_set_gpu_used(app: AppHandle, name: String, used: bool) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        choices::set_gpu_used(&paths(app)?, &name, used)?;
        crate::choices_changed(app);
        Ok(())
    })
    .await
}

/// What the computer does with a model that fits one card: on one, or on all.
#[tauri::command]
pub async fn computer_set_small_models(app: AppHandle, small_models: SmallModels) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        choices::set_small_models(&paths(app)?, small_models)?;
        crate::choices_changed(app);
        Ok(())
    })
    .await
}

/// Takes a model off the computer: its download, if one is in progress, is cancelled and stopped; if the engine has it,
/// the engine stops; the files Mango Code downloaded are deleted; if it was the default, there is no default any more.
/// A model of the user's also leaves the user's list, with its choices: the files the user chose stay where they are
/// (the window said so before asking). Nothing is loaded in its place. The interface is told also when the removal
/// stops halfway: some files may be gone already.
#[tauri::command]
pub async fn models_remove(app: AppHandle, key: String) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let removed = remove(app, &key);
        crate::choices_changed(app);
        removed
    })
    .await
}

fn remove(app: &AppHandle, key: &str) -> Result<()> {
    let st = app.state::<AppState>();
    take_off(&paths(app)?, &hardware()?, st.downloads.get(), st.engine.get(), key)
}

/// `remove` with what it works on: the queue of the downloads and the engine manager, when they are there.
pub(crate) fn take_off(paths: &Paths, hw: &Hardware, downloads: Option<&Downloads>, engine: Option<&EngineManager>, key: &str) -> Result<()> {
    let model = engine_cfg::download_of(paths, key, hw)?;
    // From here until the end nobody starts the model (`_starts`): `unload` alone would let a request that names it load
    // it again before its files are deleted. Nor can it be downloaded or resumed (`_removal`).
    let _starts = engine.map(|e| e.block_starts(key));
    let (_removal, queued) = match downloads {
        Some(downloads) => (Some(downloads.stop_for_removal(key)?), downloads.list().into_iter().map(|d| d.model).collect()),
        None => (None, Vec::new()),
    };
    if let Some(engine) = engine {
        let state = engine.state();
        if state.model.as_deref() == Some(key) || state.chosen.as_deref() == Some(key) {
            engine.unload();
        }
    }
    let kept = mango_common::download::remove_model(paths, key, &model.engine, &queued)?;
    if mango_common::catalog::read(paths)?.user.iter().any(|k| k == key) {
        mango_common::catalog::remove_user(paths, key)?;
        choices::forget_model(paths, key)?;
        crate::startup_log(paths, &format!("models: {key} taken off the user's list"));
    } else if choices::read(paths)?.default.as_deref() == Some(key) {
        choices::set_default(paths, None)?;
    }
    if !kept.is_empty() {
        let files: Vec<String> = kept.iter().map(|p| p.display().to_string()).collect();
        crate::startup_log(paths, &format!("models: {key} removed, its own files stay: {}", files.join(", ")));
    }
    Ok(())
}

/// «Aggiorna il motore» in Settings › Computer, shown when the app came with a new version of an engine whose old one is
/// on the disk (`engine_cfg::engine_updates`): for each engine, the first model on the disk that waits for it is queued,
/// also one paused or failed, and its download brings only the engine. The answer is the sentence for the user.
#[tauri::command]
pub async fn computer_update_engine(app: AppHandle) -> Result<String, BridgeError> {
    blocking(app, |app| {
        let (paths, hw) = (paths(app)?, hardware()?);
        let carriers: Vec<String> = engine_cfg::engine_updates(&paths, &hw)?.into_iter().map(|u| u.model).collect();
        if !carriers.is_empty() {
            let downloads = app.state::<AppState>().downloads.get().cloned();
            downloads.with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))?.download(&carriers)?;
            return Ok(tr!(
                "Scarico la versione nuova del motore: i modelli tornano pronti quando arriva.",
                "Downloading the new version of the engine: the models are ready again when it arrives."
            ));
        }
        Ok(match engine_cfg::computer_view(&paths, &hw)?.engine.installed {
            true => tr!("È quello di questa versione di Mango Code.", "It is the one of this version of Mango Code."),
            false => tr!("Il motore arriva con il primo modello che scarichi.", "The engine comes with the first model you download."),
        })
    })
    .await
}

/// At the start, after the downloads of the last time: an engine the app came with a new version of, whose old version is
/// on the disk, is queued with the first model on the disk that waits for it (`engine_cfg::engine_updates`), so that it
/// arrives by itself and the app is not back at its first start. An engine already among the downloads stays as it is: a
/// pause stays a pause. Then the old versions of the engines already updated go, if no process runs them.
pub(crate) fn engine_update(paths: &Paths, hw: &Hardware, downloads: &Downloads) -> Result<()> {
    let queued = downloads.list();
    let carriers: Vec<String> = engine_cfg::engine_updates(paths, hw)?
        .into_iter()
        .map(|u| u.model)
        .filter(|m| !queued.iter().any(|d| &d.model == m))
        .collect();
    if !carriers.is_empty() {
        downloads.download(&carriers)?;
    }
    mango_common::download::remove_old_engines(paths);
    Ok(())
}

/// «Come si ottimizza» in Settings › Computer: the folder of the skill that tunes Mango Code on this PC, to give to a
/// frontier AI. In the installed app it is among the resources (`<dist>\optimize`), in the repo next to the app.
#[tauri::command]
pub async fn computer_open_optimize(app: AppHandle) -> Result<(), BridgeError> {
    blocking(app, |app| {
        let dist = paths(app)?.dist;
        let installed = dist.join("optimize");
        let folder = match dist.parent() {
            Some(repo) if !installed.is_dir() => repo.join("optimize"),
            _ => installed,
        };
        crate::supervisor::open_outside_job(&folder.display().to_string())
            .with_context(|| user_text(&tr!("Non riesco ad aprire la cartella di «Come si ottimizza».", "I can't open the folder of «How it is tuned»."), folder.display()))
    })
    .await
}

/// The folder of the models, in File Explorer.
#[tauri::command]
pub async fn models_open_folder(app: AppHandle) -> Result<(), BridgeError> {
    blocking(app, |app| {
        let models = paths(app)?.models;
        let unopened = || user_text(&tr!("Non riesco ad aprire la cartella dei modelli.", "I can't open the models folder."), models.display());
        std::fs::create_dir_all(&models).with_context(unopened)?;
        crate::supervisor::open_outside_job(&models.display().to_string()).with_context(unopened)
    })
    .await
}
