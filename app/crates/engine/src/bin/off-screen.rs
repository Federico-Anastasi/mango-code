//! `off-screen <command> [arguments]`: runs a command on a Windows desktop of its own, which nobody sees. The windows
//! the command and its children open (the app's, a browser's, a file dialog's) exist and work, but never reach the
//! screen, the taskbar or the keyboard of whoever is using the PC. For the integration tests:
//!
//! ```text
//! off-screen bun test --cwd integration
//! ```
//!
//! Input, output and the exit code are the command's. Everything the command started ends with this program, also
//! when it is stopped halfway: on a desktop nobody sees, a process left behind could not be found by looking.
//! The command finds the name of its desktop in `MANGO_OFF_SCREEN`: the keyboard and the mouse of Windows do not
//! reach it, so what needs them (a real wheel, a real key) knows it cannot run there.
//! Exit code 2 for a missing command, 3 when the desktop or the command cannot be started.

use std::os::windows::io::AsRawHandle;
use std::ptr::null;
use windows_sys::Win32::Foundation::{GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, CreateDesktopW};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, INFINITE,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

const GENERIC_ALL: u32 = 0x1000_0000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: off-screen <command> [arguments]");
        std::process::exit(2);
    }
    match run(&args) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("off-screen: {e}");
            std::process::exit(3);
        }
    }
}

fn run(args: &[String]) -> Result<i32, String> {
    let failed = |what: &str| format!("{what} failed (Windows error {})", unsafe { GetLastError() });
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    // One desktop per run: two runs at the same time do not see each other's windows.
    let desktop = format!("mango-off-screen-{}", std::process::id());
    std::env::set_var("MANGO_OFF_SCREEN", &desktop);
    let name = wide(&desktop);
    let mut command = wide(&args.iter().map(|a| quoted(a)).collect::<Vec<_>>().join(" "));
    let inherited = |handle: HANDLE| unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        handle
    };
    unsafe {
        let desktop = CreateDesktopW(name.as_ptr(), null(), null(), 0, GENERIC_ALL, null());
        if desktop.is_null() {
            return Err(failed("CreateDesktop"));
        }
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(failed("CreateJobObject"));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, size) == 0 {
            return Err(failed("SetInformationJobObject"));
        }

        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.lpDesktop = name.as_ptr() as _;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = inherited(std::io::stdin().as_raw_handle() as HANDLE);
        startup.hStdOutput = inherited(std::io::stdout().as_raw_handle() as HANDLE);
        startup.hStdError = inherited(std::io::stderr().as_raw_handle() as HANDLE);
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        // Suspended until it is in the job: no child of its own can be born outside it.
        if CreateProcessW(null(), command.as_mut_ptr(), null(), null(), 1, CREATE_SUSPENDED, null(), null(), &startup, &mut process) == 0 {
            return Err(format!("{}: {}", args[0], failed("CreateProcess")));
        }
        if AssignProcessToJobObject(job, process.hProcess) == 0 {
            return Err(failed("AssignProcessToJobObject"));
        }
        ResumeThread(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        let mut code = 0u32;
        GetExitCodeProcess(process.hProcess, &mut code);
        CloseDesktop(desktop);
        Ok(code as i32)
    }
}

/// An argument the way the Windows command line wants it: quoted when it has spaces, backslashes doubled only before a quote.
fn quoted(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_string();
    }
    let mut out = String::from('"');
    let mut backslashes = 0;
    for c in argument.chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        out.push_str(&"\\".repeat(if c == '"' { backslashes * 2 + 1 } else { backslashes }));
        out.push(c);
        backslashes = 0;
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}
