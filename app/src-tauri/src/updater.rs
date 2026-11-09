//! Automatic updates.
//!
//! The app looks for a newer version in the latest GitHub release (`latest.json`, written by
//! `app/scripts/update-manifest.mjs`), downloads it in the background and, when it is ready, the web UI offers
//! "Install and restart" (a button in the title bar and a notice) and so does Settings > Help. The installer is signed
//! with the maintainer's key: the public half is in `tauri.conf.json`, and a file with another signature is refused (the check is
//! done by the download). The click stops the agent and the engine in order (the same as "Quit"), starts the installer
//! in passive mode (only its progress bar) and closes the app; the installer reopens it.
//!
//! The installer is started here and not by the plugin's `install`: the plugin starts it as a child of the app, so
//! inside the app's job (supervisor.rs), and Windows killed it together with the app the moment the app exited.
//!
//! One check per start, a minute after it, never periodically; Settings > Help can check at once.
//! No automatic checks for the service, the test instances (`MANGO_DATA`) and the development builds.

use crate::bridge::{err, BridgeError};
use crate::supervisor::CREATE_BREAKAWAY_FROM_JOB;
use mango_common::tr;
use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// After the start: the agent and the model come first.
const AFTER_START: Duration = Duration::from_secs(60);

/// The same states as the web UI's `UpdaterState` (packages/app/src/updater.ts).
#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum State {
    Idle,
    Checking,
    Downloading { version: String, percent: Option<u8> },
    Ready { version: String },
    UpToDate,
    Installing { version: String },
    Error { message: String },
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<Option<State>>,
    /// The update already downloaded and verified, waiting for the click.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

/// Registers the plugin and schedules the check of this start.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(Updates::default());
    let automatic = !cfg!(debug_assertions) && !crate::service_mode() && std::env::var_os("MANGO_DATA").is_none();
    if automatic || std::env::var_os("MANGO_UPDATE_URL").is_some() {
        let app = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(AFTER_START);
            tauri::async_runtime::block_on(check(&app));
        });
    }
    Ok(())
}

/// Looks for a newer version and, if there is one, downloads it. A version already downloaded is not looked up again.
pub async fn check(app: &AppHandle) -> State {
    if let Some(s @ (State::Ready { .. } | State::Downloading { .. } | State::Installing { .. })) = current(app) {
        return s;
    }
    set(app, State::Checking);
    let update = match updater(app) {
        // No release with a latest.json yet (only pre-releases, which `releases/latest` does not see): nothing newer.
        Ok(u) => match u.check().await {
            Err(tauri_plugin_updater::Error::ReleaseNotFound) => Ok(None),
            other => other.map_err(|e| e.to_string()),
        },
        Err(e) => Err(e),
    };
    let update = match update {
        Ok(Some(update)) => update,
        Ok(None) => return set(app, State::UpToDate),
        Err(e) => return set(app, State::Error { message: tr!("controllo degli aggiornamenti: {e}", "update check: {e}") }),
    };
    let version = update.version.clone();
    set(app, State::Downloading { version: version.clone(), percent: Some(0) });
    let (mut got, mut shown) = (0u64, 0u8);
    let progress = |chunk: usize, total: Option<u64>| {
        got += chunk as u64;
        let Some(total) = total.filter(|t| *t > 0) else { return };
        let percent = (got * 100 / total).min(100) as u8;
        // a notice every 5%, not for every piece of the download
        if percent >= shown + 5 {
            shown = percent;
            set(app, State::Downloading { version: version.clone(), percent: Some(percent) });
        }
    };
    match update.download(progress, || {}).await {
        Ok(bytes) => {
            *app.state::<Updates>().ready.lock().unwrap() = Some((update, bytes));
            set(app, State::Ready { version })
        }
        Err(e) => set(app, State::Error { message: tr!("scaricamento dell'aggiornamento: {e}", "update download: {e}") }),
    }
}

/// The updater, with the address and the transport of a local test if `MANGO_UPDATE_URL` asks for it.
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(url) = test_endpoint() {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// `MANGO_UPDATE_URL`: another `latest.json`, only on this PC (127.0.0.1 or localhost). It is used to test an update
/// before publishing it; an http address works only in a build made with `dangerousInsecureTransportProtocol`.
fn test_endpoint() -> Option<Url> {
    let url = Url::parse(&std::env::var("MANGO_UPDATE_URL").ok()?).ok()?;
    matches!(url.host_str(), Some("127.0.0.1" | "localhost")).then_some(url)
}

fn current(app: &AppHandle) -> Option<State> {
    app.state::<Updates>().state.lock().unwrap().clone()
}

/// Saves the state and tells the web UI (event `mango-update` on window).
fn set(app: &AppHandle, state: State) -> State {
    *app.state::<Updates>().state.lock().unwrap() = Some(state.clone());
    if let (Some(w), Ok(detail)) = (crate::main_window(app), serde_json::to_string(&state)) {
        let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('mango-update',{{detail:{detail}}}))"));
    }
    state
}

// ---------------------------------------------------------------- commands of the web UI

#[tauri::command]
pub fn update_state(app: AppHandle) -> State {
    current(&app).unwrap_or(State::Idle)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> State {
    check(&app).await
}

/// Installs the update already downloaded (and verified): agent and engine stop, the installer starts outside the
/// app's job and the app closes. The installer (NSIS `/P` passive, `/UPDATE`, `/R` reopens the app) replaces the files.
#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), BridgeError> {
    let Some((update, bytes)) = app.state::<Updates>().ready.lock().unwrap().take() else {
        return Err(err("invalid", tr!("nessun aggiornamento pronto", "no update ready")));
    };
    let version = update.version.clone();
    let fail = |app: &AppHandle, e: String| {
        let message = tr!("installazione dell'aggiornamento: {e}", "update install: {e}");
        set(app, State::Error { message: message.clone() });
        err("io", message)
    };
    let dir = std::env::temp_dir().join(format!("mango-code-update-{version}"));
    let installer = dir.join(format!("Mango Code {version} setup.exe"));
    std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&installer, &bytes))
        .map_err(|e| fail(&app, format!("{}: {e}", installer.display())))?;
    set(&app, State::Installing { version });
    // First agent and engine, as with "Quit": the installer must find their files free.
    if let Some(supervisor) = app.state::<crate::AppState>().sup.get() {
        supervisor.shutdown();
    }
    std::process::Command::new(&installer)
        .args(["/P", "/UPDATE", "/R"])
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .map_err(|e| fail(&app, format!("{}: {e}", installer.display())))?;
    app.exit(0);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_states_are_written_as_the_web_ui_reads_them() {
        let s = |v: State| serde_json::to_value(v).unwrap();
        assert_eq!(s(State::UpToDate), serde_json::json!({ "status": "up-to-date" }));
        assert_eq!(
            s(State::Downloading { version: "0.1.1".into(), percent: Some(40) }),
            serde_json::json!({ "status": "downloading", "version": "0.1.1", "percent": 40 })
        );
        assert_eq!(s(State::Ready { version: "0.1.1".into() }), serde_json::json!({ "status": "ready", "version": "0.1.1" }));
    }

    #[test]
    fn a_test_address_is_accepted_only_on_this_pc() {
        let with = |v: &str| {
            std::env::set_var("MANGO_UPDATE_URL", v);
            let r = test_endpoint().is_some();
            std::env::remove_var("MANGO_UPDATE_URL");
            r
        };
        assert!(with("http://127.0.0.1:8765/latest.json"));
        assert!(!with("https://example.com/latest.json"));
    }
}
