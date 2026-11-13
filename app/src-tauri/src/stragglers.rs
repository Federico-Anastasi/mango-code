//! Processes of the agent that the Job Object does not hold.
//!
//! PowerShell 7 installed from the Microsoft Store runs as a packaged app, and what it starts (`Start-Process`, a plain
//! `Process.Start`, a web server left in the background) is created outside every job, however the job is set: when
//! the app quits, the Job kills the agent and its servers but not those. Every process the agent starts inherits its
//! environment, so the supervisor gives the agent a variable that names this run of the app and, at quit, stops the
//! processes that carry it.

use std::mem::size_of;
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{
    OpenProcess, TerminateProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION, PROCESS_TERMINATE, PROCESS_VM_READ,
};

/// Stops every process of the user whose environment has `var=value`, and says how many.
pub fn kill_with_env(var: &str, value: &str) -> usize {
    let wanted: Vec<u16> = format!("{var}={value}").encode_utf16().collect();
    let me = std::process::id();
    pids().into_iter().filter(|&pid| pid != me).filter(|&pid| stop_if_marked(pid, &wanted)).count()
}

fn pids() -> Vec<u32> {
    let mut pids = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return pids };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = Process32FirstW(snapshot, &mut entry).is_ok();
        while found {
            pids.push(entry.th32ProcessID);
            found = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    pids
}

/// A process that cannot be opened (another user's, a protected one) is not ours: it stays.
fn stop_if_marked(pid: u32, wanted: &[u16]) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE, false, pid) else { return false };
        let marked = environment(process).is_some_and(|block| block.split(|&c| c == 0).any(|entry| entry == wanted));
        let stopped = marked && TerminateProcess(process, 1).is_ok();
        let _ = CloseHandle(process);
        stopped
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

    fn ping(value: Option<&str>) -> Child {
        let mut cmd = Command::new("ping");
        cmd.args(["-n", "300", "127.0.0.1"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(mango_common::CREATE_NO_WINDOW);
        if let Some(v) = value {
            cmd.env("MANGO_TEST_STRAGGLER", v);
        }
        cmd.spawn().unwrap()
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

        let stopped = kill_with_env("MANGO_TEST_STRAGGLER", "run-a");

        let (ours_gone, others_stay) = (gone(&mut ours), other_run.try_wait().unwrap().is_none() && nobody.try_wait().unwrap().is_none());
        let _ = (ours.kill(), other_run.kill(), nobody.kill());
        assert!(ours_gone, "the process with the value is still running");
        assert!(others_stay, "a process without the value was stopped");
        // a process with a console has a conhost.exe next to it, with the same environment
        assert!(stopped >= 1);
    }
}
