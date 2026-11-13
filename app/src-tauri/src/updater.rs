//! Automatic updates.
//!
//! The app looks for a newer version in the latest GitHub release (`latest.json`, written by
//! `app/scripts/update-manifest.mjs`), downloads it in the background and, when it is ready, the web UI offers
//! "Install and restart" (a button in the title bar and a notice) and so does Settings > Help. The installer is signed
//! with the maintainer's key: the public half is in `tauri.conf.json`, and a file with another signature is refused (the check is
//! done by the download). The click stops the agent and the engine in order (the same as "Quit"), starts the installer
//! in passive mode (only its progress bar) and closes the app; the installer reopens it. If the installer does not
//! start, the app starts again what it stopped.
//!
//! The installer is started here and not by the plugin's `install`: the plugin starts it as a child of the app, so
//! inside the app's job (supervisor.rs), and Windows killed it together with the app the moment the app exited.
//!
//! One check per start, a minute after it, never periodically; Settings > Help can check at once. The user can turn the
//! automatic check off (`updates.setAutomatic`, saved in `choices.json` as `update.automatic`): the check of the start is
//! then skipped, and the one asked from Settings still works.
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

/// What the web UI reads: the state, whether the check of each start is on, and when the last check that got an answer
/// ended (milliseconds since 1970; none yet in this run of the app).
#[derive(Clone, Serialize)]
pub struct Report {
    #[serde(flatten)]
    pub state: State,
    pub automatic: bool,
    pub checked_at: Option<u64>,
}

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
    /// When the last check that got an answer ended.
    checked_at: Mutex<Option<u64>>,
}

/// Registers the plugin and schedules the check of this start.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(Updates::default());
    let eligible = !cfg!(debug_assertions) && !crate::service_mode() && std::env::var_os("MANGO_DATA").is_none();
    if eligible || std::env::var_os("MANGO_UPDATE_URL").is_some() {
        let app = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(AFTER_START);
            // Read when the check is due: a choice made in the first minute counts.
            if automatic(&app) {
                tauri::async_runtime::block_on(check(&app));
            }
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
            other => other.map_err(|e| failure(tr!("controllo degli aggiornamenti", "update check"), e)),
        },
        Err(e) => Err(tr!("controllo degli aggiornamenti: {e}", "update check: {e}")),
    };
    let update = match update {
        Ok(found) => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            *app.state::<Updates>().checked_at.lock().unwrap() = Some(now);
            found
        }
        Err(message) => return set(app, State::Error { message }),
    };
    let Some(update) = update else { return set(app, State::UpToDate) };
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
        Err(e) => set(app, State::Error { message: failure(tr!("scaricamento dell'aggiornamento", "update download"), e) }),
    }
}

/// The text of a failed step: a connection that does not work in plain words (what to do, the technical text after
/// it), any other failure with the name of its step.
fn failure(step: String, e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error::{Network, Reqwest};
    match e {
        Reqwest(_) | Network(_) if mango_common::internet::is_certificate_error(&e) => mango_common::internet::certificate_message(),
        Reqwest(_) | Network(_) => mango_common::network_error(e).to_string(),
        _ => format!("{step}: {e}"),
    }
}

/// The updater, with the address and the transport of a local test if `MANGO_UPDATE_URL` asks for it.
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    let test = test_endpoint();
    // The plugin has its own network: the certificates are Windows', and the proxy is the one the rest of the app uses for the updates' address.
    let endpoint = test.as_ref().map(Url::to_string).or_else(|| app.config().plugins.0.get("updater")?.get("endpoints")?.get(0)?.as_str().map(str::to_owned));
    builder = match endpoint.as_deref().and_then(mango_common::internet::proxy_for).and_then(|p| Url::parse(&p).ok()) {
        Some(proxy) => builder.proxy(proxy),
        None => builder.no_proxy(),
    };
    if let Some(url) = test {
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

fn automatic(app: &AppHandle) -> bool {
    automatic_in(app.state::<crate::AppState>().paths.get())
}

/// The user's choice: the check of each start is on unless they turned it off. A file of the choices that cannot be
/// read leaves it on, as the standard value, and says why in the log.
fn automatic_in(paths: Option<&mango_common::Paths>) -> bool {
    let Some(paths) = paths else { return true };
    engine_cfg::choices::read(paths).map(|c| c.update.automatic).unwrap_or_else(|e| {
        crate::startup_log(paths, &format!("updates: the choice of the automatic check not read: {e:#}"));
        true
    })
}

fn report(app: &AppHandle, state: State) -> Report {
    Report { state, automatic: automatic(app), checked_at: *app.state::<Updates>().checked_at.lock().unwrap() }
}

/// Saves the state and tells the web UI (event `mango-update` on window).
fn set(app: &AppHandle, state: State) -> State {
    *app.state::<Updates>().state.lock().unwrap() = Some(state.clone());
    if let (Some(w), Ok(detail)) = (crate::main_window(app), serde_json::to_string(&report(app, state.clone()))) {
        let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('mango-update',{{detail:{detail}}}))"));
    }
    state
}

// ---------------------------------------------------------------- commands of the web UI

#[tauri::command]
pub async fn update_state(app: AppHandle) -> Report {
    let state = current(&app).unwrap_or(State::Idle);
    report(&app, state)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Report {
    let state = check(&app).await;
    report(&app, state)
}

/// Turns the check of each start on or off; it applies from the next start (or from this one, within its first minute).
#[tauri::command]
pub async fn update_set_automatic(app: AppHandle, automatic: bool) -> Result<Report, BridgeError> {
    let paths = app.state::<crate::AppState>().paths.get().cloned().ok_or_else(|| err("unavailable", tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting.")))?;
    engine_cfg::choices::set_update_automatic(&paths, automatic).map_err(|e| err("refused", e.to_string()))?;
    let state = current(&app).unwrap_or(State::Idle);
    Ok(report(&app, state))
}

/// Installs the update already downloaded (and verified): agent and engine stop, the installer starts outside the
/// app's job and the app closes. The installer (NSIS `/P` passive, `/UPDATE`, `/R` reopens the app) replaces the files.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), BridgeError> {
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
    // First agent and engine, as with "Quit": the engine saves the conversation before the installer can close the app.
    crate::stop_children(&app);
    let started = std::process::Command::new(&installer).args(["/P", "/UPDATE", "/R"]).creation_flags(CREATE_BREAKAWAY_FROM_JOB).spawn();
    if let Err(e) = started {
        // an antivirus or a locked file: the app goes on as it was
        crate::restart(&app);
        return Err(fail(&app, format!("{}: {e}", installer.display())));
    }
    app.exit(0);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_that_fails_is_told_in_plain_words_and_another_failure_keeps_its_step() {
        let offline = failure("update check".into(), tauri_plugin_updater::Error::Network("error sending request".into()));
        assert!(offline.contains(&tr!("Controlla la connessione", "Check your connection")), "{offline}");
        assert!(!offline.contains("update check"), "{offline}");
        let other = failure("update check".into(), tauri_plugin_updater::Error::EmptyEndpoints);
        assert!(other.starts_with("update check: "), "{other}");
    }

    #[test]
    fn the_states_are_written_as_the_web_ui_reads_them() {
        assert_eq!(
            serde_json::to_value(Report { state: State::Ready { version: "0.1.3".into() }, automatic: false, checked_at: Some(1_700_000_000_000) }).unwrap(),
            serde_json::json!({ "status": "ready", "version": "0.1.3", "automatic": false, "checked_at": 1_700_000_000_000u64 })
        );
        let unchecked = Report { state: State::Idle, automatic: true, checked_at: None };
        assert_eq!(serde_json::to_value(unchecked).unwrap()["checked_at"], serde_json::Value::Null);
        let s = |v: State| serde_json::to_value(v).unwrap();
        assert_eq!(s(State::UpToDate), serde_json::json!({ "status": "up-to-date" }));
        assert_eq!(
            s(State::Downloading { version: "0.1.1".into(), percent: Some(40) }),
            serde_json::json!({ "status": "downloading", "version": "0.1.1", "percent": 40 })
        );
        assert_eq!(s(State::Ready { version: "0.1.1".into() }), serde_json::json!({ "status": "ready", "version": "0.1.1" }));
    }

    /// The check of the first minute reads the choice when it is due: on by default, off once turned off, on again with a
    /// file it cannot read.
    #[test]
    fn the_automatic_check_follows_the_saved_choice() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        let paths = mango_common::Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("data") };
        assert!(automatic_in(Some(&paths)));
        engine_cfg::choices::set_update_automatic(&paths, false).unwrap();
        assert!(!automatic_in(Some(&paths)));
        engine_cfg::choices::set_update_automatic(&paths, true).unwrap();
        assert!(automatic_in(Some(&paths)));
        std::fs::write(paths.data.join(engine_cfg::choices::FILE), "{").unwrap();
        assert!(automatic_in(Some(&paths)), "a broken file leaves the standard value");
        assert!(automatic_in(None));
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
