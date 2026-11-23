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
use mango_common::catalog::{file_for_engine, About, ImageModel, Sampling, USER_FILE};
use mango_common::download::installed_engine;
use mango_common::{tr, Build, Paths};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct ModelsFile {
    pub default: String,
    /// The maximum context of a model that does not say its own.
    pub ctx: u32,
    /// The recommended local models that write, in the order they are listed everywhere: each of them appears only
    /// once. Cloud ones and the ones that make images aren't there.
    pub order: Vec<String>,
    /// Recommended and the user's together.
    pub models: BTreeMap<String, serde_json::Value>,
    /// The model used for a picture when none is named.
    pub image_default: Option<String>,
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

    /// A model that makes images: it is downloaded like the others, and never listed among the models of a
    /// conversation.
    pub fn is_image(&self, key: &str) -> bool {
        self.models.get(key).is_some_and(|v| v.get("image").is_some())
    }

    /// The local models, in the order they are listed: the recommended ones as `order` says, then the user's by key.
    pub fn local(&self) -> impl Iterator<Item = &str> {
        self.order.iter().chain(&self.user).map(String::as_str).filter(|k| !self.is_cloud(k) && !self.is_image(k))
    }

    pub fn origin(&self, key: &str) -> Origin {
        if self.user.iter().any(|k| k == key) {
            Origin::User
        } else {
            Origin::Recommended
        }
    }

    /// The user's entries are read like the others; `order` names each recommended local model that writes once and
    /// nothing else.
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
            if !self.models.contains_key(key) || self.user.contains(key) || self.is_cloud(key) || self.is_image(key) {
                bail!("{}", user(&damaged_list(), format!("the order names «{key}», which isn't a local model of the catalog that writes")));
            }
            seen.push(key);
        }
        if let Some(key) = self.models.keys().find(|k| !self.is_cloud(k) && !self.is_image(k) && !self.user.contains(k) && !seen.contains(&k.as_str())) {
            bail!("{}", user(&damaged_list(), format!("the model «{key}» is not in the order")));
        }
        if let Some(key) = self.image_default.as_ref().filter(|k| !self.is_image(k)) {
            bail!("{}", user(&damaged_list(), format!("the default image model «{key}» is not a model that makes images")));
        }
        Ok(())
    }
}

fn damaged_list() -> String {
    tr!("L'elenco dei modelli di Mango Code è danneggiato. Reinstalla l'applicazione.", "The Mango Code model list is damaged. Reinstall the application.")
}

/// The engine of the official llama.cpp builds, the general plan's one.
pub(crate) const GENERAL_ENGINE: &str = "llamacpp";

/// The engine of the models that make images: stable-diffusion.cpp.
pub(crate) const IMAGE_ENGINE: &str = "sd";

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
    /// Mango Code's own file, moved by the user to another folder: `path` is where it is (`mango_common::model_files`).
    #[serde(default)]
    pub relocated: bool,
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
    /// The model makes images: what it is made of.
    pub image: Option<ImageModel>,
    /// The license of its weights, as its catalog entry names it.
    pub license: Option<String>,
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
}

/// The image encoder's compute on a GPU, beyond its weights: an estimate, which with Qwen3.8's F16 weights (885 MiB)
/// comes to about 1.5 GB. It is confirmed with the `CLIP compute buffer size` line of the engine log.
const ENCODER_COMPUTE_MIB: u64 = 640;
const MIB: u64 = 1 << 20;

impl ModelCfg {
    /// The most context the model holds: its own, or the catalog's for a model that does not say it.
    pub(crate) fn max_context(&self, file: &ModelsFile) -> u32 {
        self.ctx.unwrap_or(file.ctx)
    }

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
        [self.gguf_for(engine), self.mmproj.as_deref()].into_iter().flatten().all(|rel| mango_common::model_files::listed(&paths.models.join(rel)).is_some_and(|m| m.is_file()))
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

    /// The model runs on the processor: official llama.cpp's processor-only build, never the cards' with no card seen
    /// (the CUDA build used that way closes at random).
    pub fn on_processor(&mut self) {
        if let Setup::General { build } = self {
            *build = Build::Cpu;
        }
    }

    /// The engine is not on the disk and the app brings it by itself: a new version of one it has (an update), or the
    /// small processor-only build of official llama.cpp on a PC that already has the engine for its cards.
    pub fn arrives(&self, paths: &Paths) -> bool {
        let processor = matches!(self, Setup::General { build: Build::Cpu });
        mango_common::download::older_engine(paths, self.engine(), self.build())
            || (processor && mango_common::download::other_build_installed(paths, self.engine(), Build::Cpu))
    }
}

/// A model that requires an engine of its own doesn't run with the general one: without a profile for this hardware
/// (of its GPUs or of its build), error. The profile counts only if the model's choice is «auto»: any other choice
/// runs the general plan, which the engine of a model that requires its own cannot do.
pub(crate) fn setup_for(paths: &Paths, key: &str, cfg: &ModelCfg, hw: &Hardware, choices: &Choices) -> Result<Setup> {
    if cfg.requires_engine.is_some() && choices.place != WhereChoice::Auto {
        bail!("{}", choices::only_automatic(&cfg.label));
    }
    let profile = if choices.place == WhereChoice::Auto { profiles::lookup(paths, key, hw)? } else { None };
    match (profile, &cfg.requires_engine) {
        (Some(p), _) => Ok(Setup::Profile(Box::new(p))),
        (None, Some(m)) if !hw.cpu.avx2 && mango_common::download::needs_avx2(paths, m) => Err(user(
            &tr!(
                "Il modello «{}» gira solo sul motore «{m}», che richiede un processore con AVX2: quello di questo PC non ce l'ha.",
                "The model «{}» only runs on the engine «{m}», which needs a processor with AVX2: this PC's does not have it.",
                cfg.label
            ),
            format!("«{m}» is compiled for AVX2, the CPU has none"),
        )),
        (None, Some(m)) => Err(user(
            &tr!(
                "Il modello «{}» gira solo sul motore «{m}», che per questo PC non c'è ancora.",
                "The model «{}» only runs on the engine «{m}», which isn't available for this PC yet.",
                cfg.label
            ),
            format!("no profile of «{key}» for this PC's GPUs or build ({})", choose_build(hw).as_str()),
        )),
        (None, None) => Ok(Setup::General { build: choose_build(hw) }),
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
    /// Its files are on the disk and it waits for the new version of its engine, whose old version is on the disk: the
    /// update of the engine brings it.
    pub waits_engine: bool,
    /// The engine and the build it runs with on this computer; `None` if it has none (`missing` says why).
    pub engine: Option<(String, Build)>,
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
            if !mango_common::model_files::listed(&paths.models.join(rel)).is_some_and(|m| m.is_file()) {
                missing.get_or_insert(tr!("manca {}", "missing {}", paths.models.join(rel).display()));
            }
        }
        let weights = missing.is_none();
        let (bytes, read_per_token) = (cfg.weights_bytes(engine), cfg.read_per_token(engine));
        let target = cfg.max_context(&file);
        // Without a fit the context is the nominal one: the profile's or the model's target.
        let nominal = match &assessed.setup {
            Ok(Setup::Profile(p)) => p.ctx,
            _ => target,
        };
        let mut waits_engine = false;
        let used_engine = assessed.setup.as_ref().ok().map(|a| (a.engine().to_string(), a.build()));
        match &assessed.setup {
            Ok(a) if installed_engine(paths, a.engine(), a.build()).is_none() => {
                waits_engine = weights && a.arrives(paths);
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
        entries.push(ModelEntry { key: key.to_string(), label: cfg.label, origin: file.origin(key), ctx, placement, images: cfg.mmproj.is_some(), missing, weights, waits_engine, engine: used_engine, bytes, speed, estimated });
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
    if cfg.image.is_some() {
        // Whether it fits is not told: what these models ask of a card and of the processor is not measured yet.
        return Ok(DownloadPlan {
            engine: IMAGE_ENGINE.to_string(),
            build: image_build(hw),
            bytes: cfg.files.iter().map(|f| f.size).sum(),
            weights: cfg.files.iter().all(|f| mango_common::model_files::listed(&paths.models.join(&f.path)).is_some_and(|m| m.is_file())),
            fits: Ok(()),
            label: cfg.label,
        });
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

/// The build of the image engine for this hardware: the one llama.cpp would get, except that stable-diffusion.cpp
/// publishes no CUDA 13 build. A driver that runs CUDA 13 runs CUDA 12 too.
pub(crate) fn image_build(hw: &Hardware) -> Build {
    match choose_build(hw) {
        Build::Cuda13 => Build::Cuda12,
        build => build,
    }
}

/// The model the app loads when it opens: the one the user made the default (`choices.json`) if it is on disk with its
/// engine, or waiting for the new version of its engine (then it is loaded when the engine arrives, and no other model
/// takes its place), also when it no longer fits (its start then says why). Otherwise `ready_model`.
pub fn startup_model(paths: &Paths, entries: &[ModelEntry]) -> Result<Option<String>> {
    let default = choices::read(paths)?.default;
    let waiting = entries.iter().find(|e| Some(&e.key) == default.as_ref() && (e.missing.is_none() || e.waits_engine));
    Ok(waiting.map(|e| e.key.clone()).or_else(|| ready_model(entries.iter())))
}

/// Of `entries`, which come in the catalog's order, the first on disk with its engine that fits this computer; if none
/// fits, the first on disk. `None`: no model can be loaded now.
fn ready_model<'a>(entries: impl Iterator<Item = &'a ModelEntry> + Clone) -> Option<String> {
    let on_disk = entries.filter(|e| e.missing.is_none());
    on_disk.clone().find(|e| e.placement.is_some()).or_else(|| on_disk.clone().next()).map(|e| e.key.clone())
}

/// What the engine manager is doing, as far as loading the default model is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineNow {
    /// No model is running or loading, and the last start did not fail.
    Free,
    /// Nothing runs, and the last start, of the model the app was waiting to load (its key), failed.
    Failed(String),
    /// A model runs, loads or was chosen, the user stopped the engine, or a start they asked for failed: it is left alone.
    Busy,
}

/// What `model_to_load` looks at.
pub struct Situation<'a> {
    /// The catalog as it is now.
    pub entries: &'a [ModelEntry],
    /// The model the app loads when nothing is loaded (`startup_model`).
    pub default: Option<&'a str>,
    pub engine: &'a EngineNow,
    /// The models whose download is queued or in progress (not paused, not failed).
    pub live: &'a [String],
    /// The models being taken off the computer.
    pub removing: &'a [String],
}

/// What the app does about the model to load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Load {
    /// The default's engine is coming: nothing is loaded yet.
    Wait,
    Model(String),
    Nothing,
}

/// What to do about the model to load. A model that is running, loading or chosen, or the failure of another model than
/// the default, is left alone. Otherwise the default loads once it is ready, also after a start that failed for its
/// missing engine; it waits while a download that brings its engine is queued or in progress; when nothing brings the
/// engine, a model that is ready loads. A model being taken off the computer is never loaded.
pub fn model_to_load(s: &Situation) -> Load {
    match s.engine {
        EngineNow::Busy => return Load::Nothing,
        EngineNow::Failed(model) if s.default != Some(model.as_str()) => return Load::Nothing,
        _ => {}
    }
    let usable = |e: &&ModelEntry| !s.removing.contains(&e.key);
    let default = s.default.and_then(|key| s.entries.iter().find(|e| e.key == key)).filter(usable);
    if let Some(d) = default {
        if d.missing.is_none() {
            return Load::Model(d.key.clone());
        }
        if d.waits_engine && s.entries.iter().any(|e| s.live.contains(&e.key) && e.engine == d.engine) {
            return Load::Wait;
        }
    }
    ready_model(s.entries.iter().filter(usable)).map_or(Load::Nothing, Load::Model)
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
    if mango_common::model_files::listed(p).is_some_and(|m| m.is_file()) {
        Ok(())
    } else {
        Err(user(&format!("{what} {remedy}"), format!("file not found: {}", p.display())))
    }
}
