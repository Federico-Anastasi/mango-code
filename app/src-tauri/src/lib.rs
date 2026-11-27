//! Mango Code, desktop app: one window.
//!
//! At startup the window shows the app's own page (`ui/`), the logo, and nothing else unless the startup fails; meanwhile a thread opens the control server (the engine manager on
//! its port, with no model yet) and starts the agent server, then moves the window to the home of the web UI the agent
//! serves. The default model loads after that, in the background: the manager tells how it goes. Nothing at startup concerns
//! the last conversation, and nothing is read for a conversation before the user writes in it. Dictation, if the user wants
//! it, comes after (`dictation.rs`).
//! The startup state is read with the `startup_status` command and arrives as the `mango://status` event.

mod agent_models;
mod other_models;
mod bridge;
mod close_notice;
mod folder;
pub mod helper;
mod chrome;
mod control;
mod downloads;
mod dictation;
mod model_choices;
mod models_move;
mod models_watch;
mod preview;
mod supervisor;
mod team;
mod phone;
mod ports;
mod engine_share;
mod engine_remote;
mod servers;
mod tray;
mod old_origin;
mod seed;
mod ui_state;
mod report;
mod sites;
mod updater;
mod zoom;

use anyhow::{Context, Result};
use mango_common::{port_busy, free_port, tr, Paths};
use engine::EngineManager;
use serde::Serialize;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use supervisor::Supervisor;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The agent server's preferred port. What the web UI remembers lives on disk (`ui_state.rs`), not in the origin it is
/// served from, so another program holding this port does not keep the app from starting: a free one is used.
const AGENT_PORT: u16 = 4096;
const VOICE_PORT: u16 = 4097;
/// Port of the phone service (off by default, see `phone.rs`). Fixed: it is in the link and the QR.
const PHONE_PORT: u16 = 47096;
/// The phone service's second port, for the pages of the browser panel: open only while the first is.
const PHONE_PREVIEW_PORT: u16 = 47097;

/// The automated tests start their own instance next to the real app, on their own ports.
fn port_from_env(var: &str, default: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
pub(crate) fn preferred_agent_port() -> u16 {
    port_from_env("MANGO_AGENT_PORT", AGENT_PORT)
}
static AGENT_PORT_NOW: AtomicU16 = AtomicU16::new(0);
/// The port the agent listens on, or will try first: chosen when first asked and again at every start of the agent
/// (`use_agent_port`), so what depends on it follows the port the agent really bound.
pub(crate) fn agent_port() -> u16 {
    match AGENT_PORT_NOW.load(Ordering::SeqCst) {
        0 => {
            let port = choose_port(preferred_agent_port(), None);
            AGENT_PORT_NOW.store(port, Ordering::SeqCst);
            port
        }
        port => port,
    }
}
/// The agent is going to start on `port`: the window and the phone service follow it.
fn use_agent_port(app: &AppHandle, port: u16) {
    AGENT_PORT_NOW.store(port, Ordering::SeqCst);
    phone::agent_port_changed(app, port);
}
/// The first of `preferred` and `previous` (the port of the agent that just ran, so that a restart keeps its address
/// while it can) that nothing listens on, otherwise a free port. When no port can be bound `preferred` stays, and the
/// start fails on it.
fn choose_port(preferred: u16, previous: Option<u16>) -> u16 {
    [Some(preferred), previous]
        .into_iter()
        .flatten()
        .find(|port| !port_busy(*port))
        .or_else(|| mango_common::random_port().ok())
        .unwrap_or(preferred)
}
/// How long the first start after an update waits for the preferred port to be released by the agent of the old version.
const PREFERRED_PORT_WAIT: Duration = Duration::from_secs(6);
/// How many ports are tried for the agent when another program takes each one before the agent binds it.
const PORT_ATTEMPTS: usize = 3;

/// Waits until nothing listens on `port` or `limit` passes; whether it is free.
fn wait_until_free(port: u16, limit: Duration) -> bool {
    let start = Instant::now();
    while port_busy(port) {
        if start.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

/// Starts the agent with `start` on the port `choose` gives. When it fails and another program holds that port the agent
/// is stopped (`stop`) and another port is chosen: a port taken between the choice and the bind is not an error of the app.
fn start_on_a_free_port<T>(
    mut choose: impl FnMut() -> u16,
    mut start: impl FnMut(u16) -> Result<T>,
    mut stop: impl FnMut(),
    mut taken: impl FnMut(u16, usize),
) -> Result<T> {
    for attempt in 1..=PORT_ATTEMPTS {
        let port = choose();
        match start(port) {
            Ok(started) => return Ok(started),
            Err(e) => {
                stop();
                if attempt == PORT_ATTEMPTS || !port_busy(port) {
                    return Err(e);
                }
                taken(port, attempt);
            }
        }
    }
    unreachable!("the last attempt returns")
}
pub(crate) fn engine_port() -> u16 {
    port_from_env("MANGO_ENGINE_PORT", mango_common::ENGINE_PORT)
}
pub(crate) fn phone_port() -> u16 {
    port_from_env("MANGO_PHONE_PORT", PHONE_PORT)
}
pub(crate) fn phone_preview_port() -> u16 {
    port_from_env("MANGO_PHONE_PREVIEW_PORT", PHONE_PREVIEW_PORT)
}

/// `--service`: the app starts without showing the window (the tray icon opens it). This is how
/// another app that only wants the service starts it (docs/INTEGRATION.md).
pub(crate) fn service_mode() -> bool {
    std::env::args().any(|a| a == "--service")
}
#[derive(Clone, Serialize, Default)]
pub struct Status {
    /// "startup" | "engine" | "agent" | "ready" | "error"
    pub stage: String,
    /// Text for the user, one line.
    pub detail: String,
    /// The stage's place in the start and how many stages the start has: the page's bar is at `step` of `steps`.
    /// Zero when there is no start to show (an error).
    pub step: u8,
    pub steps: u8,
    pub error: Option<ErrorInfo>,
}

#[derive(Clone, Serialize)]
pub struct ErrorInfo {
    pub title: String,
    pub message: String,
    /// Logs folder, for the "Open the logs" button.
    pub logs: Option<String>,
    /// This PC uses the engine of another: the page offers the way back to this PC's engine.
    pub remote: bool,
}

/// The engine the agent works with: this PC's (the manager on its port) or another PC's (its address and key).
pub(crate) struct EngineUse {
    pub url: String,
    /// The key of another PC's engine; none for this PC's.
    pub key: Option<String>,
    pub models: Vec<agent_cfg::AgentModel>,
    /// The model of new conversations; none while no model is on this computer.
    pub default_model: Option<String>,
    /// The default model waits for the new version of its engine: the start does not load it. What loads is decided once
    /// the updates of the engines are queued, and again at every change of the downloads (`load_default`).
    pub default_waits: bool,
}

#[derive(Default)]
struct AppState {
    status: Mutex<Status>,
    sup: OnceLock<Supervisor>,
    /// The control server: the engine manager, born before any model. It lives as long as the app, across "Retry" attempts.
    engine: OnceLock<EngineManager>,
    /// The routes for pictures, born with the engine manager, which lends them the cards.
    images: OnceLock<images::routes::Routes>,
    paths: OnceLock<Paths>,
    /// The microphone in the chat, off until the user turns it on.
    dictation: OnceLock<dictation::Dictation>,
    /// The window created at startup. The reference is kept instead of looking it up by label at
    /// the end of startup: the Preview panel adds a child webview to the same window, and there
    /// the lookup by label is not reliable (the app stayed on "main window gone" while the window
    /// was alive on screen).
    main: OnceLock<tauri::WebviewWindow>,
    /// Sharing the engine with the user's other PCs, born with the engine manager.
    share: OnceLock<engine::share::Share>,
    /// The PC whose engine is in use, when it is another PC's (`engine_remote.rs`).
    remote: Mutex<Option<engine_remote::Info>>,
    /// The address of the app's own page (the logo, the fatal error), to come back to it from the web UI.
    app_page: OnceLock<tauri::Url>,
    /// The agent server, when the app is ready.
    agent: Mutex<Option<String>>,
    /// A folder to open as a project that arrived before the agent was ready (`folder.rs`).
    folder: Mutex<Option<std::path::PathBuf>>,
    /// The page of the interface the window showed when the app started again (path, query and fragment): the start
    /// brings the window back to it, on the address of the new agent.
    back_to: Mutex<Option<String>>,
    /// What the control server's routes remember (`control.rs`).
    control: control::Shared,
    /// The folders served to the browser panel as sites (`sites.rs`).
    sites: sites::Sites,
    /// The ports of the app's own listeners, which no page of the phone reaches (`ports.rs`).
    ports: ports::Ports,
    /// The models being downloaded (`downloads.rs`), born at the first startup.
    downloads: OnceLock<downloads::Downloads>,
    /// The models folder is watched from the first startup on (`models_watch.rs`).
    models_watch: Mutex<models_watch::Slot>,
    /// Choosing where the models are kept, and moving them (`models_move.rs`).
    models_move: models_move::Mover,
    /// The default model whose engine the app is waiting for (`load_default`): a start of it that fails meanwhile, for the
    /// missing engine, does not stop it from loading when the engine arrives.
    awaited: Mutex<Option<String>>,
    /// The models and the default the agent knows, to tell it when they change (`agent_models.rs`).
    declared: agent_models::Declared,
    /// The section of the settings asked from the tray or the model menu, until the interface reads it (`tray.rs`).
    settings: Mutex<Option<String>>,
}

/// The main window, through the reference kept at startup: looked up by label it is not found once the Preview
/// panel has added its webview to it (the X and the tray icon then did nothing).
pub(crate) fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.try_state::<AppState>()?.main.get().cloned()
}

pub(crate) fn publish(app: &AppHandle, s: Status) {
    *app.state::<AppState>().status.lock().unwrap() = s.clone();
    let _ = app.emit("mango://status", s);
}

pub(crate) fn set_status(app: &AppHandle, stage: &str, detail: impl Into<String>) {
    let before = app.state::<AppState>().status.lock().unwrap().steps;
    let (step, steps) = progress(stage, before);
    publish(app, Status { stage: stage.into(), detail: detail.into(), step, steps, ..Default::default() });
}

/// The stages of a start, in order; one that uses another PC's engine has one more, in which it connects to it.
const STAGES: [&str; 3] = ["startup", "agent", "ready"];
const STAGES_WITH_ENGINE: [&str; 4] = ["startup", "engine", "agent", "ready"];

/// Where `stage` is in the start and of how many stages: `(step, steps)`. `before` is how many stages the start had at
/// the stage before: a start learns that it uses another PC's engine when it gets there, and keeps it until the next one.
fn progress(stage: &str, before: u8) -> (u8, u8) {
    let with_engine = stage == "engine" || (stage != "startup" && usize::from(before) == STAGES_WITH_ENGINE.len());
    let stages: &[&str] = if with_engine { &STAGES_WITH_ENGINE } else { &STAGES };
    let step = stages.iter().position(|s| *s == stage).map_or(0, |at| at + 1);
    (step as u8, stages.len() as u8)
}

pub(crate) use mango_common::startup_log;

pub(crate) fn set_error(app: &AppHandle, title: &str, err: &anyhow::Error) {
    let st = app.state::<AppState>();
    let logs = st.paths.get().map(|p| p.logs().display().to_string());
    // The error also goes to the log file: the screen shows it, but on narrow windows the box is
    // cut off and without the file nothing is left to read.
    if let Some(paths) = st.paths.get() {
        startup_log(paths, &format!("{title}: {err:#}"));
    }
    // after the log: whoever sees the reason (other apps, the tests) finds the log already written
    write_reason(&format!("{title}: {err:#}"));
    publish(
        app,
        Status {
            stage: "error".into(),
            detail: title.into(),
            error: Some(ErrorInfo {
                title: title.into(),
                message: format!("{err:#}"),
                logs,
                remote: st.paths.get().is_some_and(|p| engine::remote::file(&p.data).is_file()),
            }),
            ..Default::default()
        },
    );
}

#[tauri::command]
fn startup_status(state: tauri::State<'_, AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

/// The current language of the app, `"it"` or `"en"`, for the pages that choose their own texts (`ui/`).
#[tauri::command]
fn language() -> &'static str {
    mango_common::i18n::lang().code()
}

/// "Retry" of the error screen: stops what had started and starts again.
#[tauri::command]
fn retry_startup(app: AppHandle) {
    restart(&app);
}

/// The agent first (its running request drops and releases the engine), then the engine, which saves the open
/// conversation (up to a minute).
pub(crate) fn stop_children(app: &AppHandle) {
    let st = app.state::<AppState>();
    if let Some(s) = st.sup.get() {
        s.shutdown();
        s.stop_stragglers();
    }
    if let Some(m) = st.engine.get() {
        m.stop();
    }
    if let Some(d) = st.dictation.get() {
        d.shutdown();
    }
}

/// Stops the agent, removes the service file (the app is no longer ready) and starts again. The engine manager and its
/// model stay as they are.
pub(crate) fn restart(app: &AppHandle) {
    let st = app.state::<AppState>();
    // From the web UI of the agent about to stop, back to the loading page: it says what is happening.
    if st.status.lock().unwrap().stage == "ready" {
        // The interface writes what it holds before the window leaves it.
        ui_state::flush_page(app);
        let shown = st.main.get().filter(|window| on_agent_page(window)).and_then(|window| window.url().ok());
        *st.back_to.lock().unwrap() =
            shown.and_then(|url| url.as_str().strip_prefix(url.origin().ascii_serialization().as_str()).map(str::to_string));
        if let (Some(window), Some(page)) = (st.main.get(), st.app_page.get()) {
            set_status(app, "startup", tr!("Preparazione", "Preparing"));
            let _ = window.navigate(page.clone());
        }
    }
    if let Some(s) = st.sup.get() {
        s.shutdown();
        s.stop_team();
    }
    st.agent.lock().unwrap().take();
    if let Ok(f) = mango_common::service_file() {
        let _ = std::fs::remove_file(f);
    }
    spawn_startup(app.clone());
}

#[tauri::command]
fn open_logs(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = state.paths.get().ok_or_else(|| tr!("percorsi non ancora noti", "paths not known yet"))?.logs();
    app.opener().open_path(p.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Watches the models folder, if it is not watched already and no move of it has the watch (`models_watch.rs`).
pub(crate) fn watch_models(app: &AppHandle, paths: &Paths) {
    let st = app.state::<AppState>();
    let (changed, logs) = (app.clone(), paths.clone());
    let trouble = move |why: String| startup_log(&logs, &format!("models folder watch: {why}"));
    let started = st.models_watch.lock().unwrap().fill(|| models_watch::watch(&paths.models, models_watch::QUIET, move || changed.state::<AppState>().control.catalog_changed(), trouble));
    if let Err(e) = started {
        startup_log(paths, &format!("the models folder is not watched: {e:#}"));
    }
}

fn startup(app: &AppHandle) -> Result<()> {
    let st = app.state::<AppState>();
    let t0 = std::time::Instant::now();
    set_status(app, "startup", tr!("Preparazione", "Preparing"));
    let paths = Paths::discover().with_context(|| tr!("Impossibile trovare i file di Mango Code", "Cannot find the Mango Code files"))?;
    let paths = st.paths.get_or_init(|| paths).clone();
    let ui = app.state::<ui_state::UiState>();
    // One line per phase, with the time since the start: where a slow startup spends its time.
    let phase = |name: &str| startup_log(&paths, &format!("startup: {name} (+{} ms)", t0.elapsed().as_millis()));
    phase("begins");
    if agent_port() != preferred_agent_port() {
        phase(&format!("port {} is busy, the agent uses {}", preferred_agent_port(), agent_port()));
    }
    if let Some(done) = models_move::recover_interrupted(app, &paths).with_context(|| tr!("Uno spostamento della cartella dei modelli rimasto a metà non si è concluso. Chiudi i programmi che usano i modelli e riprova.", "A move of the models folder that stopped half way could not be finished. Close the programs that use the models and try again."))? {
        startup_log(&paths, &format!("models folder: {done}"));
    }
    if let Err(e) = std::fs::create_dir_all(&paths.models) {
        startup_log(&paths, &format!("the models folder cannot be made: {}: {e}", paths.models.display()));
    }
    watch_models(app, &paths);
    // Dictation, the microphone in the chat: off until the user turns it on, then it downloads and starts by itself once the
    // app is ready (`dictation.rs`). The agent only needs to know where the service will be.
    if st.dictation.get().is_none() {
        let voice_port = free_port(VOICE_PORT).unwrap_or(VOICE_PORT);
        st.ports.add(voice_port);
        dictation::install(app, &paths, voice_port);
    }
    let sup = match st.sup.get() {
        Some(s) => s,
        None => {
            let s = Supervisor::new(&paths.logs())?;
            match s.start_guardian() {
                Ok(helper::Placement::Outside) => {}
                Ok(helper::Placement::InTheJob) => startup_log(&paths, "the guardian of the programs the agent starts is in the app's job (an outer job does not let it leave): it ends with the app, and what the agent left running is stopped at the next start"),
                Err(e) => startup_log(&paths, &format!("the guardian of the programs the agent starts did not start: {e}")),
            }
            let _ = st.sup.set(s);
            let logs = paths.clone();
            std::thread::spawn(move || {
                let stopped = Supervisor::stop_stale_stragglers();
                if stopped > 0 {
                    startup_log(&logs, &format!("stopped {stopped} processes left by an app that was closed by force"));
                }
            });
            st.sup.get().unwrap()
        }
    };

    // The PC's development tools are detected meanwhile; they are awaited right before the agent config.
    let tools = {
        let data = paths.data.clone();
        let path = agent_cfg::tools::agent_path(&paths.data, &paths.dist, std::env::var_os("PATH").as_deref());
        std::thread::spawn(move || agent_cfg::tools::update(&data, &path))
    };

    let engine = control_server(app, &paths)?;
    phase("control server");
    // The downloads of the last time go on once the window is in use (`restore`, at the end).
    let downloads = st.downloads.get_or_init(|| {
        let (arrived, stopped, engine, changed, logs) = (app.clone(), app.clone(), app.clone(), app.clone(), paths.clone());
        downloads::Downloads::new(
            Box::new(downloads::Real { paths: paths.clone(), hardware: engine_cfg::detect }),
            paths.data.join("downloads.json"),
            downloads::Tell {
                arrived: Box::new(move |model| models_arrived(&arrived, model)),
                changed: Box::new(move |_| {
                    catalog_read_again(&changed);
                }),
                stopped: Box::new(move |_| default_reconsidered(&stopped)),
                engine: Box::new(move |_| engine_arrived(&engine)),
                log: Box::new(move |line| startup_log(&logs, &format!("downloads: {line}"))),
            },
        )
    });

    if let Err(e) = engine_cfg::choices::settle_keys(&paths) {
        startup_log(&paths, &format!("the choices not moved under the models' keys: {e:#}"));
    }
    // --- the models the agent knows: those of another PC if the user chose its engine, otherwise this computer's catalog
    let used = match engine_remote::start(app, &paths)? {
        Some(used) => used,
        None => local_models(app, &paths)?,
    };
    let remote = used.key.is_some();
    phase("models");

    // --- agent server
    set_status(app, "agent", tr!("Avvio dell'agente", "Starting the agent"));
    let (servers, server_keys) = servers::for_the_agent(&paths);
    // The agent's browser is the Preview panel: its port changes at every start and lives only in
    // the process environment. If the panel was not created (0) the browser server falls back to
    // the external browser.
    let browser = agent_cfg::BrowserInputs {
        preview_port: app.try_state::<preview::Panel>().map(|p| p.cdp_port).unwrap_or(0),
        choice: chrome::choice_file().with_context(|| tr!("Percorso della scelta del browser", "Browser choice path"))?,
    };
    let inputs = agent_cfg::AgentInputs {
        engine_url: used.url.clone(),
        control_url: format!("http://127.0.0.1:{}", engine_port()),
        engine_key: used.key.clone(),
        models: used.models.clone(),
        default_model: used.default_model.clone(),
        port: 0,
        voice_url: st.dictation.get().map(|d| d.url.clone()),
        tools: tools.join().unwrap_or_else(|_| {
            // It should not happen (every check has its own time limit): the agent starts
            // with an empty list, which is better than not starting.
            eprintln!("PC tools: detection failed");
            Default::default()
        }),
        browser,
        team: agent_cfg::team::team_inputs(&paths, team_key())
            .with_context(|| tr!("Configurazione del Team", "Team configuration"))?,
        servers: servers.clone(),
        server_keys,
    };
    let server_urls: Vec<String> = servers.list.iter().map(|s| s.url.clone()).collect();
    // The agent's address is the preferred port while it is free; the interface keeps its state in the app, not in the
    // origin of that address, so another port is no loss. While the state of that origin is not copied yet the start waits
    // a moment for the port (an agent that is closing may still hold it); the copy is read (below) whichever port is taken.
    let preferred = preferred_agent_port();
    if ui.needs_import().unwrap_or(false) && port_busy(preferred) && !wait_until_free(preferred, PREFERRED_PORT_WAIT) {
        startup_log(&paths, &format!("port {preferred} is still busy after {} s", PREFERRED_PORT_WAIT.as_secs()));
    }
    let previous = Some(AGENT_PORT_NOW.load(Ordering::SeqCst)).filter(|port| *port != 0);
    let agent_plan = start_on_a_free_port(
        || {
            let port = choose_port(preferred, previous);
            use_agent_port(app, port);
            port
        },
        |port| {
            let mut plan = agent_cfg::plan(&paths, &agent_cfg::AgentInputs { port, ..inputs.clone() })
                .with_context(|| tr!("Configurazione dell'agente", "Agent configuration"))?;
            // Bun and the servers the agent starts do not read Windows' proxy: they get it as variables, with the engine left out of it.
            plan.spec.env.extend(mango_common::internet::child_proxy_env(&used.url, &server_urls));
            sup.spawn(&plan.spec)?;
            sup.wait_ready(&plan.spec, |_| {}).with_context(|| tr!("L'agente non è partito", "The agent did not start"))?;
            Ok(plan)
        },
        || sup.shutdown(),
        |port, attempt| startup_log(&paths, &format!("port {port} was taken before the agent could use it (attempt {attempt}); trying another")),
    )?;
    if agent_port() != preferred {
        startup_log(&paths, &format!("port {preferred} is busy, the agent uses {}", agent_port()));
    }
    bridge::allow_agent_page(app, agent_port())?;
    phase("agent");
    // From now on a change of this computer's models is told to the agent; another PC's are read at the start.
    match remote {
        true => st.declared.forget(),
        false => st.declared.launched(&used.models, used.default_model.as_deref(), &servers),
    }

    // The model loads in the background, and the manager tells how it goes: the default one, or the one that was in use before
    // the engine was stopped (the engine of another PC, then back to this one). A model that is running or loading is left
    // alone: only the agent started again.
    // With the default on a server the local model starts only when it is chosen.
    if !remote && !used.default_waits && servers.default.is_none() && engine.phase() == engine::Phase::Stopped {
        if let Some(key) = engine.state().model.or(used.default_model) {
            engine.choose(&key);
        }
    }

    // --- the window moves to the home of the web UI, and the other apps can find the service
    set_status(app, "ready", tr!("Pronto", "Ready"));
    if let Some(d) = st.dictation.get() {
        d.arm();
    }
    // Under the folder lock: a folder that arrives now either finds it here, or navigates by itself (`folder::open`).
    let requested = {
        let mut waiting = st.folder.lock().unwrap();
        *st.agent.lock().unwrap() = Some(agent_plan.url.clone());
        waiting.take()
    };
    write_service_file(&agent_plan.url, &format!("http://127.0.0.1:{}", engine_port()), !remote)?;
    let win = app
        .state::<AppState>()
        .main
        .get()
        .cloned()
        .with_context(|| tr!("finestra principale sparita", "main window gone"))?;
    let agent_url: tauri::Url = agent_plan.url.parse().with_context(|| tr!("URL dell'agente", "Agent URL"))?;
    let back_to = st.back_to.lock().unwrap().take();
    let page = match (requested, back_to) {
        (Some(folder), _) => folder::page(&agent_plan.url, &folder)?,
        (None, Some(path)) => agent_url.join(&path).unwrap_or(agent_url),
        (None, None) => agent_url,
    };
    // At every attempt: a "Retry" after a startup that stopped before here takes them up, and they are taken up once.
    // What cannot be resumed or queued is not worth stopping an app that is already in use: it goes to the log.
    if let Err(e) = downloads.restore() {
        startup_log(&paths, &format!("downloads not resumed: {e:#}"));
    }
    // What the window's browser kept for the preferred port's origin (where older releases kept the interface's state) is read
    // now, while the window still shows the app's own page, and handed to the interface when it opens.
    if ui.needs_import().unwrap_or(false) {
        match old_origin::read(app, preferred) {
            Ok(old) => ui.keep_old(old),
            Err(e) => startup_log(&paths, &format!("the old storage of the interface was not read: {e:#}")),
        }
        phase("old storage");
    }
    // The color scheme the page last saved, for the page's own script to find before anything else runs. Here and not when the
    // window is built: reading the state is a read of the disk, and the thread that builds the window is the window's.
    seed::refresh_before_load(app);
    win.navigate(page)?;
    phase("window on the home");
    // Then the engine the app came with, if models on the disk wait for it: it reads the hardware and the models (about
    // 150 ms measured, too long to keep the window waiting), while the interface loads; its first read of the state
    // comes later, and finds the engine coming.
    if let Err(e) = engine_cfg::detect(&paths).and_then(|hw| model_choices::engine_update(&paths, &hw, &downloads)) {
        startup_log(&paths, &format!("the new engine not queued: {e:#}"));
    }
    phase("engine update");
    // A default that waited for its engine update is decided now that the update is queued, or is not.
    default_reconsidered(app);
    Ok(())
}

/// The control server: the engine manager on its fixed port, which starts the model the user picks and the one the
/// conversations ask for. It is born once, before any model is on the computer and also when the engine in use is another
/// PC's, and with it the sharing of the engine.
fn control_server(app: &AppHandle, paths: &Paths) -> Result<EngineManager> {
    let st = app.state::<AppState>();
    if let Some(m) = st.engine.get() {
        return Ok(m.clone());
    }
    let manager_port = engine_port();
    st.ports.add(manager_port);
    if port_busy(manager_port) {
        anyhow::bail!(
            "{}",
            tr!(
                "La porta {manager_port} del motore è occupata: probabilmente la sta usando un altro programma, per esempio un motore già \
                 acceso. Spegnilo e riapri l'app.",
                "Engine port {manager_port} is busy: another program is probably using it, for example an engine \
                 that is already running. Stop it and reopen the app."
            )
        );
    }
    let p = paths.clone();
    let m = EngineManager::new(
        Box::new(move |k, port, excluded| engine_cfg::plan_excluding(&p, Some(k), port, excluded)),
        Box::new(engine_cfg::gpu_memory),
        &paths.logs(),
    );
    // The style of the answers and the reasoning the user chose for each model: kept in memory and renewed when the
    // choices or the models change, so a change applies from the next answer without loading the model again.
    let defaults = engine_cfg::choices::ModelDefaults::new(paths.clone());
    m.set_request_defaults(Box::new(move |key| defaults.get(key)));
    // A model that goes on the cards does not start where other programs hold the memory it counts on: «Retry» starts it
    // anyway. In development builds `MANGO_ROOM_CHECK_OFF` leaves the check out: the fake models of the integration tests
    // have a plan on this PC's real cards, which another program may be using.
    if !(cfg!(debug_assertions) && std::env::var_os("MANGO_ROOM_CHECK_OFF").is_some()) {
        let p = paths.clone();
        m.set_room_check(Box::new(move |key, lent, used| engine_cfg::taken_before_start(&p, &engine_cfg::detect(&p)?, used, engine_cfg::hardware::free_ram_mib()?, key, lent)));
    }
    // The pictures: the image engine draws on a card the engine manager lends it, and gives it back.
    let p = paths.clone();
    let pictures = images::ImageManager::new(Box::new(move |key, port| engine_cfg::image_plan(&p, key, port)), images::lender(m.clone()), &paths.logs());
    let p = paths.clone();
    let _ = st.images.set(images::routes::Routes::new(pictures, Box::new(move || Ok(serde_json::to_value(engine_cfg::image_models(&p, &engine_cfg::detect(&p)?)?)?))));
    engine::http::serve(m.clone(), manager_port, Some(std::sync::Arc::new(control::Routes(app.clone())))).with_context(|| tr!("Porta del motore", "Engine port"))?;
    let _ = st.engine.set(m.clone());
    engine_share::install(app, &paths.data, m.clone()).with_context(|| tr!("Condivisione del motore", "Engine sharing"))?;
    Ok(m)
}

/// The catalog as it is on this computer now, and the model to load when the app opens, if any is on disk. Whoever needs
/// the names of the models and the default (the control server, the sharing of the engine) is told.
fn read_catalog(app: &AppHandle, paths: &Paths) -> Result<(Vec<engine_cfg::ModelEntry>, Option<String>)> {
    let hw = engine_cfg::detect(paths).with_context(|| tr!("Non riesco a guardare l'hardware di questo computer", "Cannot look at the hardware of this computer"))?;
    if let Some(e) = &hw.nvml_error {
        // The app starts anyway: the line says why an NVIDIA card runs without CUDA, or isn't used at all.
        startup_log(paths, &format!("NVML does not answer, the NVIDIA cards are read from DXGI without CUDA: {e}"));
    }
    let (catalog, _) = engine_cfg::catalog_for(paths, &hw).with_context(|| tr!("Elenco dei modelli", "Model list"))?;
    for v in catalog.iter().filter(|v| v.missing.is_some()) {
        eprintln!("model {} not available: {}", v.key, v.missing.as_deref().unwrap_or(""));
    }
    engine_share::offer(
        app,
        catalog
            .iter()
            .filter(|v| v.missing.is_none() && v.placement.is_some())
            .map(|v| engine::share::SharedModel { key: v.key.clone(), label: v.label.clone(), context: v.ctx, images: v.images })
            .collect(),
    );
    let default_model = engine_cfg::startup_model(paths, &catalog)?;
    // a list of servers that cannot be read is told by the page that shows it
    let server_default = agent_cfg::servers::read(paths).ok().and_then(|s| {
        let d = s.checked_default()?;
        let label = s.list.iter().find(|x| x.id == d.server)?.models.iter().find(|m| m.id == d.model)?.label();
        Some((format!("{}/{}", d.server, d.model), label))
    });
    let (server_model, server_label) = server_default.unzip();
    app.state::<AppState>().control.set_known(control::Known {
        labels: catalog.iter().map(|v| (v.key.clone(), v.label.clone())).collect(),
        default_model: default_model.clone(),
        server_model,
        server_label,
    });
    Ok((catalog, default_model))
}

/// `model` has just arrived on this computer: the catalog is read again, the interface is told (`catalog_revision`),
/// without a default saved it becomes it if it is the one to keep (`keep_default`: the first model downloaded that
/// fits), and the model to load is loaded if none is in use (`load_default`): the first model downloaded starts by itself.
pub(crate) fn models_arrived(app: &AppHandle, model: &str) {
    let st = app.state::<AppState>();
    let (Some(paths), Some((catalog, default))) = (st.paths.get(), catalog_read_again(app)) else { return };
    keep_default(app, paths, &catalog, Keep::Arrived(model));
    load_default(app, &catalog, default.as_deref());
}

/// A download ended without its model (failed, paused, cancelled), or the start has queued the updates of the engines:
/// if the default waits for its engine, what to load is decided again. Any other download ending changes nothing for
/// the model to load.
fn default_reconsidered(app: &AppHandle) {
    let st = app.state::<AppState>();
    let Some(paths) = st.paths.get() else { return };
    match read_catalog(app, paths) {
        Ok((catalog, default)) => {
            if catalog.iter().any(|e| Some(&e.key) == default.as_ref() && e.waits_engine) {
                load_default(app, &catalog, default.as_deref());
            }
        }
        Err(e) => startup_log(paths, &format!("the model to load was not decided after a download stopped: {e:#}")),
    }
}

/// The engine a download brings is on the disk while its files still come: a default that waited for that engine loads
/// now, not when the whole download ends; the model in use moves where its plan now puts it (the integrated graphics,
/// whose engine this was).
fn engine_arrived(app: &AppHandle) {
    if let Some(engine) = app.state::<AppState>().engine.get() {
        engine.reload_if_changed();
    }
    if app.state::<AppState>().awaited.lock().unwrap().is_none() {
        return;
    }
    if let Some((catalog, default)) = catalog_read_again(app) {
        load_default(app, &catalog, default.as_deref());
    }
}

/// The only place that loads a model by itself when none is in use (`engine_cfg::model_to_load`): the default once it is
/// ready, also after a start that failed while the app waited for its engine; nothing while a download brings that
/// engine; a model that is ready when none does.
pub(crate) fn load_default(app: &AppHandle, catalog: &[engine_cfg::ModelEntry], default: Option<&str>) {
    let st = app.state::<AppState>();
    let (Some(paths), Some(engine), Some(downloads)) = (st.paths.get(), st.engine.get(), st.downloads.get()) else { return };
    if st.remote.lock().unwrap().is_some() {
        return;
    }
    // With the default on a server the local model starts only when it is chosen; a list that cannot be read is told by
    // whoever shows it.
    if agent_cfg::servers::read(paths).is_ok_and(|s| s.checked_default().is_some()) {
        return;
    }
    let state = engine.state();
    let mut awaited = st.awaited.lock().unwrap();
    let engine_now = match (&state.failed, state.phase) {
        _ if state.chosen.is_some() => engine_cfg::EngineNow::Busy,
        (None, engine::Phase::Stopped) if state.model.is_none() => engine_cfg::EngineNow::Free,
        // Any other failure is one the user sees, with its way to try again: it is left alone.
        (Some(failed), engine::Phase::Stopped | engine::Phase::Error) if awaited.as_deref() == Some(failed.model.as_str()) => {
            engine_cfg::EngineNow::Failed(failed.model.clone())
        }
        _ => engine_cfg::EngineNow::Busy,
    };
    let (live, removing) = (downloads.live(), downloads.removals());
    let situation = engine_cfg::Situation { entries: catalog, default, engine: &engine_now, live: &live, removing: &removing };
    let load = engine_cfg::model_to_load(&situation);
    *awaited = default.filter(|_| load == engine_cfg::Load::Wait).map(str::to_string);
    drop(awaited);
    if let engine_cfg::Load::Model(key) = load {
        if let Some(default) = default.filter(|d| *d != key) {
            startup_log(paths, &format!("{default} cannot be loaded now: {key} loads instead"));
        }
        engine.choose(&key);
    }
}

/// The files of the models changed on the disk: the catalog is read again and the interface is told, also when the
/// catalog cannot be read (what it shows is no longer sure). The answer is the catalog and the model to load when the
/// app opens.
fn catalog_read_again(app: &AppHandle) -> Option<(Vec<engine_cfg::ModelEntry>, Option<String>)> {
    let st = app.state::<AppState>();
    let paths = st.paths.get()?;
    let read = read_catalog(app, paths);
    st.control.catalog_changed();
    match read {
        Ok((catalog, default_model)) => {
            agent_models::tell(app, paths, &catalog, default_model.as_deref());
            Some((catalog, default_model))
        }
        Err(e) => {
            startup_log(paths, &format!("the catalog was not read again after a download: {e:#}"));
            None
        }
    }
}

/// The user changed a choice about the models or the computer, or took a model off it: the catalog is read again, the
/// interface is told, and a running model whose plan is no longer the same is loaded again when it has no answer in
/// progress. The answer is the catalog and the default model, if it was read.
pub(crate) fn choices_changed(app: &AppHandle) -> Option<(Vec<engine_cfg::ModelEntry>, Option<String>)> {
    let st = app.state::<AppState>();
    let (Some(paths), Some(engine)) = (st.paths.get(), st.engine.get()) else { return None };
    let catalog = match read_catalog(app, paths) {
        Ok((catalog, default_model)) => {
            agent_models::tell(app, paths, &catalog, default_model.as_deref());
            Some((catalog, default_model))
        }
        Err(e) => {
            startup_log(paths, &format!("the catalog was not read again after a choice: {e:#}"));
            None
        }
    };
    st.control.catalog_changed();
    engine.reload_if_changed();
    catalog
}

/// When `keep_default` is asked: at the start, with the model 0.1.2 used last (`model.txt`), if any; or when a model
/// arrived on the computer (downloaded, or a file of the user's added).
pub(crate) enum Keep<'a> {
    Start(Option<&'a str>),
    Arrived(&'a str),
}

/// The model a computer starts with does not change by itself: without a default saved, the model to keep
/// (`engine_cfg::default_to_save`: one on the disk that fits, the one of 0.1.2 first) is saved as the default, so that a
/// model arriving later does not take its place. A model that arrived is saved only if it is that one. Not with another
/// PC's engine in use, nor for a model being taken off the computer; it is not asked when the default is taken off:
/// then there is none until the next start or the next model that arrives. The answer is the model saved; one that
/// cannot be saved leaves the rule of the catalog's order, and the log says why.
pub(crate) fn keep_default(app: &AppHandle, paths: &Paths, catalog: &[engine_cfg::ModelEntry], when: Keep) -> Option<String> {
    let st = app.state::<AppState>();
    if st.remote.lock().unwrap().is_some() {
        return None;
    }
    let remembered = match when {
        Keep::Start(remembered) => remembered,
        Keep::Arrived(_) => None,
    };
    let key = match engine_cfg::default_to_save(paths, catalog, remembered) {
        Ok(key) => key?,
        Err(e) => {
            startup_log(paths, &format!("the default model to keep was not read: {e:#}"));
            return None;
        }
    };
    let removing = st.downloads.get().is_some_and(|d| d.removing(&key));
    if removing || matches!(when, Keep::Arrived(model) if model != key) {
        return None;
    }
    match engine_cfg::choices::set_default_if_none(paths, &key) {
        Ok(()) => Some(key),
        Err(e) => {
            startup_log(paths, &format!("the default model was not saved: {e:#}"));
            None
        }
    }
}

/// This computer's models for the agent: every local model of the catalog, on disk or not (a model downloaded later needs
/// no new agent), and the one to load when the app opens, if any is on disk.
fn local_models(app: &AppHandle, paths: &Paths) -> Result<EngineUse> {
    *app.state::<AppState>().remote.lock().unwrap() = None;
    let (mut catalog, mut default_model) = read_catalog(app, paths)?;
    // 0.1.2 started with the model used last, written in `model.txt`: the first start without a default saved keeps it.
    // Once a default is saved the file has done its work and goes.
    let remembered_file = paths.data.join("model.txt");
    let remembered = std::fs::read_to_string(&remembered_file).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(kept) = keep_default(app, paths, &catalog, Keep::Start(remembered.as_deref())) {
        match std::fs::remove_file(&remembered_file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => startup_log(paths, &format!("{} was not removed: {e}", remembered_file.display())),
            _ => {}
        }
        // the model of 0.1.2 is not the one the catalog's order gave: the model to load is read again with it
        if default_model.as_deref() != Some(kept.as_str()) {
            (catalog, default_model) = read_catalog(app, paths)?;
        }
    }
    let default_waits = default_model.as_ref().is_some_and(|key| catalog.iter().any(|e| &e.key == key && e.waits_engine));
    Ok(EngineUse {
        url: format!("http://127.0.0.1:{}", engine_port()),
        key: None,
        default_model,
        default_waits,
        models: agent_models::of(&catalog),
    })
}

/// The Team's key, from the Credential Manager. Without it, or if the Manager does not answer, the Team does not start
/// (the Team page says so and shows the error), and the rest of the app does.
fn team_key() -> Option<String> {
    mango_common::credentials::read(agent_cfg::team::CREDENTIAL).unwrap_or_else(|e| {
        eprintln!("Team off: the Credential Manager does not answer: {e:#}");
        None
    })
}

/// `service.json`: where the agent, the engine and the control server are, and the process that holds them
/// (docs/INTEGRATION.md). It is written as soon as the agent answers, before the model is loaded, and removed on exit: an
/// app that finds it with a live process knows it can talk, and asks the engine for the model it wants. `local`: the engine
/// in use is this PC's; with another PC's, `engine` is `null`.
fn write_service_file(agent: &str, control: &str, local: bool) -> Result<()> {
    let f = mango_common::service_file()?;
    let v = serde_json::json!({
        "version": 1,
        "pid": std::process::id(),
        "agent": agent,
        "engine": local.then_some(control),
        "control": control,
        "window": !service_mode(),
    });
    mango_common::write_atomic(&f, serde_json::to_string_pretty(&v)?).with_context(|| tr!("scrittura di {}", "writing {}", f.display()))
}

/// While the app is not ready: why, where the other apps read it (`reason` in `service.json`, see
/// docs/INTEGRATION.md). A service that is already ready (with the agent) is left alone: startup did not fail.
fn write_reason(reason: &str) {
    let Ok(f) = mango_common::service_file() else { return };
    let ready = std::fs::read_to_string(&f)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("agent").is_some());
    if ready {
        return;
    }
    let v = serde_json::json!({ "version": 1, "pid": std::process::id(), "reason": reason, "window": !service_mode() });
    if let Err(e) = mango_common::write_atomic(&f, serde_json::to_string_pretty(&v).unwrap_or_default()) {
        eprintln!("service.json not written ({}): {e}", f.display());
    }
}

/// An agent that ends by itself (a crash, the memory, an antivirus) after a start that went to its end is started again:
/// the window would otherwise keep asking an address nobody answers. One the app stopped (a restart, the quit) is no
/// longer the supervisor's child. One that ends again soon after it was started again is not started a third time: the
/// error screen says so, with Retry.
fn watch_the_agent(app: &AppHandle) {
    const AGAIN_WITHIN: Duration = Duration::from_secs(120);
    static RESTARTED: Mutex<Option<Instant>> = Mutex::new(None);
    let st = app.state::<AppState>();
    let (Some(pid), Some(paths)) = (st.sup.get().and_then(|s| s.pid(agent_cfg::PROCESS)), st.paths.get().cloned()) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        if !matches!(mango_common::stragglers::wait_for_exit(pid, None), mango_common::stragglers::Waited::Ended) {
            return;
        }
        if app.state::<AppState>().sup.get().and_then(|s| s.pid(agent_cfg::PROCESS)) != Some(pid) {
            return;
        }
        let lines = mango_common::tail(&paths.logs().join(format!("{}.log", agent_cfg::PROCESS)), 12);
        let mut restarted = RESTARTED.lock().unwrap();
        if restarted.is_some_and(|at| at.elapsed() < AGAIN_WITHIN) {
            drop(restarted);
            let e = anyhow::anyhow!("{lines}");
            return set_error(&app, &tr!("L'agente si è chiuso di nuovo da solo", "The agent closed by itself again"), &e);
        }
        *restarted = Some(Instant::now());
        drop(restarted);
        startup_log(&paths, &format!("the agent ended by itself, it starts again; its last lines:\n{lines}"));
        restart(&app);
    });
}

fn spawn_startup(app: AppHandle) {
    std::thread::spawn(move || match startup(&app) {
        Ok(()) => watch_the_agent(&app),
        Err(e) => set_error(&app, &tr!("Mango Code non è riuscito ad avviarsi", "Mango Code could not start"), &e),
    });
}

pub fn run() {
    let mut context = tauri::generate_context!();
    // One instance per data folder: the tests (MANGO_DATA) run next to the real app, each with its own.
    if let Some(data) = std::env::var_os("MANGO_DATA") {
        let mut hash = std::hash::DefaultHasher::new();
        std::hash::Hash::hash(&data, &mut hash);
        let identifier = format!("{}.test{:x}", context.config().identifier, std::hash::Hasher::finish(&hash));
        context.config_mut().identifier = identifier;
    }
    // The second start brings the window of the running one to the front and, if it has a folder, opens it there.
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Development builds only: the tests cannot click the Windows icon, and ask its «Settings…» this way.
            if cfg!(debug_assertions) && argv.iter().any(|a| a == "--test-tray-settings") {
                return tray::open_settings(app, "models");
            }
            if cfg!(debug_assertions) && argv.iter().any(|a| a == "--test-tray-quit") {
                return tray::quit(app);
            }
            match folder::requested_folder(&argv) {
                Some(path) => folder::open(app, path),
                None => tray::show(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(ui_state::UiState::new())
        .invoke_handler(bridge::handlers!(
            startup_status,
            language,
            retry_startup,
            open_logs
        ))
        .setup(|app| {
            bridge::install(app)?;
            updater::install(app)?;
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mango Code")
                .inner_size(1360.0, 880.0)
                .min_inner_size(900.0, 600.0)
                // Ctrl+ / Ctrl- / Ctrl+0 and Ctrl+wheel: the browser's own zoom (`zoom.rs` remembers it)
                .zoom_hotkeys_enabled(true)
                // Shown after `paint_ground` below: the system's theme is known only once the window exists, and
                // the window must not appear in the wrong ground first.
                .visible(false);
            if let Some(port) = window_cdp_port() {
                app.state::<AppState>().ports.add(port);
            }
            let main = bridge::window(window_profile(window), app.handle()).build()?;
            // No theme is forced on the window: the title bar and the ground follow the system's.
            paint_ground(&main, main.theme().unwrap_or(tauri::Theme::Dark));
            if !service_mode() {
                main.show()?;
            }
            allow_microphone(&main);
            if let Ok(file) = mango_common::zoom_file() {
                zoom::install(&main, file);
            }
            let _ = app.state::<AppState>().main.set(main);
            // The Preview panel is born with the window and before the agent: the browser
            // server connects to its port. If it is not born the app starts anyway, with the
            // external browser (see `startup`).
            if let Err(e) = preview::install(app.handle()) {
                eprintln!("Preview panel not available: {e:#}");
            }
            // The tray icon: the X hides the window, the icon reopens it, "Quit" closes.
            tray::install(app.handle())?;
            // Launched with a folder (File Explorer): it becomes the open project at the end of startup.
            if let Some(path) = folder::requested_folder(&std::env::args().collect::<Vec<_>>()) {
                folder::open(app.handle(), path);
            }
            phone::install(app.handle());
            spawn_startup(app.handle().clone());
            Ok(())
        })
        .build(context)
        .expect("Tauri startup")
        .run(|app, ev| match ev {
            // Window close. Once the agent runs, the X only hides the window: the app stays alive (and with it the
            // loaded model) and reopens from the tray icon, whose "Quit" stops everything. Before that (startup, a
            // startup error) there is nothing to keep alive and the X quits.
            RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
                api.prevent_close();
                if app.state::<AppState>().agent.lock().unwrap().is_none() {
                    tray::quit(app);
                } else if let Some(w) = main_window(app) {
                    close_notice::on_close(&w);
                }
            }
            RunEvent::WindowEvent { label, event: tauri::WindowEvent::ThemeChanged(theme), .. } if label == "main" => {
                if let Some(w) = main_window(app) {
                    paint_ground(&w, theme);
                }
            }
            // The end of the app waits for a move under way to stop, in a thread: the window goes on answering meanwhile.
            RunEvent::ExitRequested { api, code, .. } => {
                if app.state::<AppState>().models_move.ask_to_quit() {
                    api.prevent_exit();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        app.state::<AppState>().models_move.wait_stopped();
                        app.exit(code.unwrap_or(0));
                    });
                }
            }
            RunEvent::Exit => {
                ui_state::settle(app);
                if let Ok(f) = mango_common::service_file() {
                    let _ = std::fs::remove_file(f);
                }
                stop_children(app);
            }
            _ => {}
        });
}

/// The WebView2 profile every window of the app opens: two windows on the same folder with different options do not start,
/// so the one that reads the old storage (`old_origin.rs`) is built with the same.
pub(crate) fn window_profile<'a, M: Manager<tauri::Wry>>(mut window: WebviewWindowBuilder<'a, tauri::Wry, M>) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    // An instance with its own data (MANGO_DATA) keeps its own WebView2 data too, next to the real app's.
    if let Some(d) = std::env::var_os("MANGO_DATA") {
        window = window.data_directory(std::path::PathBuf::from(d).join("finestra"));
    }
    // For tests that click in the window: remote debugging on the main window only. Through
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS it would apply to the Preview panel too and replace its port, and
    // the agent would have no panel.
    if let Some(port) = window_cdp_port() {
        window = window.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ));
    }
    window
}

/// The remote debugging port of the window, for the tests that drive it (`MANGO_WINDOW_CDP`).
fn window_cdp_port() -> Option<u16> {
    std::env::var("MANGO_WINDOW_CDP").ok().and_then(|p| p.parse().ok())
}

/// The page of the window is the agent's web interface (not the app's own loading or error page).
pub(crate) fn on_agent_page(window: &tauri::WebviewWindow) -> bool {
    window.url().is_ok_and(|url| url.host_str() == Some("127.0.0.1") && url.port() == Some(agent_port()))
}

/// What shows where the page does not reach (a window being resized, a page changing): the ground of the page for the
/// theme of the system, not white.
fn paint_ground(window: &tauri::WebviewWindow, theme: tauri::Theme) {
    let ground = match theme {
        tauri::Theme::Light => tauri::window::Color(241, 240, 235, 255),
        _ => tauri::window::Color(21, 21, 24, 255),
    };
    if let Err(e) = window.set_background_color(Some(ground)) {
        eprintln!("Window background not set: {e}");
    }
}

/// The dictation asks the window for the microphone. Edge's own question ("127.0.0.1:4196 wants to use your microphones")
/// means nothing to who dictates and, answered "Block", leaves a refusal the message does not explain: the window
/// says yes for the microphone, and only for that. Windows' own privacy switch still decides.
fn allow_microphone(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    let result = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("Microphone permission handler not installed: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("Microphone permission handler not installed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{choose_port, progress, start_on_a_free_port, wait_until_free, PORT_ATTEMPTS};
    use std::time::{Duration, Instant};

    /// The bar of each stage of a start, in order: every stage is told how many stages the one before had.
    fn bar(stages: &[&str]) -> Vec<(u8, u8)> {
        let mut before = 0;
        stages
            .iter()
            .map(|stage| {
                let at = progress(stage, before);
                before = at.1;
                at
            })
            .collect()
    }

    #[test]
    fn the_bar_advances_one_piece_at_each_stage_and_is_full_when_the_app_is_ready() {
        assert_eq!(bar(&["startup", "agent", "ready"]), [(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn a_start_through_another_pcs_engine_has_one_stage_more_and_never_goes_back() {
        let stages = bar(&["startup", "engine", "agent", "ready"]);
        assert_eq!(stages, [(1, 3), (2, 4), (3, 4), (4, 4)]);
        let filled: Vec<f32> = stages.iter().map(|(step, steps)| f32::from(*step) / f32::from(*steps)).collect();
        assert!(filled.windows(2).all(|pair| pair[0] < pair[1]), "{filled:?}");
    }

    #[test]
    fn the_next_start_begins_again_from_the_stages_of_this_pc() {
        assert_eq!(bar(&["startup", "engine", "agent", "ready", "startup", "agent"])[4..], [(1, 3), (2, 3)]);
    }

    fn free() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn a_free_preferred_port_is_kept() {
        let preferred = free();
        assert_eq!(choose_port(preferred, None), preferred);
        assert_eq!(choose_port(preferred, Some(free())), preferred);
    }

    #[test]
    fn a_busy_preferred_port_gives_the_last_one_while_it_is_free_and_otherwise_another_that_is_free() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = held.local_addr().unwrap().port();
        let previous = free();
        assert_eq!(choose_port(busy, Some(previous)), previous);
        let chosen = choose_port(busy, None);
        assert_ne!(chosen, busy);
        assert!(std::net::TcpListener::bind(("127.0.0.1", chosen)).is_ok());
        let also_busy = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let other = choose_port(busy, Some(also_busy.local_addr().unwrap().port()));
        assert!(other != busy && other != also_busy.local_addr().unwrap().port());
    }

    #[test]
    fn a_port_taken_between_the_choice_and_the_bind_gives_another_start() {
        // Another program binds the port the app has just chosen, before the agent does. It holds it from the start:
        // a port freed and bound again could go to a test running alongside in between.
        let thief = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = thief.local_addr().unwrap().port();
        let (mut choices, mut stops, mut told) = (0, 0, Vec::new());
        let port = start_on_a_free_port(
            || {
                choices += 1;
                if choices == 1 { preferred } else { choose_port(preferred, None) }
            },
            |port| if port == preferred { anyhow::bail!("address in use") } else { Ok(port) },
            || stops += 1,
            |port, attempt| told.push((port, attempt)),
        )
        .unwrap();
        assert_ne!(port, preferred);
        assert_eq!((stops, told), (1, vec![(preferred, 1)]));
    }

    #[test]
    fn a_start_that_fails_for_another_reason_is_not_tried_again() {
        let (mut starts, mut stops) = (0, 0);
        let error = start_on_a_free_port(
            || free(),
            |_| -> anyhow::Result<()> {
                starts += 1;
                anyhow::bail!("the agent crashed")
            },
            || stops += 1,
            |_, _| panic!("the port was not taken"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("crashed"));
        assert_eq!((starts, stops), (1, 1));
    }

    #[test]
    fn a_port_taken_every_time_ends_in_the_error_after_a_few_attempts() {
        let mut thieves = Vec::new();
        let mut starts = 0;
        let error = start_on_a_free_port(
            || free(),
            |port| -> anyhow::Result<()> {
                starts += 1;
                thieves.push(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
                anyhow::bail!("address in use")
            },
            || {},
            |_, _| {},
        )
        .unwrap_err();
        assert!(error.to_string().contains("address in use"));
        assert_eq!(starts, PORT_ATTEMPTS);
    }

    #[test]
    fn the_wait_for_the_preferred_port_ends_when_it_is_released_or_when_the_time_is_up() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!wait_until_free(port, Duration::from_millis(250)));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let start = Instant::now();
        assert!(wait_until_free(port, Duration::from_secs(10)));
        assert!(start.elapsed() < Duration::from_secs(5));
        releaser.join().unwrap();
        assert!(wait_until_free(free(), Duration::ZERO), "a free port does not wait");
    }
}
