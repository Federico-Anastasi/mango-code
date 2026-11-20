//! The app's small jobs: `mango-code.exe` started with one of these arguments does that job and exits, before any window,
//! Tauri or single-instance check exists.
//!
//! - `--relaunch <pid> [arguments]`: waits for process `<pid>` to end, then starts the app with the arguments. The app
//!   uses it to start again by itself (after the models folder moved): a second start while the first is still closing
//!   would only be handed over to it.
//! - `--reap <pid> <run>`: the guardian of a run (`stragglers::reap_when_gone`), started by the app outside its job so
//!   that it outlives the app however the app ends.

use mango_common::stragglers::{reap_when_gone, wait_for_exit, Waited};
use mango_common::{data_log, CREATE_NO_WINDOW};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

/// `CreateProcess` flag: the process leaves the app's job (which allows it) and survives the app.
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// How long `--relaunch` waits for the old app to end; an app that is still there after this is stuck, and a second one
/// would only be handed over to it.
const CLOSING: Duration = Duration::from_secs(180);

/// The mark of the guardian that is already the detached copy.
const DETACHED: &str = "--detached";

/// Where a copy of the program started by `detached` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Outside the app's job: it outlives the app however the app ends.
    Outside,
    /// An outer job does not let a process leave it (the tests run the app inside one), so the copy is in the app's job and
    /// ends with it, unless the app lets the job go before it ends (`Supervisor::let_go`).
    InTheJob,
}

/// A copy of this program that does `args`, with no window, outside the app's job and with nothing of its streams. Where an
/// outer job does not allow leaving it, the copy starts without leaving, and the answer says so.
fn detached(args: &[String]) -> std::io::Result<Placement> {
    let exe = std::env::current_exe()?;
    let start = |flags: u32| Command::new(&exe).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags).spawn().map(|_| ());
    match start(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB) {
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => start(CREATE_NO_WINDOW).map(|()| Placement::InTheJob),
        other => other.map(|()| Placement::Outside),
    }
}

/// If this start is one of the jobs above, does it and says the exit code.
pub fn run() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let owner = || args.get(1).and_then(|pid| pid.parse::<u32>().ok());
    match args.first().map(String::as_str) {
        Some("--relaunch") => Some(match owner() {
            Some(pid) => match wait_for_exit(pid, Some(CLOSING)) {
                Waited::Ended => {
                    let started = std::env::current_exe().and_then(|exe| Command::new(exe).args(&args[2..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn());
                    if let Err(e) = &started {
                        data_log(&format!("the restart of the app did not start: {e}"));
                    }
                    i32::from(started.is_err())
                }
                other => {
                    data_log(&format!("the restart of the app does not happen: the app did not end ({other:?})"));
                    1
                }
            },
            None => 1,
        }),
        Some("--reap") => Some(match (owner(), args.get(2)) {
            // The first copy only starts the second and goes: the second is not a child of the app, so ending the app
            // with its processes (`taskkill /T`) does not reach it.
            (Some(_), Some(_)) if args.get(3).map(String::as_str) != Some(DETACHED) => {
                i32::from(detached(&[args[0].clone(), args[1].clone(), args[2].clone(), DETACHED.into()]).is_err())
            }
            (Some(pid), Some(run)) => match reap_when_gone(pid, crate::supervisor::RUN_VAR, run) {
                Ok(_) => 0,
                Err(why) => {
                    data_log(&format!("the guardian of the programs the agent starts stopped nothing: {why}"));
                    1
                }
            },
            _ => 2,
        }),
        _ => None,
    }
}

/// Starts the guardian of `run`, which stops its programs when this process ends.
pub fn start_guardian(run: &str) -> std::io::Result<Placement> {
    detached(&["--reap".into(), std::process::id().to_string(), run.into()])
}

/// Starts the app again once this process has ended. The caller closes the app right after.
pub fn relaunch_after_exit(args: &[String]) -> std::io::Result<Placement> {
    let mut all = vec!["--relaunch".to_string(), std::process::id().to_string()];
    all.extend_from_slice(args);
    detached(&all)
}
