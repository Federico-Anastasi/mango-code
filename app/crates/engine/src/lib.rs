//! The engine manager: a single `llama-server` running at a time, behind a fixed port.
//!
//! The agent (and every app that integrates) always talks to the manager's port (`http.rs`). Each `/v1/...`
//! request names the model it wants (`"model"`, the key in mango-models.json): if it is the running one it passes,
//! otherwise the manager waits for the in-flight requests to finish, stops the engine and starts the right one. The
//! GPUs can be **released** for another heavy job and **resumed** afterwards: meanwhile requests wait, and the
//! conversation continues.
//! `release` lets in-flight requests finish (at most `RELEASE_WAIT`), stops the engine and replies: it doesn't wait
//! for a model to restart on the remaining GPUs, the first request after does that.
//!
//! The manager itself starts the engine process: in the app it is a child of the app's process, which sits in a Job
//! Object (see the app's `supervisor.rs`), so it dies with it.

pub mod tune;
pub mod bench;
pub mod http;
mod loan;

use anyhow::{bail, Context, Result};
use engine_cfg::EnginePlan;
use mango_common::{tr, user_error};
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How long a request waits while the GPUs are released, before giving up.
const RELEASED_WAIT: Duration = Duration::from_secs(30 * 60);
/// How long `release` lets in-flight requests finish before stopping the engine (and cutting them).
pub const RELEASE_WAIT: Duration = Duration::from_secs(60);

/// Produces the engine plan: model key, internal port, GPUs not to use.
pub type Planner = dyn Fn(&str, u16, &[u32]) -> Result<EnginePlan> + Send + Sync;
/// Memory used right now on each GPU: (PCI index, MiB used, MiB total).
pub type GpuMeter = dyn Fn() -> Vec<(u32, u64, u64)> + Send + Sync;

/// The requested model doesn't start on this PC as it is (unknown, missing files, doesn't fit in memory): the plan
/// refuses it before starting anything, and retrying is useless until the user changes something.
#[derive(Debug)]
pub struct WillNotStart(pub String);

impl std::fmt::Display for WillNotStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WillNotStart {}

/// What llama.cpp writes in the log when memory isn't enough (CUDA, Vulkan, RAM).
const OUT_OF_MEMORY: [&str; 4] = ["out of memory", "failed to allocate", "ErrorOutOfDeviceMemory", "unable to allocate"];

/// The values on the wire (`phase` of `GET /engine`) are in English: they are the contract with the apps (docs/INTEGRATION.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum Phase {
    #[default]
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "running")]
    Running,
    /// `release` is waiting for the in-flight requests to end and then saves and stops the engine. New requests wait.
    #[serde(rename = "releasing")]
    Releasing,
    #[serde(rename = "released")]
    Released,
    #[serde(rename = "error")]
    Error,
}

/// The state to show (route `GET /engine`, app). The names on the wire are in English (`serde(rename)`): they are
/// the contract with the apps (docs/INTEGRATION.md).
#[derive(Debug, Clone, Serialize)]
pub struct PublicState {
    pub phase: Phase,
    /// The running model, or the one that will be resumed.
    pub model: Option<String>,
    pub name: Option<String>,
    pub context: Option<u32>,
    /// The GPUs the running engine uses, with the memory used right now.
    pub gpus: Vec<PublicGpu>,
    /// GPUs released for another job (all of them: `all_released`).
    #[serde(rename = "released_gpus")]
    pub released: Vec<u32>,
    pub all_released: bool,
    /// Who has the GPUs on loan, and since when.
    pub loans: Vec<PublicLoan>,
    pub requests_in_flight: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicLoan {
    /// The GPUs lent; `None` = all.
    pub gpus: Option<Vec<u32>>,
    /// The process the loan is tied to: when it closes, the manager resumes. `None` = until `resume`.
    pub pid: Option<u32>,
    /// The `User-Agent` of whoever asked.
    pub who: String,
    /// When (local time, RFC 3339).
    pub since: String,
}

/// Who asks for the GPUs: the process to tie the loan to (`None`: until `resume`) and how it introduces itself.
pub struct Requester {
    pub pid: Option<u32>,
    pub who: String,
}

struct Loan {
    gpus: Option<Vec<u32>>,
    process: Option<loan::Process>,
    who: String,
    since: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicGpu {
    pub index: u32,
    pub name: String,
    pub memory_used_mib: Option<u64>,
    pub memory_total_mib: u64,
}

struct Running {
    plan: EnginePlan,
    child: Child,
}

#[derive(Default)]
struct State {
    phase: Phase,
    /// The model to keep running: it stays even while the GPUs are released.
    wanted: Option<String>,
    running: Option<Running>,
    loans: Vec<Loan>,
    /// The GPUs of the loans (`all`: a loan has taken all of them).
    excluded: Vec<u32>,
    all: bool,
    /// The running engine has restarted on the only GPUs left after a `release`.
    reduced: bool,
    /// The model that, after a `release`, doesn't fit on the remaining GPUs: requests wait for `resume`.
    doesnt_fit: Option<String>,
    error: Option<String>,
    in_flight: usize,
}

struct Inner {
    release_wait_ms: AtomicU64,
    planner: Box<Planner>,
    measure: Box<GpuMeter>,
    logs: PathBuf,
    remembered_file: Option<PathBuf>,
    st: Mutex<State>,
    cv: Condvar,
}

#[derive(Clone)]
pub struct EngineManager(Arc<Inner>);

/// The permission to use the running engine for a request: while it lives, the manager doesn't stop it to start
/// another model.
pub struct Permit {
    m: EngineManager,
    pub url: String,
    pub key: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut s = self.m.lock();
        s.in_flight = s.in_flight.saturating_sub(1);
        self.m.0.cv.notify_all();
    }
}

impl EngineManager {
    /// `logs`: the engine log folder (`engine.log`). `remembered_file`: file where the last running model is
    /// written, to resume it at the next startup.
    pub fn new(planner: Box<Planner>, measure: Box<GpuMeter>, logs: &Path, remembered_file: Option<PathBuf>) -> EngineManager {
        let m = EngineManager(Arc::new(Inner {
            release_wait_ms: AtomicU64::new(RELEASE_WAIT.as_millis() as u64),
            planner,
            measure,
            logs: logs.to_path_buf(),
            remembered_file,
            st: Mutex::new(State::default()),
            cv: Condvar::new(),
        }));
        // Every second: the loans of processes that have closed end (see `check_loans`).
        let weak = Arc::downgrade(&m.0);
        let _ = std::thread::Builder::new().name("engine-loans".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            match weak.upgrade() {
                Some(inner) => EngineManager(inner).check_loans(),
                None => return,
            }
        });
        m
    }

    /// Removes the loans of processes that closed without calling `resume`, and writes it in the log. If no loan
    /// is left the engine resumes as with `resume`.
    fn check_loans(&self) {
        let (ended, resume) = {
            let mut s = self.lock();
            let (alive, ended): (Vec<Loan>, Vec<Loan>) =
                std::mem::take(&mut s.loans).into_iter().partition(|p| p.process.as_ref().is_none_or(|x| x.alive()));
            s.loans = alive;
            if ended.is_empty() {
                return;
            }
            recompute_excluded(&mut s);
            (ended, s.loans.is_empty())
        };
        for p in &ended {
            self.log(serde_json::json!({
                "event": "loan_ended",
                "pid": p.process.as_ref().map(|x| x.pid),
                "who": p.who,
                "since": p.since,
                "reason": "the process that had asked for the GPUs closed without calling «resume»",
            }));
        }
        self.0.cv.notify_all();
        if resume {
            let m = self.clone();
            let _ = std::thread::Builder::new().name("engine-resume".into()).spawn(move || m.resume_after_loan());
        }
    }

    /// The resume that starts by itself when the last loan has ended: it gives up if, while it was starting (or
    /// while it waited for a start or a `release` to finish), a new loan was born, which isn't its own.
    fn resume_after_loan(&self) {
        if let Err(e) = self.resume_with(true, &mut |_| {}) {
            self.log(serde_json::json!({ "event": "resume_after_loan", "error": format!("{e:#}") }));
        }
    }

    /// Changes the maximum time `release` waits for in-flight requests (see `RELEASE_WAIT`).
    pub fn set_release_wait(&self, d: Duration) {
        self.0.release_wait_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    /// The last running model, if it was remembered.
    pub fn remembered(&self) -> Option<String> {
        let f = self.0.remembered_file.as_ref()?;
        std::fs::read_to_string(f).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    /// One line per control call in `manager.log` (logs folder): JSON, with local time.
    pub fn log(&self, mut line: serde_json::Value) {
        line["time"] = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false).into();
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.0.logs.join("manager.log"))
            .and_then(|mut f| writeln!(f, "{line}"));
        if let Err(e) = written {
            eprintln!("manager.log: {e}");
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts `key` (stopping the other model, if any) and waits until it's ready. `tick` receives the seconds
    /// elapsed while loading.
    pub fn start(&self, key: &str, tick: &mut dyn FnMut(u64)) -> Result<()> {
        drop(self.use_with(Some(key), tick)?);
        Ok(())
    }

    /// The engine for a request: `key` is the model it asks for (`None` = the running or wanted one).
    /// If needed, starts the model; while the GPUs are released it waits for them to resume.
    pub fn acquire(&self, key: Option<&str>) -> Result<Permit> {
        self.use_with(key, &mut |_| {})
    }

    fn use_with(&self, key: Option<&str>, tick: &mut dyn FnMut(u64)) -> Result<Permit> {
        let t0 = Instant::now();
        let mut s = self.lock();
        loop {
            let want = match key.map(str::to_string).or_else(|| s.wanted.clone()) {
                Some(k) => k,
                None => bail!("{}", tr!("nessun modello da accendere", "no model to start")),
            };
            // The running engine exited by itself (crash): it's noted in the log and the request restarts it.
            if s.phase == Phase::Running {
                let exited = s.running.as_mut().and_then(|a| a.child.try_wait().ok().flatten());
                if let Some(st) = exited {
                    let a = s.running.take().expect("running engine");
                    let log = self.0.logs.join(format!("{}.log", a.plan.spec.name));
                    let code = st.code();
                    s.phase = Phase::Error;
                    s.error = Some(format!(
                        "{:#}",
                        user_error(
                            &tr!(
                                "Il motore si è chiuso mentre lavorava: la prossima richiesta lo riaccende.",
                                "The engine closed while working: the next request restarts it."
                            ),
                            tr!("codice {code:?}.\n{}", "code {code:?}.\n{}", tail(&log, 6))
                        )
                    ));
                    self.log(serde_json::json!({ "event": "crash", "model": a.plan.key, "code": code, "log": tail(&log, 3) }));
                }
            }
            match s.phase {
                Phase::Running if s.running.as_ref().is_some_and(|a| a.plan.key == want) => {
                    s.in_flight += 1;
                    let url = s.running.as_ref().map(|a| a.plan.url.clone()).unwrap_or_default();
                    return Ok(Permit { m: self.clone(), url, key: want });
                }
                Phase::Starting => s = self.wait(s, Duration::from_secs(1)),
                // Released only in part: the model restarts on the remaining GPUs, if it fits.
                Phase::Released if !s.all && s.doesnt_fit.as_deref() != Some(want.as_str()) => {
                    s = match self.start_model(s, &want, tick) {
                        Ok(mut s) => {
                            s.reduced = true;
                            s
                        }
                        Err(_) => {
                            let mut s = self.lock();
                            s.phase = Phase::Released;
                            s.doesnt_fit = Some(want);
                            s
                        }
                    };
                }
                Phase::Releasing | Phase::Released => {
                    if t0.elapsed() > RELEASED_WAIT {
                        bail!(
                            "{}",
                            tr!(
                                "le schede video sono liberate per un altro lavoro: il motore si riaccende con «resume»",
                                "the graphics cards are released for another job: the engine restarts with «resume»"
                            )
                        );
                    }
                    s = self.wait(s, Duration::from_secs(1));
                }
                // Another model is running: wait for its requests to finish, then switch.
                Phase::Running if s.in_flight > 0 => s = self.wait(s, Duration::from_secs(1)),
                Phase::Running | Phase::Stopped | Phase::Error => {
                    s = self.start_model(s, &want, tick)?;
                }
            }
        }
    }

    fn wait<'a>(&self, s: MutexGuard<'a, State>, d: Duration) -> MutexGuard<'a, State> {
        self.0.cv.wait_timeout(s, d).unwrap_or_else(|e| e.into_inner()).0
    }

    /// Stops the running one and starts `key`. The lock is released during the slow parts. The new model's plan is
    /// made before stopping the old one: a model that can't start (unknown, missing files, released GPUs) leaves
    /// the one that was running in place.
    fn start_model<'a>(&'a self, mut s: MutexGuard<'a, State>, key: &str, tick: &mut dyn FnMut(u64)) -> Result<MutexGuard<'a, State>> {
        let wanted_before = s.wanted.clone();
        s.phase = Phase::Starting;
        s.wanted = Some(key.to_string());
        s.error = None;
        let mut old = s.running.take();
        let excluded = if s.all { None } else { Some(s.excluded.clone()) };
        drop(s);
        let plan = match excluded {
            None => Err(anyhow::anyhow!(tr!(
                "le schede video sono tutte liberate per un altro lavoro",
                "all the graphics cards are released for another job"
            ))),
            Some(excluded) => self.plan(key, &excluded).map_err(|e| anyhow::Error::new(WillNotStart(format!("{e:#}")))),
        };
        let outcome = match plan {
            Err(e) => Err(e),
            Ok(plan) => {
                if let Some(a) = old.take() {
                    self.stop_process(a);
                }
                self.start_process(plan, tick)
            }
        };
        let mut s = self.lock();
        match outcome {
            Ok(a) => {
                s.phase = Phase::Running;
                s.running = Some(a);
                if let Some(f) = &self.0.remembered_file {
                    let _ = std::fs::write(f, key);
                }
                self.0.cv.notify_all();
                Ok(s)
            }
            Err(e) => {
                s.error = Some(format!("{e:#}"));
                match old {
                    Some(a) => {
                        s.phase = Phase::Running;
                        s.running = Some(a);
                        s.wanted = wanted_before;
                    }
                    None => s.phase = Phase::Error,
                }
                self.0.cv.notify_all();
                Err(e)
            }
        }
    }

    /// The engine plan for `key` on a free port, without the `excluded` GPUs.
    fn plan(&self, key: &str, excluded: &[u32]) -> Result<EnginePlan> {
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        (self.0.planner)(key, port, excluded)
    }

    fn start_process(&self, plan: EnginePlan, tick: &mut dyn FnMut(u64)) -> Result<Running> {
        let log = self.0.logs.join(format!("{}.log", plan.spec.name));
        let out = File::create(&log).with_context(|| format!("log {}", log.display()))?;
        let mut cmd = Command::new(&plan.spec.exe);
        cmd.args(&plan.spec.args)
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .creation_flags(CREATE_NO_WINDOW);
        for k in &plan.spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &plan.spec.env {
            cmd.env(k, v);
        }
        // Without a folder of its own the engine would write its files (ik_llama.cpp: `llama.log`) where the app started.
        cmd.current_dir(plan.spec.cwd.as_ref().unwrap_or(&self.0.logs));
        let t0 = Instant::now();
        let child = cmd.spawn().with_context(|| tr!("avvio del motore ({})", "starting the engine ({})", plan.spec.exe.display()))?;
        let mut a = Running { plan, child };
        match wait_healthy(&mut a, &log, tick) {
            Ok(()) => {
                // The conversation used last: the on-disk memory restores it before the engine says it's ready;
                // the other engines restore it with the plan's startup call. If it fails the engine works anyway
                // (it rereads everything) and the log says so.
                let mut line = serde_json::json!({ "event": "restore", "model": a.plan.key });
                match &a.plan.spec.startup_post {
                    Some(c) => match c.send() {
                        Ok(v) => line["token"] = v["n_restored"].clone(),
                        Err(e) => line["error"] = format!("{e:#}").into(),
                    },
                    None => line["token"] = cached_tokens(&a.plan.url).into(),
                }
                line["ms"] = (t0.elapsed().as_millis() as u64).into();
                self.log(line);
                Ok(a)
            }
            Err(e) => {
                let _ = a.child.kill();
                let _ = a.child.wait();
                Err(e)
            }
        }
    }

    /// Releases the `gpus` (PCI indexes; `None` = all) for another job. If the running engine uses one of them,
    /// new requests wait (phase `releasing`), in-flight requests finish, but for `RELEASE_WAIT` at most: after that
    /// they drop. Then the engine stops, saving the conversation if it has the on-disk memory, and `release` replies.
    /// A model that splits itself restarts on the remaining GPUs at the first request.
    /// The loan is `who`'s: if its process closes before `resume`, the loan ends by itself.
    pub fn release(&self, gpus: Option<&[u32]>, who: Requester) -> Result<PublicState> {
        let mut s = self.lock();
        while matches!(s.phase, Phase::Starting | Phase::Releasing) {
            s = self.wait(s, Duration::from_secs(1));
        }
        let process = match who.pid {
            None => None,
            Some(pid) => Some(loan::Process::open(pid).with_context(|| {
                tr!("il processo {pid} a cui legare il prestito non c'è", "the process {pid} to tie the loan to doesn't exist")
            })?),
        };
        s.loans.push(Loan {
            gpus: gpus.map(<[u32]>::to_vec),
            process,
            who: who.who,
            since: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        });
        recompute_excluded(&mut s);
        s.doesnt_fit = None;
        let affects = |a: &Running, s: &State| s.all || a.plan.gpus_used.iter().any(|g| s.excluded.contains(&g.index));
        if s.running.as_ref().is_some_and(|a| affects(a, &s)) {
            s.phase = Phase::Releasing;
            let deadline = Instant::now() + Duration::from_millis(self.0.release_wait_ms.load(Ordering::Relaxed));
            while s.in_flight > 0 {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                s = self.wait(s, left);
            }
            let to_stop = s.running.take();
            s.reduced = false;
            // The phase stays `releasing` until the engine is stopped: a request arriving during the save would
            // start an engine (on the remaining GPUs) that would read from disk the conversation from before the
            // save, with the old one still on the GPUs.
            drop(s);
            if let Some(a) = to_stop {
                self.stop_process(a);
            }
            let mut s = self.lock();
            if s.phase == Phase::Releasing {
                s.phase = Phase::Released;
            }
            drop(s);
            self.0.cv.notify_all();
        } else {
            if s.running.is_none() {
                s.phase = Phase::Released;
            }
            drop(s);
        }
        Ok(self.state())
    }

    /// Gives all the GPUs back to the engine and restarts the wanted model. Returns when it's ready.
    pub fn resume(&self, tick: &mut dyn FnMut(u64)) -> Result<PublicState> {
        self.resume_with(false, tick)
    }

    /// `only_without_loans`: does nothing if there's a loan (the automatic resume doesn't remove other people's).
    fn resume_with(&self, only_without_loans: bool, tick: &mut dyn FnMut(u64)) -> Result<PublicState> {
        let (wanted, to_stop) = {
            let mut s = self.lock();
            while matches!(s.phase, Phase::Starting | Phase::Releasing) {
                s = self.wait(s, Duration::from_secs(1));
            }
            if only_without_loans && !s.loans.is_empty() {
                drop(s);
                return Ok(self.state());
            }
            s.loans.clear();
            recompute_excluded(&mut s);
            s.doesnt_fit = None;
            // A model restarted on the remaining GPUs only goes back to all of them.
            let to_stop = if s.reduced {
                s.reduced = false;
                // `starting` until the old one is stopped: a request arriving while it saves would start another,
                // which would read from disk the conversation from before the save.
                s.phase = Phase::Starting;
                s.running.take()
            } else {
                None
            };
            if s.phase == Phase::Released {
                s.phase = Phase::Stopped;
            }
            self.0.cv.notify_all();
            (s.wanted.clone(), to_stop)
        };
        if let Some(a) = to_stop {
            self.stop_process(a);
            let mut s = self.lock();
            if s.phase == Phase::Starting {
                s.phase = Phase::Stopped;
            }
            drop(s);
            self.0.cv.notify_all();
        }
        if let Some(k) = wanted {
            self.start(&k, tick)?;
        }
        Ok(self.state())
    }

    pub fn state(&self) -> PublicState {
        let (mut state, running) = {
            let s = self.lock();
            let plan = s.running.as_ref().map(|a| &a.plan);
            let gpus: Vec<PublicGpu> = plan
                .map(|p| {
                    p.gpus_used
                        .iter()
                        .map(|g| PublicGpu {
                            index: g.index,
                            name: g.name.clone(),
                            memory_used_mib: None,
                            memory_total_mib: g.memory_mib,
                        })
                        .collect()
                })
                .unwrap_or_default();
            (
                PublicState {
                    phase: s.phase,
                    model: plan.map(|p| p.key.clone()).or_else(|| s.wanted.clone()),
                    name: plan.map(|p| p.label.clone()),
                    context: plan.map(|p| p.ctx),
                    gpus,
                    released: s.excluded.clone(),
                    all_released: s.all,
                    loans: s
                        .loans
                        .iter()
                        .map(|p| PublicLoan {
                            gpus: p.gpus.clone(),
                            pid: p.process.as_ref().map(|x| x.pid),
                            who: p.who.clone(),
                            since: p.since.clone(),
                        })
                        .collect(),
                    requests_in_flight: s.in_flight,
                    error: s.error.clone(),
                },
                s.running.is_some(),
            )
        };
        if running {
            let measure = (self.0.measure)();
            for g in &mut state.gpus {
                g.memory_used_mib = measure.iter().find(|m| m.0 == g.index).map(|m| m.1);
            }
        }
        state
    }

    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Stops the engine: first the conversation is saved in the on-disk memory (`shutdown_post`), then the process.
    /// The save's outcome, tokens and time go in the log.
    fn stop_process(&self, mut a: Running) {
        if let Some(c) = &a.plan.spec.shutdown_post {
            if matches!(a.child.try_wait(), Ok(None)) {
                let t0 = Instant::now();
                let tokens = cached_tokens(&a.plan.url);
                let mut line = serde_json::json!({ "event": "save", "model": a.plan.key, "token": tokens });
                match c.send() {
                    Ok(v) => {
                        // `persist` (on-disk memory) says `saved`; `save` (official llama.cpp) says how many tokens
                        line["written"] = v["saved"].as_bool().or(v["n_saved"].as_u64().map(|n| n > 0)).into();
                        line["bytes"] = v["n_written"].clone();
                    }
                    Err(e) => line["error"] = format!("{e:#}").into(),
                }
                line["ms"] = (t0.elapsed().as_millis() as u64).into();
                self.log(line);
            }
        }
        let _ = a.child.kill();
        let _ = a.child.wait();
    }

    /// The running engine's plan (for whoever needs to know context, images, memory).
    pub fn running_plan(&self) -> Option<EnginePlan> {
        self.lock().running.as_ref().map(|a| a.plan.clone())
    }

    /// App shutdown: the engine saves the conversation (if it has the on-disk memory) and stops.
    pub fn stop(&self) {
        let a = {
            let mut s = self.lock();
            s.phase = Phase::Stopped;
            s.reduced = false;
            s.running.take()
        };
        if let Some(a) = a {
            self.stop_process(a);
        }
        self.0.cv.notify_all();
    }
}

/// Waits until the engine answers 200 on the health route; if the process dies first, or the time runs out, the
/// error carries the last lines of its log.
fn wait_healthy(a: &mut Running, log: &Path, tick: &mut dyn FnMut(u64)) -> Result<()> {
    let Some(url) = a.plan.spec.health_url.clone() else { return Ok(()) };
    let t0 = Instant::now();
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
    loop {
        if let Ok(r) = agent.get(&url).call() {
            if r.status() == 200 {
                return Ok(());
            }
        }
        if let Ok(Some(st)) = a.child.try_wait() {
            let what = if OUT_OF_MEMORY.iter().any(|m| tail(log, 40).contains(m)) {
                tr!(
                    "Il modello non è entrato in memoria mentre si caricava. Chiudi i programmi che ne occupano tanta (giochi, altri \
                     modelli) e riprova, oppure scegli un modello più piccolo.",
                    "The model did not fit in memory while loading. Close the programs that use a lot of it (games, other \
                     models) and try again, or choose a smaller model."
                )
            } else {
                tr!(
                    "Il motore si è chiuso mentre caricava il modello. Riprova; se succede ancora, apri i log di Mango Code.",
                    "The engine closed while loading the model. Try again; if it happens again, open the Mango Code logs."
                )
            };
            let code = st.code().map_or("?".into(), |c| c.to_string());
            return Err(user_error(
                &what,
                tr!("il motore si è chiuso subito (codice {code}).\n{}", "the engine closed right away (code {code}).\n{}", tail(log, 12)),
            ));
        }
        let s = t0.elapsed().as_secs();
        if s >= a.plan.spec.ready_timeout_s {
            return Err(user_error(
                &tr!(
                    "Il modello non ha finito di caricarsi in tempo. Riprova; se succede ancora, apri i log di Mango Code.",
                    "The model did not finish loading in time. Try again; if it happens again, open the Mango Code logs."
                ),
                tr!("il motore non risponde dopo {s} s.\n{}", "the engine does not answer after {s} s.\n{}", tail(log, 12)),
            ));
        }
        tick(s);
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// The excluded GPUs are those of the ongoing loans.
fn recompute_excluded(s: &mut State) {
    s.all = s.loans.iter().any(|p| p.gpus.is_none());
    let mut v: Vec<u32> = s.loans.iter().flat_map(|p| p.gpus.iter().flatten().copied()).collect();
    v.sort_unstable();
    v.dedup();
    s.excluded = v;
}

/// How many tokens the engine's slot memory holds right now (`GET /slots`, `n_cache_tokens`).
fn cached_tokens(url: &str) -> Option<u64> {
    let r = ureq::get(&format!("{url}/slots")).timeout(Duration::from_secs(5)).call().ok()?;
    let v: serde_json::Value = serde_json::from_reader(r.into_reader()).ok()?;
    v[0]["n_cache_tokens"].as_u64()
}

/// Last `n` non-empty lines of a log, for error messages.
fn tail(path: &Path, n: usize) -> String {
    let txt = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = txt.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_without_models(dir: &Path) -> EngineManager {
        EngineManager::new(Box::new(|key, _, _| bail!("no model in the tests ({key})")), Box::new(Vec::new), dir, None)
    }

    /// The automatic resume starts when the last loan has ended, but it runs on a separate thread: a loan born
    /// between the two isn't its own and must stay.
    #[test]
    fn the_resume_after_an_ended_loan_does_not_remove_a_loan_born_in_the_meantime() {
        let dir = tempfile::tempdir().unwrap();
        let m = manager_without_models(dir.path());
        m.release(Some(&[1]), Requester { pid: None, who: "new".into() }).unwrap();

        m.resume_after_loan();

        let s = m.state();
        assert_eq!((s.phase, s.loans.len()), (Phase::Released, 1), "{s:?}");
    }

    /// An explicit `resume` called by whoever has the GPUs always gives them back, even if there are other loans.
    #[test]
    fn explicit_resume_removes_all_loans() {
        let dir = tempfile::tempdir().unwrap();
        let m = manager_without_models(dir.path());
        m.release(Some(&[1]), Requester { pid: None, who: "one".into() }).unwrap();
        m.release(Some(&[2]), Requester { pid: None, who: "two".into() }).unwrap();

        m.resume(&mut |_| {}).unwrap();

        let s = m.state();
        assert_eq!((s.phase, s.loans.len()), (Phase::Stopped, 0), "{s:?}");
    }
}
