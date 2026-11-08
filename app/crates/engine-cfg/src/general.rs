//! The general plan: for hardware without a profile, official llama.cpp with the build chosen by `choose_build` and
//! the arguments computed from the hardware. The memory estimate also lives here: it serves the plan (where the
//! model runs and what context it holds) and `recommended` (which models fit, and where).
//!
//! A model runs **entirely on the graphics cards or entirely on the processor**, never split: on the cards if
//! weights and cache (at least `MIN_CTX` tokens) fit, otherwise on the processor if they fit in RAM, otherwise it
//! doesn't fit.
//!
//! `llama-server` options used, checked with `--help` and in the sources of build b12110 (`common/arg.cpp`,
//! `common/fit.cpp`): `-fit off` (by default `-fit` is on and, if the cards' memory isn't enough, moves layers or
//! experts to RAM), `-ngl all` (every layer on the cards), `-dev none` (nothing on the cards, image encoder
//! included), `-c`, `-ctk`/`-ctv`, `-fa`, `-t`, `-np`, `--slot-save-path`, `--mmproj`, `--chat-template-file`. With
//! more cards llama.cpp splits the layers by itself (`-sm layer` is the default). On-disk memory and MTP belong to
//! the profiles' engines: they aren't here.

use crate::catalog::{load_models, model_cfg, setup_for, ModelCfg, ModelsFile, Origin, Setup, GENERAL_ENGINE};
use crate::hardware::{choose_build, Hardware, Vendor, Gpu};
use crate::split::MIN_CTX;
use anyhow::{anyhow, bail, Result};
use mango_common::i18n::{lang, Lang};
use mango_common::{tr, Build, Paths};
use serde::{Deserialize, Serialize};

/// The context is chosen in multiples of this step.
const CTX_STEP: u32 = 4096;
/// Memory that Windows (screen, DWM) and the CUDA context take from each card (measured, see `split.rs`) plus a
/// margin for the engine's compute buffers (1024 MiB, what `-fit` would leave free by default).
const GPU_RESERVE_MIB: u64 = 1100 + 1024;
/// RAM left to Windows and the other programs when the model runs on the processor.
const RAM_RESERVE_MIB: u64 = 4096;
const MIB: u64 = 1 << 20;

/// Where a model runs: entirely on the graphics cards or entirely on the processor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Gpu,
    Cpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KvType {
    F16,
    Q8_0,
}

impl KvType {
    /// Bytes per token of a cache that weighs `f16` at f16: q8_0 uses 34 bytes every 32 values against 64.
    fn bytes_per_token(self, f16: u64) -> u64 {
        match self {
            KvType::F16 => f16,
            KvType::Q8_0 => f16 * 17 / 32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContextFit {
    pub ctx: u32,
    pub kv: KvType,
    pub placement: Placement,
}

/// What a model asks of memory, from the catalog.
struct Needs {
    /// Weights of the model and of the image encoder, with the encoder's compute.
    weights_mib: u64,
    kv_f16_bytes_per_token: u64,
    state_mib: u64,
    /// The context we want to have: the common target, if the model holds it.
    target: u32,
}

impl Needs {
    /// The minimum to run: weights, state and q8_0 cache for `MIN_CTX` tokens (or the target, if it is lower).
    fn minimum_mib(&self) -> u64 {
        let kv = KvType::Q8_0.bytes_per_token(self.kv_f16_bytes_per_token) * u64::from(MIN_CTX.min(self.target));
        self.weights_mib + self.state_mib + kv.div_ceil(MIB)
    }
}

fn needs(file: &ModelsFile, cfg: &ModelCfg, key: &str) -> Result<Needs> {
    let Some(m) = &cfg.memory else {
        bail!(
            "{}",
            tr!(
                "Il catalogo non dice quanta memoria chiede il modello «{key}». Reinstalla l'applicazione.",
                "The catalog doesn't say how much memory the model «{key}» needs. Reinstall the application."
            )
        )
    };
    if cfg.files.is_empty() {
        bail!(
            "{}",
            tr!(
                "Il catalogo non dice quanto pesano i file del modello «{key}». Reinstalla l'applicazione.",
                "The catalog doesn't say how much the files of the model «{key}» weigh. Reinstall the application."
            )
        );
    }
    let bytes: u64 = cfg.files_for(GENERAL_ENGINE).map(|f| f.size).sum::<u64>() + cfg.encoder_compute_bytes();
    Ok(Needs {
        weights_mib: bytes.div_ceil(MIB),
        kv_f16_bytes_per_token: m.kv_kib_token * 1024,
        state_mib: m.state_mib,
        target: cfg.ctx.unwrap_or(file.ctx).min(file.ctx),
    })
}

/// The cards the general engine uses: with CUDA only the NVIDIA ones, with Vulkan all of them, with the CPU none.
/// Without the `excluded` ones (indexes of the cards released for another job).
fn engine_gpus<'a>(hw: &'a Hardware, build: Build, excluded: &[u32]) -> Vec<&'a Gpu> {
    match build {
        Build::Cpu => Vec::new(),
        Build::Vulkan => hw.usable().filter(|s| !excluded.contains(&s.index)).collect(),
        Build::Cuda12 | Build::Cuda13 => hw.usable().filter(|s| s.vendor == Vendor::Nvidia && !excluded.contains(&s.index)).collect(),
    }
}

/// Memory of the cards to count on for weights and cache.
fn gpus_memory_mib(gpus: &[&Gpu]) -> u64 {
    gpus.iter().map(|s| s.memory_mib.saturating_sub(GPU_RESERVE_MIB)).sum()
}

fn ram_memory_mib(hw: &Hardware) -> u64 {
    hw.ram_mib.saturating_sub(RAM_RESERVE_MIB)
}

/// The context that fits in `available_mib`: the target with the f16 cache if it fits, otherwise the q8_0 cache
/// (half), down to `MIN_CTX` below which the agent isn't usable (a lower target stays its own).
fn context(f: &Needs, available_mib: u64, placement: Placement) -> Option<ContextFit> {
    let free = available_mib.checked_sub(f.weights_mib + f.state_mib)? * MIB;
    let with = |kv: KvType| {
        let per_token = kv.bytes_per_token(f.kv_f16_bytes_per_token);
        let fits = free.checked_div(per_token).unwrap_or(u64::MAX);
        // The target is kept whole if it fits; otherwise it goes down in multiples of the step.
        let ctx = if fits >= u64::from(f.target) { f.target } else { fits as u32 / CTX_STEP * CTX_STEP };
        (ctx >= MIN_CTX.min(f.target)).then_some(ContextFit { ctx, kv, placement })
    };
    match with(KvType::F16) {
        Some(c) if c.ctx >= f.target => Some(c),
        _ => with(KvType::Q8_0),
    }
}

/// Where the model runs and with what context: entirely on the engine's cards if it fits, otherwise entirely on the
/// processor if RAM is enough. `None` if it fits nowhere.
fn place(f: &Needs, hw: &Hardware, build: Build) -> Option<ContextFit> {
    let gpus = engine_gpus(hw, build, &[]);
    let on_gpus = if gpus.is_empty() { None } else { context(f, gpus_memory_mib(&gpus), Placement::Gpu) };
    on_gpus.or_else(|| context(f, ram_memory_mib(hw), Placement::Cpu))
}

/// Where and with what context the general plan runs the model on `hw` with `build`, if it fits.
pub(crate) fn context_for(file: &ModelsFile, cfg: &ModelCfg, hw: &Hardware, build: Build) -> Option<ContextFit> {
    place(&needs(file, cfg, "").ok()?, hw, build)
}

/// A model's general plan: what is started, with which arguments.
pub(crate) struct GeneralPlan {
    pub ctx: u32,
    pub gpus: Vec<Gpu>,
    pub env: Vec<(String, String)>,
    /// The hardware's own arguments, after those common to all engines.
    pub args: Vec<String>,
}

/// Where the model runs is decided on the whole hardware: a card lent to another job (`excluded`) doesn't send a GPU
/// model to the processor, it runs it on the remaining cards if it fits.
pub(crate) fn plan(file: &ModelsFile, cfg: &ModelCfg, key: &str, hw: &Hardware, excluded: &[u32]) -> Result<GeneralPlan> {
    let build = choose_build(hw);
    let f = needs(file, cfg, key)?;
    let c = place(&f, hw, build).ok_or_else(|| anyhow!("{}", does_not_fit(&f, cfg, hw, build)))?;
    // `-fit` is on by default and, if the cards' memory isn't enough, would move parts of the model to RAM.
    let mut args = vec!["-fit".to_string(), "off".to_string()];
    let mut env = Vec::new();
    if c.placement == Placement::Cpu {
        args.extend(["-dev".to_string(), "none".to_string(), "-t".to_string(), hw.cpu.cores.to_string()]);
        args.extend(cache_q8(c.kv));
        return Ok(GeneralPlan { ctx: c.ctx, gpus: Vec::new(), env, args });
    }
    if build == Build::Vulkan && !excluded.is_empty() {
        bail!(
            "{}",
            tr!(
                "Con la build Vulkan non si può liberare una scheda singola: il modello «{}» usa tutte le schede.",
                "With the Vulkan build a single card can't be released: the model «{}» uses all the cards.",
                cfg.label
            )
        );
    }
    let gpus = engine_gpus(hw, build, excluded);
    if gpus.is_empty() {
        bail!(
            "{}",
            tr!(
                "Il modello «{}» ha bisogno di una scheda video, e tutte quelle del PC sono state liberate per un altro lavoro.",
                "The model «{}» needs a graphics card, and all the PC's cards have been released for another job.",
                cfg.label
            )
        );
    }
    let c = context(&f, gpus_memory_mib(&gpus), Placement::Gpu).ok_or_else(|| {
        anyhow!(
            "{}",
            tr!(
                "Il modello «{}» non ci sta nelle schede video rimaste: le altre sono prestate a un altro lavoro. Riprova quando tornano libere.",
                "The model «{}» doesn't fit in the remaining graphics cards: the others are lent to another job. Try again when they are free.",
                cfg.label
            )
        )
    })?;
    if matches!(build, Build::Cuda12 | Build::Cuda13) {
        let visible: Vec<String> = gpus.iter().map(|s| s.index.to_string()).collect();
        env.push(("CUDA_DEVICE_ORDER".to_string(), "PCI_BUS_ID".to_string()));
        env.push(("CUDA_VISIBLE_DEVICES".to_string(), visible.join(",")));
    }
    args.extend(["-ngl".to_string(), "all".to_string()]);
    args.extend(cache_q8(c.kv));
    Ok(GeneralPlan { ctx: c.ctx, gpus: gpus.into_iter().cloned().collect(), env, args })
}

fn cache_q8(kv: KvType) -> Vec<String> {
    match kv {
        KvType::F16 => Vec::new(),
        KvType::Q8_0 => ["-ctk", "q8_0", "-ctv", "q8_0", "-fa", "on"].map(String::from).to_vec(),
    }
}

/// GB with one decimal, written as the current language writes them (comma in Italian, point in English).
fn gb(mib: u64) -> String {
    let s = format!("{:.1}", mib as f64 / 1024.0);
    if lang() == Lang::It { s.replace('.', ",") } else { s }
}

fn does_not_fit(f: &Needs, cfg: &ModelCfg, hw: &Hardware, build: Build) -> String {
    let gpus = engine_gpus(hw, build, &[]);
    let placement = if gpus.is_empty() {
        tr!(" e la RAM ne ha {}", " and the RAM has {}", gb(ram_memory_mib(hw)))
    } else {
        tr!(", le schede video ne hanno {} e la RAM {}", ", the graphics cards have {} and the RAM {}", gb(gpus_memory_mib(&gpus)), gb(ram_memory_mib(hw)))
    };
    tr!(
        "Il modello «{}» non ci sta in questo computer: servono almeno {} GB (pesi e cache per {} token){placement}. Scegli un modello più piccolo.",
        "The model «{}» doesn't fit on this computer: at least {} GB are needed (weights and cache for {} tokens){placement}. Choose a smaller model.",
        cfg.label,
        gb(f.minimum_mib()),
        MIN_CTX.min(f.target),
    )
}

/// Like `context_for`, but with the reason written for whoever reads.
pub(crate) fn evaluate(file: &ModelsFile, cfg: &ModelCfg, key: &str, hw: &Hardware, build: Build) -> (Option<ContextFit>, String) {
    let f = match needs(file, cfg, key) {
        Ok(f) => f,
        Err(e) => return (None, e.to_string()),
    };
    let Some(c) = place(&f, hw, build) else { return (None, does_not_fit(&f, cfg, hw, build)) };
    let kv = (c.kv.bytes_per_token(f.kv_f16_bytes_per_token) * u64::from(c.ctx)).div_ceil(MIB);
    let how_much = tr!(
        "{} GB di pesi e {} GB di cache per {} token",
        "{} GB of weights and {} GB of cache for {} tokens",
        gb(f.weights_mib + f.state_mib),
        gb(kv),
        c.ctx
    );
    let gpus = engine_gpus(hw, build, &[]);
    let reason = match c.placement {
        Placement::Gpu => tr!(
            "Ci sta nella memoria delle schede video: {how_much}, su {} GB disponibili.",
            "It fits in the graphics cards' memory: {how_much}, out of {} GB available.",
            gb(gpus_memory_mib(&gpus))
        ),
        Placement::Cpu if gpus.is_empty() => {
            tr!("Ci sta nella RAM: {how_much}, su {} GB disponibili.", "It fits in RAM: {how_much}, out of {} GB available.", gb(ram_memory_mib(hw)))
        }
        Placement::Cpu => tr!(
            "Nelle schede video non ci sta (servono almeno {} GB, ne hanno {}): gira sul processore, più lento. Nella RAM: {how_much}, su {} GB disponibili.",
            "It doesn't fit in the graphics cards (at least {} GB are needed, they have {}): it runs on the processor, slower. In RAM: {how_much}, out of {} GB available.",
            gb(f.minimum_mib()),
            gb(gpus_memory_mib(&gpus)),
            gb(ram_memory_mib(hw))
        ),
    };
    (Some(c), reason)
}

/// A catalog model and whether it fits this hardware.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recommendation {
    pub model: String,
    /// Where it runs; `None` if it doesn't fit.
    pub placement: Option<Placement>,
    /// Context it runs with; 0 if it doesn't fit.
    pub context: u32,
    pub reason: String,
    /// How much the model's files needed by its engine on this PC weigh (weights and image encoder).
    pub bytes: u64,
    /// It has a profile optimized for this PC.
    pub profile: bool,
    pub origin: Origin,
    /// Among the recommended ones that fit, probably the fastest (`mark_fastest`).
    pub fastest: bool,
}

/// The catalog's local models, in its order, each with the verdict for `hw`: with the profile if there is one,
/// otherwise with the general plan.
pub fn recommended(paths: &Paths, hw: &Hardware) -> Result<Vec<Recommendation>> {
    let file = load_models(paths)?;
    let mut v = Vec::new();
    // The bytes of weights read for every token, next to each recommendation: they only serve to find the fastest.
    let mut read = Vec::new();
    for key in file.local() {
        let cfg = model_cfg(&file, key)?;
        let setup = setup_for(paths, key, &cfg, hw);
        let profile = matches!(&setup, Ok(Setup::Profile(p)) if p.tailored());
        let bytes = cfg.files_for(cfg.engine_with(&setup)).map(|f| f.size).sum();
        let (context, placement, reason) = match &setup {
            Ok(Setup::Profile(p)) if p.tailored() => {
                let measured = match &p.measurements.date {
                    Some(d) => tr!("misurato il {d}", "measured on {d}"),
                    None => tr!("non ancora misurato", "not measured yet"),
                };
                (
                    p.ctx,
                    Some(p.placement()),
                    tr!("Ha un profilo ottimizzato per questo PC ({}), {measured}.", "It has a profile optimized for this PC ({}), {measured}.", p.id),
                )
            }
            Ok(Setup::Profile(p)) => match crate::profile_context(&cfg, p, hw) {
                Ok(ctx) => (
                    ctx,
                    Some(p.placement()),
                    tr!("Ci sta col motore «{}», con {ctx} token di contesto.", "It fits with the engine «{}», with {ctx} tokens of context.", p.engine),
                ),
                Err(e) => (0, None, format!("{e:#}")),
            },
            Ok(Setup::General { build }) => match evaluate(&file, &cfg, key, hw, *build) {
                (Some(c), reason) => (c.ctx, Some(c.placement), reason),
                (None, reason) => (0, None, reason),
            },
            Err(e) => (0, None, format!("{e:#}")),
        };
        read.push(cfg.read_per_token(cfg.engine_with(&setup)));
        v.push(Recommendation { model: key.to_string(), placement, context, reason, bytes, profile, origin: file.origin(key), fastest: false });
    }
    mark_fastest(&mut v, &read);
    Ok(v)
}

/// Among the recommended ones that fit, the probably fastest to write: on the cards beats the processor; at equal
/// place, whoever reads fewer weights for each token wins (a MoE reads only the chosen experts). On a tie, the first.
fn mark_fastest(v: &mut [Recommendation], read: &[u64]) {
    let best = v
        .iter()
        .zip(read)
        .enumerate()
        .filter(|(_, (c, _))| c.origin == Origin::Recommended)
        .filter_map(|(i, (c, &l))| Some((c.placement? == Placement::Cpu, l, i)))
        .min();
    if let Some((_, _, i)) = best {
        v[i].fastest = true;
    }
}
