//! `off-screen`: everything the command started ends with it. The Store's PowerShell 7 starts its programs outside the job
//! of whoever runs it (`mango_common::stragglers`), so the command's environment carries a name of this run and what has
//! it is stopped when the command ends.

use std::os::windows::process::CommandExt;
use std::process::Command;

const OFF_SCREEN: &str = env!("CARGO_BIN_EXE_off-screen");

#[test]
fn a_program_started_by_the_command_does_not_outlive_it() {
    if Command::new("pwsh").args(["-NoProfile", "-Command", "exit"]).creation_flags(mango_common::CREATE_NO_WINDOW).status().is_err() {
        eprintln!("skipped: PowerShell 7 is not installed");
        return;
    }
    let mark = format!("off-screen-test-{}", std::process::id());
    let script = format!("$env:MANGO_TEST_MARK = '{mark}'; Start-Process -WindowStyle Hidden ping -ArgumentList '-n 300 127.0.0.1'");
    let status = Command::new(OFF_SCREEN).args(["pwsh", "-NoProfile", "-Command", &script]).creation_flags(mango_common::CREATE_NO_WINDOW).status().unwrap();
    assert!(status.success(), "{status}");

    let left_behind = mango_common::stragglers::kill_where_env("MANGO_TEST_MARK", |value| value == mark);

    assert_eq!(left_behind, 0, "the program was still running after the command ended");
}
