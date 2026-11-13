//! Starts and watches the app's processes: the agent server (the engine is the `EngineManager`'s, which also stops it).
//!
//! The app itself enters a Job Object with KILL_ON_JOB_CLOSE at startup: every child and grandchild
//! inherits it, so when the app closes, or crashes, Windows kills them all. No orphan
//! engines holding the VRAM. A process started with CREATE_BREAKAWAY_FROM_JOB leaves it (the job allows it): the
//! installer of an update (`updater.rs`), which must outlive the app it replaces, and the programs the app opens for
//! the user (`open_outside_job`).
//! The Job does not hold what the Store's PowerShell 7 starts: at quit `stop_stragglers` stops those (`stragglers.rs`).

use anyhow::{bail, Context, Result};
use mango_common::{tail, tr, ProcSpec, CREATE_NO_WINDOW};
use std::fs::File;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::GetCurrentProcess;

/// The process leaves the app's job (which allows it): it survives the app.
pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Names this run of the app in the environment of the agent, and so of every process the agent starts (`stragglers.rs`).
const RUN_VAR: &str = "MANGO_APP_RUN";

pub struct Supervisor {
    _job: HANDLE,
    run: String,
    children: Mutex<Vec<Running>>,
    logs: PathBuf,
}

struct Running {
    name: String,
    child: Child,
    log: PathBuf,
}

// The job handle is not used from other threads after creation: it stays open as long as the app lives.
unsafe impl Send for Supervisor {}
unsafe impl Sync for Supervisor {}

impl Supervisor {
    pub fn new(logs: &Path) -> Result<Self> {
        let job = unsafe {
            let job = CreateJobObjectW(None, None).context("CreateJobObjectW")?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .context("SetInformationJobObject")?;
            AssignProcessToJobObject(job, GetCurrentProcess())
                .context("AssignProcessToJobObject (app)")?;
            job
        };
        Ok(Self { _job: job, run: mango_common::random_hex(16), children: Mutex::new(Vec::new()), logs: logs.to_path_buf() })
    }

    /// Starts the process hidden, with stdout and stderr on `<logs>/<name>.log`.
    pub fn spawn(&self, spec: &ProcSpec) -> Result<PathBuf> {
        let log = self.logs.join(format!("{}.log", spec.name));
        let out = File::create(&log).with_context(|| format!("log {}", log.display()))?;
        let err = out.try_clone()?;
        let mut cmd = Command::new(&spec.exe);
        cmd.args(&spec.args)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .creation_flags(CREATE_NO_WINDOW)
            .env(RUN_VAR, &self.run);
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(d) = &spec.cwd {
            cmd.current_dir(d);
        }
        let child = cmd
            .spawn()
            .with_context(|| tr!("avvio di {} ({})", "starting {} ({})", spec.name, spec.exe.display()))?;
        self.children.lock().unwrap().push(Running {
            name: spec.name.clone(),
            child,
            log: log.clone(),
        });
        Ok(log)
    }

    /// Waits for `spec.health_url` to answer 200. If the process dies first, or the time runs out,
    /// the error carries the last lines of its log. `tick` receives the seconds elapsed.
    pub fn wait_ready(&self, spec: &ProcSpec, mut tick: impl FnMut(u64)) -> Result<()> {
        let Some(url) = &spec.health_url else { return Ok(()) };
        let t0 = Instant::now();
        let agent = mango_common::internet::agent(url, Duration::from_secs(2));
        loop {
            if let Ok(r) = agent.get(url).call() {
                if r.status().as_u16() == 200 {
                    return Ok(());
                }
            }
            if let Some((code, log)) = self.exited(&spec.name) {
                bail!(
                    "{}",
                    tr!(
                        "{} si è chiuso subito (codice {code}).\n{}",
                        "{} exited right away (code {code}).\n{}",
                        spec.name,
                        tail(&log, 12)
                    )
                );
            }
            let s = t0.elapsed().as_secs();
            if s >= spec.ready_timeout_s {
                let log = self.logs.join(format!("{}.log", spec.name));
                bail!(
                    "{}",
                    tr!("{} non risponde dopo {s} s.\n{}", "{} does not answer after {s} s.\n{}", spec.name, tail(&log, 12))
                );
            }
            tick(s);
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn exited(&self, name: &str) -> Option<(String, PathBuf)> {
        let mut ch = self.children.lock().unwrap();
        let r = ch.iter_mut().find(|r| r.name == name)?;
        match r.child.try_wait() {
            Ok(Some(st)) => Some((
                st.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                r.log.clone(),
            )),
            _ => None,
        }
    }

    /// Stops all the children (the agent, whose running request drops and releases the engine). The job would
    /// kill them anyway when the app closes.
    pub fn shutdown(&self) {
        let children: Vec<Running> = self.children.lock().unwrap().drain(..).rev().collect();
        for mut r in children {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

impl Supervisor {
    /// At quit: stops what the agent started and the Job did not hold (`stragglers.rs`).
    pub fn stop_stragglers(&self) -> usize {
        crate::stragglers::kill_with_env(RUN_VAR, &self.run)
    }
}

/// Opens a file, a folder or an address with its Windows program, outside the app's job: the browser or the
/// spreadsheet the app opens for the user must stay open when the app quits. The opener plugin started them inside
/// the job, and Windows closed them together with the app (tried on a second PC: Chrome, opened by the app, closed
/// when the app quit). Same command as the plugin: Invoke-Item for paths, Start-Process for addresses.
pub fn open_outside_job(target: &str) -> std::io::Result<()> {
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", OPEN_SCRIPT])
        .env("MANGO_OPEN_TARGET", target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .map(|_| ())
}

const OPEN_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath $env:MANGO_OPEN_TARGET) { Invoke-Item -LiteralPath $env:MANGO_OPEN_TARGET } else { Start-Process -FilePath $env:MANGO_OPEN_TARGET }";
