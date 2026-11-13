//! The user's saved choices, `<data>\choices.json`: where each model runs and with what context, which graphics cards
//! the models may use, the default model, the automatic update. The app writes it (the bridge's commands call the
//! `set_*` functions); every plan and every verdict reads it, so a choice applies to whoever asks for a plan.
//!
//! Without the file everything has its standard value. A key the program doesn't know (a model that is no longer in
//! the catalog, a field of a later version) is ignored. A file that can't be read or understood is an error with a
//! sentence for the user, never the standard values in its place; and it is not overwritten.

use crate::catalog::{load_models, model_cfg};
use anyhow::Result;
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
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Choices {
    #[serde(rename = "where")]
    pub place: WhereChoice,
    /// The cards by name; only with `WhereChoice::Pick`.
    pub gpus: Vec<String>,
    /// `None` = the largest that fits.
    pub context: Option<u32>,
    pub style: Style,
    /// `None` = as the model wants.
    pub reasoning: Option<bool>,
}

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

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChoicesFile {
    /// The model started when the app opens.
    pub default: Option<String>,
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
    Ok(file)
}

/// Saves the choices of a model. A model that must run with its own engine only accepts `Auto`.
pub fn set_model(paths: &Paths, key: &str, mut choices: Choices) -> Result<()> {
    let file = load_models(paths)?;
    let cfg = model_cfg(&file, key)?;
    choices.check(&cfg.label)?;
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

/// What a chat request to `key` is given when it does not say it itself: the sampling values of the style the user
/// chose (the catalog's own for «recommended», the same with another temperature for «precise» and «creative») and, if
/// the user chose it for a model that reasons, whether it reasons (`chat_template_kwargs.enable_thinking`). Empty when
/// there is nothing to add: a model with no values in the catalog, the recommended style and the reasoning as the model
/// wants.
pub fn request_defaults(paths: &Paths, key: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
    let cfg = model_cfg(&load_models(paths)?, key)?;
    let choices = read(paths)?.models.remove(key).unwrap_or_default();
    let mut sampling = cfg.sampling.unwrap_or_default();
    match choices.style {
        Style::Recommended => {}
        Style::Precise => sampling.temperature = Some(sampling.temperature.map_or(PRECISE, |t| t.min(PRECISE))),
        Style::Creative => sampling.temperature = Some(CREATIVE),
    }
    let serde_json::Value::Object(mut fields) = serde_json::to_value(sampling)? else { unreachable!("a struct is written as an object") };
    if let (true, Some(reason)) = (cfg.reasoning, choices.reasoning) {
        fields.insert("chat_template_kwargs".into(), serde_json::json!({ "enable_thinking": reason }));
    }
    Ok(fields)
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
    mango_common::write_atomic(&f, serde_json::to_string_pretty(&file)?).map_err(|e| error(&e))
}

impl Choices {
    /// A context of 0 would make the engine take the model's own, and a list of cards needs cards. `name`: the model's
    /// label for the user, or its key in the file.
    fn check(&self, name: &str) -> Result<()> {
        if self.context == Some(0) {
            anyhow::bail!("{}", tr!("Il contesto scelto per «{name}» è 0.", "The context chosen for «{name}» is 0."));
        }
        if self.place == WhereChoice::Pick && self.gpus.is_empty() {
            anyhow::bail!("{}", tr!("Per «{name}» hai scelto le schede, ma non ne hai indicata nessuna.", "For «{name}» you chose the cards, but named none."));
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
