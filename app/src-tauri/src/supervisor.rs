//! Starts and watches the app's processes (engine, agent server).
//!
//! The app itself enters a Job Object with KILL_ON_JOB_CLOSE at startup: every child and grandchild
//! inherits it, so when the app closes, or crashes, Windows kills them all. No orphan
//! engines holding the VRAM. A process started with CREATE_BREAKAWAY_FROM_JOB leaves it (the job allows it): the
//! installer of an update (`updater.rs`), which must outlive the app it replaces.

use anyhow::{bail, Context, Result};
use mango_common::{tr, ProcSpec};
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

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Supervisor {
    _job: HANDLE,
    children: Mutex<Vec<Running>>,
    logs: PathBuf,
}

struct Running {
    name: String,
    child: Child,
    log: PathBuf,
    shutdown_post: Option<mango_common::PostCall>,
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
        Ok(Self { _job: job, children: Mutex::new(Vec::new()), logs: logs.to_path_buf() })
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
            .creation_flags(CREATE_NO_WINDOW);
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
            shutdown_post: spec.shutdown_post.clone(),
        });
        Ok(log)
    }

    /// Waits for `spec.health_url` to answer 200. If the process dies first, or the time runs out,
    /// the error carries the last lines of its log. `tick` receives the seconds elapsed.
    pub fn wait_ready(&self, spec: &ProcSpec, mut tick: impl FnMut(u64)) -> Result<()> {
        let Some(url) = &spec.health_url else { return Ok(()) };
        let t0 = Instant::now();
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
        loop {
            if let Ok(r) = agent.get(url).call() {
                if r.status() == 200 {
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

    /// Stops all the children, in reverse start order: first whoever uses the engine (the agent, whose
    /// running request drops and releases the engine), then the engine, which before the end receives its
    /// `shutdown_post` (saves the open conversation). The job would kill them anyway when the app
    /// closes, but without saving.
    pub fn shutdown(&self) {
        let children: Vec<Running> = self.children.lock().unwrap().drain(..).rev().collect();
        for mut r in children {
            if let Some(c) = &r.shutdown_post {
                if matches!(r.child.try_wait(), Ok(None)) {
                    let t0 = Instant::now();
                    match c.send() {
                        Ok(v) => eprintln!("{}: orderly shutdown in {} ms: {v}", r.name, t0.elapsed().as_millis()),
                        Err(e) => eprintln!("{}: orderly shutdown failed ({e}), stopping anyway", r.name),
                    }
                }
            }
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

/// Last `n` non-empty lines of a log, for the error messages.
pub fn tail(path: &Path, n: usize) -> String {
    let txt = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = txt.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}
