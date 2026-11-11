//! Dictation (the microphone in the chat) is a choice of the user, off until they turn it on, from the first start page
//! or from the settings. Turned on, its models (465 MB) download in the background once the app is ready, with the progress
//! shown where it was turned on, and the service starts when they are there; turned off, the service stops and the models are
//! deleted. Who updates from a version that already had the models finds it on. The state goes to the web UI through the
//! bridge (`dictation.state()` and the `mango-dictation` event).

use crate::bridge::{err, BridgeError};
use anyhow::{bail, Result};
use mango_common::{tr, Paths};
use serde::Serialize;
use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Manager};

const MIB: u64 = 1 << 20;
/// The choice of the user, in the app data.
const FLAG_FILE: &str = "dictation.json";

/// What the manager asks of the computer: the models and the service.
pub trait Backend: Send + Sync + 'static {
    /// Everything the models weigh.
    fn size(&self) -> u64;
    /// The models are all on disk.
    fn complete(&self) -> bool;
    /// This computer can run dictation: said before downloading 465 MB.
    fn check(&self) -> Result<()>;
    /// Downloads what is missing, `progress(bytes so far of size())`; it ends with `Stopped` when `stop` becomes true.
    fn download(&self, stop: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<()>;
    /// Starts the service; dropping the result stops it.
    fn start(&self) -> Result<Box<dyn Any + Send>>;
    /// Deletes the models.
    fn remove(&self) -> Result<()>;
}

#[derive(Debug, PartialEq)]
enum Phase {
    Off,
    /// Bytes downloaded.
    Downloading(u64),
    Ready,
    Failed(String),
}

/// What the web UI shows. `status`: `off`, `waiting` (on, it starts when the app is ready), `downloading`, `ready`, `error`.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub enabled: bool,
    pub status: &'static str,
    pub done_mb: u64,
    pub size_mb: u64,
    pub error: Option<String>,
}

struct Inner {
    phase: Phase,
    enabled: bool,
    /// The app is ready: only then the models are downloaded.
    armed: bool,
    server: Option<Box<dyn Any + Send>>,
    /// Ends the run that downloads and starts; a new run or switching off sets it.
    stop: Arc<AtomicBool>,
    /// The last run. The next one waits for it: two must never work on the same files.
    worker: Option<JoinHandle<()>>,
}

struct Shared {
    backend: Box<dyn Backend>,
    flag: PathBuf,
    notify: Box<dyn Fn(&State) + Send + Sync>,
    inner: Mutex<Inner>,
}

pub struct Dictation {
    shared: Arc<Shared>,
    /// Where the agent finds the service (always the same for the whole run of the app).
    pub url: String,
}

impl Dictation {
    pub fn new(backend: impl Backend, data: &Path, url: String, notify: impl Fn(&State) + Send + Sync + 'static) -> Dictation {
        let flag = data.join(FLAG_FILE);
        let enabled = read_flag(&flag).unwrap_or_else(|| backend.complete());
        let inner = Inner { phase: Phase::Off, enabled, armed: false, server: None, stop: Arc::default(), worker: None };
        Dictation { shared: Arc::new(Shared { backend: Box::new(backend), flag, notify: Box::new(notify), inner: Mutex::new(inner) }), url }
    }

    pub fn state(&self) -> State {
        self.shared.state(&self.shared.inner.lock().unwrap())
    }

    /// The user's choice: it is saved, and if the app is ready it takes effect. On again after an error tries again.
    pub fn set_enabled(&self, on: bool) -> Result<State> {
        mango_common::write_atomic(&self.shared.flag, serde_json::json!({ "enabled": on }).to_string())
            .map_err(|e| anyhow::anyhow!("{}: {e}", self.shared.flag.display()))?;
        let mut inner = self.shared.inner.lock().unwrap();
        inner.enabled = on;
        if on {
            if inner.armed && matches!(inner.phase, Phase::Off | Phase::Failed(_)) {
                self.shared.begin(&mut inner);
            }
        } else {
            self.shared.switch_off(&mut inner);
        }
        Ok(self.shared.state(&inner))
    }

    /// The app is ready: what the user turned on starts.
    pub fn arm(&self) {
        let mut inner = self.shared.inner.lock().unwrap();
        inner.armed = true;
        if inner.enabled && matches!(inner.phase, Phase::Off | Phase::Failed(_)) {
            self.shared.begin(&mut inner);
        }
    }

    /// The app is closing: the service stops, a download in progress ends.
    pub fn shutdown(&self) {
        let server = {
            let mut inner = self.shared.inner.lock().unwrap();
            inner.stop.store(true, Ordering::Relaxed);
            inner.server.take()
        };
        drop(server);
    }
}

impl Shared {
    fn state(&self, inner: &Inner) -> State {
        let size = self.backend.size();
        let (status, done, error) = match &inner.phase {
            Phase::Off if inner.enabled => ("waiting", 0, None),
            Phase::Off => ("off", 0, None),
            Phase::Downloading(done) => ("downloading", *done, None),
            Phase::Ready => ("ready", size, None),
            Phase::Failed(e) => ("error", 0, Some(e.clone())),
        };
        State { enabled: inner.enabled, status, done_mb: done / MIB, size_mb: size / MIB, error }
    }

    /// Download what is missing and start the service, in a thread of its own.
    fn begin(self: &Arc<Self>, inner: &mut Inner) {
        inner.stop.store(true, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        inner.stop = stop.clone();
        inner.phase = Phase::Downloading(if self.backend.complete() { self.backend.size() } else { 0 });
        let previous = inner.worker.take();
        let shared = self.clone();
        inner.worker = Some(std::thread::spawn(move || {
            if let Some(previous) = previous {
                let _ = previous.join();
            }
            shared.run(&stop);
        }));
        (self.notify)(&self.state(inner));
    }

    fn run(&self, stop: &AtomicBool) {
        let outcome = self.prepare(stop);
        let mut inner = self.inner.lock().unwrap();
        // Turned off, or started again, meanwhile: whoever did it has the last word and a service just started is dropped.
        if stop.load(Ordering::Relaxed) {
            return;
        }
        match outcome {
            Ok(server) => {
                inner.server = Some(server);
                inner.phase = Phase::Ready;
            }
            Err(e) => {
                eprintln!("dictation off: {e:#}");
                inner.phase = Phase::Failed(format!("{e:#}"));
            }
        }
        let state = self.state(&inner);
        drop(inner);
        (self.notify)(&state);
    }

    fn prepare(&self, stop: &AtomicBool) -> Result<Box<dyn Any + Send>> {
        self.backend.check()?;
        if !self.backend.complete() {
            self.backend.download(stop, &mut |done| self.progress(stop, done))?;
        }
        if stop.load(Ordering::Relaxed) {
            bail!("stopped");
        }
        self.backend.start()
    }

    fn progress(&self, stop: &AtomicBool, done: u64) {
        let mut inner = self.inner.lock().unwrap();
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if let Phase::Downloading(before) = inner.phase {
            if before / MIB != done / MIB {
                inner.phase = Phase::Downloading(done);
                let state = self.state(&inner);
                drop(inner);
                (self.notify)(&state);
            }
        }
    }

    /// The service stops and the models go, after the last run is over; the state is off at once.
    fn switch_off(self: &Arc<Self>, inner: &mut Inner) {
        inner.stop.store(true, Ordering::Relaxed);
        inner.phase = Phase::Off;
        let server = inner.server.take();
        let previous = inner.worker.take();
        let shared = self.clone();
        let stop = inner.stop.clone();
        inner.worker = Some(std::thread::spawn(move || {
            drop(server);
            if let Some(previous) = previous {
                let _ = previous.join();
            }
            if let Err(e) = shared.backend.remove() {
                let mut inner = shared.inner.lock().unwrap();
                // Not if the user has already turned it on again: that run is a newer one.
                if Arc::ptr_eq(&inner.stop, &stop) {
                    inner.phase = Phase::Failed(format!("{e:#}"));
                    let state = shared.state(&inner);
                    drop(inner);
                    (shared.notify)(&state);
                }
            }
        }));
        (self.notify)(&self.state(inner));
    }
}

/// The saved choice, or none if the user has not made it (or the file cannot be read).
fn read_flag(file: &Path) -> Option<bool> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("enabled")?.as_bool()
}

// ---------------------------------------------------------------- the real service

struct Voice {
    paths: Paths,
    port: u16,
}

impl Backend for Voice {
    fn size(&self) -> u64 {
        voice::FILES.iter().map(|f| f.size).sum()
    }

    fn complete(&self) -> bool {
        voice::missing_files(&voice::models_dir(&self.paths)).is_empty()
    }

    fn check(&self) -> Result<()> {
        voice::require_cpu_features()
    }

    fn download(&self, stop: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<()> {
        let dir = voice::models_dir(&self.paths);
        std::fs::create_dir_all(&dir)?;
        let mut before = 0;
        for file in voice::missing_files(&dir) {
            voice::download(file, &dir, stop, &mut |done, _| progress(before + done))?;
            before += file.size;
        }
        Ok(())
    }

    fn start(&self) -> Result<Box<dyn Any + Send>> {
        Ok(Box::new(voice::start(&voice::model_path(&self.paths), self.port)?))
    }

    fn remove(&self) -> Result<()> {
        remove_dir(&voice::models_dir(&self.paths))
    }
}

fn remove_dir(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            bail!("{}", tr!("Non riesco a eliminare la dettatura da {}: {e}", "Cannot delete the dictation from {}: {e}", dir.display()))
        }
        _ => Ok(()),
    }
}

/// Development builds: `MANGO_DICTATION_FAKE=<MiB per second>` downloads nothing and starts nothing, it only takes the time
/// of a download and leaves a file to say it is done, so the tests and the pictures need neither network nor model.
#[cfg(debug_assertions)]
struct Pretend {
    dir: PathBuf,
    mib_per_second: u64,
}

#[cfg(debug_assertions)]
impl Backend for Pretend {
    fn size(&self) -> u64 {
        voice::FILES.iter().map(|f| f.size).sum()
    }

    fn complete(&self) -> bool {
        self.dir.join("done").is_file()
    }

    fn check(&self) -> Result<()> {
        Ok(())
    }

    fn download(&self, stop: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut done = 0;
        while done < self.size() {
            if stop.load(Ordering::Relaxed) {
                return Err(mango_common::download::Stopped.into());
            }
            std::thread::sleep(std::time::Duration::from_millis(1000 / self.mib_per_second.max(1)));
            done += MIB;
            progress(done);
        }
        std::fs::write(self.dir.join("done"), "")?;
        Ok(())
    }

    fn start(&self) -> Result<Box<dyn Any + Send>> {
        Ok(Box::new(()))
    }

    fn remove(&self) -> Result<()> {
        remove_dir(&self.dir)
    }
}

/// The manager of this run, with the service on `port`. Before the first start page, so the page can already ask.
pub fn install(app: &AppHandle, paths: &Paths, port: u16) {
    let state = app.state::<crate::AppState>();
    let url = format!("http://127.0.0.1:{port}");
    let tell = app.clone();
    let notify = move |s: &State| {
        if let (Some(window), Ok(detail)) = (crate::main_window(&tell), serde_json::to_string(s)) {
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('mango-dictation',{{detail:{detail}}}))"));
        }
    };
    #[cfg(debug_assertions)]
    if let Some(mib_per_second) = std::env::var("MANGO_DICTATION_FAKE").ok().and_then(|v| v.parse().ok()) {
        let _ = state.dictation.set(Dictation::new(Pretend { dir: voice::models_dir(paths), mib_per_second }, &paths.data, url, notify));
        return;
    }
    let _ = state.dictation.set(Dictation::new(Voice { paths: paths.clone(), port }, &paths.data, url, notify));
}

fn service(app: &AppHandle) -> Result<&Dictation, BridgeError> {
    app.state::<crate::AppState>().inner().dictation.get().ok_or_else(|| err("unavailable", tr!("l'app non è ancora pronta", "the app is not ready yet")))
}

#[tauri::command]
pub fn dictation_state(app: AppHandle) -> Result<State, BridgeError> {
    Ok(service(&app)?.state())
}

#[tauri::command]
pub fn dictation_set_enabled(app: AppHandle, enabled: bool) -> Result<State, BridgeError> {
    service(&app)?.set_enabled(enabled).map_err(|e| err("io", format!("{e:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Test {
        have: AtomicBool,
        /// The download goes on until it is stopped or this is cleared.
        hold: AtomicBool,
        fail: Mutex<Option<String>>,
        downloads: AtomicUsize,
        removals: AtomicUsize,
        running: Arc<AtomicUsize>,
    }

    struct Service(Arc<AtomicUsize>);

    impl Drop for Service {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl Backend for Arc<Test> {
        fn size(&self) -> u64 {
            465 * MIB
        }
        fn complete(&self) -> bool {
            self.have.load(Ordering::SeqCst)
        }
        fn check(&self) -> Result<()> {
            Ok(())
        }
        fn download(&self, stop: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<()> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            if let Some(e) = self.fail.lock().unwrap().clone() {
                bail!("{e}");
            }
            progress(10 * MIB);
            while self.hold.load(Ordering::SeqCst) {
                if stop.load(Ordering::SeqCst) {
                    return Err(mango_common::download::Stopped.into());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            self.have.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn start(&self) -> Result<Box<dyn Any + Send>> {
            self.running.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Service(self.running.clone())))
        }
        fn remove(&self) -> Result<()> {
            self.have.store(false, Ordering::SeqCst);
            self.removals.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn manager(backend: &Arc<Test>, data: &Path) -> Dictation {
        Dictation::new(backend.clone(), data, "http://127.0.0.1:4097".into(), |_| {})
    }

    fn data(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-dictation-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn until(what: &str, mut condition: impl FnMut() -> bool) {
        let start = Instant::now();
        while !condition() {
            assert!(start.elapsed() < Duration::from_secs(5), "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn it_is_off_until_the_user_turns_it_on_and_who_updates_with_the_models_finds_it_on() {
        let none = Arc::new(Test::default());
        assert!(!manager(&none, &data("fresh")).state().enabled, "a new installation does not download the dictation");

        let updated = Arc::new(Test::default());
        updated.have.store(true, Ordering::SeqCst);
        let d = manager(&updated, &data("updated"));
        assert!(d.state().enabled, "the update that already had the models keeps the dictation");
        d.arm();
        until("starts without downloading", || d.state().status == "ready");
        assert_eq!(updated.downloads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn turned_on_it_downloads_in_the_background_once_the_app_is_ready_then_starts() {
        let test = Arc::new(Test::default());
        test.hold.store(true, Ordering::SeqCst);
        let d = manager(&test, &data("on"));

        let state = d.set_enabled(true).unwrap();
        assert_eq!((state.enabled, state.status), (true, "waiting"));
        assert_eq!(test.downloads.load(Ordering::SeqCst), 0, "nothing downloads before the app is ready");

        d.arm();
        until("downloading", || d.state().status == "downloading" && d.state().done_mb == 10);
        assert_eq!(d.state().size_mb, 465);
        test.hold.store(false, Ordering::SeqCst);
        until("ready", || d.state().status == "ready");
        assert_eq!((test.downloads.load(Ordering::SeqCst), test.running.load(Ordering::SeqCst)), (1, 1));
    }

    #[test]
    fn turned_off_while_downloading_it_stops_at_once_and_deletes_what_was_downloaded() {
        let test = Arc::new(Test::default());
        test.hold.store(true, Ordering::SeqCst);
        let d = manager(&test, &data("off-downloading"));
        d.arm();
        d.set_enabled(true).unwrap();
        until("downloading", || d.state().status == "downloading");

        assert_eq!(d.set_enabled(false).unwrap().status, "off");
        until("deleted", || test.removals.load(Ordering::SeqCst) == 1);
        assert_eq!(test.running.load(Ordering::SeqCst), 0);

        test.hold.store(false, Ordering::SeqCst);
        d.set_enabled(true).unwrap();
        until("ready again", || d.state().status == "ready");
    }

    #[test]
    fn turned_off_when_ready_the_service_stops_and_the_space_comes_back() {
        let test = Arc::new(Test::default());
        let d = manager(&test, &data("off-ready"));
        d.arm();
        d.set_enabled(true).unwrap();
        until("ready", || d.state().status == "ready");

        d.set_enabled(false).unwrap();
        until("deleted", || test.removals.load(Ordering::SeqCst) == 1);
        assert_eq!((test.running.load(Ordering::SeqCst), test.complete()), (0, false));
    }

    #[test]
    fn the_choice_survives_a_restart_of_the_app() {
        let test = Arc::new(Test::default());
        let dir = data("restart");
        manager(&test, &dir).set_enabled(true).unwrap();
        assert!(manager(&test, &dir).state().enabled);

        test.have.store(true, Ordering::SeqCst);
        manager(&test, &dir).set_enabled(false).unwrap();
        let d = manager(&test, &dir);
        d.arm();
        assert!(!d.state().enabled, "off stays off even if the models are still there");
        assert_eq!(test.running.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_error_is_told_and_turning_it_on_again_tries_again() {
        let test = Arc::new(Test::default());
        *test.fail.lock().unwrap() = Some("no network".into());
        let d = manager(&test, &data("error"));
        d.arm();
        d.set_enabled(true).unwrap();
        until("error", || d.state().status == "error");
        assert_eq!(d.state().error.as_deref(), Some("no network"));

        *test.fail.lock().unwrap() = None;
        d.set_enabled(true).unwrap();
        until("ready", || d.state().status == "ready");
        assert_eq!(d.state().error, None);
    }
}
