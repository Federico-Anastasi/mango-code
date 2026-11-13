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
pub mod share;
pub mod remote;
pub mod loan;

use anyhow::{bail, Context, Result};
use engine_cfg::EnginePlan;
use mango_common::{tail, tr, user_error};
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long an engine of ours, once stopped, may take to give its memory back to the cards: until then what it still holds
/// is not another program's (`room_for`).
const FREED_WITHIN: Duration = Duration::from_secs(10);
/// How long a request waits while the GPUs are released, before giving up.
const RELEASED_WAIT: Duration = Duration::from_secs(30 * 60);
/// Above this size `manager.log` becomes `manager.1.log` (the previous one is dropped): the network can cause lines.
const LOG_MAX: u64 = 1024 * 1024;
/// How long `release` lets in-flight requests finish before stopping the engine (and cutting them).
pub const RELEASE_WAIT: Duration = Duration::from_secs(60);

/// Produces the engine plan: model key, internal port, GPUs not to use.
pub type Planner = dyn Fn(&str, u16, &[u32]) -> Result<EnginePlan> + Send + Sync;
/// Memory used right now on each GPU: (PCI index, MiB used, MiB total).
pub type GpuMeter = dyn Fn() -> Vec<(u32, u64, u64)> + Send + Sync;
/// Before a model starts on the cards: what other programs hold there, when the model as planned does not fit beside it
/// (`engine_cfg::taken_before_start`). Given the model, the GPUs lent to another job and the memory used on each GPU.
pub type RoomCheck = dyn Fn(&str, &[u32], &[(u32, u64, u64)]) -> Result<Option<engine_cfg::CardsTaken>> + Send + Sync;
/// The fields a chat request to a model (its key) is given when it does not carry them: the style of the answers and
/// the reasoning the user chose for it.
pub type RequestDefaults = dyn Fn(&str) -> Result<serde_json::Map<String, serde_json::Value>> + Send + Sync;

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

/// Other programs hold memory of the cards the model counts on: it was not started, so that it does not start slow and
/// silent. `retry` starts it anyway. Like `WillNotStart` it is not retried.
#[derive(Debug)]
pub struct TakenByOthers {
    /// For the user: which cards, and how much is in use.
    pub sentence: String,
    /// What was read on the cards.
    detail: String,
}

impl std::fmt::Display for TakenByOthers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&mango_common::user_text(&self.sentence, &self.detail))
    }
}

impl std::error::Error for TakenByOthers {}

/// The model a request was waiting for is no longer the one to start: the user picked another while it was loading.
/// Like `WillNotStart` it must not be retried: a retry would stop in turn the model the user has just picked.
#[derive(Debug)]
pub struct Superseded(pub String);

impl std::fmt::Display for Superseded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Superseded {}

/// A choice made while the cards are lent: it is the model to start when they come back, nothing to start now.
#[derive(Debug)]
struct Parked;

impl std::fmt::Display for Parked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the model starts when the graphics cards come back")
    }
}

impl std::error::Error for Parked {}

/// The state changed while a start was planned (another start, a choice, a stop): nothing started, the caller looks again.
#[derive(Debug)]
struct Moved;

impl std::fmt::Display for Moved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the state changed while the start was planned")
    }
}

impl std::error::Error for Moved {}

/// What a start depends on: if it changes while the start is planned, the plan is for a state that is no longer there.
fn moment(s: &State) -> (Phase, Option<String>, Option<String>, bool, Vec<u32>) {
    (s.phase, s.running.as_ref().map(|a| a.plan.url.clone()), s.chosen.clone(), s.all, s.excluded.clone())
}

/// The load in progress was stopped on purpose (`choose`): it is not a failure of the engine.
#[derive(Debug)]
struct LoadStopped;

impl std::fmt::Display for LoadStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the load was stopped")
    }
}

impl std::error::Error for LoadStopped {}

/// The model is being taken off the computer (`EngineManager::block_starts`): it is not started until that ends.
#[derive(Debug)]
pub struct BeingRemoved(pub String);

impl std::fmt::Display for BeingRemoved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BeingRemoved {}

/// The answer to give is 422, which the agent does not retry, instead of a 5xx, which it does.
pub(crate) fn not_to_retry(e: &anyhow::Error) -> bool {
    e.is::<WillNotStart>() || e.is::<Superseded>() || e.is::<BeingRemoved>() || e.is::<TakenByOthers>()
}

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
    /// While `starting`: what is loading, where, and for how long.
    pub loading: Option<PublicLoading>,
    /// The last start that failed, until a model starts or the user picks another: the model that was running, if
    /// any, stays in `model`.
    pub failed: Option<PublicFailure>,
    /// The model the user picked that has not begun to load yet: it waits for the answer in progress of the running one.
    pub chosen: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicLoading {
    pub model: String,
    pub name: String,
    pub context: u32,
    /// The names of the GPUs it is loading on; empty on the processor.
    pub gpus: Vec<String>,
    pub seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicFailure {
    pub model: String,
    /// For the user: why it did not start.
    pub reason: String,
    /// When other programs hold the memory it counts on and it was not started (`TakenByOthers`): which cards and how
    /// much, without the detail that `reason` carries.
    pub taken: Option<String>,
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
    /// `wanted` is a model the user picked while the cards were lent: a request that starts another model on the cards
    /// that remain does not take its place, and it starts when the cards come back.
    wanted_by_choice: bool,
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
    /// The model the user picked (`choose`) that has not begun to start yet: until it does, the other requests wait.
    chosen: Option<String>,
    /// The load in progress has to stop: the user picked another model.
    stop_load: bool,
    /// How many loads were stopped, and the model of the last one: a request that was waiting for it is told.
    stops: u64,
    last_stopped: Option<String>,
    /// The plan being loaded, and since when.
    loading: Option<(EnginePlan, Instant)>,
    /// See `PublicState::failed`.
    failed: Option<PublicFailure>,
    /// The running model has to be loaded again: the user's choices changed where it runs or its context.
    stale: bool,
    /// The user's choices changed while a model was loading: when the load ends its plan is compared again.
    recheck: bool,
    /// The models that must not start: they are being taken off the computer (`StartBlock`).
    blocked: Vec<String>,
}

struct Inner {
    release_wait_ms: AtomicU64,
    planner: Box<Planner>,
    measure: Box<GpuMeter>,
    request_defaults: std::sync::OnceLock<Box<RequestDefaults>>,
    room: std::sync::OnceLock<Box<RoomCheck>>,
    /// The last engine of ours that closed (`close`), when, and its GPUs: its memory goes back to them with a delay. Apart
    /// from `st`, so that an engine closes also while the state is locked.
    freed: Mutex<Option<(Instant, Vec<u32>)>>,
    /// For each model, the last error reading its defaults: written in the log once, not at every request.
    defaults_errors: Mutex<std::collections::HashMap<String, String>>,
    logs: PathBuf,
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

/// While it lives, its model is not started by anyone (`EngineManager::block_starts`).
pub struct StartBlock {
    m: EngineManager,
    key: String,
}

impl Drop for StartBlock {
    fn drop(&mut self) {
        let mut s = self.m.lock();
        if let Some(i) = s.blocked.iter().position(|k| *k == self.key) {
            s.blocked.remove(i);
        }
    }
}

impl EngineManager {
    /// `logs`: the engine log folder (`engine.log`).
    pub fn new(planner: Box<Planner>, measure: Box<GpuMeter>, logs: &Path) -> EngineManager {
        let m = EngineManager(Arc::new(Inner {
            release_wait_ms: AtomicU64::new(RELEASE_WAIT.as_millis() as u64),
            planner,
            measure,
            request_defaults: std::sync::OnceLock::new(),
            room: std::sync::OnceLock::new(),
            freed: Mutex::new(None),
            defaults_errors: Mutex::new(std::collections::HashMap::new()),
            logs: logs.to_path_buf(),
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

    /// From now on the chat requests are given what `defaults` says for their model, where they do not say it
    /// themselves. Set once, by whoever starts the manager and knows the user's choices.
    pub fn set_request_defaults(&self, defaults: Box<RequestDefaults>) {
        let _ = self.0.request_defaults.set(defaults);
    }

    /// From now on a model that goes on the cards starts only if `check` finds room for it beside the other programs; `retry`
    /// starts it anyway. Set once, by whoever starts the manager and knows the catalog and the user's choices.
    pub fn set_room_check(&self, check: Box<RoomCheck>) {
        let _ = self.0.room.set(check);
    }

    /// The body of a chat request to `key` with the defaults of its model added. A body that is not a JSON object,
    /// or defaults that cannot be read, leave the request as it came (the reason goes to the log, once while it lasts).
    pub(crate) fn with_request_defaults(&self, key: &str, body: Vec<u8>) -> Vec<u8> {
        let Some(defaults) = self.0.request_defaults.get() else { return body };
        let outcome = defaults(key);
        let new_error = {
            let mut errors = self.0.defaults_errors.lock().unwrap_or_else(|e| e.into_inner());
            match &outcome {
                Ok(_) => {
                    errors.remove(key);
                    None
                }
                Err(e) => {
                    let e = format!("{e:#}");
                    if errors.get(key) == Some(&e) {
                        None
                    } else {
                        errors.insert(key.to_string(), e.clone());
                        Some(e)
                    }
                }
            }
        };
        if let Some(e) = new_error {
            self.log(serde_json::json!({ "event": "request defaults", "model": key, "error": e }));
        }
        match outcome {
            Ok(fields) => add_defaults(body, fields),
            Err(_) => body,
        }
    }

    /// Changes the maximum time `release` waits for in-flight requests (see `RELEASE_WAIT`).
    pub fn set_release_wait(&self, d: Duration) {
        self.0.release_wait_ms.store(d.as_millis() as u64, Ordering::Relaxed);
    }

    /// One line per control call in `manager.log` (logs folder): JSON, with local time.
    pub fn log(&self, mut line: serde_json::Value) {
        line["time"] = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false).into();
        let file = self.0.logs.join("manager.log");
        if std::fs::metadata(&file).is_ok_and(|m| m.len() > LOG_MAX) {
            let _ = std::fs::rename(&file, self.0.logs.join("manager.1.log"));
        }
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
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
        drop(self.use_with(Some(key), tick, false, true)?);
        Ok(())
    }

    /// The model the user picked: it starts in the background, and `state` tells how it goes (`loading`, `failed`).
    /// A load in progress for another model stops at once, with nothing to save; a running model finishes its
    /// in-flight requests first, as with any switch. Only this stops a load: a request that names another model
    /// waits for the load to end.
    pub fn choose(&self, key: &str) {
        self.pick(key, true);
    }

    /// «Riprova» after a start that failed: like `choose`, and the model starts also when other programs hold memory it counts
    /// on (`TakenByOthers`). The user was told; if the cards are free meanwhile it starts as usual, otherwise slower.
    pub fn retry(&self, key: &str) {
        self.pick(key, false);
    }

    /// `check`: the start looks for room beside the other programs first (`room_for`).
    fn pick(&self, key: &str, check: bool) {
        {
            let mut s = self.lock();
            s.chosen = Some(key.to_string());
            s.wanted_by_choice = false;
            s.failed = None;
        }
        self.0.cv.notify_all();
        let (m, key) = (self.clone(), key.to_string());
        let _ = std::thread::Builder::new().name("engine-choice".into()).spawn(move || {
            if let Err(e) = m.use_with(Some(&key), &mut |_| {}, true, check) {
                // A newer choice took its place, or it waits for the cards: nothing went wrong.
                if !e.is::<Superseded>() && !e.is::<Parked>() {
                    m.log(serde_json::json!({ "event": "choice", "model": key, "error": format!("{e:#}") }));
                }
            }
        });
    }

    /// The engine for a request: `key` is the model it asks for (`None` = the running or wanted one).
    /// If needed, starts the model; while the GPUs are released it waits for them to resume.
    pub fn acquire(&self, key: Option<&str>) -> Result<Permit> {
        self.use_with(key, &mut |_| {}, false, true)
    }

    /// `choice`: the call is the user's choice (`choose`), which stops a load in progress for another model. `check`: see
    /// `start_model`.
    fn use_with(&self, key: Option<&str>, tick: &mut dyn FnMut(u64), choice: bool, check: bool) -> Result<Permit> {
        let t0 = Instant::now();
        let mut s = self.lock();
        let stops = s.stops;
        // The choice has begun to start, or its model was already there: from then on it is a request like the others.
        let mut begun = !choice;
        loop {
            let want = match key.map(str::to_string).or_else(|| s.wanted.clone()) {
                Some(k) => k,
                None => bail!("{}", tr!("nessun modello da accendere", "no model to start")),
            };
            let superseded = || {
                anyhow::Error::new(Superseded(tr!(
                    "Il caricamento di questo modello è stato fermato: è stato scelto un altro modello.",
                    "The loading of this model was stopped: another model was picked."
                )))
            };
            // A model being taken off the computer is refused at once, not after a wait; while it still runs it answers.
            let runs = s.phase == Phase::Running && s.running.as_ref().is_some_and(|a| a.plan.key == want);
            if let (false, Err(e)) = (runs, refuse_blocked(&s, &want)) {
                if !begun && s.chosen.as_deref() == Some(want.as_str()) {
                    s.chosen = None;
                    self.0.cv.notify_all();
                }
                return Err(e);
            }
            if choice {
                // A newer choice took the place of this one before it began.
                if !begun && s.chosen.as_deref() != Some(want.as_str()) {
                    return Err(superseded());
                }
            } else {
                if s.stops != stops && s.last_stopped.as_deref() == Some(want.as_str()) {
                    return Err(superseded());
                }
                // The user's choice goes first: a request that started its own model now would make the choice wait.
                if s.chosen.is_some() {
                    s = self.wait(s, Duration::from_secs(1));
                    continue;
                }
            }
            // The running engine exited by itself (crash): it's noted in the log and the request restarts it.
            if s.phase == Phase::Running {
                let exited = s.running.as_mut().and_then(|a| a.child.try_wait().ok().flatten());
                if let Some(st) = exited {
                    let a = s.running.take().expect("running engine");
                    let key = a.plan.key.clone();
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
                    self.close(a);
                    self.log(serde_json::json!({ "event": "crash", "model": key, "code": code, "log": tail(&log, 3) }));
                }
            }
            match s.phase {
                // A model being taken off the computer answers as it is: it is not loaded again.
                Phase::Running if runs && (!s.stale || s.blocked.contains(&want)) => {
                    if !begun {
                        s.chosen = None;
                        self.0.cv.notify_all();
                    }
                    s.in_flight += 1;
                    let url = s.running.as_ref().map(|a| a.plan.url.clone()).unwrap_or_default();
                    return Ok(Permit { m: self.clone(), url, key: want });
                }
                Phase::Starting => {
                    if !begun {
                        if s.wanted.as_deref() == Some(want.as_str()) {
                            s.chosen = None;
                            begun = true;
                        } else {
                            s.stop_load = true;
                        }
                        self.0.cv.notify_all();
                    }
                    s = self.wait(s, Duration::from_secs(1));
                }
                // Released only in part: the model restarts on the remaining GPUs, if it fits.
                Phase::Released if !s.all && s.doesnt_fit.as_deref() != Some(want.as_str()) => {
                    let started = self.start_model(s, &want, tick, check);
                    if started.as_ref().is_err_and(|e| e.is::<Moved>()) {
                        s = self.lock();
                        continue;
                    }
                    begun = true;
                    s = match started {
                        Ok(mut s) => {
                            s.reduced = true;
                            s
                        }
                        // It does not fit on the GPUs that remain: wait for `resume`. A choice does not wait, it is parked.
                        Err(e) if e.is::<WillNotStart>() => {
                            let mut s = self.lock();
                            s.phase = Phase::Released;
                            s.doesnt_fit = Some(want.clone());
                            if choice {
                                self.park(&mut s, want);
                                return Err(anyhow::Error::new(Parked));
                            }
                            s
                        }
                        Err(e) if e.is::<LoadStopped>() => return Err(superseded()),
                        // Anything else (the program does not open, the port is taken) is told, not waited for.
                        Err(e) => {
                            self.lock().phase = Phase::Released;
                            return Err(e);
                        }
                    };
                }
                Phase::Releasing | Phase::Released => {
                    if choice {
                        self.park(&mut s, want);
                        return Err(anyhow::Error::new(Parked));
                    }
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
                    let started = self.start_model(s, &want, tick, check);
                    if started.as_ref().is_err_and(|e| e.is::<Moved>()) {
                        s = self.lock();
                        continue;
                    }
                    begun = true;
                    s = started.map_err(|e| if e.is::<LoadStopped>() { superseded() } else { e })?;
                }
            }
        }
    }

    /// A choice made while the cards it needs are lent does not wait: it is the model to start when they come back
    /// (`resume`). It is not shown as loading, and the other requests do not wait for it.
    fn park(&self, s: &mut State, key: String) {
        if s.chosen.as_deref() == Some(key.as_str()) {
            s.chosen = None;
        }
        // not starting on the cards that remain is not a failure: it waits for the others
        if s.failed.as_ref().is_some_and(|f| f.model == key) {
            s.failed = None;
        }
        s.wanted = Some(key);
        s.wanted_by_choice = true;
        self.0.cv.notify_all();
    }

    fn wait<'a>(&self, s: MutexGuard<'a, State>, d: Duration) -> MutexGuard<'a, State> {
        self.0.cv.wait_timeout(s, d).unwrap_or_else(|e| e.into_inner()).0
    }

    /// Stops the running one and starts `key`. The lock is released during the slow parts. The new model's plan is
    /// made before stopping the old one: a model that can't start (unknown, missing files, released GPUs) leaves
    /// the one that was running in place.
    ///
    /// The plan is made first, with the state as it was; if the state moved meanwhile (another start, a choice, a stop,
    /// a loan) nothing starts and the caller looks again (`Moved`). Only then the phase becomes `starting`, with what
    /// loads already in `loading`: the state never says `starting` without saying what. A model picked by the user stays
    /// `chosen`, holding the other requests back, until its load begins here.
    ///
    /// `check`: once the model before has stopped, a model that goes on the cards starts only if there is room for it beside
    /// the other programs (`room_for`); `retry` and `reload` pass `false`.
    fn start_model<'a>(&'a self, s: MutexGuard<'a, State>, key: &str, tick: &mut dyn FnMut(u64), check: bool) -> Result<MutexGuard<'a, State>> {
        refuse_blocked(&s, key)?;
        let before = moment(&s);
        let excluded = if s.all { None } else { Some(s.excluded.clone()) };
        drop(s);
        let plan = match &excluded {
            None => Err(anyhow::anyhow!(tr!(
                "le schede video sono tutte liberate per un altro lavoro",
                "all the graphics cards are released for another job"
            ))),
            Some(excluded) => self.plan(key, excluded).map_err(|e| anyhow::Error::new(WillNotStart(format!("{e:#}")))),
        };
        let mut s = self.lock();
        if moment(&s) != before {
            return Err(anyhow::Error::new(Moved));
        }
        refuse_blocked(&s, key)?;
        let wanted_before = s.wanted.clone();
        let stale_before = s.stale;
        s.phase = Phase::Starting;
        if s.chosen.as_deref() == Some(key) {
            s.chosen = None;
        }
        // A request for another model on the cards that remain does not replace the model the user picked.
        if !s.wanted_by_choice || s.wanted.as_deref() == Some(key) {
            s.wanted = Some(key.to_string());
            s.wanted_by_choice = false;
        }
        s.error = None;
        s.stale = false;
        // From here the state tells what is loading: the save and the stop of the model before are part of the wait.
        s.loading = plan.as_ref().ok().map(|plan| (plan.clone(), Instant::now()));
        let mut old = s.running.take();
        self.0.cv.notify_all();
        drop(s);
        let outcome = match plan {
            Err(e) => Err(e),
            Ok(plan) => {
                if let Some(a) = old.take() {
                    self.stop_process(a);
                }
                let room = if check { self.room_for(&plan, excluded.as_deref().unwrap_or_default()) } else { Ok(()) };
                room.and_then(|()| self.start_process(plan, tick))
            }
        };
        let mut s = self.lock();
        s.loading = None;
        // The choice that asked to stop this load finds it ended, one way or the other.
        s.stop_load = false;
        match outcome {
            Ok(a) => {
                s.phase = Phase::Running;
                s.running = Some(a);
                s.failed = None;
                self.recheck_after_load(&mut s);
                self.0.cv.notify_all();
                Ok(s)
            }
            Err(e) => {
                let stopped = e.is::<LoadStopped>();
                if stopped {
                    s.stops += 1;
                    s.last_stopped = Some(key.to_string());
                } else {
                    s.error = Some(format!("{e:#}"));
                    let taken = e.downcast_ref::<TakenByOthers>().map(|t| t.sentence.clone());
                    s.failed = Some(PublicFailure { model: key.to_string(), reason: format!("{e:#}"), taken });
                }
                match old {
                    Some(a) => {
                        // Another model did not start: the one that stays still has to take the user's changed choices.
                        s.recheck |= stale_before && a.plan.key != key;
                        s.phase = Phase::Running;
                        s.running = Some(a);
                        s.wanted = wanted_before;
                    }
                    None => s.phase = if stopped { Phase::Stopped } else { Phase::Error },
                }
                self.recheck_after_load(&mut s);
                self.0.cv.notify_all();
                Err(e)
            }
        }
    }

    /// The choices changed while the model loaded: they are compared with the plan it came up with, on a thread of its own
    /// (the plan reads the disk and the hardware).
    fn recheck_after_load(&self, s: &mut State) {
        if !std::mem::take(&mut s.recheck) {
            return;
        }
        let m = self.clone();
        if let Err(e) = std::thread::Builder::new().name("engine-recheck".into()).spawn(move || m.reload_if_changed()) {
            // the next load that ends compares them
            s.recheck = true;
            self.log(serde_json::json!({ "event": "recheck", "error": e.to_string() }));
        }
    }

    /// The engine plan for `key` on a free port, without the `excluded` GPUs.
    fn plan(&self, key: &str, excluded: &[u32]) -> Result<EnginePlan> {
        let port = mango_common::random_port()?;
        (self.0.planner)(key, port, excluded)
    }

    /// Before `plan` starts on the cards: when other programs hold memory it counts on, it does not start (`TakenByOthers`).
    /// Memory that cannot be read, or a check that does not answer, start it as before: a measure that is missing does not
    /// block the start. On the GPUs of an engine of ours stopped less than `FREED_WITHIN` ago the memory is read again until
    /// that has passed: what the engine still holds there is not another program's. `lent`: the GPUs lent to another job.
    fn room_for(&self, plan: &EnginePlan, lent: &[u32]) -> Result<()> {
        let Some(check) = self.0.room.get() else { return Ok(()) };
        if plan.gpus_used.is_empty() {
            return Ok(());
        }
        loop {
            let used = (self.0.measure)();
            if used.is_empty() {
                self.log(serde_json::json!({ "event": "room", "model": plan.key, "error": "the memory of the cards cannot be read: it starts without looking" }));
                return Ok(());
            }
            let taken = match check(&plan.key, lent, &used) {
                Ok(None) => return Ok(()),
                Ok(Some(taken)) => taken,
                Err(e) => {
                    self.log(serde_json::json!({ "event": "room", "model": plan.key, "error": format!("{e:#}") }));
                    return Ok(());
                }
            };
            let freeing = self.0.freed.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|(at, gpus)| at.elapsed() < FREED_WITHIN && taken.cards.iter().any(|c| gpus.contains(c)));
            let stop = self.lock().stop_load;
            if stop {
                return Err(anyhow::Error::new(LoadStopped));
            }
            if !freeing {
                self.log(serde_json::json!({ "event": "cards_taken", "model": plan.key, "gpus": taken.cards, "used": used }));
                let detail = used
                    .iter()
                    .filter(|u| taken.cards.contains(&u.0))
                    .map(|u| tr!("scheda {}: {} MiB in uso su {}", "GPU {}: {} MiB in use of {}", u.0, u.1, u.2))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(anyhow::Error::new(TakenByOthers { sentence: taken.sentence, detail }));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn start_process(&self, plan: EnginePlan, tick: &mut dyn FnMut(u64)) -> Result<Running> {
        let log = self.0.logs.join(format!("{}.log", plan.spec.name));
        let out = File::create(&log).with_context(|| format!("log {}", log.display()))?;
        let mut cmd = Command::new(&plan.spec.exe);
        cmd.args(&plan.spec.args)
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .creation_flags(mango_common::CREATE_NO_WINDOW);
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
        match wait_healthy(&mut a, &log, tick, &|| self.lock().stop_load) {
            Ok(()) => {
                let loaded = t0.elapsed();
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
                // The start has two slow parts, told apart: the model loading (until the engine answers) and the conversation
                // coming back.
                line["load_ms"] = (loaded.as_millis() as u64).into();
                line["restore_ms"] = ((t0.elapsed() - loaded).as_millis() as u64).into();
                line["ms"] = (t0.elapsed().as_millis() as u64).into();
                self.log(line);
                Ok(a)
            }
            Err(e) => {
                self.close(a);
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
                    loading: s.loading.as_ref().filter(|_| s.phase == Phase::Starting).map(|(plan, since)| PublicLoading {
                        model: plan.key.clone(),
                        name: plan.label.clone(),
                        context: plan.ctx,
                        gpus: plan.gpus_used.iter().map(|g| g.name.clone()).collect(),
                        seconds: since.elapsed().as_secs(),
                    }),
                    failed: s.failed.clone(),
                    chosen: s.chosen.clone(),
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
        self.close(a);
    }

    /// The only place an engine process of ours ends: stopped, a load that failed or was stopped, one that exited by itself.
    /// Its GPUs are noted as `freed`: what it held there goes back with a delay, and is not another program's (`room_for`).
    fn close(&self, mut a: Running) {
        let _ = a.child.kill();
        let _ = a.child.wait();
        *self.0.freed.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), a.plan.gpus_used.iter().map(|g| g.index).collect()));
    }

    /// The memory used on each GPU (as `GpuMeter` reads it) once an engine of ours closed less than `FREED_WITHIN` ago has had
    /// that time to give it back: what is used then is other programs'. It waits for the rest of that time, if any.
    pub fn memory_of_others(&self) -> Vec<(u32, u64, u64)> {
        let left = self.0.freed.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(at, _)| FREED_WITHIN.saturating_sub(at.elapsed()));
        if let Some(left) = left {
            std::thread::sleep(left);
        }
        (self.0.measure)()
    }

    /// The running engine's plan (for whoever needs to know context, images, memory).
    pub fn running_plan(&self) -> Option<EnginePlan> {
        self.lock().running.as_ref().map(|a| a.plan.clone())
    }

    /// The user's choices changed. If the running model would now run on other cards or with another context, it is
    /// loaded again as soon as it has no request in progress; the requests that arrive meanwhile wait for it. Choices back
    /// to the plan it runs with load nothing again and clear a failure of the changed ones. A model that does not start
    /// with the new choices stays as it is, and the state says why (`failed`). A model that is loading is compared when
    /// its load ends.
    pub fn reload_if_changed(&self) {
        let (now, excluded) = {
            let mut s = self.lock();
            if s.phase == Phase::Starting {
                s.recheck = true;
                return;
            }
            match (&s.running, s.all) {
                (Some(a), false) if s.phase == Phase::Running => (a.plan.clone(), s.excluded.clone()),
                _ => return,
            }
        };
        let cards = |p: &EnginePlan| p.gpus_used.iter().map(|g| g.index).collect::<Vec<_>>();
        let plan = self.plan(&now.key, &excluded);
        {
            let mut s = self.lock();
            // Another start came meanwhile: it was planned with the new choices, or it compares them when it ends.
            if s.phase != Phase::Running || !s.running.as_ref().is_some_and(|a| a.plan.url == now.url) {
                return;
            }
            match plan {
                Ok(new) if new.ctx == now.ctx && cards(&new) == cards(&now) => {
                    s.stale = false;
                    if s.failed.as_ref().is_some_and(|f| f.model == now.key) {
                        s.failed = None;
                    }
                    return;
                }
                Err(e) => {
                    s.stale = false;
                    s.failed = Some(PublicFailure { model: now.key.clone(), reason: format!("{e:#}"), taken: None });
                    return;
                }
                Ok(_) => s.stale = true,
            }
        }
        self.0.cv.notify_all();
        let (m, key) = (self.clone(), now.key.clone());
        // Without the thread the model stays `stale`: the next request for it loads it again.
        if let Err(e) = std::thread::Builder::new().name("engine-reload".into()).spawn(move || m.reload(&key)) {
            self.log(serde_json::json!({ "event": "reload", "model": now.key, "error": e.to_string() }));
        }
    }

    /// Loads `key` again with its new plan when it has no request in progress and no model picked is waiting. Only if it is
    /// still the running model and still has to be: a model picked or started meanwhile, the engine stopped, or the
    /// choices back as they were, end it with nothing done. It does not look for room beside the other programs (`room_for`):
    /// the model was running and in use, and a warning does not turn it off.
    fn reload(&self, key: &str) {
        let mut s = self.lock();
        loop {
            if !(s.phase == Phase::Running && s.stale && s.running.as_ref().is_some_and(|a| a.plan.key == key)) {
                return;
            }
            if s.in_flight > 0 || s.chosen.is_some() {
                s = self.wait(s, Duration::from_secs(1));
                continue;
            }
            match self.start_model(s, key, &mut |_| {}, false) {
                Ok(_) => return,
                // something moved while the plan was made: look again
                Err(e) if e.is::<Moved>() => s = self.lock(),
                Err(e) => return self.log(serde_json::json!({ "event": "reload", "model": key, "error": format!("{e:#}") })),
            }
        }
    }

    /// While the returned guard lives, `key` is not started: a request, a reload, a choice or a `resume` that would start
    /// it gets `BeingRemoved` (422 on the port) instead. It is for taking the model off the computer: take the guard,
    /// stop the engine if it runs the model (`unload`), delete the files, drop the guard. The guard stops nothing itself:
    /// a model running when it is taken answers until `unload`, one loading finishes loading.
    pub fn block_starts(&self, key: &str) -> StartBlock {
        self.lock().blocked.push(key.to_string());
        StartBlock { m: self.clone(), key: key.to_string() }
    }

    /// Stops the engine and forgets its model: the model was taken off the computer.
    pub fn unload(&self) {
        self.stop();
        let mut s = self.lock();
        s.wanted = None;
        s.failed = None;
        s.error = None;
    }

    /// Stops the engine (app shutdown, or the engine of another PC taking its place): a model that is loading stops
    /// loading and a model picked is no longer wanted; a running one saves the conversation (if it has the on-disk
    /// memory) and stops.
    pub fn stop(&self) {
        let a = {
            let mut s = self.lock();
            s.chosen = None;
            s.recheck = false;
            s.wanted_by_choice = false;
            while s.phase == Phase::Starting {
                s.stop_load = true;
                self.0.cv.notify_all();
                s = self.wait(s, Duration::from_millis(200));
            }
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
/// error carries the last lines of its log. `stop` ends the wait when the load is no longer wanted.
fn wait_healthy(a: &mut Running, log: &Path, tick: &mut dyn FnMut(u64), stop: &dyn Fn() -> bool) -> Result<()> {
    let Some(url) = a.plan.spec.health_url.clone() else { return Ok(()) };
    let t0 = Instant::now();
    let agent = mango_common::internet::agent(&url, Duration::from_secs(2));
    loop {
        if stop() {
            return Err(anyhow::Error::new(LoadStopped));
        }
        if let Ok(r) = agent.get(&url).call() {
            if r.status().as_u16() == 200 {
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

/// `body` with each of `fields` it does not carry; `null` counts as not carried, as llama-server reads it. An object among
/// them (`chat_template_kwargs`) is merged the same way: what the request says inside it stays. The body is read once,
/// and its fields stay as they came, byte for byte (the messages, images included): only a field that is added or merged
/// is written anew. A body that already says them all, or is not a JSON object, passes untouched.
fn add_defaults(body: Vec<u8>, fields: serde_json::Map<String, serde_json::Value>) -> Vec<u8> {
    with_fields(&body, fields).unwrap_or(body)
}

/// The body with the missing fields; `None` when nothing is missing or it is not a JSON object.
fn with_fields(body: &[u8], fields: serde_json::Map<String, serde_json::Value>) -> Option<Vec<u8>> {
    use serde_json::value::{to_raw_value, RawValue};
    use serde_json::Value;
    use std::borrow::Cow;
    let said: std::collections::BTreeMap<String, &RawValue> = serde_json::from_slice(body).ok()?;
    let mut request: std::collections::BTreeMap<String, Cow<'_, RawValue>> = said.into_iter().map(|(k, v)| (k, Cow::Borrowed(v))).collect();
    let mut changed = false;
    for (name, value) in fields {
        let added = match (request.get(&name).map(|v| v.get().trim()), value) {
            (None | Some("null"), value) => value,
            (Some(raw), Value::Object(inner)) => {
                let Ok(Value::Object(mut said)) = serde_json::from_str::<Value>(raw) else { continue };
                let missing: Vec<(String, Value)> = inner.into_iter().filter(|(k, _)| said.get(k).is_none_or(Value::is_null)).collect();
                if missing.is_empty() {
                    continue;
                }
                said.extend(missing);
                Value::Object(said)
            }
            _ => continue,
        };
        request.insert(name, Cow::Owned(to_raw_value(&added).ok()?));
        changed = true;
    }
    if !changed {
        return None;
    }
    serde_json::to_vec(&request).ok()
}

/// `BeingRemoved` if `key` must not start now.
fn refuse_blocked(s: &State, key: &str) -> Result<()> {
    if !s.blocked.iter().any(|k| k == key) {
        return Ok(());
    }
    Err(anyhow::Error::new(BeingRemoved(tr!(
        "Il modello «{key}» si sta togliendo dal computer: non si accende.",
        "The model «{key}» is being taken off the computer: it does not start."
    ))))
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
    let url = format!("{url}/slots");
    let mut r = mango_common::internet::agent(&url, Duration::from_secs(5)).get(&url).call().ok()?;
    let v: serde_json::Value = serde_json::from_reader(r.body_mut().as_reader()).ok()?;
    v[0]["n_cache_tokens"].as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_without_models(dir: &Path) -> EngineManager {
        EngineManager::new(Box::new(|key, _, _| bail!("no model in the tests ({key})")), Box::new(Vec::new), dir)
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

    /// A request keeps what it says; what it does not say comes from the defaults, also inside `chat_template_kwargs`.
    #[test]
    fn the_defaults_fill_only_what_a_request_does_not_say() {
        use serde_json::{json, Value};
        let defaults = |v: Value| v.as_object().unwrap().clone();
        let add = |body: Value, fields: Value| serde_json::from_slice::<Value>(&add_defaults(body.to_string().into_bytes(), defaults(fields))).unwrap();
        let fields = json!({ "temperature": 0.3, "top_k": 20, "chat_template_kwargs": { "enable_thinking": false } });
        assert_eq!(
            add(json!({ "model": "a", "messages": [] }), fields.clone()),
            json!({ "model": "a", "messages": [], "temperature": 0.3, "top_k": 20, "chat_template_kwargs": { "enable_thinking": false } })
        );
        assert_eq!(
            add(json!({ "temperature": 1.0, "chat_template_kwargs": { "enable_thinking": true, "x": 1 } }), fields.clone()),
            json!({ "temperature": 1.0, "top_k": 20, "chat_template_kwargs": { "enable_thinking": true, "x": 1 } })
        );
        assert_eq!(add(json!({ "chat_template_kwargs": { "x": 1 } }), fields.clone())["chat_template_kwargs"], json!({ "x": 1, "enable_thinking": false }));
        // what is not a JSON object passes as it came, and so does anything when there is nothing to add
        assert_eq!(add_defaults(b"not json".to_vec(), defaults(fields.clone())), b"not json");
        assert_eq!(add_defaults(b"{ \"a\":1 }".to_vec(), serde_json::Map::new()), b"{ \"a\":1 }");
        // `null` says nothing, as for llama-server
        assert_eq!(
            add(json!({ "temperature": null, "top_k": 5, "chat_template_kwargs": null }), fields.clone()),
            json!({ "temperature": 0.3, "top_k": 5, "chat_template_kwargs": { "enable_thinking": false } })
        );
        assert_eq!(add(json!({ "chat_template_kwargs": { "enable_thinking": null } }), fields.clone())["chat_template_kwargs"], json!({ "enable_thinking": false }));
    }

    /// A request that already says all the defaults, an image of a few MB included, passes byte for byte: nothing to add,
    /// nothing rewritten.
    #[test]
    fn a_request_that_says_everything_passes_as_it_came() {
        let fields = serde_json::json!({ "temperature": 0.3, "chat_template_kwargs": { "enable_thinking": false } }).as_object().unwrap().clone();
        let image = "A".repeat(4 << 20);
        let body = format!(
            r#"{{ "model":"a",  "temperature" : 1.0, "chat_template_kwargs": {{"enable_thinking": true, "x": null}}, "messages": [{{"role":"user","content":[{{"type":"image_url","image_url":{{"url":"data:image/png;base64,{image}"}}}}]}}] }}"#
        )
        .into_bytes();
        assert!(add_defaults(body.clone(), fields.clone()) == body);

        // a field is missing: it is added, and the messages reach the engine as they were written
        let messages = format!(r#"[{{"role":"user","content":[{{"type":"image_url","image_url":{{"url":"data:image/png;base64,{image}"}}}}]}}]"#);
        let body = format!(r#"{{ "model":"a", "messages":   {messages} }}"#).into_bytes();
        let out = add_defaults(body, fields);
        assert!(out.windows(messages.len()).any(|w| w == messages.as_bytes()));
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!((&v["temperature"], &v["chat_template_kwargs"]), (&serde_json::json!(0.3), &serde_json::json!({ "enable_thinking": false })));
    }

    /// Defaults that cannot be read go to the log once per model, not at every request: another model read fine in
    /// between does not write it again. Once read again, a new breakage is written again.
    #[test]
    fn defaults_that_cannot_be_read_are_logged_once() {
        let dir = tempfile::tempdir().unwrap();
        let m = manager_without_models(dir.path());
        let calls = Arc::new(AtomicU64::new(0));
        let counted = calls.clone();
        m.set_request_defaults(Box::new(move |key| {
            let n = counted.fetch_add(1, Ordering::SeqCst);
            if key == "fine" || n == 4 {
                return Ok(serde_json::Map::new());
            }
            bail!("its defaults cannot be read")
        }));
        // «b» fails, «fine» passes, «b» fails, «fine», then «b» reads well once and breaks again
        for key in ["b", "fine", "b", "fine", "b", "b"] {
            assert_eq!(m.with_request_defaults(key, b"{}".to_vec()), b"{}");
        }
        let log = std::fs::read_to_string(dir.path().join("manager.log")).unwrap();
        assert_eq!(log.matches("request defaults").count(), 2, "{log}");
    }

    /// An explicit `resume` called by whoever has the GPUs always gives them back, even if there are other loans.
    #[test]
    fn manager_log_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let m = manager_without_models(dir.path());
        std::fs::write(dir.path().join("manager.log"), vec![b'x'; LOG_MAX as usize + 1]).unwrap();

        m.log(serde_json::json!({ "event": "after" }));

        assert!(std::fs::metadata(dir.path().join("manager.1.log")).unwrap().len() > LOG_MAX);
        assert!(std::fs::metadata(dir.path().join("manager.log")).unwrap().len() < 1000);
    }

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
