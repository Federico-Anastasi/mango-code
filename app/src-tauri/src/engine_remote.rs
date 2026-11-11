//! "Use the engine of another PC": the code of that PC is pasted on the "Models and engine" page (`connect`), kept in the app
//! data (`engine::remote`) and, from then on, the app does not start an engine of its own: `start` checks the other PC at every
//! start and gives the agent its address, its models and its key. The way back is `disconnect`. The commands go through the
//! bridge: only the app window sees them.

use crate::bridge::{err, BridgeError};
use crate::{choice, set_status, AppState, EngineUse};
use agent_cfg::{AgentModel, ModelInfo};
use anyhow::Result;
use engine::remote::{self, Code, Failure};
use mango_common::{tr, Paths};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// What the "Models and engine" page says about the PC in use: its address (never the key) and its models.
#[derive(Clone, Serialize)]
pub struct Info {
    pub address: String,
    pub models: Vec<String>,
}

/// If this PC uses the engine of another, checks it and gives the agent what it needs. `None` if it uses its own. A PC that
/// does not answer is an error that says so: the error page offers "Retry" and the way back to this PC's engine.
pub fn start(app: &AppHandle, paths: &Paths) -> Result<Option<EngineUse>> {
    let Some(code) = remote::saved(&paths.data)? else { return Ok(None) };
    set_status(app, "engine", tr!("Mi collego al motore del PC {}", "Connecting to the engine of the PC {}", code.ip()));
    let offered = remote::verify(&code)?;
    let st = app.state::<AppState>();
    // Coming from this PC's engine in use: its model gives the memory back (it restarts on a request, if the sharing is on).
    if let Some(manager) = st.engine.get() {
        manager.stop();
    }
    let place = tr!("sul PC {}", "on PC {}", code.ip());
    *st.remote.lock().unwrap() = Some(Info { address: code.address.clone(), models: offered.models.iter().map(|m| m.label.clone()).collect() });
    let default_model = offered.running.filter(|k| offered.models.iter().any(|m| &m.key == k)).unwrap_or_else(|| offered.models[0].key.clone());
    Ok(Some(EngineUse {
        url: code.base(),
        key: Some(code.key),
        models: offered
            .models
            .into_iter()
            .map(|m| AgentModel {
                key: m.key,
                // the name says which PC answers: the button under the chat and the conversation read it too
                label: format!("{} · {place}", m.label),
                ctx: m.context,
                images: m.images,
                info: ModelInfo { place: "remote", ..Default::default() },
            })
            .collect(),
        default_model,
    }))
}

fn failed(f: Failure) -> BridgeError {
    err(f.code(), f.to_string())
}

fn paths(app: &AppHandle) -> Result<Paths, BridgeError> {
    app.state::<AppState>().paths.get().cloned().ok_or_else(|| err("unavailable", tr!("percorsi non ancora noti", "paths not known yet")))
}

/// The engine changed: whoever waits at the "Models and engine" page goes on from the saved choice (first start, or the page
/// opened in use); on the error page nobody waits, and the app starts again.
fn switch(app: &AppHandle) {
    if app.state::<AppState>().choice.switched().is_err() {
        crate::restart(app, choice::Mode::Startup { interactive: !crate::service_mode() });
    }
}

/// Checks the pasted code with the other PC and, if it is right, uses its engine from now on.
#[tauri::command]
pub async fn engine_remote_connect(app: AppHandle, code: String) -> Result<(), BridgeError> {
    let paths = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let code: Code = Code::parse(&code).map_err(failed)?;
        remote::verify(&code).map_err(failed)?;
        remote::save(&paths.data, &code).map_err(|e| err("io", format!("{e:#}")))?;
        switch(&app);
        Ok(())
    })
    .await
    .map_err(|e| err("io", e.to_string()))?
}

/// Back to the engine of this PC.
#[tauri::command]
pub async fn engine_remote_disconnect(app: AppHandle) -> Result<(), BridgeError> {
    let paths = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        remote::forget(&paths.data).map_err(|e| err("io", format!("{e:#}")))?;
        *app.state::<AppState>().remote.lock().unwrap() = None;
        switch(&app);
        Ok(())
    })
    .await
    .map_err(|e| err("io", e.to_string()))?
}
