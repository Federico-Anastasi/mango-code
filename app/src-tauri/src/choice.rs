//! The model choice and download page, in the app window: at startup when what is needed
//! is missing (`first_run::assess`), and later, from the "Models and engine" item of the tray icon, to add a
//! model or change the engine. The same page is where the PC starts to use the engine of another PC (`engine_remote.rs`),
//! and, while it does, the only thing it shows.

use crate::first_run::{self as fr, Assessment, Progress, Step, System};
use crate::{publish, set_error, set_status, start_page, write_reason, AppState, Status};
use anyhow::{bail, Context, Result};
use mango_common::{tr, Paths};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// What the choice page shows.
#[derive(Clone, Serialize)]
pub struct Choice {
    /// You can go back without choosing (the app is already in use).
    pub cancelable: bool,
    /// What this PC would download; none while it uses the engine of another PC (nothing to download then).
    pub assessment: Option<Assessment>,
    /// The PC whose engine is in use, if one is.
    pub remote: Option<crate::engine_remote::Info>,
    /// The model just added from "Other models": the page ticks it.
    pub added: Option<String>,
    /// The folder of the skill that optimizes Mango Code on this PC, to give to a frontier AI.
    pub optimize_dir: String,
}

/// How the choice is reached.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The app startup: the page appears only if something is missing. Without a window (`--service`) nothing
    /// can be asked: it is an error, written where the other apps read it.
    Startup { interactive: bool },
    /// The user asked for it: it always appears and can be cancelled.
    Change,
}

pub enum Outcome {
    /// There was nothing to download.
    Nothing,
    Downloaded,
    Cancelled,
    /// The user chose the engine of another PC, or to come back to this one: startup goes on from the saved choice.
    Switched,
}

enum Answer {
    Chosen(Vec<String>),
    Cancel,
    /// The list of models changed (one added or removed from "Other models"): it is read again and the choice proposed again.
    Reassess(Option<String>),
    /// The engine in use changed (`engine_remote.rs` saved or removed the other PC's code).
    Switched,
}

/// Who waits for the user's answer to the choice page.
#[derive(Default)]
pub struct Pending {
    current: Mutex<Option<(mpsc::Sender<Answer>, bool)>>,
}

impl Pending {
    fn open(&self, cancelable: bool) -> mpsc::Receiver<Answer> {
        let (tx, rx) = mpsc::channel();
        *self.current.lock().unwrap() = Some((tx, cancelable));
        rx
    }

    pub fn reassess(&self, added: Option<String>) -> Result<(), String> {
        self.answer(Answer::Reassess(added))
    }

    pub fn switched(&self) -> Result<(), String> {
        self.answer(Answer::Switched)
    }

    fn answer(&self, a: Answer) -> Result<(), String> {
        let mut current = self.current.lock().unwrap();
        let (_, cancelable) = current.as_ref().ok_or_else(|| tr!("nessuna scelta in attesa", "no choice waiting"))?;
        if matches!(a, Answer::Cancel) && !cancelable {
            return Err(tr!("questa scelta non si può annullare", "this choice cannot be cancelled"));
        }
        let (tx, _) = current.take().expect("checked above");
        tx.send(a).map_err(|_| tr!("la scelta non è più in attesa", "the choice is no longer waiting"))
    }
}

#[tauri::command]
pub fn choice_confirm(state: tauri::State<'_, AppState>, chosen: Vec<String>) -> Result<(), String> {
    state.choice.answer(Answer::Chosen(chosen))
}

#[tauri::command]
pub fn choice_cancel(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.choice.answer(Answer::Cancel)
}

/// The folder of the `optimize/` skill: in the installed app it is among the resources (`<dist>\optimize`), in the repo next
/// to `launcher/`.
fn optimize_dir(paths: &Paths) -> PathBuf {
    let installed = paths.dist.join("optimize");
    match paths.dist.parent() {
        Some(repo) if !installed.is_dir() => repo.join("optimize"),
        _ => installed,
    }
}

#[tauri::command]
pub fn open_optimize(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = optimize_dir(state.paths.get().ok_or_else(|| tr!("percorsi non ancora noti", "paths not known yet"))?);
    app.opener()
        .open_path(p.display().to_string(), None::<&str>)
        .map_err(|e| tr!("Non riesco ad aprire la cartella {}: {e}", "Cannot open the folder {}: {e}", p.display()))
}

fn show_download(app: &AppHandle, title: &str, progress: &Progress) {
    publish(app, Status { stage: "download".into(), detail: title.into(), download: Some(progress.clone()), ..Default::default() });
}

/// The interrupted download to resume: the choice of the other time, if it still applies and there is still
/// something to download.
fn to_resume(v: &Assessment, data: &std::path::Path) -> Option<(Vec<String>, Vec<Step>)> {
    let chosen = fr::remembered_choice(data)?;
    match fr::plan(v, &chosen) {
        Ok(plan) if !plan.is_empty() => Some((chosen, plan)),
        Ok(_) => {
            fr::forget_choice(data);
            None
        }
        Err(e) => {
            eprintln!("the choice of the other time no longer applies, proposing it from scratch: {e:#}");
            fr::forget_choice(data);
            None
        }
    }
}

/// Brings the computer to a state where a model can be started: if something is missing it shows the choice,
/// then downloads. Returns when done (or the user cancelled).
pub fn ensure(app: &AppHandle, paths: &Paths, system: &dyn System, mode: Mode) -> Result<Outcome> {
    let st = app.state::<AppState>();
    let assess_error = || tr!("Non riesco a controllare cosa serve a questo computer", "Cannot check what this computer needs");
    let v = fr::assess(system).with_context(assess_error)?;
    let startup = matches!(mode, Mode::Startup { .. });

    let resumed = if startup { to_resume(&v, &paths.data) } else { None };
    let resuming = resumed.is_some();
    let (chosen, plan) = match resumed {
        Some(r) => r,
        None => {
            if let Mode::Startup { interactive } = mode {
                if v.ready() {
                    return Ok(Outcome::Nothing);
                }
                if !interactive {
                    bail!(
                        "{}",
                        tr!(
                            "Mango Code è partito senza finestra e non è ancora pronto: {} Apri la finestra dall'icona nella barra \
                             delle applicazioni, scegli cosa scaricare e premi «Riprova».",
                            "Mango Code started without a window and is not ready yet: {} Open the window from the icon in the \
                             taskbar, choose what to download and press \"Retry\".",
                            v.missing()
                        )
                    );
                }
            }
            if startup {
                write_reason(&tr!(
                    "Mango Code aspetta che nella sua finestra si scelgano i modelli da scaricare.",
                    "Mango Code is waiting for the models to download to be chosen in its window."
                ));
            }
            let mut v = v;
            let mut added = None;
            loop {
                let waiting = st.choice.open(!startup);
                publish(
                    app,
                    Status {
                        stage: "choice".into(),
                        detail: tr!("Scegli cosa scaricare", "Choose what to download"),
                        choice: Some(Choice {
                            cancelable: !startup,
                            assessment: Some(v.clone()),
                            remote: None,
                            added: added.take(),
                            optimize_dir: optimize_dir(paths).display().to_string(),
                        }),
                        ..Default::default()
                    },
                );
                match waiting.recv().with_context(|| tr!("la pagina della scelta si è chiusa", "the choice page was closed"))? {
                    Answer::Chosen(chosen) => {
                        let plan = fr::plan(&v, &chosen)?;
                        break (chosen, plan);
                    }
                    Answer::Cancel => return Ok(Outcome::Cancelled),
                    Answer::Switched => return Ok(Outcome::Switched),
                    Answer::Reassess(key) => {
                        v = fr::assess(system).with_context(assess_error)?;
                        added = key;
                    }
                }
            }
        }
    };
    if plan.is_empty() {
        return Ok(Outcome::Nothing);
    }

    fr::remember_choice(&paths.data, &chosen)
        .with_context(|| tr!("Non riesco a ricordare cosa stai scaricando", "Cannot remember what you are downloading"))?;
    if startup {
        write_reason(&tr!("Mango Code sta scaricando i modelli scelti.", "Mango Code is downloading the chosen models."));
    }
    let title = if resuming {
        tr!("Riprendo lo scaricamento", "Resuming the download")
    } else {
        tr!("Scarico quello che serve", "Downloading what is needed")
    };
    fr::run(system, &plan, &mut |progress| show_download(app, &title, progress))?;
    fr::forget_choice(&paths.data);
    if startup && !fr::assess(system)?.ready() {
        bail!("{}", tr!("Lo scaricamento è finito, ma il modello non risulta installato.", "The download finished, but the model does not appear to be installed."));
    }
    Ok(Outcome::Downloaded)
}

/// "Models and engine" while this PC uses the engine of another: the page shows that PC and the way back, no hardware and
/// no downloads. It returns when the user closes the page or changes the engine.
fn show_remote(app: &AppHandle, paths: &Paths, info: crate::engine_remote::Info) -> Result<Outcome> {
    let waiting = app.state::<AppState>().choice.open(true);
    publish(
        app,
        Status {
            stage: "choice".into(),
            detail: tr!("Modelli e motore", "Models and engine"),
            choice: Some(Choice { cancelable: true, assessment: None, remote: Some(info), added: None, optimize_dir: optimize_dir(paths).display().to_string() }),
            ..Default::default()
        },
    );
    match waiting.recv().with_context(|| tr!("la pagina della scelta si è chiusa", "the choice page was closed"))? {
        Answer::Switched => Ok(Outcome::Switched),
        Answer::Cancel => Ok(Outcome::Cancelled),
        Answer::Chosen(_) | Answer::Reassess(_) => bail!("{}", tr!("questa pagina non scarica modelli", "this page does not download models")),
    }
}

/// The "Models and engine" item of the tray. If the app is in use, the window moves to the choice page
/// without stopping anything; the agent restarts only if something was downloaded.
pub fn change(app: &AppHandle) {
    crate::tray::show(app);
    let st = app.state::<AppState>();
    if st.changing.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = change_in_use(&app) {
            set_error(&app, &tr!("Non sono riuscito a cambiare i modelli", "Could not change the models"), &e);
        }
        app.state::<AppState>().changing.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

fn change_in_use(app: &AppHandle) -> Result<()> {
    let st = app.state::<AppState>();
    let stage = st.status.lock().unwrap().stage.clone();
    match stage.as_str() {
        "ready" => {}
        // The window already shows the app page: we start over from the choice.
        "error" => {
            crate::restart(app, Mode::Change);
            return Ok(());
        }
        // Startup is in progress: the app page is already in front.
        _ => return Ok(()),
    }
    let paths = st.paths.get().with_context(|| tr!("percorsi non ancora noti", "paths not known yet"))?.clone();
    let agent = st.agent.lock().unwrap().clone().with_context(|| tr!("l'agente non risulta acceso", "the agent does not appear to be running"))?;
    let remote = st.remote.lock().unwrap().clone();
    let window = st.main.get().cloned().with_context(|| tr!("finestra principale sparita", "main window gone"))?;
    set_status(app, "startup", tr!("Controllo il computer", "Checking the computer"));
    window.navigate(st.app_page.get().with_context(|| tr!("pagina dell'app sconosciuta", "app page unknown"))?.clone())?;
    let outcome = match remote {
        Some(info) => show_remote(app, &paths, info)?,
        // The hardware is read only if this PC's engine is the one in use.
        None => ensure(app, &paths, &*crate::system::choose(&paths)?, Mode::Change)?,
    };
    match outcome {
        Outcome::Downloaded | Outcome::Switched => crate::restart(app, Mode::Startup { interactive: true }),
        Outcome::Nothing | Outcome::Cancelled => {
            set_status(app, "ready", tr!("Pronto", "Ready"));
            window.navigate(start_page(&agent).parse().with_context(|| tr!("URL dell'agente", "Agent URL"))?)?;
        }
    }
    Ok(())
}
