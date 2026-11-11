//! Mango Code, desktop app: one window.
//!
//! At startup the window shows the loading page (`ui/`); meanwhile a thread starts the engine and the agent server,
//! then moves the window to the web UI the server serves. Dictation, if the user wants it, comes after (`dictation.rs`).
//! The startup state is read with the `startup_status` command and arrives as the
//! `mango://status` event.

mod other_models;
mod bridge;
mod folder;
mod chrome;
mod dictation;
#[cfg(debug_assertions)]
mod fake;
mod mcp;
mod preview;
mod preparation;
mod first_run;
mod choice;
mod system;
mod supervisor;
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
use choice::Mode;
use serde::Serialize;
use std::sync::atomic::AtomicBool;
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
/// How long to wait for the agent's browser, web search and documents to connect (and reconnect).
const MCP_WAIT_MAX: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Clone, Serialize, Default)]
pub struct Status {
    /// "startup" | "choice" | "download" | "engine" | "agent" | "preparing" | "ready" | "error"
    pub stage: String,
    /// Text for the user, one line.
    pub detail: String,
    pub error: Option<ErrorInfo>,
    /// With "choice": what the model choice page shows.
    pub choice: Option<choice::Choice>,
    /// With "download": the progress of the steps.
    pub download: Option<first_run::Progress>,
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
    pub default_model: String,
}

#[derive(Default)]
struct AppState {
    status: Mutex<Status>,
    sup: OnceLock<Supervisor>,
    /// The engine manager: lives as long as the app, across "Retry" attempts.
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
    /// The address of the app's own page (loading, model choice), to come back to it from the web UI.
    app_page: OnceLock<tauri::Url>,
    /// Who waits for the answer to the choice page.
    choice: choice::Pending,
    /// The model choice opened from the tray is in progress.
    changing: AtomicBool,
    /// The agent server, when the app is ready.
    agent: Mutex<Option<String>>,
    /// A folder to open as a project that arrived before the agent was ready (`folder.rs`).
    folder: Mutex<Option<std::path::PathBuf>>,
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

pub(crate) fn set_error(app: &AppHandle, title: &str, err: &anyhow::Error) {
    let st = app.state::<AppState>();
    let logs = st.paths.get().map(|p| p.logs().display().to_string());
    // The error also goes to the log file: the screen shows it, but on narrow windows the box is
    // cut off and without the file nothing is left to read.
    if let Some(paths) = st.paths.get() {
        use std::io::Write;
        let _ = std::fs::create_dir_all(paths.logs());
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.logs().join("startup.log"))
        {
            let _ = writeln!(file, "{title}: {err:#}");
        }
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
    restart(&app, Mode::Startup { interactive: true });
}

/// The agent first (its running request drops and releases the engine), then the engine, which saves the open
/// conversation (up to a minute).
pub(crate) fn stop_children(app: &AppHandle) {
    let st = app.state::<AppState>();
    if let Some(s) = st.sup.get() {
        s.shutdown();
    }
    if let Some(m) = st.engine.get() {
        m.stop();
    }
    if let Some(d) = st.dictation.get() {
        d.shutdown();
    }
}

/// Stops the agent, removes the service file (the app is no longer ready) and starts again.
pub(crate) fn restart(app: &AppHandle, mode: Mode) {
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
    spawn_startup(app.clone(), mode);
}

#[tauri::command]
fn open_logs(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = state.paths.get().ok_or_else(|| tr!("percorsi non ancora noti", "paths not known yet"))?.logs();
    app.opener().open_path(p.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

fn startup(app: &AppHandle, mode: Mode) -> Result<()> {
    let st = app.state::<AppState>();
    set_status(app, "startup", tr!("Preparazione", "Preparing"));
    let paths = Paths::discover().with_context(|| tr!("Impossibile trovare i file di Mango Code", "Cannot find the Mango Code files"))?;
    let paths = st.paths.get_or_init(|| paths).clone();
    // Dictation, the microphone in the chat: off until the user turns it on (the first start page asks), then it downloads
    // and starts by itself once the app is ready (`dictation.rs`). The agent only needs to know where the service will be.
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

    // The PC's development tools are detected while the engine loads the model (tens of
    // seconds), so they cost nothing at startup. They are awaited right before the agent config.
    let tools = {
        let data = paths.data.clone();
        std::thread::spawn(move || agent_cfg::tools::update(&data))
    };

    // --- engine: the one of another PC if the user chose it, otherwise this computer's (choice and download first)
    let used = match engine_remote::start(app, &paths)? {
        Some(used) => used,
        None => match local_engine(app, &paths, mode)? {
            Some(used) => used,
            // The choice page was answered with the engine of another PC.
            None => engine_remote::start(app, &paths)?.with_context(|| tr!("Il codice dell'altro PC non c'è più", "The code of the other PC is gone"))?,
        },
    };
    let remote = used.key.is_some();

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
            engine_key: used.key.clone(),
            models: used.models,
            default_model: used.default_model,
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
    connect_tools(app, &agent_plan.url);
    // The engine of another PC reads the base of the prompt where it is: there is nothing to prepare on this PC.
    if !remote {
        prepare_model(app, &agent_plan.url);
    }

    // --- the window moves to the web UI, and the other apps can find it
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
    write_service_file(&agent_plan.url, (!remote).then_some(used.url.as_str()))?;
    let win = app
        .state::<AppState>()
        .main
        .get()
        .cloned()
        .with_context(|| tr!("finestra principale sparita", "main window gone"))?;
    let page = match requested {
        Some(folder) => folder::page(&agent_plan.url, &folder)?,
        None => start_page(&agent_plan.url).parse().with_context(|| tr!("URL dell'agente", "Agent URL"))?,
    };
    win.navigate(page)?;
    Ok(())
}

/// This computer's engine: the choice and download of what is missing, the manager on its port, and the model the last time (or the
/// default). `None` if the choice page was answered with the engine of another PC.
fn local_engine(app: &AppHandle, paths: &Paths, mode: Mode) -> Result<Option<EngineUse>> {
    let st = app.state::<AppState>();
    {
        let system = system::choose(paths)?;
        if let choice::Outcome::Switched = choice::ensure(app, paths, &*system, mode)? {
            return Ok(None);
        }
        set_status(app, "startup", tr!("Preparazione", "Preparing"));
    }
    *st.remote.lock().unwrap() = None;

    // --- engine: the manager on the fixed port, which starts the model the conversations ask for
    set_status(app, "engine", tr!("Avvio del motore", "Starting the engine"));
    let (catalog, default_model) = engine_cfg::catalog(paths).with_context(|| tr!("Elenco dei modelli", "Model list"))?;
    let available: Vec<&engine_cfg::ModelEntry> = catalog.iter().filter(|v| v.missing.is_none()).collect();
    for v in catalog.iter().filter(|v| v.missing.is_some()) {
        eprintln!("model {} not available: {}", v.key, v.missing.as_deref().unwrap_or(""));
    }
    if available.is_empty() {
        anyhow::bail!(
            "{}",
            tr!(
                "Nessun modello è sul disco: i file vanno nella cartella {}. (dettaglio tecnico: {})",
                "No model is on disk: the files go in the {} folder. (technical detail: {})",
                paths.models.display(),
                catalog.iter().filter_map(|v| v.missing.clone()).collect::<Vec<_>>().join("; ")
            )
        );
    }
    let engine = match st.engine.get() {
        Some(m) => m.clone(),
        None => {
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
                Some(paths.data.join("model.txt")),
            );
            engine::http::serve(m.clone(), manager_port).with_context(|| tr!("Porta del motore", "Engine port"))?;
            let _ = st.engine.set(m.clone());
            engine_share::install(app, &paths.data, m.clone()).with_context(|| tr!("Condivisione del motore", "Engine sharing"))?;
            m
        }
    };
    engine_share::offer(
        app,
        available
            .iter()
            .filter(|v| v.placement.is_some())
            .map(|v| engine::share::SharedModel { key: v.key.clone(), label: v.label.clone(), context: v.ctx, images: v.images })
            .collect(),
    );
    // The model of the last time, if it is still there and fits; otherwise the default, otherwise the first that fits.
    let ready = |k: &str| available.iter().any(|v| v.key == k && v.placement.is_some());
    let initial = engine
        .remembered()
        .filter(|k| ready(k))
        .or_else(|| ready(&default_model).then(|| default_model.clone()))
        .or_else(|| available.iter().find(|v| v.placement.is_some()).map(|v| v.key.clone()))
        .with_context(|| {
            tr!(
                "Nessuno dei modelli sul computer ci sta nella sua memoria. Scegline uno più piccolo da «Modelli e motore», nel menu \
                 dell'icona di Mango Code.",
                "None of the models on this computer fits in its memory. Pick a smaller one from \"Models and engine\" in the menu \
                 of the Mango Code icon."
            )
        })?;
    let entry = available.iter().find(|v| v.key == initial).expect("chosen among the available");
    let placement = if entry.placement == Some(engine_cfg::Placement::Cpu) {
        tr!(" sul processore, più lento", " on the processor, slower")
    } else {
        String::new()
    };
    engine
        .start(&initial, &mut |s| {
            set_status(app, "engine", tr!("Caricamento del modello {}{placement} ({s} s)", "Loading the model {}{placement} ({s} s)", entry.label))
        })
        .with_context(|| tr!("Il motore non è partito", "The engine did not start"))?;
    let engine_plan = engine
        .running_plan()
        .with_context(|| tr!("il motore si è spento subito dopo l'avvio", "the engine stopped right after starting"))?;
    Ok(Some(EngineUse {
        url: format!("http://127.0.0.1:{}", engine_port()),
        key: None,
        // The context of the running model is the one of its plan (the split can reduce it); for the others the declared one
        // applies. In the web UI selector the name says where the model runs when it is not on the GPUs: whoever picks it
        // reads that before waiting.
        models: available
            .iter()
            .map(|v| agent_cfg::AgentModel {
                key: v.key.clone(),
                label: v.label.clone(),
                ctx: if v.key == engine_plan.key { engine_plan.ctx } else { v.ctx },
                images: v.images,
                info: agent_cfg::ModelInfo {
                    bytes: Some(v.bytes),
                    place: match v.placement {
                        Some(engine_cfg::Placement::Gpu) => "gpu",
                        Some(engine_cfg::Placement::Cpu) => "cpu",
                        None => "none",
                    },
                    speed: v.speed.map(|s| s.as_str().to_string()),
                    weak: v.on_request,
                },
            })
            .collect(),
        default_model: engine_plan.key.clone(),
    }))
}

/// The Team's key, from the Credential Manager. Without it, or if the Manager does not answer, the Team does not start
/// (the Team page says so and shows the error), and the rest of the app does.
fn team_key() -> Option<String> {
    mango_common::credentials::read(agent_cfg::team::CREDENTIAL).unwrap_or_else(|e| {
        eprintln!("Team off: the Credential Manager does not answer: {e:#}");
        None
    })
}

/// `service.json`: where the agent and the engine are, and the process that holds them (docs/INTEGRATION.md). It is
/// written at "ready" and removed on exit: an app that finds it with a live process knows it can talk. Without an engine
/// manager on this PC (the engine is another PC's) `engine` is `null`.
fn write_service_file(agent: &str, engine: Option<&str>) -> Result<()> {
    let f = mango_common::service_file()?;
    let v = serde_json::json!({
        "version": 1,
        "pid": std::process::id(),
        "agent": agent,
        "engine": engine,
        "window": !service_mode(),
    });
    mango_common::write_atomic(&f, serde_json::to_string_pretty(&v)?).with_context(|| tr!("scrittura di {}", "writing {}", f.display()))
}

/// While the app is not ready: why, where the other apps read it (`reason` in `service.json`, see
/// docs/INTEGRATION.md). A service that is already ready (with the agent) is left alone: startup did not fail.
pub(crate) fn write_reason(reason: &str) {
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

/// Before "ready": the MCP tools of the conversation that reopens must be connected, otherwise the
/// first request has a different system prompt from the following ones and the engine rereads
/// everything (see `mcp.rs`). It does not block startup: if one does not connect, the app starts
/// anyway, warns on the loading page and writes it to the log.
fn connect_tools(app: &AppHandle, agent_url: &str) {
    let Some(folder) = mcp::last_session_dir(agent_url) else {
        // No conversation to reopen: the MCPs start at the first request, and the server makes it
        // wait until they are connected.
        return;
    };
    set_status(app, "agent", tr!("Collego browser, ricerca web e documenti", "Connecting the browser, web search and documents"));
    let outcome = mcp::wait(agent_url, &folder, MCP_WAIT_MAX, &mut |phrase| set_status(app, "agent", phrase));
    if outcome.missing.is_empty() {
        return;
    }
    for (name, reason) in &outcome.missing {
        eprintln!("MCP {name}: not connected ({reason}); the agent starts without its tools");
    }
    let names: Vec<String> = outcome.missing.iter().map(|(n, _)| mcp::user_name(n)).collect();
    let names = names.join(", ");
    set_status(app, "agent", tr!("Non sono riuscito a collegare {names}: parto senza", "Could not connect {names}: starting without"));
    // Time to read the sentence before the window moves to the web UI.
    std::thread::sleep(std::time::Duration::from_secs(4));
}

/// Before "ready": the engine reads the system prompt and the tools of the conversation the user
/// will open and saves its base (see `preparation.rs`). If the base is already there it costs nothing and
/// the page does not show it; if the read fails the app starts anyway (the first conversation
/// will wait for the read, as before) and the reason goes to the log.
fn prepare_model(app: &AppHandle, agent_url: &str) {
    let Some(folder) = preparation::folder_to_prepare(mcp::last_session_dir(agent_url)) else {
        eprintln!("model preparation: no working folder yet, nothing to prepare");
        return;
    };
    let t0 = std::time::Instant::now();
    let outcome = preparation::prepare(agent_url, &folder, &mut |s| {
        set_status(app, "preparing", tr!("Preparo il modello ({s} s)", "Preparing the model ({s} s)"))
    });
    match outcome {
        Ok(preparation::Outcome::AlreadyReady) => eprintln!("model preparation: base already ready for {folder}"),
        Ok(preparation::Outcome::Prepared { tokens, ms }) => {
            eprintln!("model preparation: read {tokens} tokens in {:.1} s for {folder}", ms / 1000.0)
        }
        Ok(preparation::Outcome::Skipped(reason)) => eprintln!("model preparation skipped: {reason}"),
        Err(e) => eprintln!("model preparation failed after {:.1} s: {e:#}", t0.elapsed().as_secs_f32()),
    }
}

/// The page to open: the last one seen (project or conversation) if it belongs to the current server,
/// otherwise the web UI home.
pub(crate) fn start_page(agent_url: &str) -> String {
    let home = agent_url.to_string();
    let Ok(file) = mango_common::last_page_file() else { return home };
    let Some(url) = std::fs::read_to_string(file).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return home;
    };
    if !url.starts_with(&format!("{}/", agent_url.trim_end_matches('/'))) {
        return home;
    }
    // A saved conversation may no longer exist (deleted, data not restored): the web UI would
    // show "Cannot find this conversation" with no obvious way out. The server is asked before
    // navigating there; if it does not answer or does not know it, the home is better.
    match saved_session(&url) {
        Some((id, query)) => {
            if session_exists(agent_url, &id, query.as_deref()) {
                url
            } else {
                eprintln!("saved conversation {id} is gone: opening the home");
                home
            }
        }
        None => url,
    }
}

/// Id and query (`directory=…`, already encoded as the web UI sends it) of a saved page that
/// points to a conversation: `…/session/ses_x?directory=…`.
fn saved_session(url: &str) -> Option<(String, Option<String>)> {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (url, None),
    };
    let id = path.rsplit('/').next()?.to_string();
    if !id.starts_with("ses_") || !path.ends_with(&format!("/session/{id}")) {
        return None;
    }
    Some((id, query))
}

fn session_exists(agent_url: &str, id: &str, query: Option<&str>) -> bool {
    let q = query.map(|d| format!("?{d}")).unwrap_or_default();
    let url = format!("{}/session/{id}{q}", agent_url.trim_end_matches('/'));
    mango_common::internet::agent(&url, std::time::Duration::from_secs(5)).get(&url).call().is_ok()
}

fn spawn_startup(app: AppHandle, mode: Mode) {
    std::thread::spawn(move || {
        if let Err(e) = startup(&app, mode) {
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| match folder::requested_folder(&argv) {
            Some(path) => folder::open(app, path),
            None => tray::show(app),
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(bridge::handlers!(
            startup_status,
            language,
            retry_startup,
            open_logs,
            other_models::other_models_open,
            other_models::other_models_local,
            other_models::other_models_add,
            other_models::other_models_remove,
            other_models::other_models_token_status,
            other_models::other_models_token_save,
            other_models::other_models_token_remove,
            choice::choice_confirm,
            choice::choice_cancel,
            choice::open_optimize
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
                // Ctrl+ / Ctrl- / Ctrl+0: the browser's own zoom (`zoom.rs` remembers it)
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
            if let Some(zoom) = mango_common::zoom_file().ok().and_then(|f| zoom::read(&f)) {
                let _ = main.set_zoom(zoom);
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
            spawn_startup(app.handle().clone(), Mode::Startup { interactive: !service_mode() });
            Ok(())
        })
        .build(context)
        .expect("Tauri startup")
        .run(|app, ev| match ev {
            // Window close. Once the agent runs, the X only hides the window: the app stays alive (and with it the
            // loaded model) and reopens from the tray icon, whose "Quit" stops everything. Before that (model choice,
            // download, startup, a startup error) there is nothing to keep alive and the X quits: an interrupted
            // download resumes at the next start.
            RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
                api.prevent_close();
                if app.state::<AppState>().agent.lock().unwrap().is_none() {
                    tray::quit(app);
                } else if let Some(w) = main_window(app) {
                    let _ = w.hide();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn recognizes_saved_pages() {
        let (id, q) = saved_session("http://127.0.0.1:4096/session/ses_abc?directory=C%3A%5Cp").unwrap();
        assert_eq!(id, "ses_abc");
        assert_eq!(q.as_deref(), Some("directory=C%3A%5Cp"));
        let (id, q) = saved_session("http://127.0.0.1:4096/session/ses_abc").unwrap();
        assert_eq!(id, "ses_abc");
        assert_eq!(q, None);
        // home and projects are not conversations: we navigate without asking the server
        assert!(saved_session("http://127.0.0.1:4096/").is_none());
        assert!(saved_session("http://127.0.0.1:4096/project/prj_x").is_none());
        assert!(saved_session("http://127.0.0.1:4096/session/ses_abc/extra").is_none());
    }

    /// A conversation the server does not know (404) must not be reopened: we fall back to the home.
    #[test]
    fn asks_the_server_before_navigating() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            for expected in ["/session/ses_alive?directory=C%3A%5Cp", "/session/ses_dead?directory=C%3A%5Cp"] {
                let (mut c, _) = l.accept().unwrap();
                let mut buf = [0u8; 1024];
                let n = c.read(&mut buf).unwrap();
                let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
                assert_eq!(line, format!("GET {expected} HTTP/1.1"));
                let (code, body) = if expected.contains("alive") { ("200 OK", "{}") } else { ("404 Not Found", "{}") };
                let _ = write!(c, "HTTP/1.1 {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        assert!(session_exists(&base, "ses_alive", Some("directory=C%3A%5Cp")));
        assert!(!session_exists(&base, "ses_dead", Some("directory=C%3A%5Cp")));
        h.join().unwrap();
    }
}
