//! Processes that a Job Object does not hold.
//!
//! PowerShell 7 installed from the Microsoft Store runs as a packaged app, and every process it starts (`Start-Process`,
//! a plain `Process.Start`, a web server left in the background) is created outside the job of whoever started the
//! PowerShell, however the job is set: when the job closes, it kills the shell but not those (measured with
//! `off-screen`: the same commands under Windows PowerShell 5.1 end with the job). They do inherit the environment, so
//! whoever owns a job gives its command a variable that names this run and, when the run ends, stops the processes that
//! carry it. A run that ended without the chance (the app closed by `taskkill /T /F`) is cleaned up by the next one
//! (`stale_runs`), which leaves the programs that have a window: the user may be working in them.

use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use windows::core::PCWSTR;
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, EnumDesktopWindows, EnumDesktopsW, GetProcessWindowStation, OpenDesktopW, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, PROCESS_VM_READ,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindowVisible};

/// The name of a run: the process that owns it and a random part. Another owner after this one ends is told by the
/// process id (`stale_runs`).
pub fn run_name() -> String {
    format!("{}-{}", std::process::id(), crate::random_hex(8))
}

/// Stops every process of the user that has `var` in its environment with a value `of_a_run_to_stop` accepts, and says
/// how many. Not this process.
pub fn kill_where_env(var: &str, of_a_run_to_stop: impl Fn(&str) -> bool) -> usize {
    let prefix: Vec<u16> = format!("{var}=").encode_utf16().collect();
    let me = std::process::id();
    processes().into_iter().map(|(pid, _)| pid).filter(|&pid| pid != me && is_marked(pid, &prefix, &of_a_run_to_stop, true)).count()
}

/// Like `kill_where_env`, but the processes that have a visible window stay, and so do those a window's process of the
/// same run started (a browser's helpers): what the user is working in outlives the run that opened it. When the windows
/// cannot be listed nothing is stopped.
pub fn kill_background_where_env(var: &str, of_a_run_to_stop: impl Fn(&str) -> bool) -> usize {
    let Some(owners) = window_owners() else { return 0 };
    let prefix: Vec<u16> = format!("{var}=").encode_utf16().collect();
    let me = std::process::id();
    let all = processes();
    let marked: HashSet<u32> = all.iter().map(|&(pid, _)| pid).filter(|&pid| pid != me && is_marked(pid, &prefix, &of_a_run_to_stop, false)).collect();
    let spared = spared_by_windows(&owners, &marked, &all);
    marked.iter().filter(|pid| !spared.contains(pid)).filter(|&&pid| is_marked(pid, &prefix, &of_a_run_to_stop, true)).count()
}

/// The `marked` processes (`all` gives each one's parent) that own a window in `owners`, or descend from a marked process
/// that does.
fn spared_by_windows(owners: &HashSet<u32>, marked: &HashSet<u32>, all: &[(u32, u32)]) -> HashSet<u32> {
    let parents: HashMap<u32, u32> = all.iter().copied().collect();
    let descends = |mut pid: u32| {
        // The chain is bounded: a parent id that was reused can close a loop.
        for _ in 0..64 {
            if owners.contains(&pid) && marked.contains(&pid) {
                return true;
            }
            match parents.get(&pid) {
                Some(&parent) if parent != pid && parent != 0 => pid = parent,
                _ => return false,
            }
        }
        false
    };
    marked.iter().copied().filter(|&pid| descends(pid)).collect()
}
/// The processes that own a visible top-level window on any desktop of this window station that can be read, minimized
/// ones included. `None` when no desktop can be read: nothing is known about the windows then.
fn window_owners() -> Option<HashSet<u32>> {
    unsafe extern "system" fn desktop(name: PCWSTR, names: LPARAM) -> BOOL {
        let names = &mut *(names.0 as *mut Vec<Vec<u16>>);
        names.push(name.as_wide().iter().copied().chain([0]).collect());
        BOOL(1)
    }
    unsafe extern "system" fn window(window: HWND, owners: LPARAM) -> BOOL {
        if IsWindowVisible(window).as_bool() {
            let mut owner = 0;
            GetWindowThreadProcessId(window, Some(&mut owner));
            (*(owners.0 as *mut HashSet<u32>)).insert(owner);
        }
        BOOL(1)
    }
    let mut names: Vec<Vec<u16>> = Vec::new();
    let mut owners = HashSet::new();
    let mut read = 0;
    unsafe {
        let station = GetProcessWindowStation().ok()?;
        EnumDesktopsW(station, Some(desktop), LPARAM(&mut names as *mut _ as isize)).ok()?;
        for name in names {
            // The desktop of the log-on screen, among others, is not ours to read.
            let Ok(opened) = OpenDesktopW(PCWSTR(name.as_ptr()), DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS.0) else { continue };
            if EnumDesktopWindows(opened, Some(window), LPARAM(&mut owners as *mut _ as isize)).is_ok() {
                read += 1;
            }
            let _ = CloseDesktop(opened);
        }
    }
    (read > 0).then_some(owners)
}

/// The runs of `run_name` whose owner is gone: a value that names a process that no longer runs.
pub fn stale_runs(value: &str) -> bool {
    let Some(owner) = value.split_once('-').and_then(|(pid, _)| pid.parse::<u32>().ok()) else { return false };
    !is_running(owner)
}

fn is_running(pid: u32) -> bool {
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        // Access denied: it exists and is not ours (a protected process). Any other refusal: no such process.
        let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(process) => process,
            Err(e) => return e.code() == windows::Win32::Foundation::E_ACCESSDENIED,
        };
        let mut code = 0u32;
        let running = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE;
        let _ = CloseHandle(process);
        running
    }
}

/// Every process: its id and its parent's.
fn processes() -> Vec<(u32, u32)> {
    let mut all = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return all };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = Process32FirstW(snapshot, &mut entry).is_ok();
        while found {
            all.push((entry.th32ProcessID, entry.th32ParentProcessID));
            found = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    all
}

/// Whether `pid` has `prefix` in its environment with a value `of_a_run_to_stop` accepts, and stops it if `stop`. A
/// process that cannot be opened (another user's, a protected one) is not ours: it stays.
fn is_marked(pid: u32, prefix: &[u16], of_a_run_to_stop: &impl Fn(&str) -> bool, stop: bool) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE, false, pid) else { return false };
        let marked = environment(process).is_some_and(|block| {
            block.split(|&c| c == 0).any(|entry| entry.starts_with(prefix) && of_a_run_to_stop(&String::from_utf16_lossy(&entry[prefix.len()..])))
        });
        let done = marked && (!stop || TerminateProcess(process, 1).is_ok());
        let _ = CloseHandle(process);
        done
    }
}

/// The environment block of a process (UTF-16, entries separated by NUL), read from its memory: the PEB points to the
/// process parameters, which hold its address and size (offsets of 64-bit Windows).
unsafe fn environment(process: HANDLE) -> Option<Vec<u16>> {
    let mut info = PROCESS_BASIC_INFORMATION::default();
    NtQueryInformationProcess(process, ProcessBasicInformation, &mut info as *mut _ as *mut _, size_of::<PROCESS_BASIC_INFORMATION>() as u32, &mut 0)
        .ok()
        .ok()?;
    let parameters: usize = read(process, info.PebBaseAddress as usize + 0x20)?;
    let address: usize = read(process, parameters + 0x80)?;
    let bytes: usize = read(process, parameters + 0x3F0)?;
    let mut block = vec![0u16; bytes.min(1 << 20) / 2];
    ReadProcessMemory(process, address as _, block.as_mut_ptr() as _, block.len() * 2, None).ok()?;
    Some(block)
}

unsafe fn read<T: Default>(process: HANDLE, address: usize) -> Option<T> {
    let mut value = T::default();
    ReadProcessMemory(process, address as _, &mut value as *mut T as _, size_of::<T>(), None).ok()?;
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    fn ping_with(var: &str, value: Option<&str>) -> Child {
        let mut cmd = Command::new("ping");
        cmd.args(["-n", "300", "127.0.0.1"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(crate::CREATE_NO_WINDOW);
        if let Some(v) = value {
            cmd.env(var, v);
        }
        cmd.spawn().unwrap()
    }

    fn ping(value: Option<&str>) -> Child {
        ping_with("MANGO_TEST_STRAGGLER", value)
    }

    const HOLDER: &str = "MANGO_TEST_WINDOW_HOLDER";
    /// The variable of the cleanup test of the windows: its own, so that the cleanups of the other tests do not stop its processes.
    const WINDOWS_RUN: &str = "MANGO_TEST_WINDOWS_RUN";

    /// The program of `a_window_holder`: a visible window on a desktop of its own, which nobody sees, until it is stopped.
    /// Run by itself it does nothing.
    #[test]
    fn window_holder_program() {
        use windows::core::w;
        use windows::Win32::System::StationsAndDesktops::{CreateDesktopW, SetThreadDesktop, DESKTOP_CONTROL_FLAGS};
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WINDOW_EX_STYLE, WS_POPUP, WS_VISIBLE};
        if std::env::var_os(HOLDER).is_none() {
            return;
        }
        unsafe {
            let name = format!("mango-test-desktop-{}\0", std::process::id()).encode_utf16().collect::<Vec<u16>>();
            let desktop = CreateDesktopW(PCWSTR(name.as_ptr()), None, None, DESKTOP_CONTROL_FLAGS(0), 0x1000_0000, None).unwrap();
            SetThreadDesktop(desktop).unwrap();
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("held"), WS_POPUP | WS_VISIBLE, 0, 0, 10, 10, None, None, None, None).unwrap();
            std::thread::sleep(Duration::from_secs(300));
        }
    }

    /// A process of this test binary that has a visible window on a desktop of its own, with `value` in `WINDOWS_RUN`.
    fn a_window_holder(value: &str) -> Child {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "stragglers::tests::window_holder_program", "--nocapture"])
            .env(HOLDER, "1")
            .env(WINDOWS_RUN, value)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::CREATE_NO_WINDOW);
        let child = cmd.spawn().unwrap();
        let t0 = Instant::now();
        while !window_owners().is_some_and(|owners| owners.contains(&child.id())) {
            assert!(t0.elapsed() < Duration::from_secs(10), "the window did not appear");
            std::thread::sleep(Duration::from_millis(50));
        }
        child
    }

    fn gone(child: &mut Child) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// Only the processes that carry this run's value die: those of another run of the app, or of nobody, stay.
    #[test]
    fn stops_the_processes_with_the_value_and_only_those() {
        let (mut ours, mut other_run, mut nobody) = (ping(Some("run-a")), ping(Some("run-b")), ping(None));

        let stopped = kill_where_env("MANGO_TEST_STRAGGLER", |value| value == "run-a");

        let (ours_gone, others_stay) = (gone(&mut ours), other_run.try_wait().unwrap().is_none() && nobody.try_wait().unwrap().is_none());
        let _ = (ours.kill(), other_run.kill(), nobody.kill());
        assert!(ours_gone, "the process with the value is still running");
        assert!(others_stay, "a process without the value was stopped");
        // a process with a console has a conhost.exe next to it, with the same environment
        assert!(stopped >= 1);
    }

    /// The run of an app that was closed by force is stale, the run of one that goes on is not, and a value that does not
    /// name an owner is left alone.
    #[test]
    fn a_run_is_stale_when_its_owner_is_gone() {
        let mut owner = ping(None);
        let name = format!("{}-abc", owner.id());
        assert!(!stale_runs(&name), "its owner runs");
        assert!(!stale_runs(&run_name()), "this process runs");
        owner.kill().unwrap();
        owner.wait().unwrap();
        assert!(stale_runs(&name), "its owner is gone");
        assert!(!stale_runs("0123456789abcdef"), "a value of another kind");
        assert!(!stale_runs("x-abc"), "no process id");
    }

    /// The cleanup at the start stops the processes of a closed run that have no visible window, and leaves the one the
    /// user may be using. The window is on a desktop nobody sees.
    #[test]
    fn the_cleanup_at_the_start_leaves_the_processes_with_a_visible_window() {
        let mut dead_owner = ping(None);
        let dead = format!("{}-dead", dead_owner.id());
        dead_owner.kill().unwrap();
        dead_owner.wait().unwrap();
        let (mut with_window, mut without) = (a_window_holder(&dead), ping_with(WINDOWS_RUN, Some(&dead)));

        kill_background_where_env(WINDOWS_RUN, stale_runs);

        let (without_gone, with_window_stays) = (gone(&mut without), with_window.try_wait().unwrap().is_none());
        let _ = (with_window.kill(), without.kill());
        assert!(without_gone, "the process without a window is still running");
        assert!(with_window_stays, "the process with a visible window was stopped");
    }

    /// A marked process is spared when it owns a window or descends from a marked one that does; a window of a process
    /// that is not marked (the shell, a terminal) spares nothing.
    #[test]
    fn what_a_window_started_is_spared_with_it() {
        // 1 holds a window; 2 and 3 descend from it; 4 descends from 5, a window of a process that is not marked; 6 has
        // no parent in the list.
        let all = [(1, 5), (2, 1), (3, 2), (4, 5), (5, 0), (6, 77)];
        let (owners, marked) = (HashSet::from([1, 5]), HashSet::from([1, 2, 3, 4, 6]));
        assert_eq!(spared_by_windows(&owners, &marked, &all), HashSet::from([1, 2, 3]));
        assert!(spared_by_windows(&HashSet::new(), &marked, &all).is_empty());
        let loop_of_parents = [(1, 2), (2, 1)];
        assert!(spared_by_windows(&HashSet::from([9]), &HashSet::from([1, 2]), &loop_of_parents).is_empty(), "a loop of parents ends");
    }

    /// What the stale-run cleanup does to a process of a closed run, and not to one of a run that goes on.
    #[test]
    fn the_stale_runs_are_stopped_and_the_live_ones_stay() {
        let mut dead_owner = ping(None);
        let dead = format!("{}-dead", dead_owner.id());
        dead_owner.kill().unwrap();
        dead_owner.wait().unwrap();
        let (mut left_behind, mut live) = (ping(Some(&dead)), ping(Some(&run_name())));

        kill_where_env("MANGO_TEST_STRAGGLER", stale_runs);

        let (left_behind_gone, live_stays) = (gone(&mut left_behind), live.try_wait().unwrap().is_none());
        let _ = (left_behind.kill(), live.kill());
        assert!(left_behind_gone, "the process of a closed run is still running");
        assert!(live_stays, "the process of a run that goes on was stopped");
    }
}
