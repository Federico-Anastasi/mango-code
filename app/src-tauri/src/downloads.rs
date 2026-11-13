//! Downloading models in the background: the user asks for models from the app's window and
//! goes on using the app. One download runs at a time and the others wait their turn; each can be paused, resumed and
//! cancelled. What is in progress is kept in `<data>\downloads.json`: a download interrupted by closing the app goes on
//! by itself at the next start from the bytes that had arrived, a paused one stays paused. A download brings the
//! model's engine too, if this computer does not have it yet.

use crate::bridge::{err, BridgeError};
use anyhow::{bail, Context, Result};
use engine_cfg::Hardware;
use mango_common::download::{EngineUnusable, NoSpace, Stopped, Trouble};
use mango_common::{tr, Paths};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// The speed shown is the one of the last seconds.
const SPEED_WINDOW: Duration = Duration::from_secs(5);

/// How long taking a model off the computer waits for its download to stop: a read from the network can hold the
/// download for up to a minute before it sees the stop.
const STOP_WAIT: Duration = Duration::from_secs(90);

/// What downloading a model takes on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Need {
    /// What the download brings, for the user: the model, or its engine when only the engine is missing.
    pub label: String,
    /// The bytes of its engine still to download; 0 if the engine is installed.
    pub engine_bytes: u64,
    /// The bytes of its files; 0 if they are on the disk.
    pub weights_bytes: u64,
}

/// Why a model needs no download: the queue drops it instead of failing it.
#[derive(Debug)]
pub enum NotNeeded {
    /// Its files and its engine are on the computer: the label.
    Present(String),
    NotInCatalog,
}

impl std::fmt::Display for NotNeeded {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&match self {
            NotNeeded::Present(label) => tr!("«{label}» è già sul computer.", "«{label}» is already on the computer."),
            NotNeeded::NotInCatalog => tr!("Questo modello non è nel catalogo.", "This model is not in the catalog."),
        })
    }
}

impl std::error::Error for NotNeeded {}

/// A model this computer cannot download now (it does not fit): the sentence says why.
#[derive(Debug)]
pub struct Unfit(pub String);

impl std::fmt::Display for Unfit {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for Unfit {}

/// The computer and the network, seen from the queue: the part the tests replace.
pub trait Source: Send + Sync {
    /// What it takes to download `model`. It fails with `NotNeeded` when it needs no download and with `Unfit` when it
    /// does not fit; any other error is a failure to look (`refusal` makes it a sentence).
    fn need(&self, model: &str) -> Result<Need>;
    /// `need` of several models; the real computer reads its hardware once for all of them.
    fn needs(&self, models: &[String]) -> Result<Vec<Need>> {
        models.iter().map(|m| self.need(m)).collect()
    }
    /// The model's name for the user, also when `need` fails.
    fn label(&self, model: &str) -> String;
    /// Downloads and installs the engine of `model`. `progress(done, total)` in bytes; `stop` ends it with `Stopped`.
    fn engine(&self, model: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()>;
    /// Downloads the files of `model`, going on from what had already arrived.
    fn weights(&self, model: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()>;
    /// Deletes what an interrupted download of the files of `model` left; a partial file that one of `queued` (the other
    /// models among the downloads) shares stays.
    fn discard(&self, model: &str, queued: &[String]) -> Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Waiting,
    Paused,
    Failed,
}

/// A download, as the interface shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Download {
    pub model: String,
    pub label: String,
    pub state: Status,
    /// Bytes arrived and to arrive, the engine's included if it is downloaded too.
    pub done: u64,
    pub total: u64,
    /// 0 unless it is the active one.
    pub bytes_per_second: u64,
    /// One sentence, with `Failed`.
    pub error: Option<String>,
    /// The model's files are on the disk: it brings only the engine (the app came with a new one).
    pub engine_only: bool,
}

struct Entry {
    model: String,
    label: String,
    state: Status,
    /// Bytes of the engine and of the files: arrived, to arrive.
    engine: (u64, u64),
    weights: (u64, u64),
    error: Option<String>,
    /// Ends the download in progress (a pause, a cancel).
    stop: Arc<AtomicBool>,
    /// The thread that downloads is inside this download, and has not come back from it yet.
    running: bool,
    /// The user cancelled it: it is no longer shown nor saved, and it leaves the queue once its partial files are gone.
    cancelled: bool,
    /// Its partial files are being deleted: nothing downloads it meanwhile, also if it is asked again.
    discarding: bool,
    /// The bytes arrived at the last moments, for the speed.
    samples: VecDeque<(Instant, u64)>,
}

impl Entry {
    fn new(model: &str, need: Need, state: Status) -> Entry {
        Entry {
            model: model.to_string(),
            label: need.label,
            state,
            engine: (0, need.engine_bytes),
            weights: (0, need.weights_bytes),
            error: None,
            stop: Arc::new(AtomicBool::new(false)),
            running: false,
            cancelled: false,
            discarding: false,
            samples: VecDeque::new(),
        }
    }

    fn done(&self) -> u64 {
        self.engine.0 + self.weights.0
    }

    fn view(&self, now: Instant) -> Download {
        Download {
            model: self.model.clone(),
            label: self.label.clone(),
            state: self.state,
            done: self.done(),
            total: self.engine.1 + self.weights.1,
            bytes_per_second: self.speed(now),
            error: self.error.clone(),
            engine_only: self.weights.1 == 0 && self.engine.1 > 0,
        }
    }

    /// The bytes of the last seconds over the time up to now: during a stall the speed goes down, and after a whole
    /// window without bytes it is 0.
    fn speed(&self, now: Instant) -> u64 {
        if self.state != Status::Active {
            return 0;
        }
        let first = self.samples.iter().find(|(t, _)| now.saturating_duration_since(*t) <= SPEED_WINDOW);
        let (Some((t0, b0)), Some((_, b1))) = (first, self.samples.back()) else { return 0 };
        let seconds = now.saturating_duration_since(*t0).as_secs_f64();
        if seconds <= 0.0 {
            return 0;
        }
        (b1.saturating_sub(*b0) as f64 / seconds) as u64
    }

    fn sample(&mut self) {
        let (now, done) = (Instant::now(), self.done());
        // Fewer bytes than before: the download started again from the beginning (a server that ignores the range).
        if self.samples.back().is_some_and(|(_, b)| *b > done) {
            self.samples.clear();
        }
        self.samples.push_back((now, done));
        while self.samples.front().is_some_and(|(t, _)| now.saturating_duration_since(*t) > SPEED_WINDOW) {
            self.samples.pop_front();
        }
    }
}

/// What `downloads.json` keeps of a download: enough to go on with it at the next start.
#[derive(Serialize, Deserialize)]
struct Saved {
    model: String,
    paused: bool,
}

#[derive(Default)]
struct Queue {
    entries: Vec<Entry>,
    /// A thread is downloading.
    working: bool,
    /// Models being taken off the computer (`stop_for_removal`): they cannot be downloaded again until it is done.
    removing: Vec<String>,
}

impl Queue {
    /// The other models among the downloads, for the files they share with `model`.
    fn others(&self, model: &str) -> Vec<String> {
        self.entries.iter().filter(|e| e.model != model && !e.cancelled).map(|e| e.model.clone()).collect()
    }
}

/// How a download that did not arrive ended.
enum Ended {
    /// The model needs no download (any more): it leaves the queue.
    NotNeeded(NotNeeded),
    /// Paused or cancelled.
    Stopped,
    /// The sentence for the user, and the whole error for the log.
    Failed(String, anyhow::Error),
}

struct Inner {
    source: Box<dyn Source>,
    file: PathBuf,
    queue: Mutex<Queue>,
    /// A download stopped running or finished deleting its partial files.
    settled: Condvar,
    /// A model has arrived whole.
    arrived: Box<dyn Fn(&str) + Send + Sync>,
    /// The files of a model changed on the disk, and nothing is to be loaded for that: a download cancelled when it had
    /// just ended whole.
    changed: Box<dyn Fn(&str) + Send + Sync>,
    /// A line for the log: what goes wrong where nobody waits for an answer.
    log: Box<dyn Fn(&str) + Send + Sync>,
    /// The downloads of the last time were taken up (`restore`). Until then the queue is not saved: it would write over them.
    restored: AtomicBool,
    /// How long taking a model off waits for its download to stop.
    stop_wait: Duration,
}

/// Callbacks of the queue: `arrived(model)` when a model is whole on the disk, `changed(model)` when its files changed
/// without anything to load, `log(line)` for what went wrong in the background.
pub struct Tell {
    pub arrived: Box<dyn Fn(&str) + Send + Sync>,
    pub changed: Box<dyn Fn(&str) + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
}

/// A model being taken off the computer: until this is dropped, it cannot be downloaded or resumed.
pub struct Removal {
    downloads: Downloads,
    model: String,
}

impl Drop for Removal {
    fn drop(&mut self) {
        self.downloads.0.queue.lock().unwrap().removing.retain(|m| m != &self.model);
    }
}

#[derive(Clone)]
pub struct Downloads(Arc<Inner>);

impl Downloads {
    /// `file`: where the queue is kept between one start and the next.
    pub fn new(source: Box<dyn Source>, file: PathBuf, tell: Tell) -> Downloads {
        Downloads::waiting(source, file, tell, STOP_WAIT)
    }

    fn waiting(source: Box<dyn Source>, file: PathBuf, tell: Tell, stop_wait: Duration) -> Downloads {
        Downloads(Arc::new(Inner {
            source,
            file,
            queue: Mutex::new(Queue::default()),
            settled: Condvar::new(),
            arrived: tell.arrived,
            changed: tell.changed,
            log: tell.log,
            restored: AtomicBool::new(false),
            stop_wait,
        }))
    }

    /// `model` is being taken off the computer: whoever would load it waits for the end.
    pub fn removing(&self, model: &str) -> bool {
        self.0.queue.lock().unwrap().removing.iter().any(|m| m == model)
    }

    /// The downloads, in the order they were asked.
    pub fn list(&self) -> Vec<Download> {
        let now = Instant::now();
        self.0.queue.lock().unwrap().entries.iter().filter(|e| !e.cancelled).map(|e| e.view(now)).collect()
    }

    /// Queues `models`. Nothing is queued if one of them cannot be downloaded: the error says which and why. A model
    /// already in the queue stays where it is; if it was paused, had failed or was being cancelled it waits its turn
    /// again.
    pub fn download(&self, models: &[String]) -> Result<()> {
        let needs = self.0.source.needs(models)?;
        let mut q = self.0.queue.lock().unwrap();
        if let Some(model) = models.iter().find(|m| q.removing.contains(m)) {
            bail!("{}", being_removed(&self.0.source.label(model)));
        }
        for (model, need) in models.iter().zip(needs) {
            match q.entries.iter_mut().find(|e| &e.model == model) {
                Some(e) => again(e),
                None => q.entries.push(Entry::new(model, need, Status::Waiting)),
            }
        }
        self.save_and_work(q)
    }

    /// Stops the download of `model` where it is: what has arrived stays.
    pub fn pause(&self, model: &str) -> Result<()> {
        let mut q = self.0.queue.lock().unwrap();
        let e = entry(&mut q, model)?;
        if !matches!(e.state, Status::Active | Status::Waiting) {
            return Ok(());
        }
        e.stop.store(true, Ordering::SeqCst);
        e.state = Status::Paused;
        self.save(&q)
    }

    /// A paused download, or one that failed, waits its turn again.
    pub fn resume(&self, model: &str) -> Result<()> {
        let mut q = self.0.queue.lock().unwrap();
        if q.removing.iter().any(|m| m == model) {
            bail!("{}", being_removed(&self.0.source.label(model)));
        }
        again(entry(&mut q, model)?);
        self.save_and_work(q)
    }

    /// Takes `model` out of the queue and deletes what had arrived of its files.
    pub fn cancel(&self, model: &str) -> Result<()> {
        let mut q = self.0.queue.lock().unwrap();
        entry(&mut q, model)?;
        self.cancel_queued(q, model)
    }

    /// Before `model` is taken off the computer: from now until the answer is dropped it cannot be downloaded or resumed;
    /// its download, if any, is cancelled, and this returns once nothing of it is running or deleting files any more.
    pub fn stop_for_removal(&self, model: &str) -> Result<Removal> {
        let removal = {
            let mut q = self.0.queue.lock().unwrap();
            q.removing.push(model.to_string());
            Removal { downloads: self.clone(), model: model.to_string() }
        };
        // A queue that cannot be saved does not stop the removal: what counts is that the download stops.
        if let Err(e) = self.cancel_queued(self.0.queue.lock().unwrap(), model) {
            (self.0.log)(&format!("download of {model} cancelled for its removal: {e:#}"));
        }
        let busy = |q: &mut Queue| q.entries.iter().any(|e| e.model == model && (e.running || e.discarding));
        let (_q, waited) = self.0.settled.wait_timeout_while(self.0.queue.lock().unwrap(), self.0.stop_wait, busy).unwrap();
        if waited.timed_out() {
            bail!(
                "{}",
                tr!(
                    "Lo scaricamento di «{}» non si è ancora fermato. Riprova tra un minuto.",
                    "The download of «{}» has not stopped yet. Try again in a minute.",
                    self.0.source.label(model)
                )
            );
        }
        Ok(removal)
    }

    /// Cancels `model` if it is in the queue and not cancelled already.
    fn cancel_queued(&self, mut q: MutexGuard<'_, Queue>, model: &str) -> Result<()> {
        let Some(e) = q.entries.iter_mut().find(|e| e.model == model && !e.cancelled) else { return Ok(()) };
        e.cancelled = true;
        e.stop.store(true, Ordering::SeqCst);
        // The thread inside it, or the one already deleting its files, does the rest (`finish`, `discarded`).
        if e.running || e.discarding {
            return self.save(&q);
        }
        e.discarding = true;
        let saved = self.save(&q);
        let others = q.others(model);
        drop(q);
        let deleted = self.0.source.discard(model, &others);
        self.discarded(model);
        saved.and(deleted)
    }

    /// The partial files of `model` are gone: a cancelled download leaves the queue, one asked again meanwhile can start.
    fn discarded(&self, model: &str) {
        let mut q = self.0.queue.lock().unwrap();
        if let Some(i) = q.entries.iter().position(|e| e.model == model && e.discarding) {
            q.entries[i].discarding = false;
            if q.entries[i].cancelled {
                q.entries.remove(i);
            }
        }
        self.0.settled.notify_all();
        if let Err(e) = self.save_and_work(q) {
            (self.0.log)(&format!("{e:#}"));
        }
    }

    /// The downloads of the last time, at startup: the paused ones stay paused, the others go on. A model that no longer
    /// needs downloading (it arrived by another road, it left the catalog) is dropped; one that cannot be downloaded now
    /// stays, failed, with the reason. It runs once: a startup tried again does not take them up twice.
    pub fn restore(&self) -> Result<()> {
        if self.0.restored.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let saved = self.read_saved();
        // A file that could not be read is tried again by the next startup, and is not written over meanwhile. One that is
        // not valid is lost anyway: the queue is saved over it.
        if saved.as_ref().is_err_and(|e| e.is::<std::io::Error>()) {
            self.0.restored.store(false, Ordering::SeqCst);
        }
        let mut q = self.0.queue.lock().unwrap();
        for s in saved? {
            // Asked again from the window before the startup got here.
            if q.entries.iter().any(|e| e.model == s.model) {
                continue;
            }
            let state = if s.paused { Status::Paused } else { Status::Waiting };
            match self.0.source.need(&s.model) {
                Ok(need) => q.entries.push(Entry::new(&s.model, need, state)),
                Err(e) if e.is::<NotNeeded>() => (self.0.log)(&format!("download of {} dropped: {e}", s.model)),
                Err(e) => {
                    (self.0.log)(&format!("download of {} not resumed: {e:#}", s.model));
                    let label = self.0.source.label(&s.model);
                    let mut entry = Entry::new(&s.model, Need { label: label.clone(), engine_bytes: 0, weights_bytes: 0 }, state);
                    // A paused one stays paused: resuming it says why it cannot go on.
                    if !s.paused {
                        entry.state = Status::Failed;
                        entry.error = Some(refusal(&label, &e));
                    }
                    q.entries.push(entry);
                }
            }
        }
        self.save_and_work(q)
    }

    fn read_saved(&self) -> Result<Vec<Saved>> {
        let text = match std::fs::read_to_string(&self.0.file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(anyhow::Error::new(e).context(tr!("non riesco a leggere {}", "can't read {}", self.0.file.display()))),
        };
        serde_json::from_str(&text).with_context(|| tr!("{} non è valido", "{} is not valid", self.0.file.display()))
    }

    fn save(&self, q: &Queue) -> Result<()> {
        if !self.0.restored.load(Ordering::SeqCst) {
            return Ok(());
        }
        let saved: Vec<Saved> = q.entries.iter().filter(|e| !e.cancelled).map(|e| Saved { model: e.model.clone(), paused: e.state == Status::Paused }).collect();
        mango_common::write_atomic(&self.0.file, serde_json::to_string_pretty(&saved)?)
            .with_context(|| mango_common::user_text(&tr!("Non riesco a salvare gli scaricamenti in corso.", "I can't save the downloads in progress."), self.0.file.display()))
    }

    /// Saves the queue and lets it go on: a queue that cannot be saved still downloads, and the error is the answer.
    fn save_and_work(&self, q: MutexGuard<'_, Queue>) -> Result<()> {
        let saved = self.save(&q);
        self.work(q);
        saved
    }

    /// Starts the thread that downloads, if none is running.
    fn work(&self, mut q: MutexGuard<'_, Queue>) {
        if std::mem::replace(&mut q.working, true) {
            return;
        }
        drop(q);
        let this = self.clone();
        std::thread::spawn(move || loop {
            let (model, stop) = {
                let mut q = this.0.queue.lock().unwrap();
                let Some(e) = q.entries.iter_mut().find(|e| e.state == Status::Waiting && !e.cancelled && !e.discarding) else {
                    q.working = false;
                    return;
                };
                e.state = Status::Active;
                e.running = true;
                e.stop = Arc::new(AtomicBool::new(false));
                e.samples.clear();
                (e.model.clone(), e.stop.clone())
            };
            let outcome = this.run(&model, &stop);
            this.finish(&model, outcome);
        });
    }

    /// One download: the engine if it is missing, then the files if they are missing.
    fn run(&self, model: &str, stop: &AtomicBool) -> Result<(), Ended> {
        let need = self.0.source.need(model).map_err(|e| match e.downcast::<NotNeeded>() {
            Ok(not) => Ended::NotNeeded(not),
            Err(e) => Ended::Failed(refusal(&self.0.source.label(model), &e), e),
        })?;
        self.update(model, |e| (e.label, e.engine.1, e.weights.1) = (need.label.clone(), need.engine_bytes, need.weights_bytes));
        let engine_only = need.weights_bytes == 0;
        let failed = |e: anyhow::Error| if e.is::<Stopped>() { Ended::Stopped } else { Ended::Failed(failure(&need.label, engine_only, &e), e) };
        if need.engine_bytes > 0 {
            self.0.source.engine(model, stop, &mut |done, total| self.update(model, |e| e.engine = (done, total))).map_err(failed)?;
        }
        if need.weights_bytes > 0 {
            self.0.source.weights(model, stop, &mut |done, total| self.update(model, |e| e.weights = (done, total))).map_err(failed)?;
        }
        Ok(())
    }

    fn update(&self, model: &str, change: impl FnOnce(&mut Entry)) {
        if let Some(e) = self.0.queue.lock().unwrap().entries.iter_mut().find(|e| e.model == model && e.running) {
            change(e);
            e.sample();
        }
    }

    /// What becomes of a download that ended: gone if it arrived, needs no download or was cancelled (then its partial
    /// files go first), still there if it was paused or failed.
    fn finish(&self, model: &str, outcome: Result<(), Ended>) {
        let mut q = self.0.queue.lock().unwrap();
        let Some(i) = q.entries.iter().position(|e| e.model == model && e.running) else { return };
        q.entries[i].running = false;
        // Cancelled: also when the download ended whole right then, the model is being taken off.
        if q.entries[i].cancelled {
            q.entries[i].discarding = true;
            self.0.settled.notify_all();
            let others = q.others(model);
            drop(q);
            if let Err(e) = self.0.source.discard(model, &others) {
                (self.0.log)(&format!("download of {model} cancelled, its partial files not removed: {e:#}"));
            }
            // It ended whole right when it was cancelled: its files are on the disk, and the interface reads them again.
            if outcome.is_ok() {
                (self.0.changed)(model);
            }
            return self.discarded(model);
        }
        let mut arrived = false;
        match outcome {
            Ok(()) => {
                q.entries.remove(i);
                arrived = true;
            }
            Err(Ended::NotNeeded(not)) => {
                q.entries.remove(i);
                arrived = matches!(not, NotNeeded::Present(_));
            }
            // Paused, or asked again meanwhile: the state is already the one to keep.
            Err(Ended::Stopped) => {}
            // A pause stays a pause, also when the download failed before it stopped.
            Err(Ended::Failed(_, e)) if q.entries[i].state == Status::Paused => (self.0.log)(&format!("download of {model}, paused: {e:#}")),
            Err(Ended::Failed(sentence, e)) => {
                (self.0.log)(&format!("download of {model} failed: {e:#}"));
                q.entries[i].state = Status::Failed;
                q.entries[i].error = Some(sentence);
            }
        }
        self.0.settled.notify_all();
        if let Err(e) = self.save(&q) {
            (self.0.log)(&format!("{e:#}"));
        }
        drop(q);
        if arrived {
            (self.0.arrived)(model);
        }
    }
}

/// The sentence for a download that failed: what happened and what to do, without addresses or hashes (those go to the
/// log). `label` is what it brings: the model, or the engine alone (`engine_only`).
fn failure(label: &str, engine_only: bool, e: &anyhow::Error) -> String {
    let gb = |b: u64| b as f64 / (1u64 << 30) as f64;
    if let Some(s) = e.chain().find_map(|c| c.downcast_ref::<NoSpace>()) {
        return tr!(
            "Sul disco non c'è spazio per «{label}»: servono {:.1} GB, ne sono liberi {:.1}. Libera spazio e riprova.",
            "There is no room on the disk for «{label}»: {:.1} GB are needed, {:.1} are free. Free some space and try again.",
            gb(s.needed),
            gb(s.free)
        );
    }
    if let Some(t) = e.chain().find_map(|c| c.downcast_ref::<Trouble>()) {
        return match t {
            Trouble::Network(_) => tr!(
                "Lo scaricamento di «{label}» si è interrotto. Controlla la connessione e riprova: riparte da dove era arrivato.",
                "The download of «{label}» stopped. Check the connection and try again: it goes on from where it got to."
            ),
            Trouble::Server(_) => tr!(
                "Il server non dà i file di «{label}». Riprova più tardi.",
                "The server does not give the files of «{label}». Try again later."
            ),
            Trouble::WrongFile(_) => tr!(
                "Un file di «{label}» è arrivato diverso da quello giusto ed è stato scartato. Riprova: si riscarica da capo.",
                "A file of «{label}» arrived different from the right one and was discarded. Try again: it downloads again from the start."
            ),
        };
    }
    if e.chain().any(|c| c.is::<EngineUnusable>()) && engine_only {
        return tr!(
            "«{label}» è arrivato ma non parte su questo computer. Segnala il problema.",
            "«{label}» arrived but does not start on this computer. Report the problem."
        );
    }
    if e.chain().any(|c| c.is::<EngineUnusable>()) {
        return tr!(
            "Il motore di «{label}» è arrivato ma non parte su questo computer. Segnala il problema.",
            "The engine of «{label}» arrived but does not start on this computer. Report the problem."
        );
    }
    let denied = e.chain().filter_map(|c| c.downcast_ref::<std::io::Error>()).any(|io| io.kind() == std::io::ErrorKind::PermissionDenied);
    if denied && engine_only {
        return tr!(
            "Mango Code non può scrivere «{label}» sul computer. Controlla che la sua cartella non sia protetta (anche dall'antivirus) e riprova.",
            "Mango Code cannot write «{label}» on the computer. Check that its folder is not protected (by the antivirus too) and try again."
        );
    }
    if denied {
        return tr!(
            "Mango Code non può scrivere i file di «{label}» nella cartella dei modelli. Controlla che non sia protetta (anche dall'antivirus) e riprova.",
            "Mango Code cannot write the files of «{label}» in the models folder. Check that it is not protected (by the antivirus too) and try again."
        );
    }
    tr!(
        "Lo scaricamento di «{label}» non è riuscito. Riprova; se succede ancora, segnala il problema.",
        "The download of «{label}» did not succeed. Try again; if it happens again, report the problem."
    )
}

/// The sentence for a model that cannot be downloaded: its own when it does not fit or needs no download, otherwise
/// that the computer could not be looked at (the detail goes to the log).
fn refusal(label: &str, e: &anyhow::Error) -> String {
    if e.is::<Unfit>() || e.is::<NotNeeded>() {
        return e.to_string();
    }
    tr!(
        "Non riesco a preparare lo scaricamento di «{label}». Riprova; se succede ancora, segnala il problema.",
        "I can't prepare the download of «{label}». Try again; if it happens again, report the problem."
    )
}

fn being_removed(label: &str) -> String {
    tr!(
        "«{label}» si sta togliendo dal computer: lo puoi scaricare di nuovo quando ha finito.",
        "«{label}» is being taken off the computer: you can download it again when that is done."
    )
}

/// A download that was paused, had failed or was being cancelled waits its turn again; any other stays as it is.
fn again(e: &mut Entry) {
    if e.cancelled || matches!(e.state, Status::Paused | Status::Failed) {
        e.state = Status::Waiting;
        e.error = None;
        e.cancelled = false;
    }
}

fn entry<'a>(q: &'a mut Queue, model: &str) -> Result<&'a mut Entry> {
    q.entries
        .iter_mut()
        .find(|e| e.model == model && !e.cancelled)
        .with_context(|| tr!("Questo modello non è fra gli scaricamenti.", "This model is not among the downloads."))
}

/// The real computer: the catalog and the hardware of `engine-cfg`, the downloads of `mango-common`.
pub struct Real {
    pub paths: Paths,
    /// How the computer is read: `engine_cfg::detect`, or a fixed computer in the tests.
    pub hardware: fn() -> Result<Hardware>,
}

impl Real {
    /// The hardware, read: 60 ms on the PC measured (`detect`), so a command reads it once.
    fn read_hardware(&self) -> Result<Hardware> {
        (self.hardware)().with_context(|| tr!("Non riesco a guardare l'hardware di questo computer.", "Cannot look at the hardware of this computer."))
    }

    /// What downloading `model` means here, with the user's choices.
    fn plan(&self, model: &str) -> Result<engine_cfg::DownloadPlan> {
        engine_cfg::download_of(&self.paths, model, &self.read_hardware()?)
    }

    fn need_on(&self, model: &str, hw: &Hardware) -> Result<Need> {
        if !self.in_catalog(model)? {
            return Err(NotNeeded::NotInCatalog.into());
        }
        let d = engine_cfg::download_of(&self.paths, model, hw)?;
        if let Err(reason) = &d.fits {
            return Err(Unfit(tr!("«{}» non ci sta in questo computer: {reason}", "«{}» does not fit in this computer: {reason}", d.label)).into());
        }
        let engine_bytes = mango_common::download::engine_size(&self.paths, &d.engine, d.build)?;
        if d.weights && engine_bytes == 0 {
            return Err(NotNeeded::Present(d.label).into());
        }
        let label = if d.weights { engine_cfg::engine_label(&d.engine, d.build) } else { d.label };
        Ok(Need { label, engine_bytes, weights_bytes: if d.weights { 0 } else { d.bytes } })
    }

    fn in_catalog(&self, model: &str) -> Result<bool> {
        Ok(mango_common::catalog::read(&self.paths)?.root.get("models").and_then(|m| m.get(model)).is_some())
    }
}

impl Source for Real {
    fn need(&self, model: &str) -> Result<Need> {
        self.need_on(model, &self.read_hardware()?)
    }

    fn needs(&self, models: &[String]) -> Result<Vec<Need>> {
        let hw = self.read_hardware()?;
        models.iter().map(|m| self.need_on(m, &hw)).collect()
    }

    fn label(&self, model: &str) -> String {
        let catalog = mango_common::catalog::read(&self.paths).ok();
        let label = catalog.as_ref().and_then(|c| c.root.get("models")?.get(model)?.get("label")?.as_str().map(str::to_string));
        label.unwrap_or_else(|| model.to_string())
    }

    fn engine(&self, model: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        let d = self.plan(model)?;
        mango_common::download::install_engine(&self.paths, &d.engine, d.build, stop, progress).map(|_| ())
    }

    fn weights(&self, model: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        mango_common::download::install_model(&self.paths, model, &self.plan(model)?.engine, stop, progress)
    }

    fn discard(&self, model: &str, queued: &[String]) -> Result<()> {
        mango_common::download::discard_partial(&self.paths, model, &self.plan(model)?.engine, queued)
    }
}

// ---------------------------------------------------------------- the bridge's commands (`models`, only in the app's window)

/// What a command answers when it refuses: the sentence for the user, without the technical detail
/// (`mango_common::user_phrase`); the whole error goes to the log. `code` is `token` for a refusal of Hugging Face that the
/// user's token answers (the interface shows the way to it), `refused` otherwise.
pub(crate) fn refused(app: &tauri::AppHandle, e: anyhow::Error) -> BridgeError {
    let code = if mango_common::download::hugging_face::is_token_refusal(&e) { "token" } else { "refused" };
    crate::bridge::shown(app, code, "models: refused", e)
}

/// Runs a command's work away from the threads that serve the bridge: reading the hardware, stopping the engine and
/// deleting files block.
pub(crate) async fn blocking<T: Send + 'static>(app: tauri::AppHandle, work: impl FnOnce(&tauri::AppHandle) -> Result<T> + Send + 'static) -> Result<T, BridgeError> {
    tauri::async_runtime::spawn_blocking(move || work(&app).map_err(|e| refused(&app, e))).await.map_err(|e| err("io", e.to_string()))?
}

fn queue(app: &tauri::AppHandle) -> Result<Downloads, BridgeError> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    state.downloads.get().cloned().ok_or_else(|| err("unavailable", tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting.")))
}

/// Queues the models to download; it answers at once, the downloads are told by the control server's state.
#[tauri::command]
pub async fn models_download(app: tauri::AppHandle, keys: Vec<String>) -> Result<(), BridgeError> {
    let q = queue(&app)?;
    blocking(app, move |_| q.download(&keys)).await
}

#[tauri::command]
pub async fn models_pause(app: tauri::AppHandle, key: String) -> Result<(), BridgeError> {
    let q = queue(&app)?;
    blocking(app, move |_| q.pause(&key)).await
}

#[tauri::command]
pub async fn models_resume(app: tauri::AppHandle, key: String) -> Result<(), BridgeError> {
    let q = queue(&app)?;
    blocking(app, move |_| q.resume(&key)).await
}

#[tauri::command]
pub async fn models_cancel(app: tauri::AppHandle, key: String) -> Result<(), BridgeError> {
    let q = queue(&app)?;
    blocking(app, move |_| q.cancel(&key)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A computer where every model weighs 1000 bytes and arrives 100 bytes at a time; `gate` holds the downloads still
    /// until the test lets them go.
    #[derive(Default)]
    struct Fake {
        arrived: Mutex<HashMap<String, u64>>,
        /// Models whose download fails, those the computer cannot download, those not in the catalog, and those the
        /// computer cannot be looked at for.
        broken: Mutex<Vec<String>>,
        refused: Vec<String>,
        unknown: Vec<String>,
        blind: Vec<String>,
        engine_missing: AtomicBool,
        /// The engine's download waits while this is true.
        hold_engine: AtomicBool,
        /// The models discarded, each with the other models that were among the downloads then.
        discarded: Mutex<Vec<String>>,
        queued_at_discard: Mutex<Vec<Vec<String>>>,
        gate: AtomicBool,
        /// The download does not see the stop until the gate opens: a read from the network that hangs.
        stubborn: AtomicBool,
        /// Deleting the partial files waits while this is true.
        hold_discard: AtomicBool,
        /// Models being discarded right now, and those that downloaded meanwhile.
        discarding: Mutex<Vec<String>>,
        overlaps: Mutex<Vec<String>>,
    }

    const SIZE: u64 = 1000;

    impl Fake {
        fn whole(&self, model: &str) -> bool {
            self.arrived.lock().unwrap().get(model).is_some_and(|b| *b >= SIZE)
        }
    }

    impl Source for Arc<Fake> {
        fn need(&self, model: &str) -> Result<Need> {
            if self.refused.iter().any(|m| m == model) {
                return Err(Unfit(format!("«{model}» does not fit")).into());
            }
            if self.blind.iter().any(|m| m == model) {
                bail!("the hardware does not answer");
            }
            if self.unknown.iter().any(|m| m == model) {
                return Err(NotNeeded::NotInCatalog.into());
            }
            let engine_missing = self.engine_missing.load(Ordering::SeqCst);
            if self.whole(model) && !engine_missing {
                return Err(NotNeeded::Present(self.label(model)).into());
            }
            Ok(Need { label: self.label(model), engine_bytes: if engine_missing { 200 } else { 0 }, weights_bytes: if self.whole(model) { 0 } else { SIZE } })
        }

        fn label(&self, model: &str) -> String {
            format!("Model {model}")
        }

        fn engine(&self, _: &str, _: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
            while self.hold_engine.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            progress(200, 200);
            self.engine_missing.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn weights(&self, model: &str, stop: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
            // `Real::weights` downloads what is missing of the files whatever the engine; this one fails when there is
            // nothing to download, so a call that should not happen shows.
            self.need(model)?;
            loop {
                if self.discarding.lock().unwrap().iter().any(|m| m == model) {
                    self.overlaps.lock().unwrap().push(model.to_string());
                }
                let stops = || stop.load(Ordering::SeqCst) && !self.stubborn.load(Ordering::SeqCst);
                while !self.gate.load(Ordering::SeqCst) && !stops() {
                    std::thread::sleep(Duration::from_millis(2));
                }
                if stops() {
                    return Err(Stopped.into());
                }
                if self.broken.lock().unwrap().iter().any(|m| m == model) {
                    return Err(Trouble::Network("the network is gone from https://huggingface.co/x".into()).into());
                }
                let mut arrived = self.arrived.lock().unwrap();
                let done = arrived.entry(model.to_string()).or_default();
                if *done >= SIZE {
                    return Ok(());
                }
                *done += 100;
                progress(*done, SIZE);
                drop(arrived);
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        fn discard(&self, model: &str, queued: &[String]) -> Result<()> {
            self.queued_at_discard.lock().unwrap().push(queued.to_vec());
            self.discarding.lock().unwrap().push(model.to_string());
            while self.hold_discard.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            self.arrived.lock().unwrap().remove(model);
            self.discarded.lock().unwrap().push(model.to_string());
            self.discarding.lock().unwrap().retain(|m| m != model);
            Ok(())
        }
    }

    struct Fixture {
        fake: Arc<Fake>,
        downloads: Downloads,
        arrived: Arc<Mutex<Vec<String>>>,
        changed: Arc<Mutex<Vec<String>>>,
        log: Arc<Mutex<Vec<String>>>,
        _dir: tempfile::TempDir,
    }

    /// A queue that has not taken up the downloads of the last time yet, as at the start of the app.
    fn fixture_with(fake: Fake, dir: tempfile::TempDir) -> Fixture {
        fixture_waiting(fake, dir, STOP_WAIT)
    }

    fn fixture_waiting(fake: Fake, dir: tempfile::TempDir, stop_wait: Duration) -> Fixture {
        let fake = Arc::new(fake);
        let (arrived, changed, log) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let (seen, touched, lines) = (arrived.clone(), changed.clone(), log.clone());
        let tell = Tell {
            arrived: Box::new(move |m| seen.lock().unwrap().push(m.to_string())),
            changed: Box::new(move |m| touched.lock().unwrap().push(m.to_string())),
            log: Box::new(move |l| lines.lock().unwrap().push(l.to_string())),
        };
        let downloads = Downloads::waiting(Box::new(fake.clone()), dir.path().join("downloads.json"), tell, stop_wait);
        Fixture { fake, downloads, arrived, changed, log, _dir: dir }
    }

    /// A queue in use: the start has taken up the downloads of the last time (none).
    fn ready(fake: Fake) -> Fixture {
        let f = fixture_with(fake, tempfile::tempdir().unwrap());
        f.downloads.restore().unwrap();
        f
    }

    fn fixture() -> Fixture {
        ready(Fake::default())
    }

    impl Fixture {
        fn states(&self) -> Vec<(String, Status)> {
            self.downloads.list().into_iter().map(|d| (d.model, d.state)).collect()
        }

        fn ask(&self, models: &[&str]) -> Result<()> {
            self.downloads.download(&models.iter().map(|m| m.to_string()).collect::<Vec<_>>())
        }

        fn go(&self) {
            self.fake.gate.store(true, Ordering::SeqCst);
        }

        fn saved(&self) -> String {
            std::fs::read_to_string(self._dir.path().join("downloads.json")).unwrap().split_whitespace().collect()
        }

        fn arrived(&self) -> Vec<String> {
            self.arrived.lock().unwrap().clone()
        }
    }

    fn until(what: &str, done: impl Fn() -> bool) {
        let t0 = Instant::now();
        while !done() {
            assert!(t0.elapsed() < Duration::from_secs(5), "{what}: not within 5 s");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn states(v: &[(&str, Status)]) -> Vec<(String, Status)> {
        v.iter().map(|(m, s)| (m.to_string(), *s)).collect()
    }

    #[test]
    fn one_download_at_a_time_in_the_order_asked_and_each_model_is_told_when_whole() {
        let f = fixture();
        f.ask(&["a", "b"]).unwrap();
        f.ask(&["c"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active), ("b", Status::Waiting), ("c", Status::Waiting)]));
        assert_eq!(f.saved(), r#"[{"model":"a","paused":false},{"model":"b","paused":false},{"model":"c","paused":false}]"#);
        f.go();
        until("all arrived", || f.states().is_empty());
        assert_eq!(f.arrived(), ["a", "b", "c"]);
        assert_eq!(f.saved(), "[]");
    }

    #[test]
    fn the_progress_counts_the_engine_too_and_the_speed_is_of_the_active_one() {
        let f = fixture();
        f.fake.engine_missing.store(true, Ordering::SeqCst);
        f.ask(&["a", "b"]).unwrap();
        until("the engine arrived", || f.downloads.list()[0].done == 200);
        let a = &f.downloads.list()[0];
        assert_eq!((a.label.as_str(), a.total), ("Model a", 1200));
        f.go();
        until("bytes arriving", || f.downloads.list().first().is_some_and(|d| d.model == "a" && d.done > 400 && d.bytes_per_second > 0));
        assert_eq!(f.downloads.list().last().unwrap().bytes_per_second, 0, "a download that waits has no speed");
        until("all arrived", || f.states().is_empty());
    }

    /// The files are on the disk and only the engine is missing: the download brings the engine, does not
    /// touch the files, and the model is told whole.
    #[test]
    fn a_model_whose_files_are_there_downloads_only_its_engine_and_arrives() {
        let f = fixture();
        f.fake.arrived.lock().unwrap().insert("a".into(), SIZE);
        f.fake.engine_missing.store(true, Ordering::SeqCst);
        f.fake.hold_engine.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        assert_eq!(f.downloads.list()[0].total, 200, "what arrives is the engine only");
        f.fake.hold_engine.store(false, Ordering::SeqCst);
        until("«a» arrived", || f.states().is_empty());
        assert_eq!(f.arrived(), ["a"]);
    }

    /// A model that arrived by another road while it waited its turn: it leaves the queue, it does not fail.
    #[test]
    fn a_model_already_on_the_computer_when_its_turn_comes_leaves_the_queue() {
        let f = fixture();
        f.ask(&["a", "b"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active), ("b", Status::Waiting)]));
        f.fake.arrived.lock().unwrap().insert("b".into(), SIZE);
        f.go();
        until("the queue empty", || f.states().is_empty());
        assert_eq!(f.arrived(), ["a", "b"]);
    }

    #[test]
    fn a_paused_download_keeps_what_arrived_lets_the_next_go_and_resumes_from_there() {
        let f = fixture();
        f.ask(&["a", "b"]).unwrap();
        f.go();
        until("some of «a» arrived", || f.downloads.list()[0].done >= 300);
        f.downloads.pause("a").unwrap();
        until("«b» arrived instead", || f.states() == states(&[("a", Status::Paused)]));
        let kept = f.fake.arrived.lock().unwrap()["a"];
        assert!((300..SIZE).contains(&kept), "{kept}");
        assert_eq!(f.saved(), r#"[{"model":"a","paused":true}]"#);
        assert_eq!(f.arrived(), ["b"]);

        f.downloads.resume("a").unwrap();
        until("«a» arrived", || f.states().is_empty());
        assert_eq!(f.arrived(), ["b", "a"]);
        assert!(f.fake.discarded.lock().unwrap().is_empty(), "a pause deletes nothing");
    }

    /// The download fails after the user paused it, before it saw the pause: it stays paused, also in the file.
    #[test]
    fn a_pause_stays_a_pause_when_the_download_fails_before_stopping() {
        let f = fixture();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        f.downloads.pause("a").unwrap();
        f.fake.broken.lock().unwrap().push("a".into());
        f.go();
        until("the download ended", || f.log.lock().unwrap().iter().any(|l| l.contains("paused")));
        assert_eq!(f.states(), states(&[("a", Status::Paused)]));
        assert_eq!(f.downloads.list()[0].error, None);
        assert_eq!(f.saved(), r#"[{"model":"a","paused":true}]"#);
    }

    #[test]
    fn a_cancelled_download_leaves_the_queue_and_its_partial_files_go() {
        let f = fixture();
        f.ask(&["a", "b", "c"]).unwrap();
        // one that waits
        f.downloads.cancel("b").unwrap();
        assert_eq!(f.states().iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        // the one that is running
        f.go();
        until("some of «a» arrived", || f.downloads.list()[0].model == "a" && f.downloads.list()[0].done >= 300);
        f.downloads.cancel("a").unwrap();
        until("«c» arrived", || f.states().is_empty());
        assert_eq!(f.arrived(), ["c"]);
        assert_eq!(*f.fake.discarded.lock().unwrap(), ["b", "a"]);
        assert_eq!(*f.fake.queued_at_discard.lock().unwrap(), [vec!["a".to_string(), "c".to_string()], vec!["c".to_string()]], "their shared files stay");
        assert!(!f.fake.arrived.lock().unwrap().contains_key("a"));
        assert!(f.downloads.cancel("a").is_err(), "it is no longer among the downloads");
    }

    /// A download cancelled right when it ended whole: its files are on the disk, the interface is told, nothing loads.
    #[test]
    fn a_download_cancelled_when_it_ended_whole_is_told_but_not_loaded() {
        let f = fixture();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        f.downloads.cancel("a").unwrap();
        f.go();
        until("its partial files gone", || f.fake.discarded.lock().unwrap().len() == 1);
        assert_eq!((f.arrived(), f.changed.lock().unwrap().clone()), (vec![], vec!["a".to_string()]));
    }

    /// A running download that does not see the cancel at once is no longer shown, nor saved.
    #[test]
    fn a_cancelled_download_is_not_shown_while_it_stops() {
        let f = fixture();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        f.downloads.cancel("a").unwrap();
        assert!(f.states().is_empty());
        assert_eq!(f.saved(), "[]");
        assert!(f.downloads.pause("a").is_err());
        f.go();
        until("its files gone", || f.fake.discarded.lock().unwrap().len() == 1);
    }

    /// Cancel, then Download again while the partial files are still being deleted: the new download waits
    /// for the deletion, so it is not deleted under it.
    #[test]
    fn a_download_asked_again_while_its_files_are_deleted_waits_for_the_deletion() {
        let f = fixture();
        f.ask(&["x", "a"]).unwrap();
        until("«x» active", || f.states() == states(&[("x", Status::Active), ("a", Status::Waiting)]));
        f.fake.hold_discard.store(true, Ordering::SeqCst);
        let d = f.downloads.clone();
        let cancel = std::thread::spawn(move || d.cancel("a"));
        until("the deletion started", || !f.fake.discarding.lock().unwrap().is_empty());
        f.ask(&["a"]).unwrap();
        f.go();
        until("«x» arrived and the thread that downloads left", || f.arrived() == ["x"] && !f.downloads.0.queue.lock().unwrap().working);
        assert_eq!(f.states(), states(&[("a", Status::Waiting)]), "it waits for the deletion");
        f.fake.hold_discard.store(false, Ordering::SeqCst);
        cancel.join().unwrap().unwrap();
        until("«a» arrived", || f.arrived() == ["x", "a"]);
        assert!(f.fake.overlaps.lock().unwrap().is_empty(), "nothing downloaded while the files were deleted");
        assert!(f.fake.whole("a"));
    }

    /// Taking a model off the computer while it downloads: the removal waits until the download has left
    /// its files, and a download that ended whole right then does not announce the model.
    #[test]
    fn a_removal_waits_for_the_running_download_to_stop() {
        let f = fixture();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        let fake = f.fake.clone();
        let opens = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            fake.gate.store(true, Ordering::SeqCst);
        });
        let t0 = Instant::now();
        let removal = f.downloads.stop_for_removal("a").unwrap();
        assert!(t0.elapsed() >= Duration::from_millis(250), "it returned before the download stopped");
        assert_eq!(*f.fake.discarded.lock().unwrap(), ["a"]);
        assert!(f.arrived().is_empty(), "a model being taken off is not announced");
        assert!(f.states().is_empty());
        opens.join().unwrap();

        // Until the removal ends the model cannot come back into the queue.
        let refused = tr!(
            "«Model a» si sta togliendo dal computer: lo puoi scaricare di nuovo quando ha finito.",
            "«Model a» is being taken off the computer: you can download it again when that is done."
        );
        assert!(f.downloads.removing("a"));
        assert_eq!(f.ask(&["a"]).unwrap_err().to_string(), refused);
        assert!(f.states().is_empty());
        drop(removal);
        assert!(!f.downloads.removing("a"));
        f.ask(&["a"]).unwrap();
        until("«a» arrived again", || f.arrived() == ["a"]);

        // Nothing in the queue: nothing to wait for.
        drop(f.downloads.stop_for_removal("b").unwrap());
    }

    /// While a model is taken off the computer a request that names it does not start it: the guard is taken before the
    /// download is stopped and let go when the removal ends.
    #[test]
    fn a_model_being_taken_off_is_not_started_by_a_request() {
        let w = real_world();
        let engine = engine::EngineManager::new(Box::new(|key, _, _| bail!("the plan of «{key}»")), Box::new(Vec::new), w._dir.path());
        let f = fixture();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["3.5-4b"]).unwrap();
        until("the download active", || f.states() == states(&[("3.5-4b", Status::Active)]));
        let hw = (w.real.hardware)().unwrap();
        std::thread::scope(|s| {
            let removal = s.spawn(|| crate::model_choices::take_off(&w.real.paths, &hw, Some(&f.downloads), Some(&engine), "3.5-4b"));
            until("the removal waiting for the download", || f.downloads.removing("3.5-4b"));
            let refused = engine.acquire(Some("3.5-4b")).err();
            f.go();
            removal.join().unwrap().unwrap();
            let refused = refused.expect("the model started during its removal");
            assert!(refused.is::<engine::BeingRemoved>(), "{refused:#}");
        });
        // The removal ended: a request starts the model again (here the plan refuses it, as there are no files).
        let after = engine.acquire(Some("3.5-4b")).err().expect("no plan in the test");
        assert!(!after.is::<engine::BeingRemoved>(), "{after:#}");
    }

    /// A model of the user's taken off the computer leaves the user's list, with its choices and the default: the file the
    /// user chose stays where it is; the files Mango Code downloaded for one from Hugging Face go, with their folders.
    #[test]
    fn a_model_of_the_user_taken_off_leaves_the_list_and_only_the_users_file_stays() {
        use engine_cfg::choices::{self, Choices, WhereChoice};
        let w = real_world();
        let hw = (w.real.hardware)().unwrap();
        let paths = &w.real.paths;
        let mine = w._dir.path().join("elsewhere").join("mine.gguf");
        std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
        std::fs::write(&mine, b"x").unwrap();
        let entry = |file: serde_json::Value| {
            serde_json::json!({ "label": "Mine", "gguf": file["path"], "ctx": 32768, "files": [file], "memory": { "kv_kib_token": 32, "state_mib": 50 } })
        };
        let list = serde_json::json!({ "models": {
            "local-mine": entry(serde_json::json!({ "path": mine.display().to_string(), "size": 1_000_000_000u64 })),
            "hf-mine": entry(serde_json::json!({ "path": "owner/repo/hf.gguf", "size": 1_000_000_000u64, "sha256": "0".repeat(64) })),
        } });
        std::fs::create_dir_all(&paths.data).unwrap();
        std::fs::write(paths.data.join(mango_common::catalog::USER_FILE), list.to_string()).unwrap();
        w.put("owner/repo/hf.gguf");
        choices::set_model(paths, "local-mine", Choices { place: WhereChoice::Cpu, ..Choices::default() }).unwrap();
        choices::set_default(paths, Some("local-mine")).unwrap();

        crate::model_choices::take_off(paths, &hw, None, None, "local-mine").unwrap();
        assert_eq!(mango_common::catalog::read(paths).unwrap().user, ["hf-mine"], "it is no longer in the list");
        assert!(mine.is_file(), "the user's file stays where it is");
        let saved = choices::read(paths).unwrap();
        assert!(saved.default.is_none() && saved.models.is_empty(), "{saved:?}");

        crate::model_choices::take_off(paths, &hw, None, None, "hf-mine").unwrap();
        assert!(mango_common::catalog::read(paths).unwrap().user.is_empty());
        assert!(!paths.models.join("owner").exists(), "the downloaded file goes, and its empty folders");
    }

    /// A paused download being taken off: resuming it is refused until the removal ends.
    #[test]
    fn a_paused_download_being_removed_cannot_be_resumed() {
        let f = fixture();
        f.ask(&["a"]).unwrap();
        f.downloads.pause("a").unwrap();
        let removal = f.downloads.stop_for_removal("a").unwrap();
        assert!(f.downloads.resume("a").is_err());
        drop(removal);
        assert!(f.states().is_empty(), "the removal cancelled it");
    }

    /// A download that does not stop within the wait: the removal gives up with a sentence, and the model is no longer
    /// being removed.
    #[test]
    fn a_removal_gives_up_when_the_download_does_not_stop_in_time() {
        let f = fixture_waiting(Fake::default(), tempfile::tempdir().unwrap(), Duration::from_millis(200));
        f.downloads.restore().unwrap();
        f.fake.stubborn.store(true, Ordering::SeqCst);
        f.ask(&["a"]).unwrap();
        until("«a» active", || f.states() == states(&[("a", Status::Active)]));
        let e = match f.downloads.stop_for_removal("a") {
            Ok(_) => panic!("the download was still running"),
            Err(e) => e.to_string(),
        };
        assert_eq!(e, tr!("Lo scaricamento di «Model a» non si è ancora fermato. Riprova tra un minuto.", "The download of «Model a» has not stopped yet. Try again in a minute."));
        assert!(!f.downloads.removing("a"));
        f.go();
        until("its files gone", || f.fake.discarded.lock().unwrap().len() == 1);
    }

    #[test]
    fn a_download_that_fails_says_why_in_a_sentence_lets_the_next_go_and_can_be_tried_again() {
        let f = fixture();
        f.fake.broken.lock().unwrap().push("a".into());
        f.ask(&["a", "b"]).unwrap();
        f.go();
        until("«a» failed, «b» arrived", || f.states() == states(&[("a", Status::Failed)]));
        let sentence = tr!(
            "Lo scaricamento di «Model a» si è interrotto. Controlla la connessione e riprova: riparte da dove era arrivato.",
            "The download of «Model a» stopped. Check the connection and try again: it goes on from where it got to."
        );
        assert_eq!(f.downloads.list()[0].error, Some(sentence));
        assert!(f.log.lock().unwrap().iter().any(|l| l.contains("https://huggingface.co/x")), "the address goes to the log");
        f.fake.broken.lock().unwrap().clear();
        f.downloads.resume("a").unwrap();
        until("«a» arrived", || f.states().is_empty());
        assert_eq!(f.arrived(), ["b", "a"]);
    }

    #[test]
    fn without_room_on_the_disk_the_sentence_says_how_much_is_needed() {
        let e = anyhow::Error::new(NoSpace { needed: 3 << 30, free: 1 << 30, dir: PathBuf::from(r"C:\models") }).context("m.gguf");
        assert_eq!(
            failure("M", false, &e),
            tr!(
                "Sul disco non c'è spazio per «M»: servono 3.0 GB, ne sono liberi 1.0. Libera spazio e riprova.",
                "There is no room on the disk for «M»: 3.0 GB are needed, 1.0 are free. Free some space and try again."
            )
        );
    }

    /// Each failure says what happened in its own sentence: only the network asks to check the connection.
    #[test]
    fn each_failure_has_its_sentence() {
        let says = |e: anyhow::Error| failure("M", false, &e.context("m.gguf"));
        let generic = tr!(
            "Lo scaricamento di «M» non è riuscito. Riprova; se succede ancora, segnala il problema.",
            "The download of «M» did not succeed. Try again; if it happens again, report the problem."
        );
        let connection = tr!("Controlla la connessione", "Check the connection");
        assert!(says(Trouble::Network("x".into()).into()).contains(&connection));
        for e in [
            anyhow::Error::new(Trouble::Server("404".into())),
            anyhow::Error::new(Trouble::WrongFile("sha256".into())),
            anyhow::anyhow!("--version").context(EngineUnusable { engine: "llamacpp".into(), build: mango_common::Build::Cpu }),
            anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            anyhow::anyhow!("anything else"),
        ] {
            let sentence = says(e);
            assert!(!sentence.contains(&connection) && sentence.contains("«M»"), "{sentence}");
        }
        assert_eq!(says(anyhow::anyhow!("anything else")), generic);
        assert!(says(anyhow::Error::new(Trouble::WrongFile("x".into()))).contains(&tr!("scartato", "discarded")));
        assert!(says(anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied))).contains(&tr!("cartella dei modelli", "models folder")));
    }

    #[test]
    fn a_model_that_cannot_be_downloaded_is_refused_with_its_reason_and_nothing_is_queued() {
        let f = fixture_with(Fake { refused: vec!["huge".into()], ..Fake::default() }, tempfile::tempdir().unwrap());
        let e = f.ask(&["a", "huge"]).unwrap_err().to_string();
        assert_eq!(e, "«huge» does not fit");
        assert!(f.states().is_empty());
        assert!(f.downloads.pause("a").is_err());
    }

    /// The queue cannot be written: the downloads go on all the same, and the answer says it was not saved.
    #[test]
    fn a_queue_that_cannot_be_saved_still_downloads() {
        let f = fixture();
        std::fs::remove_file(f._dir.path().join("downloads.json")).unwrap();
        std::fs::create_dir(f._dir.path().join("downloads.json")).unwrap();
        let e = f.ask(&["a"]).unwrap_err();
        let phrase = mango_common::user_phrase(&e);
        assert!(phrase.contains(&tr!("Non riesco a salvare", "I can't save")) && !phrase.contains("downloads.json"), "the sentence without the path: {phrase}");
        f.go();
        until("«a» arrived", || f.arrived() == ["a"]);
    }

    /// Closing the app leaves the queue in its file: at the next start the paused download is still paused and the
    /// others go on, in order, from what had arrived. One that cannot be downloaded now stays, failed, with its reason;
    /// one that is already there, or left the catalog, goes.
    #[test]
    fn at_the_next_start_the_downloads_go_on_and_the_paused_one_stays_paused() {
        let f = fixture_with(Fake { refused: vec!["huge".into()], unknown: vec!["gone".into()], blind: vec!["blind".into()], ..Fake::default() }, tempfile::tempdir().unwrap());
        std::fs::write(
            f._dir.path().join("downloads.json"),
            r#"[{"model":"a","paused":true},{"model":"huge","paused":false},{"model":"blind","paused":false},{"model":"gone","paused":false},{"model":"there","paused":false},{"model":"b","paused":false}]"#,
        )
        .unwrap();
        f.fake.arrived.lock().unwrap().insert("b".into(), 600);
        f.fake.arrived.lock().unwrap().insert("there".into(), SIZE);
        f.downloads.restore().unwrap();
        let failed = [("a", Status::Paused), ("huge", Status::Failed), ("blind", Status::Failed)];
        until("«b» active", || f.states() == states(&[failed.as_slice(), &[("b", Status::Active)]].concat()));
        let error = |m: &str| f.downloads.list().into_iter().find(|d| d.model == m).unwrap().error;
        assert_eq!(error("huge").as_deref(), Some("«huge» does not fit"));
        let blind = tr!(
            "Non riesco a preparare lo scaricamento di «Model blind». Riprova; se succede ancora, segnala il problema.",
            "I can't prepare the download of «Model blind». Try again; if it happens again, report the problem."
        );
        assert_eq!(error("blind"), Some(blind), "the detail goes to the log");
        assert!(f.log.lock().unwrap().iter().any(|l| l.contains("the hardware does not answer")));
        f.go();
        until("«b» arrived", || f.states() == states(&failed));
        assert_eq!(f.arrived(), ["b"]);
        assert_eq!(f.saved(), r#"[{"model":"a","paused":true},{"model":"huge","paused":false},{"model":"blind","paused":false}]"#);
    }

    /// A download asked from the window before the startup took up those of the last time: the file is not written over,
    /// and the saved ones join it.
    #[test]
    fn a_download_asked_before_the_saved_ones_are_taken_up_does_not_lose_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("downloads.json"), r#"[{"model":"a","paused":true}]"#).unwrap();
        let f = fixture_with(Fake::default(), dir);
        f.ask(&["b"]).unwrap();
        assert_eq!(f.saved(), r#"[{"model":"a","paused":true}]"#);
        f.downloads.restore().unwrap();
        assert_eq!(f.saved(), r#"[{"model":"b","paused":false},{"model":"a","paused":true}]"#);
    }

    /// A startup tried again after a failure takes up the downloads if the first one did not get to them,
    /// and only once.
    #[test]
    fn the_downloads_of_the_last_time_are_taken_up_once_also_when_the_startup_is_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        // A file that cannot be read now (here a folder in its place).
        std::fs::create_dir(dir.path().join("downloads.json")).unwrap();
        let f = fixture_with(Fake::default(), dir);
        assert!(f.downloads.restore().is_err());
        std::fs::remove_dir(f._dir.path().join("downloads.json")).unwrap();
        std::fs::write(f._dir.path().join("downloads.json"), r#"[{"model":"a","paused":true}]"#).unwrap();
        f.downloads.restore().unwrap();
        f.downloads.restore().unwrap();
        assert_eq!(f.states(), states(&[("a", Status::Paused)]));
    }

    #[test]
    fn without_a_file_there_is_nothing_to_go_on_with() {
        let f = fixture();
        f.downloads.restore().unwrap();
        assert!(f.states().is_empty());
    }

    fn entry_with(samples: &[(Instant, u64)]) -> Entry {
        let mut e = Entry::new("a", Need { label: "A".into(), engine_bytes: 0, weights_bytes: SIZE }, Status::Active);
        e.samples = samples.iter().copied().collect();
        e
    }

    /// The speed is of the last seconds up to now: it goes down during a stall and is 0 after a whole window without
    /// bytes; bytes that go down (a download started again) give no absurd speed.
    #[test]
    fn the_speed_goes_down_during_a_stall_and_starts_again_when_the_bytes_go_down() {
        let t = Instant::now();
        let e = entry_with(&[(t, 0), (t + Duration::from_secs(1), 4000)]);
        assert_eq!(e.speed(t + Duration::from_secs(1)), 4000);
        assert_eq!(e.speed(t + Duration::from_secs(4)), 1000, "three seconds without bytes");
        assert_eq!(e.speed(t + Duration::from_secs(7)), 0, "a whole window without bytes");

        let mut e = entry_with(&[]);
        e.weights.0 = 900;
        e.sample();
        e.weights.0 = 100;
        e.sample();
        assert_eq!(e.samples.len(), 1, "the samples start again");
        assert!(e.speed(Instant::now() + Duration::from_millis(500)) < 1000);
    }

    // ---------------------------------------------------------------- the real computer

    /// A computer with the real catalogs, no graphics card, the general engine installed for the processor.
    struct RealWorld {
        real: Real,
        _dir: tempfile::TempDir,
    }

    fn real_world() -> RealWorld {
        let dir = tempfile::tempdir().unwrap();
        let launcher = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../launcher");
        let paths = Paths { dist: dir.path().join("dist"), engines: dir.path().join("engines"), models: dir.path().join("models"), opencode: dir.path().join("o"), data: dir.path().join("data") };
        std::fs::create_dir_all(&paths.dist).unwrap();
        for f in ["mango-models.json", "mango-engines.json"] {
            std::fs::copy(launcher.join(f), paths.dist.join(f)).unwrap();
        }
        let engines: serde_json::Value = serde_json::from_str(std::fs::read_to_string(launcher.join("mango-engines.json")).unwrap().trim_start_matches('\u{feff}')).unwrap();
        let exe = paths.engines.join("llamacpp").join(format!("{}-{}", engines["llamacpp"]["version"].as_str().unwrap(), mango_common::Build::Cpu)).join("llama-server.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        let hardware = || Ok(Hardware { gpus: vec![], cpu: engine_cfg::Cpu { name: "Test CPU".into(), cores: 8, avx2: true, avx512: false }, ram_mib: 65_536, nvml_error: None });
        RealWorld { real: Real { paths, hardware }, _dir: dir }
    }

    impl RealWorld {
        fn put(&self, rel: &str) {
            let p = self.real.paths.models.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }

        fn engine_exe(&self) -> PathBuf {
            let dir = self.real.paths.engines.join("llamacpp");
            std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path().join("llama-server.exe")
        }
    }

    const GGUF: &str = "Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf";
    const MMPROJ: &str = "Qwen3.5-4B-GGUF/mmproj-F16.gguf";

    /// What the real computer says a download needs: the files when they are missing, only the engine when the files are
    /// there, nothing when both are there or the model is not in the catalog.
    #[test]
    fn the_real_computer_says_what_a_download_needs() {
        let w = real_world();
        let need = w.real.need("3.5-4b").unwrap();
        assert_eq!((need.label.as_str(), need.engine_bytes), ("Qwen3.5-4B", 0));
        assert!(need.weights_bytes > 1_000_000_000, "{need:?}");

        w.put(GGUF);
        w.put(MMPROJ);
        let present = w.real.need("3.5-4b").unwrap_err();
        assert!(matches!(present.downcast_ref::<NotNeeded>(), Some(NotNeeded::Present(l)) if l == "Qwen3.5-4B"), "{present:#}");

        std::fs::remove_file(w.engine_exe()).unwrap();
        let need = w.real.need("3.5-4b").unwrap();
        assert!(need.engine_bytes > 0 && need.weights_bytes == 0, "{need:?}");

        assert!(matches!(w.real.need("ghost").unwrap_err().downcast_ref::<NotNeeded>(), Some(NotNeeded::NotInCatalog)));
        assert_eq!(w.real.label("3.5-4b"), "Qwen3.5-4B");
    }

    /// «Aggiorna il motore»: an engine is to update when the catalog's version of it is missing (the app came with a new
    /// one), its old version is on the disk and a model on the disk waits for it. One model brings it, with only the
    /// engine in its download, however many wait; Computer names that engine. An engine never installed, or the engine
    /// of another PC in use, updates nothing.
    #[test]
    fn an_engine_to_update_comes_with_one_model_on_the_disk_and_brings_only_the_engine() {
        let w = real_world();
        let hw = (w.real.hardware)().unwrap();
        assert!(engine_cfg::engine_updates(&w.real.paths, &hw).unwrap().is_empty(), "nothing on the disk");
        w.put(GGUF);
        w.put(MMPROJ);
        w.put("Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf");
        assert!(engine_cfg::engine_updates(&w.real.paths, &hw).unwrap().is_empty(), "the engine is there");
        // the models on the disk, as Models lists them: (key, present, waits for the engine, bytes)
        let on_disk = || -> Vec<(String, bool, bool, u64)> {
            let views = engine_cfg::models_view(&w.real.paths, &hw).unwrap();
            views.into_iter().filter(|m| m.key == "3.5-4b" || m.key == "3.5-2b").map(|m| (m.key, m.present, m.waits_engine, m.bytes)).collect()
        };
        let before = on_disk();
        assert!(before.iter().all(|m| m.1 && !m.2), "{before:?}");

        // the version on the disk is no longer the catalog's
        let old = w.engine_exe().parent().unwrap().to_path_buf();
        std::fs::rename(&old, old.with_file_name("0-old-cpu")).unwrap();
        let label = engine_cfg::engine_label("llamacpp", mango_common::Build::Cpu);
        let updates = engine_cfg::engine_updates(&w.real.paths, &hw).unwrap();
        // the download that brings only the engine is named after the engine: its failure says the engine, not the model
        assert_eq!(w.real.need(&updates[0].model).unwrap().label, label);
        let unusable = anyhow::anyhow!("--version").context(EngineUnusable { engine: "llamacpp".into(), build: mango_common::Build::Cpu });
        for e in [anyhow::Error::new(Trouble::Server("503".into())), unusable, anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied))] {
            let sentence = failure(&label, true, &e);
            assert!(sentence.contains(&format!("«{label}»")) && !sentence.contains(&tr!("Il motore di", "The engine of")) && !sentence.contains(&tr!("cartella dei modelli", "models folder")), "{sentence}");
        }
        assert_eq!(updates, [engine_cfg::EngineUpdate { model: updates[0].model.clone(), label: label.clone() }], "one for the engine, not one a model");
        assert!(["3.5-4b", "3.5-2b"].contains(&updates[0].model.as_str()), "{updates:?}");
        let engine = engine_cfg::computer_view(&w.real.paths, &hw).unwrap().engine;
        assert!(engine.update && engine.label == label, "{engine:?}");
        // all the models that wait stay with the models on the computer, with their own weight, not the engine's
        let waiting: Vec<_> = before.iter().map(|m| (m.0.clone(), false, true, m.3)).collect();
        assert_eq!(on_disk(), waiting);
        let need = w.real.need(&updates[0].model).unwrap();
        assert!(need.engine_bytes > 0 && need.weights_bytes == 0, "{need:?}");

        // the engine of another PC in use: this PC's is not updated meanwhile
        std::fs::create_dir_all(&w.real.paths.data).unwrap();
        std::fs::write(w.real.paths.remote_engine(), "{}").unwrap();
        assert!(engine_cfg::engine_updates(&w.real.paths, &hw).unwrap().is_empty(), "another PC's engine in use");
        assert!(!engine_cfg::computer_view(&w.real.paths, &hw).unwrap().engine.update);
        std::fs::remove_file(w.real.paths.remote_engine()).unwrap();

        // never installed: the download of a model brings it, nothing is queued by itself
        std::fs::remove_dir_all(old.with_file_name("0-old-cpu")).unwrap();
        assert!(engine_cfg::engine_updates(&w.real.paths, &hw).unwrap().is_empty(), "no old version on the disk");
        assert!(on_disk().iter().all(|m| !m.1 && !m.2), "they are to download, with their engine");
    }

    /// At the start after an update of the app that brings a new engine: the engine is queued by
    /// itself with one model on the disk that waits for it, and its download says it brings only the engine; one already
    /// among the downloads stays as it is.
    #[test]
    fn at_the_start_the_new_engine_is_queued_with_one_model_and_brings_only_it() {
        let w = real_world();
        let hw = (w.real.hardware)().unwrap();
        w.put(GGUF);
        w.put(MMPROJ);
        w.put("Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf");
        let old = w.engine_exe().parent().unwrap().to_path_buf();
        std::fs::rename(&old, old.with_file_name("0-old-cpu")).unwrap();
        let carrier = engine_cfg::engine_updates(&w.real.paths, &hw).unwrap()[0].model.clone();
        let f = fixture();
        f.fake.arrived.lock().unwrap().insert(carrier.clone(), SIZE);
        f.fake.engine_missing.store(true, Ordering::SeqCst);
        f.fake.hold_engine.store(true, Ordering::SeqCst);
        crate::model_choices::engine_update(&w.real.paths, &hw, &f.downloads).unwrap();
        until("the engine downloading", || f.states() == states(&[(carrier.as_str(), Status::Active)]));
        assert!(f.downloads.list()[0].engine_only, "it brings only the engine");
        f.downloads.pause(&carrier).unwrap();
        crate::model_choices::engine_update(&w.real.paths, &hw, &f.downloads).unwrap();
        assert_eq!(f.states(), states(&[(carrier.as_str(), Status::Paused)]), "a pause stays a pause");
        f.fake.hold_engine.store(false, Ordering::SeqCst);
    }

    /// Queuing several models reads the hardware once (`detect` takes about 60 ms).
    #[test]
    fn the_real_computer_reads_its_hardware_once_for_several_models() {
        static READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let w = real_world();
        let counted = Real {
            paths: w.real.paths.clone(),
            hardware: || {
                READS.fetch_add(1, Ordering::SeqCst);
                Ok(Hardware { gpus: vec![], cpu: engine_cfg::Cpu { name: "Test CPU".into(), cores: 8, avx2: true, avx512: false }, ram_mib: 65_536, nvml_error: None })
            },
        };
        let needs = counted.needs(&["3.5-4b".to_string(), "3.5-2b".to_string()]).unwrap();
        assert_eq!((needs.len(), READS.load(Ordering::SeqCst)), (2, 1));
    }

    #[test]
    fn the_real_computer_deletes_the_partial_files_of_a_cancelled_download() {
        let w = real_world();
        w.put(&format!("{GGUF}.part"));
        w.put(MMPROJ);
        w.real.discard("3.5-4b", &[]).unwrap();
        assert!(!w.real.paths.models.join(format!("{GGUF}.part")).exists());
        assert!(w.real.paths.models.join(MMPROJ).is_file(), "a whole file is not a partial one");
    }
}
