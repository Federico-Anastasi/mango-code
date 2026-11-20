//! The color scheme the page last saved, given to every page the window loads before its own scripts run.
//!
//! The script that paints the page reads the scheme from the page's own storage, which belongs to the origin the page is
//! served from: on another port that storage is empty. The app keeps the scheme on disk (`ui_state.rs`), so a script
//! registered in the window writes it into the storage first. It is registered again whenever the scheme changes, so a page
//! loaded later in the same run gets the current one.

use crate::ui_state::UiState;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
use windows_webview::core::HSTRING;

/// The scripts registered in the window, to remove when the next one replaces them. Only touched on the window's thread.
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Registers the script for the scheme in the state now, in place of the one registered before.
pub(crate) fn refresh(app: &AppHandle) {
    register(app, None);
}

/// Like `refresh`, and gives back once the script is registered (or after a moment): the start loads the page right after.
/// Not for the window's thread.
pub(crate) fn refresh_before_load(app: &AppHandle) {
    let (done, registered) = channel();
    register(app, Some(done));
    let _ = registered.recv_timeout(Duration::from_secs(2));
}

fn register(app: &AppHandle, done: Option<Sender<()>>) {
    let Some(window) = crate::main_window(app) else { return };
    let script = app.state::<UiState>().seed_script().map(|script| format!("if (window.top === window) {{ {script} }}"));
    let signal = done.clone();
    let registered = window.with_webview(move |webview| unsafe {
        let finished = |done: &Option<Sender<()>>| {
            if let Some(done) = done {
                let _ = done.send(());
            }
        };
        let Ok(core) = webview.controller().CoreWebView2() else { return finished(&done) };
        for id in REGISTERED.lock().unwrap().drain(..) {
            let _ = core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id));
        }
        let Some(script) = script else { return finished(&done) };
        let completed = done.clone();
        let remember = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
            if result.is_ok() {
                REGISTERED.lock().unwrap().push(id);
            }
            finished(&completed);
            Ok(())
        }));
        if let Err(e) = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &remember) {
            eprintln!("The color scheme script was not registered: {e}");
            finished(&done);
        }
    });
    if let Err(e) = registered {
        eprintln!("The color scheme script was not registered: {e}");
        if let Some(signal) = signal {
            let _ = signal.send(());
        }
    }
}
