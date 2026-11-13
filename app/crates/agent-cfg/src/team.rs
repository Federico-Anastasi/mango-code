//! The Team in the app: a manager, a dev and agents, with the same roles and the same plugin
//! (`launcher/opencode-home/plugin/mango-team.js`). A MANAGER (cloud model) is the `team` agent of the conversation in
//! the app; the DEV (the local model) and up to 4 cloud AGENTS are hidden `opencode serve` processes that the manager
//! starts when needed, described by `launch.json`.
//!
//! The choices (how many agents, which models) live in `<data>/team.json`. The OpenRouter key is in no file: it comes
//! from the Credential Manager, passes in the agent server's environment (`KEY_VAR`) and the config reads it from there
//! (`{env:…}`); the hidden processes inherit it from the server.

use anyhow::{bail, Context, Result};
use mango_common::{tr, Paths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const AGENTS_MAX: u8 = 4;
/// The credential's name in the Credential Manager: it is also the `api_key_field` field of the catalog's cloud models.
pub const CREDENTIAL: &str = "OPENROUTER_API_KEY";
/// The opencode provider of the cloud models, in the config.
pub const PROVIDER_CLOUD: &str = "openrouter";
/// The variable through which the key reaches the agent's processes.
pub const KEY_VAR: &str = "MANGO_OPENROUTER_KEY";
/// The name of the opencode agent that holds the conversation with the Team on.
pub const AGENT: &str = "team";
/// The dev on 4090, the agents from 4092.
pub const DEV_PORT: u16 = 4090;
pub const AGENT_PORTS: [u16; AGENTS_MAX as usize] = [4092, 4093, 4094, 4095];
/// The manager's tools (`mango-team.js`): the conversation without Team doesn't see them.
pub const MANAGER_TOOLS: &[&str] = &["ask_dev", "launch_agent", "ask_agent", "list_agents", "read_todos", "close_agent"];

const CHOICES_FILE: &str = "team.json";
const DEFAULT_MODEL: &str = "deepseek";

/// What the user chooses in the Team page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choices {
    /// How many cloud agents the manager may start (0-4).
    pub agents: u8,
    /// Catalog keys (`mango-models.json`) of the manager and of the agents: entries with a `cloud` block.
    pub manager: String,
    pub agent: String,
}

impl Default for Choices {
    fn default() -> Self {
        Choices { agents: AGENTS_MAX, manager: DEFAULT_MODEL.into(), agent: DEFAULT_MODEL.into() }
    }
}

impl Choices {
    fn check(&self, catalog: &Value) -> Result<()> {
        if self.agents > AGENTS_MAX {
            bail!("{}", tr!("gli agenti vanno da 0 a {AGENTS_MAX}, non {}", "agents go from 0 to {AGENTS_MAX}, not {}", self.agents));
        }
        cloud_model(catalog, &self.manager)?;
        cloud_model(catalog, &self.agent)?;
        Ok(())
    }
}

/// The saved choices, or the default ones if there are none. A file that is there and can't be read is an error.
pub fn read_choices(paths: &Paths) -> Result<Choices> {
    let f = paths.data.join(CHOICES_FILE);
    let text = match std::fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Choices::default()),
        Err(e) => return Err(e).with_context(|| mango_common::user_text(&tr!("Non riesco a leggere le scelte del Team.", "I can't read the Team's choices."), f.display())),
    };
    serde_json::from_str(text.trim_start_matches('\u{feff}')).with_context(|| {
        mango_common::user_text(&tr!("Le scelte del Team sono rovinate: salvale di nuovo.", "The Team's choices are damaged: save them again."), f.display())
    })
}

/// Checks the choices against the catalog and saves them.
pub fn write_choices(paths: &Paths, choices: &Choices) -> Result<()> {
    choices.check(&mango_common::catalog::read(paths)?.root)?;
    let f = paths.data.join(CHOICES_FILE);
    mango_common::write_atomic(&f, serde_json::to_string_pretty(choices)?)
        .with_context(|| mango_common::user_text(&tr!("Non riesco a salvare le scelte del Team.", "I can't save the Team's choices."), f.display()))
}

/// A catalog cloud model, with the numbers opencode's config asks for.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudModel {
    pub key: String,
    /// The id OpenRouter expects.
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub ctx: u32,
    pub images: bool,
    pub input_cost: f64,
    pub output_cost: f64,
    pub cache_cost: f64,
}

/// The catalog's cloud models, in key order.
pub fn cloud_models(catalog: &Value) -> Vec<CloudModel> {
    let Some(models) = catalog.get("models").and_then(Value::as_object) else { return Vec::new() };
    models.keys().filter_map(|k| cloud_model(catalog, k).ok()).collect()
}

pub fn cloud_model(catalog: &Value, key: &str) -> Result<CloudModel> {
    let entry = catalog
        .pointer(&format!("/models/{key}"))
        .with_context(|| tr!("«{key}» non è nel catalogo dei modelli", "«{key}» is not in the model catalog"))?;
    let cloud = entry.get("cloud").with_context(|| {
        tr!(
            "«{key}» non è un modello cloud: manager e agenti del Team ne usano uno",
            "«{key}» is not a cloud model: the Team's manager and agents use one"
        )
    })?;
    let text = |v: Option<&Value>, name: &str| {
        v.and_then(Value::as_str).map(str::to_string).with_context(|| tr!("al modello «{key}» manca {name}", "the model «{key}» lacks {name}"))
    };
    let number = |name: &str| {
        cloud
            .pointer(&format!("/cost/{name}"))
            .and_then(Value::as_f64)
            .with_context(|| tr!("al modello «{key}» manca cost.{name}", "the model «{key}» lacks cost.{name}"))
    };
    Ok(CloudModel {
        key: key.to_string(),
        id: text(cloud.get("model_id"), "cloud.model_id")?,
        label: text(entry.get("label"), "label")?,
        base_url: text(cloud.get("base_url"), "cloud.base_url")?,
        ctx: entry
            .get("ctx")
            .and_then(Value::as_u64)
            .and_then(|c| u32::try_from(c).ok())
            .with_context(|| tr!("al modello «{key}» manca ctx", "the model «{key}» lacks ctx"))?,
        images: cloud.get("image").and_then(Value::as_bool).unwrap_or(false),
        input_cost: number("input")?,
        output_cost: number("output")?,
        cache_cost: number("cache_read")?,
    })
}

/// Everything needed to generate the Team.
#[derive(Debug, Clone)]
pub struct TeamInputs {
    pub agents: u8,
    pub manager: CloudModel,
    pub agent: CloudModel,
    /// The OpenRouter key: it goes only in the process environment, never in a file.
    pub key: String,
}

/// The Team to generate, if possible: `None` when there is no key. Wrong choices and catalog are errors.
pub fn team_inputs(paths: &Paths, key: Option<String>) -> Result<Option<TeamInputs>> {
    let Some(key) = key.filter(|c| !c.trim().is_empty()) else { return Ok(None) };
    let choices = read_choices(paths)?;
    let catalog = mango_common::catalog::read(paths)?.root;
    choices.check(&catalog).with_context(|| tr!("{CHOICES_FILE} non è valido: correggilo o toglilo", "{CHOICES_FILE} is not valid: fix it or remove it"))?;
    Ok(Some(TeamInputs {
        agents: choices.agents,
        manager: cloud_model(&catalog, &choices.manager)?,
        agent: cloud_model(&catalog, &choices.agent)?,
        key,
    }))
}

/// The Team's folder in the data: the links between sessions, the pids, the logs and the hidden processes' folders.
pub fn folder(paths: &Paths) -> PathBuf {
    paths.data.join("team")
}

/// `launch.json`: how the plugin starts the hidden dev and agents. No secrets: they inherit the key from the server.
pub fn launch(paths: &Paths, exe: &Path, team: &TeamInputs) -> Value {
    let dir = folder(paths);
    let agents: Vec<Value> = (1..=team.agents)
        .map(|i| json!({ "id": i, "port": AGENT_PORTS[i as usize - 1], "config": dir.join("agent-home"), "xdg": dir.join(format!("agent-{i}")) }))
        .collect();
    json!({
        "exe": exe,
        "dev": { "port": DEV_PORT, "config": dir.join("dev-home"), "xdg": dir.join("dev") },
        "agents": agents,
    })
}

/// The `openrouter` provider block for the config: one entry per model (manager and agent, one if they're the same).
pub fn openrouter_models(team: &TeamInputs, base: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for m in [&team.manager, &team.agent] {
        let mut v = base.clone();
        v["name"] = json!(m.label);
        v["attachment"] = json!(m.images);
        v["modalities"]["input"] = if m.images { json!(["text", "image"]) } else { json!(["text"]) };
        v["limit"] = json!({ "context": m.ctx, "output": (m.ctx / 8).clamp(4096, 16384) });
        v["cost"] = json!({ "input": m.input_cost, "output": m.output_cost, "cache_read": m.cache_cost });
        out.insert(m.id.clone(), v);
    }
    Value::Object(out)
}
