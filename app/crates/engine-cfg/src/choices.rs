//! The user's saved choices, `<data>\choices.json`: where each model runs and with what context, which graphics cards
//! the models may use, the default model, the automatic update. The app writes it (the bridge's commands call the
//! `set_*` functions); every plan and every verdict reads it, so a choice applies to whoever asks for a plan.
//!
//! Without the file everything has its standard value. A key the program doesn't know (a model that is no longer in
//! the catalog, a field of a later version) is ignored. A file that can't be read or understood is an error with a
//! sentence for the user, never the standard values in its place; and it is not overwritten.

use crate::catalog::{load_models, model_cfg};
use crate::reasoning;
use crate::split::{context_label, MIN_CTX};
use anyhow::Result;
use mango_common::catalog::Sampling;
use mango_common::{tr, user_error, Paths};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;

pub const FILE: &str = "choices.json";

/// Where a model runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhereChoice {
    /// The setup tailored to this PC if there is one; otherwise the fewest cards that give a decent context.
    #[default]
    Auto,
    /// The fastest card among those in use.
    One,
    /// All the cards in use.
    All,
    /// The processor.
    Cpu,
    /// The cards named in `Choices::gpus`.
    Pick,
}

/// How the answers are written; the manager applies it to the requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    #[default]
    Recommended,
    Precise,
    Creative,
}

/// What the PC does with a model that fits one card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmallModels {
    /// On one card only.
    #[default]
    One,
    /// On all the cards in use.
    All,
}

/// One model's choices.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Choices {
    #[serde(rename = "where")]
    pub place: WhereChoice,
    /// The cards by name; only with `WhereChoice::Pick`.
    pub gpus: Vec<String>,
    /// `None` = the largest that fits; a number is any number of tokens from the minimum to what the model holds, and
    /// the plan goes lower if the memory can't carry it.
    pub context: Option<u32>,
    pub style: Style,
    /// The values the user chose one by one, over the style's: a missing one is the style's.
    pub sampling: Sampling,
    /// A level the model's chat template offers (`reasoning::Reasoning`): "off" or "on", or "low", "medium" or "high".
    /// `None` = as the model wants. A file written before the levels has `true` or `false`: they are read as "on" and "off".
    #[serde(deserialize_with = "saved_reasoning")]
    pub reasoning: Option<String>,
}

fn saved_reasoning<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Saved {
        Switch(bool),
        Level(String),
    }
    Ok(Option::<Saved>::deserialize(d)?.map(|saved| match saved {
        Saved::Switch(on) => if on { "on" } else { "off" }.to_string(),
        Saved::Level(level) => level,
    }))
}

/// The names a choice of reasoning can have; which of them a model has depends on its chat template.
const REASONING: [&str; 5] = ["off", "on", "low", "medium", "high"];

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ComputerChoices {
    /// The cards, by name, that no model uses.
    pub unused_gpus: Vec<String>,
    pub small_models: SmallModels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateChoices {
    pub automatic: bool,
}

impl Default for UpdateChoices {
    fn default() -> Self {
        UpdateChoices { automatic: true }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChoicesFile {
    /// The model started when the app opens.
    pub default: Option<String>,
    /// The model that makes a picture when a request names none; none = the catalog's (`image_default`).
    pub image_default: Option<String>,
    /// Only the models whose choices differ from the standard ones.
    pub models: BTreeMap<String, Choices>,
    pub computer: ComputerChoices,
    pub update: UpdateChoices,
}

/// What a plan or a verdict needs of the choices: the model's own and the computer's.
#[derive(Debug, Clone, Default)]
pub(crate) struct Scope {
    pub choices: Choices,
    /// The cards, by name, that no model uses.
    pub unused: Vec<String>,
    pub small_all: bool,
}

impl ChoicesFile {
    /// The model's choices with the computer's.
    pub(crate) fn scope(&self, key: &str) -> Scope {
        Scope { choices: self.models.get(key).cloned().unwrap_or_default(), ..self.computer_scope() }
    }

    /// The computer's choices with the standard ones for a model: for a model that has none yet.
    pub(crate) fn computer_scope(&self) -> Scope {
        Scope { choices: Choices::default(), unused: self.computer.unused_gpus.clone(), small_all: self.computer.small_models == SmallModels::All }
    }
}

/// The saved choices; the standard ones if the file isn't there.
pub fn read(paths: &Paths) -> Result<ChoicesFile> {
    let f = paths.data.join(FILE);
    let txt = match std::fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ChoicesFile::default()),
        Err(e) => return Err(user_error(&cannot_read(), format!("{}: {e}", f.display()))),
    };
    let file: ChoicesFile = serde_json::from_str(txt.trim_start_matches('\u{feff}')).map_err(|e| user_error(&not_valid(), format!("{}: {e}", f.display())))?;
    for (key, choices) in &file.models {
        choices.check(key).map_err(|e| user_error(&not_valid(), format!("{}: {e:#}", f.display())))?;
    }
    // a model list that cannot be read is told by whoever lists the models
    Ok(under_the_models_key(file, &mango_common::catalog::read(paths).map(|c| c.same).unwrap_or_default()))
}

/// What was chosen for an entry of the user's that is a Mango Code model's own file (`ModelCatalog::same`) is chosen
/// for that model: the entry is not a model any more.
fn under_the_models_key(mut file: ChoicesFile, same: &BTreeMap<String, String>) -> ChoicesFile {
    for (own, model) in same {
        if file.default.as_ref() == Some(own) {
            file.default = Some(model.clone());
        }
        if let Some(choices) = file.models.remove(own) {
            file.models.entry(model.clone()).or_insert(choices);
        }
    }
    file
}

/// Saves the choices of a model. A model that must run with its own engine only accepts `Auto`.
pub fn set_model(paths: &Paths, key: &str, mut choices: Choices) -> Result<()> {
    let file = load_models(paths)?;
    let cfg = model_cfg(&file, key)?;
    choices.check(&cfg.label)?;
    choices.check_context(&cfg.label, cfg.max_context(&file))?;
    if cfg.requires_engine.is_some() && choices.place != WhereChoice::Auto {
        anyhow::bail!("{}", only_automatic(&cfg.label));
    }
    if choices.place != WhereChoice::Pick {
        choices.gpus.clear();
    }
    change(paths, |c| {
        c.models.insert(key.to_string(), choices);
    })
}

/// The model started when the app opens; `None` = the first one on the disk.
pub fn set_default(paths: &Paths, key: Option<&str>) -> Result<()> {
    change(paths, |c| c.default = key.map(str::to_string))
}

/// The model that makes pictures when a request names none; `None` = the catalog's. It must be a model that makes images.
pub fn set_image_default(paths: &Paths, key: Option<&str>) -> Result<()> {
    if let Some(key) = key {
        let file = load_models(paths)?;
        if !file.is_image(key) {
            anyhow::bail!("{}", tr!("«{key}» non è un modello che fa immagini.", "«{key}» is not a model that makes images."));
        }
    }
    change(paths, |c| c.image_default = key.map(str::to_string))
}

/// `key` becomes the default only if the user has none: one chosen meanwhile is not replaced.
pub fn set_default_if_none(paths: &Paths, key: &str) -> Result<()> {
    if read(paths)?.default.is_some() {
        return Ok(());
    }
    change(paths, |c| {
        c.default.get_or_insert_with(|| key.to_string());
    })
}

/// A model that is no longer in the catalog (one of the user's, taken off the list): its choices go, and it is no longer
/// the default.
pub fn forget_model(paths: &Paths, key: &str) -> Result<()> {
    change(paths, |c| {
        c.models.remove(key);
        if c.default.as_deref() == Some(key) {
            c.default = None;
        }
    })
}

/// A card, by name, is used or not by the models.
pub fn set_gpu_used(paths: &Paths, name: &str, used: bool) -> Result<()> {
    change(paths, |c| {
        c.computer.unused_gpus.retain(|n| n != name);
        if !used {
            c.computer.unused_gpus.push(name.to_string());
        }
    })
}

pub fn set_small_models(paths: &Paths, small_models: SmallModels) -> Result<()> {
    change(paths, |c| c.computer.small_models = small_models)
}

pub fn set_update_automatic(paths: &Paths, automatic: bool) -> Result<()> {
    change(paths, |c| c.update.automatic = automatic)
}

/// The temperature of the styles that are not the model's own. «Precise» is never above the catalog's: a model made to
/// answer at 0.1 stays there.
const PRECISE: f64 = 0.3;
const CREATIVE: f64 = 1.1;

/// The sampling values a request gets: the catalog's (`catalog`), with the temperature of the style the user chose
/// («precise» and «creative»), and over them the values the user chose one by one.
pub(crate) fn effective_sampling(catalog: Option<Sampling>, choices: &Choices) -> Sampling {
    let mut sampling = catalog.unwrap_or_default();
    match choices.style {
        Style::Recommended => {}
        Style::Precise => sampling.temperature = Some(sampling.temperature.map_or(PRECISE, |t| t.min(PRECISE))),
        Style::Creative => sampling.temperature = Some(CREATIVE),
    }
    let own = &choices.sampling;
    Sampling {
        temperature: own.temperature.or(sampling.temperature),
        top_p: own.top_p.or(sampling.top_p),
        top_k: own.top_k.or(sampling.top_k),
        min_p: own.min_p.or(sampling.min_p),
        presence_penalty: own.presence_penalty.or(sampling.presence_penalty),
        repeat_penalty: own.repeat_penalty.or(sampling.repeat_penalty),
    }
}

/// What a chat request to `key` is given when it does not say it itself: the sampling values the user's style and
/// choices make of the catalog's (`effective_sampling`), the reasoning of the earlier turns kept in the history
/// (`chat_template_kwargs.preserve_thinking`, which a template that does not read it ignores) and, if the user chose it
/// for a model whose template offers it, the level (`reasoning_effort`) or the switch (`enable_thinking`).
pub(crate) fn request_defaults(paths: &Paths, key: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
    let cfg = model_cfg(&load_models(paths)?, key)?;
    let choices = read(paths)?.models.remove(key).unwrap_or_default();
    let sampling = effective_sampling(cfg.sampling, &choices);
    let serde_json::Value::Object(mut fields) = serde_json::to_value(sampling)? else { unreachable!("a struct is written as an object") };
    let mut kwargs = serde_json::Map::from_iter([("preserve_thinking".to_string(), true.into())]);
    if let Some((name, value)) = choices.reasoning.as_deref().and_then(|chosen| reasoning::of_model(paths, &cfg).kwarg(chosen)) {
        kwargs.insert(name.into(), value);
    }
    fields.insert("chat_template_kwargs".into(), kwargs.into());
    Ok(fields)
}

/// What a chat request to each model is given (`request_defaults`), kept in memory until one of the files it comes from is
/// written: the choices, the user's models, where the model files are. Whoever writes them says so
/// (`mango_common::catalog::changed`); a request does not read the disk. A model whose defaults cannot be read is read again at
/// the next request.
pub struct ModelDefaults {
    paths: Paths,
    kept: Mutex<Kept>,
}

struct Kept {
    revision: u64,
    models: std::collections::HashMap<String, serde_json::Map<String, serde_json::Value>>,
}

impl ModelDefaults {
    pub fn new(paths: Paths) -> ModelDefaults {
        let revision = mango_common::catalog::revision(&paths.data);
        ModelDefaults { paths, kept: Mutex::new(Kept { revision, models: Default::default() }) }
    }

    pub fn get(&self, key: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
        let revision = mango_common::catalog::revision(&self.paths.data);
        let mut kept = self.kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if kept.revision != revision {
            kept.revision = revision;
            kept.models.clear();
        }
        if let Some(fields) = kept.models.get(key) {
            return Ok(fields.clone());
        }
        let fields = request_defaults(&self.paths, key)?;
        kept.models.insert(key.to_string(), fields.clone());
        Ok(fields)
    }
}

/// Two commands that change the file at the same time must not read the same old content: one of the changes would be
/// lost. This process is the only one that writes the file.
static CHANGING: Mutex<()> = Mutex::new(());

/// Rereads the file, applies the change and writes it whole (`write_atomic`): a file that can't be read is not
/// overwritten. Only the models whose choices are not the standard ones are kept. One change at a time.
fn change(paths: &Paths, apply: impl FnOnce(&mut ChoicesFile)) -> Result<()> {
    // A change that panicked left the file whole (it is written last, atomically): the lock is good to use.
    let _one_at_a_time = CHANGING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut file = read(paths)?;
    apply(&mut file);
    file.models.retain(|_, c| *c != Choices::default());
    let f = paths.data.join(FILE);
    let error = |e: &dyn std::fmt::Display| user_error(&tr!("Non riesco a salvare le tue scelte.", "I can't save your choices."), format!("{}: {e}", f.display()));
    std::fs::create_dir_all(&paths.data).map_err(|e| error(&e))?;
    mango_common::write_atomic(&f, serde_json::to_string_pretty(&file)?).map_err(|e| error(&e))?;
    mango_common::catalog::changed(&paths.data);
    Ok(())
}

impl Choices {
    /// A context of 0 would make the engine take the model's own, a list of cards needs cards, and a sampling value
    /// has its interval. `name`: the model's label for the user, or its key in the file.
    fn check(&self, name: &str) -> Result<()> {
        if self.context == Some(0) {
            anyhow::bail!("{}", tr!("Il contesto scelto per «{name}» è 0.", "The context chosen for «{name}» is 0."));
        }
        if self.place == WhereChoice::Pick && self.gpus.is_empty() {
            anyhow::bail!("{}", tr!("Per «{name}» hai scelto le schede, ma non ne hai indicata nessuna.", "For «{name}» you chose the cards, but named none."));
        }
        if let Some(level) = self.reasoning.as_deref().filter(|l| !REASONING.contains(l)) {
            anyhow::bail!("{}", tr!("Per «{name}» il ragionamento «{level}» non esiste.", "For «{name}» the reasoning «{level}» does not exist."));
        }
        let s = &self.sampling;
        let in_interval = |field: &str, value: Option<f64>, low: f64, high: f64, range: String| match value {
            Some(v) if !(low..=high).contains(&v) => anyhow::bail!("{}", tr!("Per «{name}» il valore {field} deve stare {range}.", "For «{name}» the value {field} must be {range}.")),
            _ => Ok(()),
        };
        in_interval("temperature", s.temperature, 0.0, 2.0, tr!("fra 0 e 2", "between 0 and 2"))?;
        in_interval("top_p", s.top_p, 0.0, 1.0, tr!("fra 0 e 1", "between 0 and 1"))?;
        in_interval("min_p", s.min_p, 0.0, 1.0, tr!("fra 0 e 1", "between 0 and 1"))?;
        in_interval("presence_penalty", s.presence_penalty, -2.0, 2.0, tr!("fra -2 e 2", "between -2 and 2"))?;
        match s.repeat_penalty {
            Some(v) if !(v > 0.0 && v.is_finite()) => {
                anyhow::bail!("{}", tr!("Per «{name}» il valore repeat_penalty deve essere maggiore di 0.", "For «{name}» the value repeat_penalty must be above 0."))
            }
            _ => Ok(()),
        }
    }

    /// The context chosen is from the minimum (or what the model holds, if that is less) to what the model holds: less
    /// leaves the agent no room to work, more is not a context the model has. What the memory carries is not for the
    /// choice to say: the plan goes lower and the view tells it.
    fn check_context(&self, name: &str, max: u32) -> Result<()> {
        let Some(context) = self.context else { return Ok(()) };
        let k = context_label(MIN_CTX.min(max));
        if context < MIN_CTX.min(max) {
            anyhow::bail!("{}", tr!("Almeno {k} token: con meno l'agente non ha spazio per lavorare.", "At least {k} tokens: with less the agent has no room to work."));
        }
        let k = context_label(max);
        if context > max {
            anyhow::bail!("{}", tr!("«{name}» regge al massimo {k} token di contesto.", "«{name}» holds at most {k} tokens of context."));
        }
        Ok(())
    }
}

fn cannot_read() -> String {
    tr!("Non riesco a leggere le tue scelte.", "I can't read your choices.")
}

fn not_valid() -> String {
    tr!("Le tue scelte salvate non sono valide: correggile o toglile.", "Your saved choices are not valid: fix them or remove them.")
}

/// The sentence for a model that only runs with its own engine and was asked to run elsewhere.
pub(crate) fn only_automatic(label: &str) -> String {
    tr!(
        "Il modello «{label}» gira solo col suo motore: «Dove gira» può essere solo Automatico.",
        "The model «{label}» only runs with its own engine: «Where it runs» can only be Automatic."
    )
}
