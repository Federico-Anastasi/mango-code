//! Configuration of the agent server (`opencode serve` with the web UI built in): config generated from the templates,
//! environment variables, MCP, plugins. It starts nothing:
//! it produces a `ProcSpec`.
//!
//! The generated config lives in `<data>/opencode-home` (OPENCODE_CONFIG_DIR). The distribution (`paths.dist`) is
//! read-only: the app never writes there.
//!
//! Static files: plugins are COPIED (opencode only discovers them if they are in `<config>/plugin/`);
//! MCP scripts are REFERENCED by their path in `dist` (as the launcher does): they are big or have
//! `node_modules` next to them, and there's no reason to duplicate them.

pub mod tools;
pub mod team;
pub mod servers;

use anyhow::{bail, Context, Result};
use mango_common::{tr, Paths, ProcSpec};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Provider of the local models in the config: the app's web UI always uses the local engine.
const PROVIDER: &str = "mango";
/// The environment variable that carries the key of another PC's engine to the agent, which reads it as `{env:…}` in its config
/// and sends it to that engine.
pub const ENGINE_KEY_VAR: &str = "MANGO_ENGINE_KEY";
/// The name of the agent's process for the supervisor, and of its log (`<logs>\agent.log`).
pub const PROCESS: &str = "agent";

/// Plugins of `opencode-home/plugin` copied to the config folder. The other one, `mango-team.js`, imports npm packages,
/// so it isn't copied but declared with its path in the distribution, where `node_modules` sits next to it (only with
/// the Team).
const PLUGINS: &[&str] = &["mango-discipline.js", "mango-web-diet.js", "mango-documents.js", "mango-project.js"];

/// Template placeholders that concern the cloud provider: the `openrouter` block is discarded, but as long as it is
/// in the text the bare placeholders must give valid JSON.
const CLOUD_PLACEHOLDERS: &[&str] = &[
    "OR_BASE_URL", "OR_API_KEY", "OR_MODEL_ID", "OR_LABEL", "OR_CTX", "OR_COST_IN",
    "OR_COST_OUT", "OR_COST_CACHE", "OR_ATTACHMENT", "OR_INPUT_MODALITIES",
];

/// A local model the web UI offers. The key is mango-models.json's: it is the model's id in the config, and the
/// engine manager reads it in the requests to start the right one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentModel {
    pub key: String,
    pub label: String,
    pub ctx: u32,
    pub images: bool,
}

#[derive(Debug, Clone)]
pub struct AgentInputs {
    /// The engine's URL: the app's engine manager, e.g. "http://127.0.0.1:47080", or another PC's engine.
    pub engine_url: String,
    /// The app's control server (`/control/*`), always on this PC, also when the engine is another PC's: the agent
    /// forwards its `/mango/state`, `/mango/models`, `/mango/computer`, `/mango/model/*` and `/mango/image/*` there.
    pub control_url: String,
    /// The key of the engine, when it is another PC's (`engine::remote`). It goes to the agent in the environment only.
    pub engine_key: Option<String>,
    /// The models the agent knows: every model of the catalog, on disk or not (the agent does not look at the files, and a
    /// model downloaded later needs no new config). Empty when the catalog is.
    pub models: Vec<AgentModel>,
    /// Key of the model of new conversations; `None` while no model is on the computer.
    pub default_model: Option<String>,
    /// Port of the agent's web server: the one the app chose for this start.
    pub port: u16,
    /// URL of the dictation service, if running.
    pub voice_url: Option<String>,
    /// The PC's development tools (see `tools`): they become a section of the system prompt.
    pub tools: tools::Detection,
    /// The agent's browser: the app's Preview panel.
    pub browser: BrowserInputs,
    /// The Team (see `team`), if there's an OpenRouter key.
    pub team: Option<team::TeamInputs>,
    /// The external servers (see `servers`), each a provider beside the local models, and the model of new
    /// conversations when it is a server's.
    pub servers: servers::Servers,
    /// The keys of the servers that have one, by `Server::credential`: they go to the agent in the environment only.
    pub server_keys: Vec<(String, String)>,
}

/// Which config is generated: the app server's, or those of the Team's hidden processes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    App,
    Dev,
    Agent,
}

/// How the browser server (`mango-chrome-mcp.mjs`) finds the agent's browser. It goes through the process
/// environment and not the config: the port changes at every app start and mustn't stay written on disk.
#[derive(Debug, Clone)]
pub struct BrowserInputs {
    /// Remote debugging port of the Preview panel (127.0.0.1 only, chosen at random at every start).
    pub preview_port: u16,
    /// File with the «Also in my Chrome» choice (`{"myChrome":true}`): the server rereads it at every tool call, so the
    /// choice applies without restarting the agent.
    pub choice: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AgentPlan {
    pub spec: ProcSpec,
    /// E.g. "http://127.0.0.1:4096".
    pub url: String,
    /// Folder of the generated config (OPENCODE_CONFIG_DIR).
    pub config_dir: PathBuf,
}

/// Writes the config in `<data>/opencode-home` and describes the process to launch.
pub fn plan(paths: &Paths, inp: &AgentInputs) -> Result<AgentPlan> {
    let exe = paths.opencode.join("web").join("mango-code.exe");
    if !exe.is_file() {
        bail!(
            "{}",
            tr!(
                "manca la build di Mango Code con la web UI: {}",
                "the Mango Code build with the web UI is missing: {}",
                exe.display()
            )
        );
    }
    // In the app there is no initial working folder: projects are chosen from the web UI.
    let home = std::env::var_os("USERPROFILE").with_context(|| tr!("USERPROFILE non impostata", "USERPROFILE is not set"))?;

    let config_dir = paths.data.join("opencode-home");
    fs::create_dir_all(&config_dir).with_context(|| cannot_create(&config_dir))?;

    tools::install_bun_shim(&paths.data)?;
    write_config(paths, inp, &exe, &config_dir, Role::App)?;
    if let Some(team) = &inp.team {
        prepare_team(paths, inp, team, &exe)?;
    }

    let url = format!("http://127.0.0.1:{}", inp.port);
    let env = |k: &str, v: &str| (k.to_string(), v.to_string());
    let mut spec_env = vec![
        env("OPENCODE_CONFIG_DIR", &config_dir.to_string_lossy()),
        env("MANGO_HOME", &paths.dist.to_string_lossy()),
        env("MANGO_ENGINE_URL", &inp.engine_url),
        env("MANGO_CONTROL_URL", &inp.control_url),
        // What goes in the prompt, for all folders: the agent rereads it at every request and writes it from the
        // settings page. It lives in the app's data, so it follows MANGO_DATA.
        env("MANGO_SETTINGS", &paths.data.join("settings.json").to_string_lossy()),
        // The programs installed on this PC, as the text the harness's prompt puts in its `{{programs}}` line: a fact of
        // the PC, detected at every start. The Team's hidden processes inherit it.
        env("MANGO_PC_PROGRAMS", &tools::programs(&inp.tools)),
        // The Windows display language, for the agent's texts when no language is chosen (Bun only knows the
        // regional format, which can differ).
        env("MANGO_SYSTEM_LANGUAGE", mango_common::i18n::system_lang().code()),
        // `bun` for the agent: the shim in `bin` (at the head of the PATH) launches this same executable as the Bun
        // runtime. Then `git`: Git for Windows travels in the resources (`prepare-installer.mjs`), and every project is a
        // repository also on a PC without Git.
        env("PATH", &tools::agent_path(&paths.data, &paths.dist, std::env::var_os("PATH").as_deref())),
        env(tools::BUN_VAR, &exe.to_string_lossy()),
        // The agent's browser is the app's panel: without this port the browser server would not find the panel.
        env("MANGO_PANEL_CDP", &inp.browser.preview_port.to_string()),
        env("MANGO_BROWSER_CHOICE", &inp.browser.choice.to_string_lossy()),
        // Every folder the agent works in becomes a git repository (project.ts, ensureGit): projects, diffs and the
        // files the app opens go through it.
        env("MANGO_PROJECTS_GIT", "1"),
        // Offline: no models.dev, updates, sharing, LSP downloads.
        env("OPENCODE_DISABLE_AUTOUPDATE", "1"),
        env("OPENCODE_DISABLE_MODELS_FETCH", "1"),
        env("OPENCODE_DISABLE_SHARE", "1"),
        env("OPENCODE_DISABLE_LSP_DOWNLOAD", "1"),
        // Isolation: the app behaves as on a PC where nothing has ever been. Conversations, config, cache and logs
        // live only in the app's data (opencode finds them from the XDG variables); no Claude Code skills or
        // CLAUDE.md (~/.claude) nor external skills (~/.agents): the skills are the product's, built into the agent.
        env("XDG_DATA_HOME", &paths.data.join("agent").join("data").to_string_lossy()),
        env("XDG_CONFIG_HOME", &paths.data.join("agent").join("config").to_string_lossy()),
        env("XDG_CACHE_HOME", &paths.data.join("agent").join("cache").to_string_lossy()),
        env("XDG_STATE_HOME", &paths.data.join("agent").join("state").to_string_lossy()),
        env("OPENCODE_DISABLE_CLAUDE_CODE", "1"),
        env("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1"),
        // No built-in opencode commands and skills (/init, /review, customize-opencode): only the product's. The
        // project's context (CLAUDE.md, .claude/, .mcp.json) is added by mango-project.js.
        env("OPENCODE_DISABLE_BUILTIN_COMMANDS", "1"),
        // A project's own opencode.json and .opencode folder are not read: they can start plugins, MCP servers and
        // other providers in the agent with nothing asked. Its context comes from mango-project.js (AGENTS.md too), and
        // its .mcp.json servers start once the user allowed them.
        env("OPENCODE_DISABLE_PROJECT_CONFIG", "1"),
        // Two additions to the config: doom_loop is the only permission that stays "ask", and in the browser it would
        // stop the agent waiting for a click; enabled_providers leaves only the running model in the selector.
        env(
            "OPENCODE_CONFIG_CONTENT",
            &json!({"enabled_providers": providers(inp), "permission": {"doom_loop": "allow"}}).to_string(),
        ),
    ];
    if let Some(team) = &inp.team {
        spec_env.extend(team_env(paths, team));
    }
    spec_env.extend(inp.server_keys.iter().cloned());
    // Without a password: the server listens only on 127.0.0.1 and the agent only accepts local pages. With a
    // password the browser would ask for it at every reload.
    // Without the inherited SHELL: the shell tool (and its description in the system prompt) doesn't depend on how the
    // app was launched (from Git Bash it would become bash, from the Start menu PowerShell).
    // A different system prompt also means a different base in the engine's memory.
    let mut env_remove = vec!["OPENCODE_SERVER_PASSWORD".to_string(), "OPENCODE_SERVER_USERNAME".to_string(), "SHELL".to_string()];
    // The key of another PC's engine goes only in the process environment (the config reads it from there), like the Team's.
    match &inp.engine_key {
        Some(k) => spec_env.push(env(ENGINE_KEY_VAR, k)),
        // A value inherited from outside is not this engine's key.
        None => env_remove.push(ENGINE_KEY_VAR.to_string()),
    }
    match &inp.voice_url {
        Some(u) => spec_env.push(env("MANGO_VOICE_URL", u)),
        // A value inherited from outside would point to a dictation that isn't this one.
        None => env_remove.push("MANGO_VOICE_URL".to_string()),
    }

    let spec = ProcSpec {
        name: PROCESS.to_string(),
        exe,
        args: vec![
            "serve".into(),
            "--hostname".into(),
            "127.0.0.1".into(),
            "--port".into(),
            inp.port.to_string(),
        ],
        env: spec_env,
        env_remove,
        cwd: Some(PathBuf::from(home)),
        health_url: Some(format!("{url}/global/health")),
        ready_timeout_s: 60,
        shutdown_post: None,
        startup_post: None,
    };
    Ok(AgentPlan { spec, url, config_dir })
}

fn cannot_create(path: &Path) -> String {
    tr!("impossibile creare {}", "cannot create {}", path.display())
}

/// Writes a role's config in `dir`, with the plugins and the declaration that npm isn't needed.
fn write_config(paths: &Paths, inp: &AgentInputs, exe: &Path, dir: &Path, role: Role) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| cannot_create(dir))?;
    let config = render_config(paths, inp, exe, role)?;
    let file = dir.join("opencode.json");
    mango_common::write_atomic(&file, serde_json::to_string_pretty(&config)?).with_context(|| tr!("impossibile scrivere {}", "cannot write {}", file.display()))?;
    install_plugins(paths, dir)?;
    skip_dependency_install(dir)
}

fn providers(inp: &AgentInputs) -> Vec<&str> {
    let mut providers = vec![PROVIDER];
    if inp.team.is_some() {
        providers.push(team::PROVIDER_CLOUD);
    }
    providers.extend(inp.servers.list.iter().map(|s| s.id.as_str()));
    providers
}

/// The Team's hidden processes' configs, `launch.json` for the plugin and the cleanup of the earlier links.
fn prepare_team(paths: &Paths, inp: &AgentInputs, team: &team::TeamInputs, exe: &Path) -> Result<()> {
    let dir = team::folder(paths);
    write_config(paths, inp, exe, &dir.join("dev-home"), Role::Dev)?;
    write_config(paths, inp, exe, &dir.join("agent-home"), Role::Agent)?;
    write(&dir.join("launch.json"), &serde_json::to_string_pretty(&team::launch(paths, exe, team))?)?;
    // The links are rewritten by the processes at their first message: those of an earlier start point to dead sessions.
    let agents = dir.join("agents");
    fs::create_dir_all(&agents)?;
    let old = fs::read_dir(&dir)?.chain(fs::read_dir(&agents)?).flatten().map(|v| v.path());
    for f in old.filter(|f| f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("team-link") || n.ends_with(".pid"))) {
        fs::remove_file(&f).with_context(|| tr!("impossibile togliere {}", "cannot remove {}", f.display()))?;
    }
    Ok(())
}

/// The agent server's environment for the manager (`mango-team.js`, role `manager`).
fn team_env(paths: &Paths, team: &team::TeamInputs) -> Vec<(String, String)> {
    let dir = team::folder(paths);
    let var = |k: &str, v: &str| (k.to_string(), v.to_string());
    vec![
        var("MANGO_TEAM_ROLE", "manager"),
        // The plugin treats as manager only the opencode agent `team`: the other conversations are its own.
        var("MANGO_TEAM_AGENT", team::AGENT),
        var("MANGO_TEAM_DIR", &dir.to_string_lossy()),
        var("MANGO_TEAM_LAUNCH", &dir.join("launch.json").to_string_lossy()),
        var("MANGO_AGENT_MAX", &team.agents.to_string()),
        var("MANGO_AGENT_LABEL", &tr!("{} su OpenRouter", "{} on OpenRouter", team.agent.label)),
        var("MANGO_AGENT_DIR", &dir.join("agents").to_string_lossy()),
        var("MANGO_AGENT_PORTS", &team::AGENT_PORTS.map(|p| p.to_string()).join(",")),
        var(team::KEY_VAR, &team.key),
    ]
}

/// The content of `opencode.json`: the `dist` template with the running model's numbers, plus the fixes for the end
/// user (see the comments of the steps).
fn render_config(paths: &Paths, inp: &AgentInputs, exe: &Path, role: Role) -> Result<Value> {
    check_default(&inp.models, inp.default_model.as_deref())?;
    let server_default = server_default(&inp.servers)?;
    let mut cfg = template(paths, &placeholders(paths, Some(inp))?)?;
    let provider_base = cfg.pointer(&format!("/provider/{PROVIDER}")).cloned().context("provider.mango is missing from the template")?;

    let root = cfg.as_object_mut().context("the config must be a JSON object")?;
    // No model on the computer yet: the agent starts without a default, and the conversations wait for the first model.
    if inp.default_model.is_none() {
        root.remove("model");
        root.remove("small_model");
    }
    // One model for each local model offered, copied from the template's (`local`).
    let models = root
        .get_mut("provider")
        .and_then(|p| p.get_mut(PROVIDER))
        .and_then(|p| p.get_mut("models"))
        .and_then(Value::as_object_mut)
        .context("provider.mango.models is missing from the template")?;
    let base = models.remove("local").context("the local model is missing from the template")?;
    for m in &inp.models {
        models.insert(m.key.clone(), model_entry(&base, m)?);
    }
    if inp.engine_key.is_some() {
        root["provider"][PROVIDER]["options"]["apiKey"] = json!(format!("{{env:{ENGINE_KEY_VAR}}}"));
    }
    // The Team's hidden processes work with the local and cloud models only.
    if role == Role::App {
        for s in &inp.servers.list {
            root["provider"][s.id.as_str()] = server_provider(&provider_base, &base, s)?;
        }
        if let Some(r) = &server_default {
            root.insert("model".into(), json!(r));
            root.insert("small_model".into(), json!(r));
        }
    }
    // Without the Team the app uses no cloud models: the block (with a fake key and an openrouter.ai address) is
    // useless, and `enabled_providers` would exclude it anyway.
    let cloud = root
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .and_then(|p| p.remove(team::PROVIDER_CLOUD))
        .context("provider.openrouter is missing from the template")?;
    // The opencode «@» agents (explore, general) work through the `task` tool, which the template keeps off: in the
    // «@» menu they would be entries that don't work.
    let mut agents = json!({ "explore": { "disable": true }, "general": { "disable": true } });
    if let Some(t) = &inp.team {
        apply_team(&mut cfg, cloud, t, role, &mut agents)?;
    }
    cfg.as_object_mut().context("the config must be a JSON object")?.insert("agent".into(), agents);
    strip_annotations(&mut cfg);
    use_bundled_runtime(&mut cfg, exe, &paths.dist, &paths.data.join("mcp"))?;
    check_referenced_files(&cfg)?;

    let left = cfg.to_string();
    if let Some(i) = left.find("{{") {
        bail!("unresolved placeholder in the template: {}", &left[i..(i + 40).min(left.len())]);
    }
    Ok(cfg)
}

/// The template's placeholders and their values. Without the inputs, those of an agent with no engine, model or Team:
/// enough to read the parts of the template that do not depend on them (the base of a local model). Text values are
/// escaped.
fn placeholders(paths: &Paths, inp: Option<&AgentInputs>) -> Result<Vec<(&'static str, String)>> {
    let mut vars = vec![
        ("BASE_URL", inp.map(|i| esc(&format!("{}/v1", i.engine_url))).unwrap_or_default()),
        // Always on: even for a text-only model the screenshot is useful, because the user sees it in the chat; the
        // server only hands the model a note (see toModelMessages).
        ("SCREENSHOT_TOOL", "true".to_string()),
        ("SELF", esc(&paths.dist.to_string_lossy())),
        ("PROVIDER", PROVIDER.to_string()),
        ("MODEL_REF", esc(inp.and_then(|i| i.default_model.as_deref()).unwrap_or_default())),
        ("PLUGIN_LIST", match inp {
            Some(i) => team_plugin(paths, i)?,
            None => String::new(),
        }),
    ];
    match inp.and_then(|i| i.team.as_ref()) {
        Some(t) => vars.extend(cloud_placeholders(t)),
        None => vars.extend(CLOUD_PLACEHOLDERS.iter().map(|k| (*k, "null".to_string()))),
    }
    Ok(vars)
}

/// An external server as an opencode provider: the local provider's block with the server's address, its key read from
/// the environment (`Server::credential`) or the fake one the client needs, and one model for each of its models.
fn server_provider(provider_base: &Value, model_base: &Value, s: &servers::Server) -> Result<Value> {
    let mut p = provider_base.clone();
    p["name"] = json!(s.label());
    p["options"]["baseURL"] = json!(s.url);
    p["options"]["apiKey"] = json!(if s.key { format!("{{env:{}}}", s.credential()) } else { "dummy".to_string() });
    let models = s
        .models
        .iter()
        .map(|m| {
            let mut entry = model_entry(model_base, &AgentModel { key: m.id.clone(), label: m.label(), ctx: m.ctx, images: m.images })?;
            if let Some(price) = m.price {
                entry["cost"] = json!({ "input": price.input, "output": price.output });
            }
            Ok((m.id.clone(), entry))
        })
        .collect::<Result<serde_json::Map<_, _>>>()?;
    p["models"] = Value::Object(models);
    strip_annotations(&mut p);
    Ok(p)
}

/// The model of new conversations when it is a server's, as the config writes it (`<server>/<model>`); it must be one of
/// that server's models.
fn server_default(servers: &servers::Servers) -> Result<Option<String>> {
    let Some(r) = &servers.default else { return Ok(None) };
    if !servers.list.iter().any(|s| s.id == r.server && s.models.iter().any(|m| m.id == r.model)) {
        bail!("{}", tr!("il modello predefinito «{}» non è fra quelli del server", "the default model «{}» is not among the server's", r.model));
    }
    Ok(Some(format!("{}/{}", r.server, r.model)))
}

/// The default must be one of the models offered.
fn check_default(models: &[AgentModel], default: Option<&str>) -> Result<()> {
    if let Some(key) = default.filter(|key| !models.iter().any(|m| m.key == *key)) {
        bail!("{}", tr!("il modello predefinito «{key}» non è fra quelli offerti", "the default model «{key}» is not among those offered"));
    }
    Ok(())
}

/// The template with its `{{NAME}}` placeholders replaced, even inside JSON strings and as bare values: the substitution is
/// done on the text, then it is read as JSON.
fn template(paths: &Paths, vars: &[(&str, String)]) -> Result<Value> {
    let tpl_path = paths.dist.join("opencode-home").join("opencode.template.json");
    let tpl = fs::read_to_string(&tpl_path)
        .with_context(|| tr!("manca il template della config: {}", "the config template is missing: {}", tpl_path.display()))?;
    let mut text = tpl.trim_start_matches('\u{feff}').to_string();
    for (k, v) in vars {
        text = text.replace(&format!("{{{{{k}}}}}"), v);
    }
    serde_json::from_str(&text).with_context(|| format!("{} is not valid JSON after the substitution", tpl_path.display()))
}

/// A local model in the config: the template's `local` entry with its name, images and limits. An answer may take the
/// whole context, so that is also its limit: the request carries none.
fn model_entry(base: &Value, m: &AgentModel) -> Result<Value> {
    let mut v = base.clone();
    v["name"] = json!(m.label);
    v["attachment"] = json!(m.images);
    v["modalities"]["input"] = serde_json::from_str(modalities(m.images))?;
    v["limit"] = json!({ "context": m.ctx, "output": m.ctx });
    strip_annotations(&mut v);
    Ok(v)
}

/// Writes again the local models of the configuration `plan` wrote and the model of new conversations: each model's
/// context is the verdict's, which a choice or a card taken out of use changes, a model the user adds joins the list,
/// and `default` is the model loaded when the app opens (`engine_cfg::startup_model`, `None` while no model is on the
/// computer). The agent's own file must be there; the Team's hidden processes' are written if they are. The rest stays
/// as it is. The agent reads it again when the app asks (`POST /mango/reload`), as soon as no conversation is answering.
pub fn set_models(paths: &Paths, models: &[AgentModel], default: Option<&str>, servers: &servers::Servers) -> Result<()> {
    check_default(models, default)?;
    let server_default = server_default(servers)?;
    let rendered = template(paths, &placeholders(paths, None)?)?;
    let base = rendered.pointer(&format!("/provider/{PROVIDER}/models/local")).cloned().context("the local model is missing from the template")?;
    let provider_base = rendered.pointer(&format!("/provider/{PROVIDER}")).cloned().context("provider.mango is missing from the template")?;
    let entries = models.iter().map(|m| Ok((m.key.clone(), model_entry(&base, m)?))).collect::<Result<serde_json::Map<_, _>>>()?;
    let team = team::folder(paths);
    let app = paths.data.join("opencode-home").join("opencode.json");
    if !app.is_file() {
        bail!("{}", tr!("manca la configurazione dell'agente: {}", "the agent's configuration is missing: {}", app.display()));
    }
    // The hidden agents of the Team work with their cloud model: only the app's server and the local dev get the default.
    let files = [(app.clone(), true), (team.join("dev-home").join("opencode.json"), true), (team.join("agent-home").join("opencode.json"), false)];
    for (file, local_default) in files.iter().filter(|(f, _)| f.is_file()) {
        let text = fs::read_to_string(file).with_context(|| tr!("impossibile leggere {}", "cannot read {}", file.display()))?;
        let mut cfg: Value = serde_json::from_str(&text).with_context(|| format!("{} is not valid JSON", file.display()))?;
        *cfg.pointer_mut(&format!("/provider/{PROVIDER}/models")).with_context(|| format!("provider.{PROVIDER}.models is missing from {}", file.display()))? =
            Value::Object(entries.clone());
        if *local_default {
            let root = cfg.as_object_mut().context("the config must be a JSON object")?;
            if file == &app {
                let providers = root.get_mut("provider").and_then(Value::as_object_mut).context("the provider block is missing")?;
                providers.retain(|id, _| !id.starts_with("server-"));
                for s in &servers.list {
                    providers.insert(s.id.clone(), server_provider(&provider_base, &base, s)?);
                }
            }
            let reference = match (&server_default, default) {
                (Some(r), _) if file == &app => Some(r.clone()),
                (_, Some(key)) => Some(format!("{PROVIDER}/{key}")),
                (_, None) => None,
            };
            match reference {
                Some(r) => {
                    root.insert("model".into(), json!(r));
                    root.insert("small_model".into(), json!(r));
                }
                // No model on the computer: the agent goes on without a default, as before the first model.
                None => {
                    root.remove("model");
                    root.remove("small_model");
                }
            }
        }
        mango_common::write_atomic(file, serde_json::to_string_pretty(&cfg)?).with_context(|| tr!("impossibile scrivere {}", "cannot write {}", file.display()))?;
    }
    Ok(())
}

/// The cloud provider's placeholders filled with the manager. The key isn't in the text: the config reads it from the
/// process environment, so it isn't on disk.
fn cloud_placeholders(t: &team::TeamInputs) -> Vec<(&'static str, String)> {
    let m = &t.manager;
    vec![
        ("OR_BASE_URL", esc(&m.base_url)),
        ("OR_API_KEY", format!("{{env:{}}}", team::KEY_VAR)),
        ("OR_MODEL_ID", esc(&m.id)),
        ("OR_LABEL", esc(&m.label)),
        ("OR_CTX", m.ctx.to_string()),
        ("OR_COST_IN", m.input_cost.to_string()),
        ("OR_COST_OUT", m.output_cost.to_string()),
        ("OR_COST_CACHE", m.cache_cost.to_string()),
        ("OR_ATTACHMENT", m.images.to_string()),
        ("OR_INPUT_MODALITIES", modalities(m.images).to_string()),
    ]
}

/// The Team's plugin, with its path in the distribution (where it has `node_modules` next to it), as an entry of the
/// `plugin` list.
fn team_plugin(paths: &Paths, inp: &AgentInputs) -> Result<String> {
    if inp.team.is_none() {
        return Ok(String::new());
    }
    let plugin = paths.dist.join("opencode-home").join("plugin").join("mango-team.js");
    if !plugin.is_file() {
        bail!("{}", tr!("manca il plugin del Team: {}", "the Team plugin is missing: {}", plugin.display()));
    }
    Ok(format!("\"{}\"", esc(&plugin.to_string_lossy())))
}

/// The Team in the config: the cloud provider with the manager's and agents' models; for the app's server the `team`
/// agent (the manager) and the manager's tools removed from the normal agent; for the agents their model.
fn apply_team(cfg: &mut Value, mut cloud: Value, t: &team::TeamInputs, role: Role, agents: &mut Value) -> Result<()> {
    let base = cloud
        .get("models")
        .and_then(Value::as_object)
        .and_then(|m| m.values().next())
        .cloned()
        .context("the model of provider.openrouter is missing from the template")?;
    cloud["models"] = team::openrouter_models(t, &base);
    cfg["provider"][team::PROVIDER_CLOUD] = cloud;
    match role {
        Role::Dev => {}
        Role::Agent => {
            let model_ref = format!("{}/{}", team::PROVIDER_CLOUD, t.agent.id);
            cfg["model"] = json!(model_ref);
            cfg["small_model"] = json!(model_ref);
        }
        Role::App => {
            let denied: serde_json::Map<String, Value> = team::MANAGER_TOOLS.iter().map(|s| (s.to_string(), json!("deny"))).collect();
            agents["build"] = json!({ "permission": denied });
            agents[team::AGENT] = json!({
                "mode": "primary",
                "description": tr!(
                    "Il manager del Team: un modello cloud che guida il dev locale e gli agenti cloud",
                    "The Team's manager: a cloud model that leads the local dev and the cloud agents"
                ),
                "model": format!("{}/{}", team::PROVIDER_CLOUD, t.manager.id),
            });
        }
    }
    Ok(())
}

fn modalities(images: bool) -> &'static str {
    if images {
        r#"["text", "image"]"#
    } else {
        r#"["text"]"#
    }
}

/// Keys that start with `_` are notes for whoever reads the template (with people's
/// names and PowerShell commands): in the config generated for the user they would be noise, and some (the MCPs'
/// `node` command) would become false.
fn strip_annotations(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| !k.starts_with('_'));
            m.values_mut().for_each(strip_annotations);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_annotations),
        _ => {}
    }
}

/// On the user's PC there is no Node: the MCPs the template launches with `node` start with the same `mango-code.exe`
/// (compiled with Bun) which with `BUN_BE_BUN=1` behaves as the `bun` runtime and runs the scripts. `cwd` = `dist`:
/// `bun` loads the `bunfig.toml` and `.env` of the current folder, and the default one is the project open in the web
/// UI. `MANGO_RUNTIME`: writable folder for the MCPs' profile and logs (the program folder may not be).
fn use_bundled_runtime(cfg: &mut Value, exe: &Path, dist: &Path, runtime: &Path) -> Result<()> {
    let servers = cfg
        .get_mut("mcp")
        .and_then(Value::as_object_mut)
        .context("the mcp section is missing from the template")?;
    for (name, srv) in servers.iter_mut() {
        let srv = srv.as_object_mut().with_context(|| format!("mcp.{name} is not an object"))?;
        let cmd = srv
            .get_mut("command")
            .and_then(Value::as_array_mut)
            .with_context(|| format!("mcp.{name}.command is not an array"))?;
        if cmd.first().and_then(Value::as_str) != Some("node") {
            bail!("mcp.{name}: the command is not `node`, the port doesn't know how to run it without Node");
        }
        cmd[0] = json!(exe.to_string_lossy());
        srv.insert(
            "environment".into(),
            json!({ "BUN_BE_BUN": "1", "MANGO_RUNTIME": runtime.to_string_lossy() }),
        );
        srv.insert("cwd".into(), json!(dist.to_string_lossy()));
    }
    Ok(())
}

/// A missing MCP script would only show as «failed»
/// in the page: better to stop at start with the file's name.
fn check_referenced_files(cfg: &Value) -> Result<()> {
    let mut files: Vec<&str> = Vec::new();
    fn strs(v: Option<&Value>) -> Vec<&str> {
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
    }
    if let Some(servers) = cfg.get("mcp").and_then(Value::as_object) {
        for s in servers.values() {
            files.extend(strs(s.get("command")).into_iter().skip(1));
        }
    }
    for f in files {
        if !Path::new(f).exists() {
            bail!("{}", tr!("la config rimanda a un file che non c'è: {f}", "the config refers to a file that isn't there: {f}"));
        }
    }
    Ok(())
}

/// Copies the plugins to `<config>/plugin/`. The folder is emptied first: a plugin removed from the distribution must
/// not stay active.
fn install_plugins(paths: &Paths, config_dir: &Path) -> Result<()> {
    let src = paths.dist.join("opencode-home").join("plugin");
    let dst = config_dir.join("plugin");
    if dst.exists() {
        fs::remove_dir_all(&dst).with_context(|| tr!("impossibile svuotare {}", "cannot empty {}", dst.display()))?;
    }
    fs::create_dir_all(&dst)?;
    for name in PLUGINS {
        let from = src.join(name);
        fs::copy(&from, dst.join(name)).with_context(|| tr!("impossibile copiare il plugin {}", "cannot copy the plugin {}", from.display()))?;
    }
    Ok(())
}

/// At start opencode installs `@opencode-ai/plugin` in the config folder if `node_modules` is missing (a trip over the
/// network to npm, in the background). The copied plugins import nothing: the install is declared already done, with an
/// empty `node_modules` and a lockfile that lists the dependency, so the app doesn't contact npm. (The check is in
/// `Npm.install` of packages/core: if `node_modules` exists and the lockfile contains the declared packages, it exits.)
fn skip_dependency_install(config_dir: &Path) -> Result<()> {
    fs::create_dir_all(config_dir.join("node_modules"))?;
    let lock = json!({"lockfileVersion": 3, "packages": {"": {"dependencies": {"@opencode-ai/plugin": "*"}}}});
    write(&config_dir.join("package-lock.json"), &lock.to_string())
}

fn write(path: &Path, text: &str) -> Result<()> {
    fs::write(path, text).with_context(|| tr!("impossibile scrivere {}", "cannot write {}", path.display()))
}

/// The content of a JSON string (without the quotes): Windows paths have backslashes.
fn esc(s: &str) -> String {
    let q = Value::String(s.to_string()).to_string();
    q[1..q.len() - 1].to_string()
}
