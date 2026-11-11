//! "Share the engine with my PCs" on the "Models and engine" page: turns the sharing of the engine on and off (`engine::share`),
//! gives the codes to copy and renews the key. The commands go through the bridge: only the app window sees them.

use crate::bridge::{err, BridgeError};
use engine::share::{Share, SharedModel, State};
use tauri::{AppHandle, Manager};

/// Port of the shared engine (off by default). Fixed: it is in the code the other PCs paste.
const SHARE_PORT: u16 = 47098;

fn share_port() -> u16 {
    std::env::var("MANGO_SHARE_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(SHARE_PORT)
}

/// All the networks' addresses that count. In development builds `MANGO_SHARE_PC_ONLY` keeps it on 127.0.0.1: the tests
/// drive the sharing from the PC without Windows asking to open the port.
fn only_here() -> bool {
    cfg!(debug_assertions) && std::env::var_os("MANGO_SHARE_PC_ONLY").is_some()
}

/// The service for the engine manager that has just been created, with the state saved in the app data; if it was on, the
/// port reopens right away. At the next starts only the models offered change.
pub fn install(app: &AppHandle, data: &std::path::Path, manager: engine::EngineManager) -> anyhow::Result<()> {
    let state = app.state::<crate::AppState>();
    if state.share.get().is_none() {
        let _ = state.share.set(Share::new(data, manager, share_port(), only_here())?);
    }
    Ok(())
}

pub fn offer(app: &AppHandle, models: Vec<SharedModel>) {
    if let Some(share) = app.state::<crate::AppState>().share.get() {
        share.set_models(models);
    }
}

fn service(app: &AppHandle) -> Result<&Share, BridgeError> {
    app.state::<crate::AppState>().inner().share.get().ok_or_else(|| err("unavailable", mango_common::tr!("il motore non è ancora acceso", "the engine is not running yet")))
}

#[tauri::command]
pub fn engine_share_state(app: AppHandle) -> Result<State, BridgeError> {
    Ok(service(&app)?.state())
}

#[tauri::command]
pub fn engine_share_set_enabled(app: AppHandle, enabled: bool) -> Result<State, BridgeError> {
    service(&app)?.set_enabled(enabled).map_err(|e| err("io", format!("{e:#}")))
}

#[tauri::command]
pub fn engine_share_new_key(app: AppHandle) -> Result<State, BridgeError> {
    service(&app)?.new_key().map_err(|e| err("io", format!("{e:#}")))
}
