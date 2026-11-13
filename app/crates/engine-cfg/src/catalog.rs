//! `mango-models.json`: the model catalog (what they are, where they are downloaded from, how much they weigh),
//! plus the user's models (`mango_common::catalog`). How they run on specific hardware is told by the profiles
//! (`profiles.rs`); failing that, the general plan (`general.rs`).

use crate::choices::{self, Choices, WhereChoice};
use crate::general::Placement;
use crate::gguf::cache_type;
use crate::hardware::{choose_build, Hardware};
use crate::profiles::{self, Profile};
use crate::split::{Layer, LayerKind, ModelShape};
use crate::user;
use anyhow::{bail, Result};
use mango_common::catalog::{file_for_engine, About, Sampling, USER_FILE};
use mango_common::download::installed_engine;
use mango_common::{tr, Build, Paths};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct ModelsFile {
    pub default: String,
    /// Target context of all models: it lives here so that it isn't lowered out of laziness.
    pub ctx: u32,
    /// The recommended local models, in the order they are listed everywhere: each local model of the catalog
    /// appears only once. Cloud ones aren't there.
    pub order: Vec<String>,
    /// Recommended and the user's together.
    pub models: BTreeMap<String, serde_json::Value>,
    /// The keys of `models` that come from the user's file.
    #[serde(skip)]
    pub user: Vec<String>,
}

/// Where a model comes from: the Mango Code catalog or the user's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Recommended,
    User,
}

impl ModelsFile {
    fn is_cloud(&self, key: &str) -> bool {
        self.models.get(key).is_some_and(|v| v.get("cloud").is_some())
    }

    /// The local models, in the order they are listed: the recommended ones as `order` says, then the user's by key.
    pub fn local(&self) -> impl Iterator<Item = &str> {
        self.order.iter().chain(&self.user).map(String::as_str).filter(|k| !self.is_cloud(k))
    }

    pub fn origin(&self, key: &str) -> Origin {
        if self.user.iter().any(|k| k == key) {
            Origin::User
        } else {
            Origin::Recommended
        }
    }

    /// The user's entries are read like the others; `order` names each recommended local model once and nothing else.
    fn validate(&self) -> Result<()> {
        for key in &self.user {
            if let Err(e) = serde_json::from_value::<ModelCfg>(self.models[key].clone()) {
                return Err(user(
                    &tr!(
                        "Nel tuo elenco di modelli ({USER_FILE}) «{key}» non è valido: correggilo o toglilo.",
                        "In your model list ({USER_FILE}) «{key}» is not valid: fix it or remove it."
                    ),
                    e,
                ));
            }
        }
        let mut seen: Vec<&str> = Vec::new();
        for key in &self.order {
            if seen.contains(&key.as_str()) {
                bail!("{}", user(&damaged_list(), format!("«{key}» is in the order twice")));
            }
            if !self.models.contains_key(key) || self.user.contains(key) || self.is_cloud(key) {
                bail!("{}", user(&damaged_list(), format!("the order names «{key}», which isn't a local model of the catalog")));
            }
            seen.push(key);
        }
        if let Some(key) = self.models.keys().find(|k| !self.is_cloud(k) && !self.user.contains(k) && !seen.contains(&k.as_str())) {
            bail!("{}", user(&damaged_list(), format!("the model «{key}» is not in the order")));
        }
        Ok(())
    }
}

fn damaged_list() -> String {
    tr!("L'elenco dei modelli di Mango Code è danneggiato. Reinstalla l'applicazione.", "The Mango Code model list is damaged. Reinstall the application.")
}

/// The engine of the official llama.cpp builds, the general plan's one.
pub(crate) const GENERAL_ENGINE: &str = "llamacpp";

/// A model file in the Hugging Face repo, and how much it weighs.
#[derive(Deserialize)]
pub(crate) struct ModelFile {
    pub path: String,
    pub size: u64,
    /// Missing for a file of the user's, which Mango Code never downloads (`mango_common::download::users_file`).
    #[serde(default)]
    pub sha256: String,
    /// The only engine that reads the file (`mango_common::catalog::file_for_engine`).
    pub engine: Option<String>,
}

/// The model's shape to split it across the GPUs before downloading it, from the GGUF header like `memory`:
/// `layers` (without the MTP ones), one with full attention every `attention_every` (the last of each group), the
/// others recurrent; equal weights per layer type. Cache and state come from `memory`.
#[derive(Deserialize)]
pub(crate) struct CatalogShape {
    pub layers: usize,
    pub attention_every: usize,
    pub attention_bytes: u64,
    pub recurrent_bytes: u64,
    /// Output head (weights and norm).
    pub output_bytes: u64,
    /// The MTP layer, if the GGUF has one.
    pub mtp_bytes: Option<u64>,
}

/// How much memory the model asks beyond the weights (read from the GGUF header).
#[derive(Deserialize)]
pub(crate) struct ModelMemory {
    /// K+V cache per token at f16, full-attention layers only.
    pub kv_kib_token: u64,
    /// Fixed state of the recurrent layers.
    pub state_mib: u64,
    /// Only in a user's model whose header the count doesn't know all of: the numbers are an estimate, and this says
    /// what the header lacked (technical, for whoever reads the file).
    pub estimated: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ModelCfg {
    pub label: String,
    pub cloud: Option<serde_json::Value>,
    pub gguf: Option<String>,
    pub mmproj: Option<String>,
    pub chat_template: Option<String>,
    /// The model's maximum context.
    pub ctx: Option<u32>,
    /// The engine without which the model can't be read (weights in a format official llama.cpp doesn't have).
    pub requires_engine: Option<String>,
    #[serde(default)]
    pub files: Vec<ModelFile>,
    pub memory: Option<ModelMemory>,
    pub shape: Option<CatalogShape>,
    /// In MoEs, the thousandths of the weights that are read for each token (the chosen experts and the rest of the
    /// model), from the GGUF header; absent in dense ones, which read all of them.
    pub active_permille: Option<u64>,
    /// A model for small graphics cards: it is proposed as the fastest only when no other recommended model fits on
    /// the cards (it reads the fewest weights, and would win on every PC).
    #[serde(default)]
    pub fallback: bool,
    /// Only on request: it stays in the list and whoever wants it chooses it, but it is never preselected nor marked
    /// as the fastest (TOQ, until it is reliable as an agent).
    #[serde(default)]
    pub on_request: bool,
    /// The line shown under the model's name.
    pub about: Option<About>,
    /// The values recommended by whoever made the model.
    pub sampling: Option<Sampling>,
    /// The model can think before it answers, and its chat template turns that on and off.
    #[serde(default)]
    pub reasoning: bool,
}

/// The image encoder's compute on a GPU, beyond its weights: an estimate, which with Qwen3.8's F16 weights (885 MiB)
/// comes to about 1.5 GB. It is confirmed with the `CLIP compute buffer size` line of the engine log.
const ENCODER_COMPUTE_MIB: u64 = 640;
const MIB: u64 = 1 << 20;

impl ModelCfg {
    /// The engine the model would run with: the setup's or, if this PC has none, the one it requires.
    pub fn engine_with<'a>(&'a self, setup: &'a Result<Setup>) -> &'a str {
        match setup {
            Ok(a) => a.engine(),
            Err(_) => self.requires_engine.as_deref().unwrap_or(GENERAL_ENGINE),
        }
    }

    /// The files to download for the model to run on `engine`.
    pub fn files_for<'a>(&'a self, engine: &'a str) -> impl Iterator<Item = &'a ModelFile> {
        self.files.iter().filter(move |f| file_for_engine(f.engine.as_deref(), engine))
    }

    /// The weights `engine` opens: the file in `files` reserved for it, if any, otherwise `gguf`.
    pub fn gguf_for(&self, engine: &str) -> Option<&str> {
        self.files
            .iter()
            .find(|f| f.engine.as_deref() == Some(engine) && self.mmproj.as_deref() != Some(f.path.as_str()))
            .map(|f| f.path.as_str())
            .or(self.gguf.as_deref())
    }

    /// The weights `engine` opens and the image encoder are in the models' folder.
    pub fn weights_on_disk(&self, paths: &Paths, engine: &str) -> bool {
        [self.gguf_for(engine), self.mmproj.as_deref()].into_iter().flatten().all(|rel| paths.models.join(rel).is_file())
    }

    /// The memory it asks is an estimate (`ModelMemory::estimated`).
    pub fn memory_estimated(&self) -> bool {
        self.memory.as_ref().is_some_and(|m| m.estimated.is_some())
    }

    /// The image encoder's memory on a GPU: its weights (from the catalog) and the compute. 0 without images.
    pub fn encoder_bytes(&self) -> u64 {
        self.mmproj_bytes() + self.encoder_compute_bytes()
    }

    /// The image encoder's weights, from the catalog. 0 without images.
    fn mmproj_bytes(&self) -> u64 {
        let Some(mmproj) = &self.mmproj else { return 0 };
        self.files.iter().find(|f| &f.path == mmproj).map_or(0, |f| f.size)
    }

    /// The image encoder's compute, beyond its weights. 0 without images.
    pub fn encoder_compute_bytes(&self) -> u64 {
        if self.mmproj.is_some() {
            ENCODER_COMPUTE_MIB * MIB
        } else {
            0
        }
    }

    /// The bytes of the weights that `engine` reads for every token written: all of them in dense models, only the
    /// active ones in MoEs.
    pub fn read_per_token(&self, engine: &str) -> u64 {
        self.weights_bytes(engine) * self.active_permille.unwrap_or(1000) / 1000
    }

    /// The weights `engine` loads, without the image encoder.
    pub fn weights_bytes(&self, engine: &str) -> u64 {
        self.files_for(engine).map(|f| f.size).sum::<u64>() - self.mmproj_bytes()
    }

    /// The model's shape from the catalog, with the cache types `ctk`/`ctv`. `None` if the catalog doesn't say.
    pub fn shape(&self, ctk: &str, ctv: &str) -> Result<Option<ModelShape>> {
        let (Some(f), Some(m)) = (&self.shape, &self.memory) else { return Ok(None) };
        if f.attention_every < 2 || f.layers < f.attention_every {
            bail!("{}", tr!(
                "forma del modello «{}» non valida: {} strati, uno ad attenzione ogni {}",
                "invalid shape of the model «{}»: {} layers, one with attention every {}",
                self.label,
                f.layers,
                f.attention_every
            ));
        }
        let n_attention = (f.layers / f.attention_every) as u64;
        let n_recurrent = f.layers as u64 - n_attention;
        // `kv_kib_token` is the K+V cache at f16 of all the attention layers: K and V weigh the same, and each scales
        // with its type.
        let values = m.kv_kib_token * 1024 / n_attention / 4;
        let ((kb, ke), (vb, ve)) = (cache_type(ctk)?, cache_type(ctv)?);
        let cache = (values * kb).div_ceil(ke) + (values * vb).div_ceil(ve);
        let attention = Layer { kind: LayerKind::Attention, weight_bytes: f.attention_bytes, cache_bytes_per_token: cache, state_bytes: 0 };
        let recurrent = Layer { kind: LayerKind::Recurrent, weight_bytes: f.recurrent_bytes, cache_bytes_per_token: 0, state_bytes: m.state_mib * MIB / n_recurrent };
        let layers = (0..f.layers).map(|il| if il % f.attention_every == f.attention_every - 1 { attention.clone() } else { recurrent.clone() }).collect();
        let mtp = f.mtp_bytes.map(|b| Layer { weight_bytes: b, ..attention.clone() }).into_iter().collect();
        Ok(Some(ModelShape { layers, mtp, output_bytes: f.output_bytes }))
    }
}

pub(crate) fn load_models(paths: &Paths) -> Result<ModelsFile> {
    let c = mango_common::catalog::read(paths)?;
    let mut file: ModelsFile = serde_json::from_value(c.root).map_err(|e| user(&damaged_list(), format!("mango-models.json: {e}")))?;
    file.user = c.user;
    file.validate()?;
    Ok(file)
}

pub(crate) fn model_cfg(file: &ModelsFile, key: &str) -> Result<ModelCfg> {
    let raw = file.models.get(key).ok_or_else(|| {
        let known: Vec<_> = file.models.keys().map(String::as_str).collect();
        user(
            &tr!("Il modello richiesto non è tra quelli di Mango Code.", "The requested model is not among Mango Code's."),
            format!("«{key}» unknown; available: {}", known.join(", ")),
        )
    })?;
    serde_json::from_value(raw.clone()).map_err(|e| {
        user(
            &tr!("La configurazione del modello è danneggiata. Reinstalla l'applicazione.", "The model configuration is damaged. Reinstall the application."),
            format!("model «{key}»: {e}"),
        )
    })
}

/// Which engine a model runs with on a piece of hardware: the profile if it applies, otherwise official llama.cpp.
pub(crate) enum Setup {
    Profile(Box<Profile>),
    General { build: Build },
}

impl Setup {
    pub fn engine(&self) -> &str {
        match self {
            Setup::Profile(p) => &p.engine,
            Setup::General { .. } => GENERAL_ENGINE,
        }
    }

    pub fn build(&self) -> Build {
        match self {
            Setup::Profile(p) => p.build,
            Setup::General { build } => *build,
        }
    }
}

/// A model that requires an engine of its own doesn't run with the general one: without a profile for this hardware
/// (of its GPUs or of its build), error. The profile counts only if the model's choice is «auto»: any other choice
/// runs the general plan, which the engine of a model that requires its own cannot do.
pub(crate) fn setup_for(paths: &Paths, key: &str, cfg: &ModelCfg, hw: &Hardware, choices: &Choices) -> Result<Setup> {
    if cfg.requires_engine.is_some() && choices.place != WhereChoice::Auto {
        bail!("{}", choices::only_automatic(&cfg.label));
    }
    if choices.place == WhereChoice::Auto {
        if let Some(p) = profiles::lookup(paths, key, hw)? {
            return Ok(Setup::Profile(Box::new(p)));
        }
    }
    match &cfg.requires_engine {
        Some(m) => Err(user(
            &tr!(
                "Il modello «{}» gira solo sul motore «{m}», che per questo PC non c'è ancora.",
                "The model «{}» only runs on the engine «{m}», which isn't available for this PC yet.",
                cfg.label
            ),
            format!("no profile of «{key}» for this PC's GPUs or build ({})", choose_build(hw).as_str()),
        )),
        None => Ok(Setup::General { build: choose_build(hw) }),
    }
}

/// A local catalog model, for whoever has to choose it (the app, the integration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelEntry {
    pub key: String,
    pub label: String,
    pub origin: Origin,
    /// Context it runs with on this hardware (the plan confirms it at every start).
    pub ctx: u32,
    /// Where it runs on this hardware; `None` if it doesn't fit.
    pub placement: Option<Placement>,
    pub images: bool,
    /// `None` if weights, image encoder and engine are on disk; otherwise what is missing.
    pub missing: Option<String>,
    /// Weights and image encoder are on disk (the engine may still be missing).
    pub weights: bool,
    /// The weights it loads, without the image encoder.
    pub bytes: u64,
    /// How fast it writes, if it runs on the processor.
    pub speed: Option<crate::Speed>,
    /// Its memory is estimated (a model of the user's that the count doesn't know): the verdict may be wrong.
    pub estimated: bool,
}

/// The local models (cloud ones stay out) in catalog order, the recommended ones first and then the user's, and the
/// default's key.
pub fn catalog(paths: &Paths) -> Result<(Vec<ModelEntry>, String)> {
    catalog_for(paths, &crate::hardware::detect()?)
}

pub fn catalog_for(paths: &Paths, hw: &Hardware) -> Result<(Vec<ModelEntry>, String)> {
    let file = load_models(paths)?;
    let choices = choices::read(paths)?;
    let mut entries = Vec::new();
    for key in file.local() {
        let cfg = model_cfg(&file, key)?;
        let assessed = crate::view::assess(paths, &file, key, &cfg, hw, &choices, &[]);
        let engine = cfg.engine_with(&assessed.setup);
        let mut missing = None;
        for rel in [cfg.gguf_for(engine), cfg.mmproj.as_deref()].into_iter().flatten() {
            if !paths.models.join(rel).is_file() {
                missing.get_or_insert(tr!("manca {}", "missing {}", paths.models.join(rel).display()));
            }
        }
        let weights = missing.is_none();
        let (bytes, read_per_token) = (cfg.weights_bytes(engine), cfg.read_per_token(engine));
        let target = cfg.ctx.unwrap_or(file.ctx).min(file.ctx);
        // Without a fit the context is the nominal one: the profile's or the model's target.
        let nominal = match &assessed.setup {
            Ok(Setup::Profile(p)) => p.ctx,
            _ => target,
        };
        match &assessed.setup {
            Ok(a) if installed_engine(paths, a.engine(), a.build()).is_none() => {
                missing.get_or_insert(tr!("manca il motore {} ({})", "the engine {} ({}) is missing", a.engine(), a.build().as_str()));
            }
            Err(e) => {
                missing.get_or_insert(format!("{e:#}"));
            }
            Ok(_) => {}
        }
        let (ctx, placement) = match &assessed.located.fit {
            Some(f) => (f.ctx, Some(f.placement)),
            None => (nominal, None),
        };
        let speed = (placement == Some(Placement::Cpu)).then(|| crate::cpu_speed(read_per_token));
        let estimated = cfg.memory_estimated();
        entries.push(ModelEntry { key: key.to_string(), label: cfg.label, origin: file.origin(key), ctx, placement, images: cfg.mmproj.is_some(), missing, weights, bytes, speed, estimated });
    }
    Ok((entries, file.default))
}

/// What downloading a local model of the catalog means on a computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadPlan {
    pub label: String,
    /// The engine and the build it would run with here, given the user's choices for it.
    pub engine: String,
    pub build: Build,
    /// The bytes of its files for that engine.
    pub bytes: u64,
    /// Its weights and image encoder are already on disk.
    pub weights: bool,
    /// Why it does not fit this computer, if it doesn't.
    pub fits: std::result::Result<(), String>,
}

/// What downloading `key` means on `hw`. An error for a model that is not a local model of the catalog, or that has no
/// engine for this computer.
pub fn download_of(paths: &Paths, key: &str, hw: &Hardware) -> Result<DownloadPlan> {
    let file = load_models(paths)?;
    let cfg = model_cfg(&file, key)?;
    if cfg.cloud.is_some() {
        bail!("{}", tr!("«{}» è un modello online, non si scarica.", "«{}» is an online model, it is not downloaded.", cfg.label));
    }
    let assessed = crate::view::assess(paths, &file, key, &cfg, hw, &choices::read(paths)?, &[]);
    let setup = assessed.setup?;
    let weights = cfg.weights_on_disk(paths, setup.engine());
    Ok(DownloadPlan {
        engine: setup.engine().to_string(),
        build: setup.build(),
        bytes: cfg.files_for(setup.engine()).map(|f| f.size).sum(),
        weights,
        fits: assessed.located.fit.map(|_| ()).ok_or(assessed.located.reason),
        label: cfg.label,
    })
}

/// The model the app loads when it opens: the one the user made the default (`choices.json`) if it is on disk with its
/// engine, also when it no longer fits (its start then says why). Otherwise, of `entries`, which come in the catalog's
/// order, the first on disk that fits this computer; if none fits, the first on disk. `None`: there is nothing to load yet.
pub fn startup_model(paths: &Paths, entries: &[ModelEntry]) -> Result<Option<String>> {
    let on_disk = || entries.iter().filter(|e| e.missing.is_none());
    let default = choices::read(paths)?.default;
    let chosen = on_disk().find(|e| Some(&e.key) == default.as_ref()).or_else(|| on_disk().find(|e| e.placement.is_some())).or_else(|| on_disk().next());
    Ok(chosen.map(|e| e.key.clone()))
}

/// The model to save as the default while the user has none (the model a computer starts with does not change
/// by itself): `remembered`, the last model of 0.1.2 (`model.txt`), if it is on the disk and fits, otherwise the model
/// the app loads, if it fits. Only a model with a place to run: one that does not fit, kept forever, would not give way
/// to one that arrives later and fits. `None` with a default saved already, or with nothing on the disk that fits.
pub fn default_to_save(paths: &Paths, entries: &[ModelEntry], remembered: Option<&str>) -> Result<Option<String>> {
    if choices::read(paths)?.default.is_some() {
        return Ok(None);
    }
    let fits = |key: &str| entries.iter().any(|e| e.key == key && e.missing.is_none() && e.placement.is_some());
    Ok(remembered.filter(|k| fits(k)).map(str::to_string).or(startup_model(paths, entries)?.filter(|k| fits(k))))
}

/// The needed file must be there: otherwise a readable error with what to do.
pub(crate) fn require(p: &Path, what: &str, remedy: &str) -> Result<()> {
    if p.is_file() {
        Ok(())
    } else {
        Err(user(&format!("{what} {remedy}"), format!("file not found: {}", p.display())))
    }
}
