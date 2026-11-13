//! The first time the X hides the window, the window says why before it goes: Mango Code stays in the tray icon,
//! and the programs the model started (the server of a site it made) stay on until "Quit". Once read, never again.
//!
//! The words are the web UI's (its languages): the X sends the `mango-close-notice` event and the window stays while
//! the page answers (`close_notice_answer`): the notice is up, or it cannot be shown now (another dialog is open, or
//! the notice already was, and this is a second X) and the window goes. A page that does not answer within a second,
//! or that is not the agent's (the loading page, a startup error), lets the window go as always: the X never stops
//! working because a page did not answer. Only "OK" (`close_notice_seen`) counts as read: closed otherwise, the
//! notice comes back at the next X.

use crate::bridge::{err, BridgeError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// How long the X waits for the page to say the notice is up.
const ANSWER: Duration = Duration::from_secs(1);

/// What the X does once the agent runs.
#[derive(Debug, PartialEq, Eq)]
pub enum Close {
    /// The notice is asked of the page and the window stays.
    Ask,
    /// The window is hidden.
    Hide,
}

/// The choice, from what is known: the notice already read, the agent's page in the window, an X already waiting for
/// the page.
pub fn decide(seen: bool, agent_page: bool, waiting: bool) -> Close {
    if seen || !agent_page || waiting {
        Close::Hide
    } else {
        Close::Ask
    }
}

/// The X waiting for the page's answer, by its number (0: none).
pub struct Pending {
    waiting: AtomicU64,
    last: AtomicU64,
}

impl Pending {
    pub const fn new() -> Self {
        Self { waiting: AtomicU64::new(0), last: AtomicU64::new(0) }
    }

    /// A new X waits: its number.
    fn ask(&self) -> u64 {
        let id = self.last.fetch_add(1, Ordering::SeqCst) + 1;
        self.waiting.store(id, Ordering::SeqCst);
        id
    }

    fn waiting(&self) -> bool {
        self.waiting.load(Ordering::SeqCst) != 0
    }

    /// The page answered, or the window went: nothing waits any more.
    fn answer(&self) {
        self.waiting.store(0, Ordering::SeqCst);
    }

    /// The time is up for X `id`: true if the page has not answered it, and the window must go.
    fn expire(&self, id: u64) -> bool {
        self.waiting.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

static PENDING: Pending = Pending::new();

fn file(data: &Path) -> PathBuf {
    data.join("close-notice.json")
}

fn seen(data: &Path) -> bool {
    file(data).is_file()
}

fn remember(data: &Path) -> std::io::Result<()> {
    mango_common::write_atomic(&file(data), r#"{"seen":true}"#)
}

/// The X with the agent running: the notice the first times, until it is read; otherwise the window hides.
pub fn on_close(window: &WebviewWindow) {
    let Ok(data) = mango_common::data_dir() else {
        hide(window);
        return;
    };
    let agent_page = window.url().is_ok_and(|url| url.host_str() == Some("127.0.0.1") && url.port() == Some(crate::agent_port()));
    if decide(seen(&data), agent_page, PENDING.waiting()) == Close::Hide {
        PENDING.answer();
        hide(window);
        return;
    }
    let id = PENDING.ask();
    if window.eval("window.dispatchEvent(new CustomEvent('mango-close-notice'))").is_err() {
        PENDING.answer();
        hide(window);
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ANSWER);
        if PENDING.expire(id) {
            hide(&window);
        }
    });
}

// Both commands are `async`: they run on a thread of their own, and their hide reaches the window through the app's
// event loop, after the page's call has returned. A command without `async` runs on the main thread inside the page's
// call, and its hide is done there and then. In the real window (0.1.3, 13/11) «OK» wrote the notice as read and the
// window stayed; which of the two is the cause is not known yet: `hide` writes in `startup.log` when it fails or when
// the window is still visible right after it.

/// The page's answer to the X: `shown` when the notice is up and the window stays; otherwise the window goes.
#[tauri::command(async)]
pub(crate) fn close_notice_answer(app: AppHandle, shown: bool) -> Result<(), BridgeError> {
    PENDING.answer();
    if !shown {
        if let Some(w) = crate::main_window(&app) {
            hide(&w);
        }
    }
    Ok(())
}

/// "OK" on the notice: it is not shown again, and the window goes to the tray as the X asked.
#[tauri::command(async)]
pub(crate) fn close_notice_seen(app: AppHandle) -> Result<(), BridgeError> {
    let written = mango_common::data_dir().map_err(|e| e.to_string()).and_then(|data| {
        remember(&data).map_err(|e| format!("{}: {e}", file(&data).display()))
    });
    if let Some(w) = crate::main_window(&app) {
        hide(&w);
    }
    written.map_err(|e| {
        log(&app, &format!("close notice not remembered: {e}"));
        err("close_notice", e)
    })
}

/// Hides the window; a hide that fails, or after which the window is still visible, goes to `startup.log`.
fn hide(window: &WebviewWindow) {
    let app = window.app_handle();
    match window.hide() {
        Err(e) => log(app, &format!("close notice: the window was not hidden: {e}")),
        Ok(()) if window.is_visible().unwrap_or(false) => log(app, "close notice: the window is still visible after hide"),
        Ok(()) => {}
    }
}

fn log(app: &AppHandle, line: &str) {
    if let Some(paths) = app.state::<crate::AppState>().paths.get() {
        crate::startup_log(paths, line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_is_asked_on_the_agent_page_until_read_and_never_blocks_the_x() {
        assert_eq!(decide(false, true, false), Close::Ask);
        // an X while the page has not answered the one before: the window goes
        assert_eq!(decide(false, true, true), Close::Hide);
        // read once: never again
        assert_eq!(decide(true, true, false), Close::Hide);
        // a page that cannot show it (the loading page, an error): the window goes as always
        assert_eq!(decide(false, false, false), Close::Hide);
    }

    #[test]
    fn a_notice_the_page_does_not_confirm_lets_the_window_go_and_is_not_read() {
        let pending = Pending::new();
        let first = pending.ask();
        assert!(pending.waiting());
        // no answer within the time: the window goes (`expire`, which writes nothing), and the next X asks again
        assert!(pending.expire(first));
        assert!(!pending.waiting());
        assert_eq!(decide(false, true, pending.waiting()), Close::Ask);
        // answered in time: the window stays, the late timer does nothing
        let second = pending.ask();
        pending.answer();
        assert!(!pending.expire(second));
        // the timer of an older X does not touch a newer one
        let third = pending.ask();
        assert!(!pending.expire(second));
        assert!(pending.waiting());
        assert!(pending.expire(third));
    }

    #[test]
    fn ok_writes_the_notice_as_read_in_the_app_data() {
        let data = std::env::temp_dir().join(format!("mango-close-notice-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let _ = std::fs::remove_file(file(&data));
        assert!(!seen(&data));
        remember(&data).unwrap();
        assert!(seen(&data));
        assert_eq!(decide(seen(&data), true, false), Close::Hide);
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn a_write_that_fails_is_an_error_and_the_notice_comes_back() {
        // the app data is a file: nothing can be written inside it
        let data = std::env::temp_dir().join(format!("mango-close-notice-blocked-{}", std::process::id()));
        std::fs::write(&data, "not a folder").unwrap();
        assert!(remember(&data).is_err());
        assert!(!seen(&data));
        assert_eq!(decide(seen(&data), true, false), Close::Ask);
        std::fs::remove_file(&data).unwrap();
    }
}
