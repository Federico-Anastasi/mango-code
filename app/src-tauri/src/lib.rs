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
mod chrome;
mod control;
mod downloads;
mod dictation;
mod model_choices;
mod preview;
mod supervisor;
mod stragglers;
mod team;
mod phone;
mod engine_share;
mod engine_remote;
mod tray;
mod report;
mod updater;
mod zoom;

use anyhow::{Context, Result};
use mango_common::{port_busy, free_port, tr, Paths};
use engine::EngineManager;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use supervisor::Supervisor;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Port of the agent server. Fixed on purpose: the web UI saves projects and preferences
/// per origin (http://127.0.0.1:<port>), a different port at every start would lose them.
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
pub(crate) fn agent_port() -> u16 {
    port_from_env("MANGO_AGENT_PORT", AGENT_PORT)
}
fn engine_port() -> u16 {
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
}

#[derive(Default)]
struct AppState {
    status: Mutex<Status>,
    sup: OnceLock<Supervisor>,
    /// The control server: the engine manager, born before any model. It lives as long as the app, across "Retry" attempts.
    engine: OnceLock<EngineManager>,
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
    /// What the control server's routes remember (`control.rs`).
    control: control::Shared,
    /// The models being downloaded (`downloads.rs`), born at the first startup.
    downloads: OnceLock<downloads::Downloads>,
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
    publish(app, Status { stage: stage.into(), detail: detail.into(), ..Default::default() });
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
        if let (Some(window), Some(page)) = (st.main.get(), st.app_page.get()) {
            set_status(app, "startup", tr!("Preparazione", "Preparing"));
            let _ = window.navigate(page.clone());
        }
    }
    if let Some(s) = st.sup.get() {
        s.shutdown();
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

fn startup(app: &AppHandle) -> Result<()> {
    let st = app.state::<AppState>();
    let t0 = std::time::Instant::now();
    set_status(app, "startup", tr!("Preparazione", "Preparing"));
    let paths = Paths::discover().with_context(|| tr!("Impossibile trovare i file di Mango Code", "Cannot find the Mango Code files"))?;
    let paths = st.paths.get_or_init(|| paths).clone();
    // One line per phase, with the time since the start: where a slow startup spends its time.
    let phase = |name: &str| startup_log(&paths, &format!("startup: {name} (+{} ms)", t0.elapsed().as_millis()));
    phase("begins");
    // Dictation, the microphone in the chat: off until the user turns it on, then it downloads and starts by itself once the
    // app is ready (`dictation.rs`). The agent only needs to know where the service will be.
    if st.dictation.get().is_none() {
        dictation::install(app, &paths, free_port(VOICE_PORT).unwrap_or(VOICE_PORT));
    }
    let sup = match st.sup.get() {
        Some(s) => s,
        None => {
            let s = Supervisor::new(&paths.logs())?;
            let _ = st.sup.set(s);
            st.sup.get().unwrap()
        }
    };

    // The PC's development tools are detected meanwhile; they are awaited right before the agent config.
    let tools = {
        let data = paths.data.clone();
        std::thread::spawn(move || agent_cfg::tools::update(&data))
    };

    let engine = control_server(app, &paths)?;
    phase("control server");
    // The downloads of the last time go on once the window is in use (`restore`, at the end).
    let downloads = st.downloads.get_or_init(|| {
        let (arrived, changed, logs) = (app.clone(), app.clone(), paths.clone());
        downloads::Downloads::new(
            Box::new(downloads::Real { paths: paths.clone(), hardware: engine_cfg::detect }),
            paths.data.join("downloads.json"),
            downloads::Tell {
                arrived: Box::new(move |model| models_arrived(&arrived, model)),
                changed: Box::new(move |_| {
                    catalog_read_again(&changed);
                }),
                log: Box::new(move |line| startup_log(&logs, &format!("downloads: {line}"))),
            },
        )
    });

    // --- the models the agent knows: those of another PC if the user chose its engine, otherwise this computer's catalog
    let used = match engine_remote::start(app, &paths)? {
        Some(used) => used,
        None => local_models(app, &paths)?,
    };
    let remote = used.key.is_some();
    phase("models");

    // --- agent server
    set_status(app, "agent", tr!("Avvio dell'agente", "Starting the agent"));
    // The agent's browser is the Preview panel: its port changes at every start and lives only in
    // the process environment. If the panel was not created (0) the browser server falls back to
    // the external browser, as it did before.
    let browser = agent_cfg::BrowserInputs {
        preview_port: app.try_state::<preview::Panel>().map(|p| p.cdp_port).unwrap_or(0),
        choice: chrome::choice_file().with_context(|| tr!("Percorso della scelta del browser", "Browser choice path"))?,
    };
    let port = agent_port();
    if port_busy(port) {
        anyhow::bail!(
            "{}",
            tr!(
                "La porta {port} è occupata: probabilmente un altro programma la sta usando. \
                 Chiudilo e riapri l'app.",
                "Port {port} is busy: another program is probably using it. \
                 Close it and reopen the app."
            )
        );
    }
    let mut agent_plan = agent_cfg::plan(
        &paths,
        &agent_cfg::AgentInputs {
            engine_url: used.url.clone(),
            control_url: format!("http://127.0.0.1:{}", engine_port()),
            engine_key: used.key.clone(),
            models: used.models.clone(),
            default_model: used.default_model.clone(),
            port,
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
        },
    )
    .with_context(|| tr!("Configurazione dell'agente", "Agent configuration"))?;
    // Bun and the servers the agent starts do not read Windows' proxy: they get it as variables, with the engine left out of it.
    agent_plan.spec.env.extend(mango_common::internet::child_proxy_env(&used.url));
    sup.spawn(&agent_plan.spec)?;
    sup.wait_ready(&agent_plan.spec, |_| {}).with_context(|| tr!("L'agente non è partito", "The agent did not start"))?;
    phase("agent");
    // From now on a change of this computer's models is told to the agent; another PC's are read at the start.
    match remote {
        true => st.declared.forget(),
        false => st.declared.launched(&used.models, used.default_model.as_deref()),
    }

    // The model loads in the background, and the manager tells how it goes: the default one, or the one that was in use before
    // the engine was stopped (the engine of another PC, then back to this one). A model that is running or loading is left
    // alone: only the agent started again.
    if !remote && engine.phase() == engine::Phase::Stopped {
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
    let page = match requested {
        Some(folder) => folder::page(&agent_plan.url, &folder)?,
        None => agent_plan.url.parse().with_context(|| tr!("URL dell'agente", "Agent URL"))?,
    };
    // At every attempt: a "Retry" after a startup that stopped before here takes them up, and they are taken up once.
    // What cannot be resumed or queued is not worth stopping an app that is already in use: it goes to the log.
    if let Err(e) = downloads.restore() {
        startup_log(&paths, &format!("downloads not resumed: {e:#}"));
    }
    win.navigate(page)?;
    phase("window on the home");
    // Then the engine the app came with, if models on the disk wait for it: it reads the hardware and the models (about
    // 150 ms measured, too long to keep the window waiting), while the interface loads; its first read of the state
    // comes later, and finds the engine coming.
    if let Err(e) = engine_cfg::detect().and_then(|hw| model_choices::engine_update(&paths, &hw, &downloads)) {
        startup_log(&paths, &format!("the new engine not queued: {e:#}"));
    }
    phase("engine update");
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
    // The style of the answers and the reasoning the user chose for each model: read at every request, so a change
    // applies from the next answer without loading the model again.
    let p = paths.clone();
    m.set_request_defaults(Box::new(move |key| engine_cfg::choices::request_defaults(&p, key)));
    // A model that goes on the cards does not start where other programs hold the memory it counts on: «Riprova» starts it
    // anyway. In development builds `MANGO_ROOM_CHECK_OFF` leaves the check out: the fake models of the integration tests
    // have a plan on this PC's real cards, which another program may be using.
    if !(cfg!(debug_assertions) && std::env::var_os("MANGO_ROOM_CHECK_OFF").is_some()) {
        let p = paths.clone();
        m.set_room_check(Box::new(move |key, lent, used| engine_cfg::taken_before_start(&p, &engine_cfg::detect()?, used, key, lent)));
    }
    engine::http::serve(m.clone(), manager_port, Some(std::sync::Arc::new(control::Routes(app.clone())))).with_context(|| tr!("Porta del motore", "Engine port"))?;
    let _ = st.engine.set(m.clone());
    engine_share::install(app, &paths.data, m.clone()).with_context(|| tr!("Condivisione del motore", "Engine sharing"))?;
    Ok(m)
}

/// The catalog as it is on this computer now, and the model to load when the app opens, if any is on disk. Whoever needs
/// the names of the models and the default (the control server, the sharing of the engine) is told.
fn read_catalog(app: &AppHandle, paths: &Paths) -> Result<(Vec<engine_cfg::ModelEntry>, Option<String>)> {
    let hw = engine_cfg::detect().with_context(|| tr!("Non riesco a guardare l'hardware di questo computer", "Cannot look at the hardware of this computer"))?;
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
    app.state::<AppState>().control.set_known(control::Known {
        labels: catalog.iter().map(|v| (v.key.clone(), v.label.clone())).collect(),
        default_model: default_model.clone(),
    });
    Ok((catalog, default_model))
}

/// `model` has just arrived on this computer: the catalog is read again, the interface is told (`catalog_revision`),
/// without a default saved it becomes it if it is the one to keep (`keep_default`: the first model downloaded that
/// fits), and, if no model is running, loading or failed, the one to load is loaded: the first model downloaded starts
/// by itself.
fn models_arrived(app: &AppHandle, model: &str) {
    let st = app.state::<AppState>();
    let (Some(paths), Some(engine), Some((catalog, Some(key)))) = (st.paths.get(), st.engine.get(), catalog_read_again(app)) else { return };
    keep_default(app, paths, &catalog, Keep::Arrived(model));
    let state = engine.state();
    let idle = state.phase == engine::Phase::Stopped && state.model.is_none() && state.failed.is_none() && state.chosen.is_none();
    let remote = st.remote.lock().unwrap().is_some();
    // A model being taken off the computer is not loaded, also if it is the one the catalog read before its files went.
    let removing = st.downloads.get().is_some_and(|d| d.removing(&key));
    if idle && !remote && !removing {
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
/// progress. The answer is the catalog, if it was read.
pub(crate) fn choices_changed(app: &AppHandle) -> Option<Vec<engine_cfg::ModelEntry>> {
    let st = app.state::<AppState>();
    let (Some(paths), Some(engine)) = (st.paths.get(), st.engine.get()) else { return None };
    let catalog = match read_catalog(app, paths) {
        Ok((catalog, default_model)) => {
            agent_models::tell(app, paths, &catalog, default_model.as_deref());
            Some(catalog)
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
    Ok(EngineUse {
        url: format!("http://127.0.0.1:{}", engine_port()),
        key: None,
        default_model,
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

fn spawn_startup(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = startup(&app) {
            set_error(&app, &tr!("Mango Code non è riuscito ad avviarsi", "Mango Code could not start"), &e);
        }
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
            match folder::requested_folder(&argv) {
                Some(path) => folder::open(app, path),
                None => tray::show(app),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(bridge::handlers!(
            startup_status,
            language,
            retry_startup,
            open_logs
        ))
        .setup(|app| {
            bridge::install(app)?;
            updater::install(app)?;
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mango Code")
                // The Windows title bar follows the window theme: dark like the app, instead of
                // the system white that clashes with the dark interface.
                .theme(Some(tauri::Theme::Dark))
                // What shows where the page does not reach (a window being resized, a page changing): the dark of the app, not white.
                .background_color(tauri::window::Color(21, 23, 31, 255))
                .inner_size(1360.0, 880.0)
                .min_inner_size(900.0, 600.0)
                // Ctrl+ / Ctrl- / Ctrl+0 and Ctrl+wheel: the browser's own zoom (`zoom.rs` remembers it)
                .zoom_hotkeys_enabled(true)
                .visible(!service_mode());
            // An instance with its own data (MANGO_DATA) keeps its own WebView2 data too: two WebView2 with
            // different options (the remote debugging of the tests) on the same folder do not start.
            if let Some(d) = std::env::var_os("MANGO_DATA") {
                window = window.data_directory(std::path::PathBuf::from(d).join("finestra"));
            }
            // For tests that click in the window: remote debugging on the main window only. Through
            // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS it would apply to the Preview panel too and replace its port, and
            // the agent would have no panel.
            if let Some(port) = std::env::var("MANGO_WINDOW_CDP").ok().and_then(|p| p.parse::<u16>().ok()) {
                window = window.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ));
            }
            let main = bridge::window(window, app.handle()).build()?;
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
            RunEvent::Exit => {
                if let Ok(f) = mango_common::service_file() {
                    let _ = std::fs::remove_file(f);
                }
                stop_children(app);
            }
            _ => {}
        });
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
