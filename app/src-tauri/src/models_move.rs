//! Where the models are kept, from the settings: what moving them to another folder would do (`models_dir_preview`), moving
//! them (`models_dir_move`), using a folder that already has files as it is (`models_dir_use`), and the choice as it stands
//! now (`models_dir_state`). The work is `mango_common::models_dir`; this is what the app does around it.
//!
//! A move stops everything that uses the folder, as taking a model off the computer does (`model_choices::take_off`): the
//! engine and the pictures, the downloads (held, not paused), the dictation and the watch of the folder. When the choice is
//! written the app starts again by itself (`helper.rs`), since every part of it has the old folder in memory; if something
//! stayed in the old folder (a link that holds models, a file a program had open) it waits in `Moved` until the user has
//! seen it and asks to start again (`models_dir_restart`). A move that is cancelled or fails gives all of that back and the
//! old folder goes on; one whose choice is written gives nothing back, whatever happens next, since the app has the old folder
//! in memory: it starts again, or waits for the user to. The interface hears of it with the event `mango-models-dir` on the
//! window, whose detail is the `MoveState`: the end of the last move stays in `models_dir_state` until the next one begins.

use crate::bridge::BridgeError;
use crate::downloads::{blocking, Hold};
use crate::AppState;
use anyhow::{bail, Context, Result};
use engine::StartBlock;
use mango_common::models_dir::journal;
use mango_common::models_dir::owned::Owned;
use mango_common::models_dir::place;
use mango_common::models_dir::relocate::{self, Cancelled, Job, Preview, Progress};
use mango_common::models_dir::{self, Cancel};
use mango_common::{tr, user_text, Paths};
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Where a move is, as the interface is told.
#[derive(Clone, Serialize, Default, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MoveState {
    #[default]
    Idle,
    /// Stopping the engine, the downloads and the rest, then copying: `progress` is there from the first file on.
    Moving { to: String, model: Option<String>, progress: Option<Progress> },
    /// A model's files are where they were asked to be.
    Done { model: String },
    /// The models are in the new folder and the choice is written; `left` is what stayed in the old folder, `reason` the
    /// sentence when the app could not start again by itself. The app waits here until the user has seen it and asks to start
    /// again.
    Moved {
        left: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// The app is starting again on the new folder.
    Restarting,
    /// It did not happen and the old folder is still the models folder; `message` is the sentence to show.
    Failed { message: String },
    Cancelled,
}

impl MoveState {
    /// A move is under way, or done and waiting for the app to start again: no other can begin.
    fn busy(&self) -> bool {
        matches!(self, MoveState::Moving { .. } | MoveState::Moved { .. } | MoveState::Restarting)
    }
}

/// How long the end of the app waits for a move to stop.
const QUIT_WAIT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Mover {
    state: Mutex<MoveState>,
    /// Told at every change of the state: the end of the app waits for a move to stop.
    changed: Condvar,
    cancel: Cancel,
    /// The app is ending: what a move stopped is kept, not given back, it would only be stopped again. It goes on being
    /// true until `resume`.
    quitting: AtomicBool,
    kept: Mutex<Vec<Kept>>,
}

/// What a move stopped, put aside instead of given back.
struct Kept {
    /// The choice of the move is written: the app is about to start again and nothing is given back.
    for_good: bool,
    give_back: Box<dyn FnOnce() + Send>,
}

impl Mover {
    fn set(&self, app: &AppHandle, state: MoveState) {
        self.set_quietly(state.clone());
        if let (Some(window), Ok(detail)) = (crate::main_window(app), serde_json::to_string(&state)) {
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('mango-models-dir',{{detail:{detail}}}))"));
        }
    }

    fn set_quietly(&self, state: MoveState) {
        *self.state.lock().unwrap() = state;
        self.changed.notify_all();
    }

    /// The app is ending (the end of the app, an update being installed): no move begins from now on, and one under way is
    /// asked to stop. Says whether there is one to wait for (`wait_stopped`): only the first time, so that the end of the app
    /// asked again after the wait ran out does not wait again.
    pub fn ask_to_quit(&self) -> bool {
        let asked_before = self.quitting.swap(true, Ordering::SeqCst);
        let moving = matches!(*self.state.lock().unwrap(), MoveState::Moving { .. });
        if moving {
            self.cancel.request();
        }
        moving && !asked_before
    }

    /// Waits for the move asked to stop to be over, a while at most: one that has written the choice cannot stop and is waited
    /// for as well; if it is not over in time the app ends anyway and the next start finishes it (`journal::recover`).
    pub fn wait_stopped(&self) {
        let state = self.state.lock().unwrap();
        drop(self.changed.wait_timeout_while(state, QUIT_WAIT, |s| matches!(s, MoveState::Moving { .. })).unwrap());
    }

    pub fn quit(&self) {
        if self.ask_to_quit() {
            self.wait_stopped();
        }
    }

    /// The app goes on after it was asked to end (an installer that did not start): what moves stopped meanwhile goes back to
    /// work. What a move whose choice is written stopped stays stopped.
    pub fn resume(&self) {
        self.quitting.store(false, Ordering::SeqCst);
        let (for_good, to_give): (Vec<Kept>, Vec<Kept>) = std::mem::take(&mut *self.kept.lock().unwrap()).into_iter().partition(|k| k.for_good);
        self.kept.lock().unwrap().extend(for_good);
        to_give.into_iter().for_each(|k| (k.give_back)());
    }

    /// A move is over with what it stopped: it goes back to work (`give_back`), except when the choice of a move of the whole
    /// folder is written (for good) or the app is ending (until `resume`).
    fn finish(&self, folder: bool, give_back: impl FnOnce() + Send + 'static) {
        let for_good = folder && self.cancel.committed();
        match for_good || self.quitting.load(Ordering::SeqCst) {
            true => self.kept.lock().unwrap().push(Kept { for_good, give_back: Box::new(give_back) }),
            false => give_back(),
        }
    }

    /// Takes the turn to move: checked and taken in one hold of the lock, so that of two requests only one passes.
    fn take(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if self.quitting.load(Ordering::SeqCst) {
            bail!("{}", tr!("Mango Code si sta chiudendo.", "Mango Code is closing."));
        }
        if state.busy() {
            bail!("{}", tr!("Il cambio di cartella è già in corso.", "The folder is already being changed."));
        }
        self.cancel.reset();
        *state = MoveState::Moving { to: String::new(), model: None, progress: None };
        Ok(())
    }

    /// Asks the move in progress to stop, at the next block; an error when there is none or the choice is written.
    fn ask_to_stop(&self) -> Result<()> {
        let too_late = || anyhow::anyhow!("{}", tr!("Non si può più annullare: la scelta è già scritta.", "It can no longer be cancelled: the choice is already written."));
        match *self.state.lock().unwrap() {
            MoveState::Moving { .. } => {}
            MoveState::Moved { .. } | MoveState::Restarting => return Err(too_late()),
            _ => bail!("{}", tr!("Nessuno spostamento in corso.", "No move in progress.")),
        }
        self.cancel.request().then_some(()).ok_or_else(too_late)
    }

    /// The turn to start again of a move that is done: taken once, and it says what stayed behind.
    fn take_moved(&self) -> Result<Vec<String>> {
        let mut state = self.state.lock().unwrap();
        match &*state {
            MoveState::Moved { left, .. } => {
                let left = left.clone();
                *state = MoveState::Restarting;
                Ok(left)
            }
            _ => bail!("{}", tr!("Nessuno spostamento da concludere.", "No move to finish.")),
        }
    }
}

/// The turn to move, taken before anything is looked at, so that two requests cannot both pass: from here on the state says
/// a move is under way. Dropped without `begin` (the request was refused, or failed before the work started) it gives the
/// turn back.
struct Turn {
    app: AppHandle,
    taken: bool,
}

impl Turn {
    fn take(app: &AppHandle) -> Result<Turn> {
        app.state::<AppState>().models_move.take()?;
        Ok(Turn { app: app.clone(), taken: true })
    }

    /// The choice is written without a thread (a folder used as it is): the turn is not given back, `leave` says where it ends.
    fn keep(mut self) {
        self.taken = false;
    }

    /// Starts the work of the move in a thread and tells how it ends: a move that is cancelled or fails, or whose thread
    /// panics, leaves things as they were.
    fn begin(self, paths: Paths, to: String, model: Option<String>, work: impl FnOnce(&AppHandle, &Paths) -> Result<MoveState> + Send + 'static) {
        let app = self.app.clone();
        self.keep();
        let folder = model.is_none();
        app.state::<AppState>().models_move.set(&app, MoveState::Moving { to, model, progress: None });
        std::thread::spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(|| work(&app, &paths)));
            let mover = &app.state::<AppState>().models_move;
            let end = ended(outcome, folder && mover.cancel.committed(), |line| crate::startup_log(&paths, line));
            mover.set(&app, end);
        });
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if self.taken {
            self.app.state::<AppState>().models_move.set_quietly(MoveState::Idle);
        }
    }
}

/// How a move's thread ended, as the state to tell: a panic is a move that stopped (what the thread held is given back as it
/// unwinds), and says so. Once the choice is written (`committed`) the old folder does not go on whatever happened after: the
/// move is `Moved`, with the sentence, and waits for the app to be started again.
fn ended(outcome: std::thread::Result<Result<MoveState>>, committed: bool, log: impl Fn(&str)) -> MoveState {
    match outcome {
        Ok(Ok(state)) => state,
        Ok(Err(e)) if e.is::<Cancelled>() => {
            log("models: the move was cancelled");
            MoveState::Cancelled
        }
        Ok(Err(e)) => {
            log(&format!("models: the move failed: {e:#}"));
            match committed {
                true => MoveState::Moved { left: Vec::new(), reason: Some(mango_common::user_phrase(&e)) },
                false => MoveState::Failed { message: mango_common::user_phrase(&e) },
            }
        }
        Err(panic) => {
            let why = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            log(&format!("models: the move stopped on an internal error: {why}"));
            match committed {
                true => MoveState::Moved {
                    left: Vec::new(),
                    reason: Some(tr!(
                        "La cartella dei modelli è cambiata, ma lo spostamento si è fermato per un errore interno. Chiudi e riapri Mango Code.",
                        "The models folder has changed, but the move stopped on an internal error. Close and open Mango Code."
                    )),
                },
                false => MoveState::Failed {
                    message: tr!(
                        "Lo spostamento si è fermato per un errore interno. Chiudi e riapri Mango Code: uno spostamento interrotto si conclude o si annulla all'avvio.",
                        "The move stopped on an internal error. Close and open Mango Code: an interrupted move is finished or put back when it starts."
                    ),
                },
            }
        }
    }
}

/// How often the interface hears of the progress of a copy.
const TELL_EVERY: Duration = Duration::from_millis(250);

/// The choice as it stands: where the models are, where they are without a choice, whether the user chose the folder, and
/// whether the installation fixes it (then it cannot be chosen), and the move in progress.
#[derive(Serialize)]
pub struct Info {
    pub path: PathBuf,
    pub default_path: PathBuf,
    pub chosen: bool,
    pub pinned: bool,
    pub moving: MoveState,
}

fn paths(app: &AppHandle) -> Result<Paths> {
    app.state::<AppState>().paths.get().cloned().with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))
}

/// What in the models folder is Mango Code's own: the files of the catalog's models and of the user's, and the dictation's.
fn owned(paths: &Paths) -> Result<Owned> {
    let dictation: Vec<PathBuf> = voice::FILES.iter().map(|f| Path::new("whisper").join(f.name)).collect();
    Owned::of(paths, &paths.models, &dictation)
}

/// The folders are the user's to choose, unless the installation fixes the models folder.
fn free_to_choose(paths: &Paths) -> Result<()> {
    if models_dir::pinned(&paths.dist)? {
        bail!(
            "{}",
            tr!("Su questo computer la cartella dei modelli è fissata dall'installazione: non si può cambiare da qui.", "On this computer the installation fixes the models folder: it cannot be changed from here.")
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn models_dir_state(app: AppHandle) -> Result<Info, BridgeError> {
    blocking(app, |app| {
        let paths = paths(app)?;
        Ok(Info {
            default_path: models_dir::default_dir(&paths.data),
            chosen: models_dir::chosen(&paths.data)?.is_some(),
            pinned: models_dir::pinned(&paths.dist)?,
            moving: app.state::<AppState>().models_move.state.lock().unwrap().clone(),
            path: paths.models,
        })
    })
    .await
}

/// What moving the models to `dir` would do; nothing changes.
#[tauri::command]
pub async fn models_dir_preview(app: AppHandle, dir: String) -> Result<Preview, BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        free_to_choose(&paths)?;
        relocate::preview(&paths.models, &PathBuf::from(dir), &owned(&paths)?)
    })
    .await
}

/// Moves the models to `dir` and starts the app again on it. It answers as soon as the move has begun; the progress and
/// the end arrive as `mango-models-dir`.
#[tauri::command]
pub async fn models_dir_move(app: AppHandle, dir: String) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        free_to_choose(&paths)?;
        let turn = Turn::take(app)?;
        let owned = owned(&paths)?;
        let found = relocate::preview(&paths.models, &PathBuf::from(dir), &owned)?;
        if let Some(why) = found.refusal.or(found.move_refusal) {
            bail!("{why}");
        }
        turn.begin(paths, found.to.display().to_string(), None, move |app, paths| run(app, paths, &owned, &found.to));
        Ok(())
    })
    .await
}

/// What putting one model's files in a folder would do (without a folder: back in the models folder); nothing changes.
#[tauri::command]
pub async fn model_place_preview(app: AppHandle, key: String, dir: Option<String>) -> Result<place::Preview, BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        place::preview(&paths, &place::plan(&paths, &key, dir.as_deref().map(Path::new))?)
    })
    .await
}

/// Puts one model's files (with their notes and partial downloads) in `dir`, or back in the models folder without one, and
/// remembers where they are: the model starts, downloads and is removed there. It answers as soon as it has begun; the
/// progress and the end arrive as `mango-models-dir`, and the app does not start again.
#[tauri::command]
pub async fn model_place_move(app: AppHandle, key: String, dir: Option<String>) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        let turn = Turn::take(app)?;
        let plan = place::plan(&paths, &key, dir.as_deref().map(Path::new))?;
        let found = place::preview(&paths, &plan)?;
        if let Some(why) = found.refusal.or(found.move_refusal) {
            bail!("{why}");
        }
        let to = dir.unwrap_or_else(|| paths.models.display().to_string());
        turn.begin(paths, to, Some(key.clone()), move |app, paths| run_model(app, paths, &key, &plan));
        Ok(())
    })
    .await
}

/// Uses `dir`, a folder that has files of its own, as the models folder, as it is, and starts the app again on it.
#[tauri::command]
pub async fn models_dir_use(app: AppHandle, dir: String) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        free_to_choose(&paths)?;
        let turn = Turn::take(app)?;
        let to = PathBuf::from(dir);
        let owned = owned(&paths)?;
        if let Some(why) = relocate::preview(&paths.models, &to, &owned)?.refusal {
            bail!("{why}");
        }
        let _quiet = Quiet::new(app, &paths, None)?;
        // The choice is written at once: from here there is nothing left to cancel.
        let mover = &app.state::<AppState>().models_move;
        if !mover.cancel.commit() {
            return Err(Cancelled.into());
        }
        if let Err(e) = relocate::use_folder(Job { data: &paths.data, from: &paths.models, to: &to, owned: &owned }) {
            mover.cancel.reset();
            return Err(e);
        }
        crate::startup_log(&paths, &format!("models folder: {} is now the models folder, used as it is", to.display()));
        turn.keep();
        leave(app, Vec::new())
    })
    .await
}

/// Starts the app again on the new folder, after a move that left something behind (`Moved`): the user has seen what.
#[tauri::command]
pub async fn models_dir_restart(app: AppHandle) -> Result<(), BridgeError> {
    blocking(app, |app| {
        let left = app.state::<AppState>().models_move.take_moved()?;
        leave(app, left)
    })
    .await
}

/// Cancels the move in progress, at the next block; a move that has written the choice is done and cannot be.
#[tauri::command]
pub async fn models_dir_cancel(app: AppHandle) -> Result<(), BridgeError> {
    blocking(app, |app| {
        app.state::<AppState>().models_move.ask_to_stop()
    })
    .await
}

/// The app starts again by itself, on the folder just chosen. If it cannot, the move stays `Moved` (with `left`), so that
/// nothing else moves from the folder that is in memory, and the user is told to close and open the app.
fn leave(app: &AppHandle, left: Vec<String>) -> Result<()> {
    let mover = &app.state::<AppState>().models_move;
    let args: Vec<String> = crate::service_mode().then(|| "--service".to_string()).into_iter().collect();
    let placement = match crate::helper::relaunch_after_exit(&args) {
        Ok(placement) => placement,
        Err(e) => {
            let reason = tr!("La cartella è cambiata, ma l'app non riesce a riaprirsi da sola: chiudila e riaprila.", "The folder has changed, but the app cannot start again by itself: close it and open it again.");
            mover.set(app, MoveState::Moved { left, reason: Some(reason.clone()) });
            return Err(anyhow::Error::new(e).context(user_text(&reason, "relaunch helper")));
        }
    };
    mover.set(app, MoveState::Restarting);
    // As with «Quit»: what the page still holds, the agent and the engine first, then the app ends and the helper starts
    // it again. Every caller runs off the window's thread, which delivers the page's answer.
    crate::ui_state::flush_page(app);
    crate::stop_children(app);
    if placement == crate::helper::Placement::InTheJob {
        if let Some(sup) = app.state::<AppState>().sup.get() {
            if let Err(e) = sup.let_go() {
                crate::startup_log(&paths(app)?, &format!("models folder: the job could not be let go: {e:#}"));
            }
        }
    }
    app.exit(0);
    Ok(())
}

/// What a move stopped, given back as it goes (`Mover::finish` says whether it is).
struct Quiet {
    app: AppHandle,
    paths: Paths,
    starts: Vec<StartBlock>,
    retired: Vec<images::Retired>,
    hold: Option<Hold>,
    /// The model the engine had, to load it again.
    model: Option<String>,
    unloaded: bool,
    dictation_stopped: bool,
    /// It stopped what uses the whole folder, not one model's files.
    folder: bool,
}

impl Quiet {
    /// Stops what uses the models folder, or only `model` (one model's files: its pictures, its engine if it runs it, and the
    /// downloads). A model that is loading or answering is stopped, as `take_off` does for the one
    /// it takes off; the downloads stop where they are.
    fn new(app: &AppHandle, paths: &Paths, only: Option<&str>) -> Result<Quiet> {
        let st = app.state::<AppState>();
        let catalog = mango_common::catalog::read(paths)?;
        let keys: Vec<String> = match only {
            Some(model) => vec![model.to_string()],
            None => catalog.root["models"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default(),
        };
        let pictures: Vec<&String> = keys.iter().filter(|k| catalog.root["models"][k.as_str()].get("image").is_some()).collect();
        let mut quiet = Quiet {
            app: app.clone(),
            paths: paths.clone(),
            starts: Vec::new(),
            retired: Vec::new(),
            hold: None,
            model: st.engine.get().and_then(|e| e.state().model),
            unloaded: false,
            dictation_stopped: false,
            folder: only.is_none(),
        };
        if let Some(engine) = st.engine.get() {
            quiet.starts = keys.iter().map(|k| engine.block_starts(k)).collect();
            let state = engine.state();
            if only.is_none_or(|m| state.model.as_deref() == Some(m) || state.chosen.as_deref() == Some(m)) {
                engine.unload();
                quiet.unloaded = true;
            }
        }
        if let Some(images) = st.images.get() {
            for key in pictures {
                quiet.retired.push(images.retire(key)?);
            }
            images.manager().unload();
        }
        quiet.hold = st.downloads.get().map(|d| d.hold()).transpose()?;
        if only.is_none() {
            if let Some(dictation) = st.dictation.get() {
                dictation.shutdown();
                quiet.dictation_stopped = true;
            }
            st.models_watch.lock().unwrap().suspend();
        }
        Ok(quiet)
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        let (app, paths, folder) = (self.app.clone(), self.paths.clone(), self.folder);
        let (starts, retired, hold) = (std::mem::take(&mut self.starts), std::mem::take(&mut self.retired), self.hold.take());
        let (model, unloaded, dictation_stopped) = (self.model.take(), self.unloaded, self.dictation_stopped);
        let give_back = move || {
            drop((starts, retired, hold));
            let st = app.state::<AppState>();
            if folder {
                st.models_watch.lock().unwrap().resume();
                crate::watch_models(&app, &paths);
            }
            if let Some(dictation) = st.dictation.get().filter(|_| dictation_stopped) {
                dictation.resume();
            }
            if let (Some(engine), Some(model), true) = (st.engine.get(), &model, unloaded) {
                engine.choose(model);
            }
        };
        self.app.state::<AppState>().models_move.finish(folder, give_back);
    }
}

/// A move left half done by an app that was ended, finished or put back from its journal at the start. It takes the turn, so
/// that no move begins meanwhile; a move already under way (the app starting again during one) has nothing to recover.
pub(crate) fn recover_interrupted(app: &AppHandle, paths: &Paths) -> Result<Option<String>> {
    if journal::read(&paths.data)?.is_none() {
        return Ok(None);
    }
    let Ok(_turn) = Turn::take(app) else { return Ok(None) };
    journal::recover(&paths.data)
}

/// The move, from the stopping to the choice written. An error is a move that did not happen. When something stayed in the old
/// folder the user is told first (`Moved`); otherwise the app starts again at once.
fn run(app: &AppHandle, paths: &Paths, owned: &Owned, to: &Path) -> Result<MoveState> {
    let mover = &app.state::<AppState>().models_move;
    let _quiet = Quiet::new(app, paths, None)?;
    let job = Job { data: &paths.data, from: &paths.models, to, owned };
    crate::startup_log(paths, &format!("models folder: moving {} to {}", paths.models.display(), to.display()));
    let (mut last, mut stage) = (Instant::now() - TELL_EVERY, None);
    let report = relocate::relocate(job, &mover.cancel, &mut |p| {
        if last.elapsed() >= TELL_EVERY || stage != Some(p.stage) {
            (last, stage) = (Instant::now(), Some(p.stage));
            mover.set(app, MoveState::Moving { to: to.display().to_string(), model: None, progress: Some(p.clone()) });
        }
    })?;
    crate::startup_log(paths, &format!("models folder: moved ({:?}, {} files, {} bytes, {} left behind: {})", report.method, report.files, report.bytes, report.left.len(), report.left.join(", ")));
    if !report.left.is_empty() {
        return Ok(MoveState::Moved { left: report.left, reason: None });
    }
    match leave(app, Vec::new()) {
        Ok(()) => Ok(MoveState::Restarting),
        Err(e) => {
            crate::startup_log(paths, &format!("models folder: the app did not start again by itself: {e:#}"));
            Ok(MoveState::Moved { left: Vec::new(), reason: Some(mango_common::user_phrase(&e)) })
        }
    }
}

/// The files of one model, from the stopping of what uses them to the new place written down. The app goes on: the catalog
/// is read again and the model that was running is loaded again from its new place.
fn run_model(app: &AppHandle, paths: &Paths, key: &str, plan: &place::Plan) -> Result<MoveState> {
    let mover = &app.state::<AppState>().models_move;
    let quiet = Quiet::new(app, paths, Some(key))?;
    let to = plan.places.first().and_then(|(_, to)| to.parent()).map_or_else(String::new, |p| p.display().to_string());
    crate::startup_log(paths, &format!("models: putting the files of {key} in {to}"));
    let (mut last, mut stage) = (Instant::now() - TELL_EVERY, None);
    let report = place::run(paths, plan, &mover.cancel, &mut |p| {
        if last.elapsed() >= TELL_EVERY || stage != Some(p.stage) {
            (last, stage) = (Instant::now(), Some(p.stage));
            mover.set(app, MoveState::Moving { to: to.clone(), model: Some(key.to_string()), progress: Some(p.clone()) });
        }
    })?;
    crate::startup_log(paths, &format!("models: the files of {key} moved ({:?}, {} files, {} bytes, {} left behind: {})", report.method, report.files, report.bytes, report.left.len(), report.left.join(", ")));
    drop(quiet);
    crate::choices_changed(app);
    Ok(MoveState::Done { model: key.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex as StdMutex};

    fn busy(mover: &Mover) -> bool {
        mover.state.lock().unwrap().busy()
    }

    /// Of any number of requests at the same moment only one takes the turn, and the state says so before anything is looked at;
    /// a move done and waiting for the app to start again, and one starting it, hold the turn too.
    #[test]
    fn of_many_requests_at_once_one_takes_the_turn() {
        let mover = Mover::default();
        let taken = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| {
                    if mover.take().is_ok() {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(taken.load(Ordering::SeqCst), 1);
        assert!(matches!(*mover.state.lock().unwrap(), MoveState::Moving { .. }) && busy(&mover));

        for held in [MoveState::Moved { left: vec!["links".into()], reason: None }, MoveState::Restarting] {
            mover.set_quietly(held);
            assert!(mover.take().is_err() && busy(&mover));
        }
        for free in [MoveState::Idle, MoveState::Cancelled, MoveState::Failed { message: "no".into() }, MoveState::Done { model: "m".into() }] {
            mover.set_quietly(free);
            assert!(!busy(&mover));
            assert!(mover.take().is_ok(), "the turn is free again");
        }
    }

    /// A stop asked for in the move before can not be inherited by the next: the turn clears it.
    #[test]
    fn a_new_turn_forgets_the_stop_of_the_one_before() {
        let mover = Mover::default();
        mover.take().unwrap();
        mover.ask_to_stop().unwrap();
        assert!(mover.cancel.requested());
        mover.set_quietly(MoveState::Cancelled);
        mover.take().unwrap();
        assert!(!mover.cancel.requested());
    }

    /// A stop is asked of a move that is under way and has not written the choice; not of none, and not of one that has (a folder
    /// used as it is writes it at once, so it cannot be cancelled either).
    #[test]
    fn a_stop_is_asked_only_of_a_move_that_can_still_stop() {
        let mover = Mover::default();
        assert!(mover.ask_to_stop().is_err(), "nothing moves");
        mover.take().unwrap();
        mover.ask_to_stop().unwrap();
        assert!(!mover.cancel.commit(), "a move that was asked to stop does not write the choice");
        mover.set_quietly(MoveState::Cancelled);
        mover.take().unwrap();
        assert!(mover.cancel.commit(), "the choice is written");
        let late = mover.ask_to_stop().unwrap_err().to_string();
        assert!(late.contains(&tr!("Non si può più annullare", "can no longer be cancelled")), "{late}");
        assert!(!mover.cancel.requested(), "a move that is done is not stopped");

        for written in [MoveState::Moved { left: vec![], reason: None }, MoveState::Restarting] {
            mover.set_quietly(written);
            let late = mover.ask_to_stop().unwrap_err().to_string();
            assert!(late.contains(&tr!("Non si può più annullare", "can no longer be cancelled")), "{late}");
        }
        mover.set_quietly(MoveState::Cancelled);
        let none = mover.ask_to_stop().unwrap_err().to_string();
        assert!(none.contains(&tr!("Nessuno spostamento", "No move")), "{none}");
    }

    /// The end of the app asks a move to stop and waits until it has: the thread hears the stop, gives back what it held, and
    /// only then tells it is over. The app stays «ending» for what comes after, until it is told it goes on.
    #[test]
    fn the_end_of_the_app_waits_for_a_move_to_stop() {
        let mover = Arc::new(Mover::default());
        mover.take().unwrap();
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let thread = {
            let (mover, seen) = (mover.clone(), seen.clone());
            std::thread::spawn(move || {
                while !mover.cancel.requested() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                seen.lock().unwrap().push(("quitting while it stops", mover.quitting.load(Ordering::SeqCst)));
                std::thread::sleep(Duration::from_millis(100));
                seen.lock().unwrap().push(("gave back", true));
                mover.set_quietly(MoveState::Cancelled);
            })
        };
        mover.quit();
        assert_eq!(*seen.lock().unwrap(), [("quitting while it stops", true), ("gave back", true)], "it returned only after the move ended");
        assert!(matches!(*mover.state.lock().unwrap(), MoveState::Cancelled));
        assert!(mover.quitting.load(Ordering::SeqCst), "a move that ends later (the wait ran out) still finds the app ending");
        assert!(mover.take().is_err(), "no move begins in an app that is ending");
        mover.resume();
        assert!(mover.take().is_ok(), "an app that goes on (an update that did not start) moves again");
        thread.join().unwrap();
    }

    #[test]
    fn the_end_of_the_app_does_not_wait_when_nothing_moves() {
        let mover = Mover::default();
        let started = Instant::now();
        assert!(!mover.ask_to_quit(), "nothing to wait for");
        mover.resume();
        mover.take().unwrap();
        assert!(mover.ask_to_quit(), "a move is under way: it is waited for");
        assert!(!mover.ask_to_quit(), "once: the end of the app asked again after the wait ran out goes on");
        mover.resume();
        mover.set_quietly(MoveState::Idle);
        mover.quit();
        mover.set_quietly(MoveState::Moved { left: vec![], reason: None });
        mover.quit();
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// The restart after a move that left something behind is taken once, and says what it was.
    #[test]
    fn the_restart_after_a_move_is_taken_once() {
        let mover = Mover::default();
        assert!(mover.take_moved().is_err(), "no move is done");
        mover.set_quietly(MoveState::Moved { left: vec!["links/big.gguf".into()], reason: None });
        assert_eq!(mover.take_moved().unwrap(), ["links/big.gguf"]);
        assert!(matches!(*mover.state.lock().unwrap(), MoveState::Restarting));
        assert!(mover.take_moved().is_err(), "once");
    }

    /// What stands for `Quiet`: it hands what it holds to `Mover::finish` as it goes, as the real one does.
    struct Stopped {
        mover: Arc<Mover>,
        folder: bool,
        given_back: Arc<AtomicBool>,
    }

    impl Drop for Stopped {
        fn drop(&mut self) {
            let given_back = self.given_back.clone();
            self.mover.finish(self.folder, move || given_back.store(true, Ordering::SeqCst));
        }
    }

    fn stopped(mover: &Arc<Mover>, folder: bool) -> (Stopped, Arc<AtomicBool>) {
        let given_back = Arc::new(AtomicBool::new(false));
        (Stopped { mover: mover.clone(), folder, given_back: given_back.clone() }, given_back)
    }

    /// What a move stopped is given back when the move ends, and also when its thread panics (the guards drop as it unwinds).
    #[test]
    fn what_a_move_stopped_is_given_back_when_it_ends_or_panics() {
        let mover = Arc::new(Mover::default());
        let (guard, given_back) = stopped(&mover, true);
        drop(guard);
        assert!(given_back.load(Ordering::SeqCst), "a move that ends");

        let (guard, given_back) = stopped(&mover, true);
        let panicked = catch_unwind(AssertUnwindSafe(move || {
            let _held = guard;
            panic!("the disk went away");
        }));
        assert!(panicked.is_err());
        assert!(given_back.load(Ordering::SeqCst), "a move whose thread panicked, before the choice was written");
    }

    /// The app is ending: nothing is given back (it would be stopped again); it is when the app turns out to go on, and not
    /// before.
    #[test]
    fn what_a_move_stopped_is_kept_while_the_app_ends_and_given_back_if_it_goes_on() {
        let mover = Arc::new(Mover::default());
        mover.ask_to_quit();
        let (guard, given_back) = stopped(&mover, true);
        let (late, late_back) = stopped(&mover, false);
        drop(guard);
        assert!(!given_back.load(Ordering::SeqCst), "kept: the app is ending");

        mover.resume();
        assert!(given_back.load(Ordering::SeqCst), "the installer did not start: it goes back to work");
        assert!(!mover.quitting.load(Ordering::SeqCst));
        drop(late);
        assert!(late_back.load(Ordering::SeqCst), "a move that ends after the app went on gives back as it ends");
    }

    /// The choice of a move of the whole folder is written: the app has the old folder in memory, so nothing is given back, at
    /// the end of the move, when it panics after the choice, and when the app goes on after it was ending. One model's files
    /// are different: the app goes on there.
    #[test]
    fn nothing_is_given_back_once_the_choice_of_the_folder_is_written() {
        let mover = Arc::new(Mover::default());
        mover.take().unwrap();
        assert!(mover.cancel.commit());

        let (guard, given_back) = stopped(&mover, true);
        let (panicking, panic_back) = stopped(&mover, true);
        drop(guard);
        let _ = catch_unwind(AssertUnwindSafe(move || {
            let _held = panicking;
            panic!("after the choice");
        }));
        assert!(!given_back.load(Ordering::SeqCst) && !panic_back.load(Ordering::SeqCst), "the downloads and the engine do not start on the old folder");

        mover.ask_to_quit();
        mover.resume();
        assert!(!given_back.load(Ordering::SeqCst) && !panic_back.load(Ordering::SeqCst), "not even when the app goes on");

        let (model, model_back) = stopped(&mover, false);
        drop(model);
        assert!(model_back.load(Ordering::SeqCst), "one model's files: the app goes on");
    }

    /// How a thread ends: cancelled, failed with the sentence of the failure (the detail stays in the log), or panicked, which
    /// is a move that stopped and says what to do, not a state that stays «moving» for ever. After the choice is written it is
    /// never «failed»: the old folder does not go on.
    #[test]
    fn a_thread_that_panics_or_fails_ends_the_move_with_a_sentence() {
        let logged = StdMutex::new(Vec::new());
        let log = |line: &str| logged.lock().unwrap().push(line.to_string());

        let panicked = catch_unwind(|| -> Result<MoveState> { panic!("the disk went away") });
        let MoveState::Failed { message } = ended(panicked, false, &log) else { panic!("not failed") };
        assert!(message.contains(&tr!("errore interno", "internal error")), "{message}");
        assert!(logged.lock().unwrap().iter().any(|l| l.contains("the disk went away")), "the reason is in the log");

        assert!(matches!(ended(Ok(Err(Cancelled.into())), false, &log), MoveState::Cancelled));
        let failed = ended(Ok(Err(mango_common::user_error("No room.", "D: 3 bytes"))), false, &log);
        assert!(matches!(&failed, MoveState::Failed { message } if message == "No room."), "{failed:?}");
        assert!(matches!(ended(Ok(Ok(MoveState::Restarting)), false, &log), MoveState::Restarting));

        let panicked = catch_unwind(|| -> Result<MoveState> { panic!("after the choice") });
        let MoveState::Moved { left, reason } = ended(panicked, true, &log) else { panic!("not moved") };
        assert!(left.is_empty() && reason.is_some_and(|r| r.contains(&tr!("errore interno", "internal error"))));
        let failed_late = ended(Ok(Err(mango_common::user_error("No room.", "D: 3 bytes"))), true, &log);
        assert!(matches!(&failed_late, MoveState::Moved { reason: Some(r), .. } if r == "No room."), "{failed_late:?}");
    }

    /// The states are written as the interface reads them; `reason` is there only when there is one.
    #[test]
    fn the_moved_state_carries_the_reason_only_when_there_is_one() {
        assert_eq!(serde_json::to_value(MoveState::Moved { left: vec!["a".into()], reason: None }).unwrap(), serde_json::json!({ "status": "moved", "left": ["a"] }));
        assert_eq!(
            serde_json::to_value(MoveState::Moved { left: vec![], reason: Some("close it".into()) }).unwrap(),
            serde_json::json!({ "status": "moved", "left": [], "reason": "close it" })
        );
    }
}
