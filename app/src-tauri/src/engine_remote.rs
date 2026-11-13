//! "Use the engine of another PC": the code of that PC is pasted in the settings (`connect`, through the bridge), kept in the app
//! data (`engine::remote`) and, from then on, the app does not start an engine of its own: `start` checks the other PC at every
//! start and gives the agent its address, its models and its key. The way back is `disconnect`. The commands go through the
//! bridge: only the app window sees them.

use crate::bridge::{err, shown, BridgeError};
use crate::{set_status, AppState, EngineUse};
use agent_cfg::AgentModel;
use anyhow::Result;
use engine::remote::{self, Code, Failure};
use mango_common::{tr, Paths};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How often the PC whose engine is in use is asked whether it answers.
const CHECK_EVERY: Duration = Duration::from_secs(5);
/// The same, while it refuses the key: each ask is a line in its log.
const CHECK_REFUSED_EVERY: Duration = Duration::from_secs(60);

/// The PC whose engine is in use, as the interface shows it (`/control/state`): its address (never the key), its models,
/// and whether it answered the last time it was asked (`engine::remote::watch`, which stops when this goes).
pub struct Info {
    pub address: String,
    pub models: Vec<String>,
    pub reachable: Arc<AtomicBool>,
}

/// If this PC uses the engine of another, checks it and gives the agent what it needs. `None` if it uses its own. A PC that
/// does not answer is an error that says so: the error page offers "Retry" and the way back to this PC's engine.
pub fn start(app: &AppHandle, paths: &Paths) -> Result<Option<EngineUse>> {
    let Some(code) = remote::saved(&paths.data)? else { return Ok(None) };
    set_status(app, "engine", tr!("Mi collego al motore dell'altro PC", "Connecting to the other PC's engine"));
    let offered = remote::verify(&code)?;
    let st = app.state::<AppState>();
    // Coming from this PC's engine in use: its model gives the memory back (it restarts on a request, if the sharing is on).
    if let Some(manager) = st.engine.get() {
        manager.stop();
    }
    let place = tr!("sull'altro PC", "on the other PC");
    let reachable = Arc::new(AtomicBool::new(true));
    remote::watch(code.clone(), Arc::downgrade(&reachable), CHECK_EVERY, CHECK_REFUSED_EVERY);
    *st.remote.lock().unwrap() = Some(Info { address: code.address.clone(), models: offered.models.iter().map(|m| m.label.clone()).collect(), reachable });
    let default_model = Some(offered.running.filter(|k| offered.models.iter().any(|m| &m.key == k)).unwrap_or_else(|| offered.models[0].key.clone()));
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

/// How long the command's answer has to reach the page before the restart takes the window to the app's own page.
const ANSWER_FIRST: std::time::Duration = std::time::Duration::from_millis(300);

/// The engine changed: the command answers that it is done, then the app starts again on the saved choice. The restart
/// takes the window away from the page that asked, which would otherwise lose the answer.
fn restart_after_the_answer(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(ANSWER_FIRST);
        crate::restart(&app);
    });
}

/// Checks the pasted code with the other PC and, if it is right, uses its engine from now on.
#[tauri::command]
pub async fn engine_remote_connect(app: AppHandle, code: String) -> Result<(), BridgeError> {
    let paths = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let code: Code = Code::parse(&code).map_err(failed)?;
        remote::verify(&code).map_err(failed)?;
        remote::save(&paths.data, &code).map_err(|e| shown(&app, "io", "another PC's engine: code not saved", e))?;
        restart_after_the_answer(app);
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
        remote::forget(&paths.data).map_err(|e| shown(&app, "io", "another PC's engine: code not removed", e))?;
        *app.state::<AppState>().remote.lock().unwrap() = None;
        restart_after_the_answer(app);
        Ok(())
    })
    .await
    .map_err(|e| err("io", e.to_string()))?
}
