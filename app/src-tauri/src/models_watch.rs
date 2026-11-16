//! The models folder, watched: a file put there or taken away by hand, which nothing in the app announces, makes the
//! interface read the catalog and the computer again (the space the models use, the models on the computer).
//!
//! Windows tells that something under the folder changed; a burst of changes (a copy, a download writing its file) ends
//! with one call, `QUIET` after the last change.

use anyhow::{Context, Result};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use windows::core::HSTRING;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Storage::FileSystem::{
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_SIZE,
};
use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};

pub const QUIET: Duration = Duration::from_secs(2);

/// Calls `changed` when what is under `dir` (created if it is not there) changed and stopped changing, for as long as
/// the app runs. Returns once the watch is armed, so a change made after it is seen. If the watch cannot go on (the
/// folder was deleted or renamed), it ends and `lost` is called once with the reason.
pub fn watch(dir: &Path, quiet: Duration, changed: impl Fn() + Send + 'static, lost: impl FnOnce(String) + Send + 'static) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| dir.display().to_string())?;
    let name = HSTRING::from(dir.as_os_str());
    let dir = dir.to_path_buf();
    let (armed, armed_rx) = mpsc::channel();
    std::thread::spawn(move || {
        // The handle is born in the thread that waits on it.
        let handle = unsafe { FindFirstChangeNotificationW(&name, true, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE) };
        let handle = match handle {
            Ok(handle) => handle,
            Err(e) => {
                let _ = armed.send(Err(e));
                return;
            }
        };
        let _ = armed.send(Ok(()));
        let quiet_ms = quiet.as_millis() as u32;
        // Windows goes on answering for a folder that is gone, so the folder is looked at each time before the handle
        // asks for the next change.
        let rearm = || match dir.is_dir() {
            true => unsafe { FindNextChangeNotification(handle) }.map_err(|e| format!("the watch cannot be armed again: {e}")),
            false => Err("the folder is gone or was renamed".to_string()),
        };
        let reason = loop {
            if unsafe { WaitForSingleObject(handle, INFINITE) } != WAIT_OBJECT_0 {
                break "waiting for a change failed".to_string();
            }
            let mut armed_again = rearm();
            while armed_again.is_ok() && unsafe { WaitForSingleObject(handle, quiet_ms) } == WAIT_OBJECT_0 {
                armed_again = rearm();
            }
            changed();
            if let Err(reason) = armed_again {
                break reason;
            }
        };
        unsafe { FindCloseChangeNotification(handle) }.ok();
        lost(reason);
    });
    armed_rx.recv().context("the watch did not start")?.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc::Receiver;

    const QUIET_TEST: Duration = Duration::from_millis(500);
    const LONG: Duration = Duration::from_secs(10);

    /// A watched `models` folder in a temporary one: what the watch announces as changes, and why it ended.
    fn watched() -> (tempfile::TempDir, PathBuf, Receiver<()>, Receiver<String>) {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("models");
        let (changed, changes) = mpsc::channel();
        let (lost, ended) = mpsc::channel();
        watch(&models, QUIET_TEST, move || { let _ = changed.send(()); }, move |why| { let _ = lost.send(why); }).unwrap();
        (dir, models, changes, ended)
    }

    /// Waits for a call, then for the folder to be quiet again, and says how many more calls came meanwhile.
    fn call_then_calm(changes: &Receiver<()>) -> usize {
        changes.recv_timeout(LONG).expect("a call within 10 s");
        std::iter::from_fn(|| changes.recv_timeout(QUIET_TEST * 3).ok()).count()
    }

    /// A file put by hand under the folder, at any depth, and one taken away are each told once the folder is quiet;
    /// a burst of writes is one call.
    #[test]
    fn a_file_put_in_the_folder_by_hand_or_taken_away_is_told() {
        let (_dir, models, changes, _ended) = watched();

        std::fs::write(models.join("mine.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
        std::fs::create_dir(models.join("owner")).unwrap();
        std::fs::write(models.join("owner").join("nested.gguf"), b"weights").unwrap();
        call_then_calm(&changes);

        for i in 0..20 {
            std::fs::write(models.join("owner").join("growing.part"), vec![0u8; 1000 * (i + 1)]).unwrap();
        }
        assert_eq!(call_then_calm(&changes), 0, "the burst of writes made one call");

        std::fs::remove_file(models.join("mine.gguf")).unwrap();
        call_then_calm(&changes);
    }

    /// The folder deleted or renamed while the app runs (a renamed one is noticed at the next change in it): the watch
    /// cannot follow it, so it ends, saying so once, and the thread is gone (no loop on a handle that keeps answering).
    #[test]
    fn a_folder_deleted_or_renamed_ends_the_watch_once() {
        for rename in [false, true] {
            let (dir, models, _changes, ended) = watched();
            match rename {
                true => {
                    // A renamed folder is watched under its new name until something changes in it.
                    let moved = dir.path().join("elsewhere");
                    std::fs::rename(&models, &moved).unwrap();
                    std::fs::write(moved.join("late.gguf"), b"weights").unwrap();
                }
                false => std::fs::remove_dir_all(&models).unwrap(),
            }
            let why = ended.recv_timeout(LONG).unwrap_or_else(|_| panic!("the watch did not end (rename: {rename})"));
            assert!(!why.is_empty());
            assert!(matches!(ended.recv_timeout(QUIET_TEST * 3), Err(mpsc::RecvTimeoutError::Disconnected)), "it said so once and left");
        }
    }
}
