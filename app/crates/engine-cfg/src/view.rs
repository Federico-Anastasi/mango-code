//! What the app tells about the models and the computer, with the user's choices (`choices.rs`) taken into account:
//! the verdict «fits / doesn't fit», where it runs and with what context are those the plan would use at start.
//!
//! - `recommended`: the catalog's local models with the verdict, for the first start.
//! - `models_view`: for each model the verdict, the choices offered here (`Limits`), the saved choices and the
//!   catalog's line and sampling values.
//! - `computer_view`: the cards (used or not, and why one can't be), the cores, the RAM, the models' folder.

use crate::catalog::{load_models, model_cfg, setup_for, ModelCfg, ModelsFile, Origin, Setup};
use crate::choices::{self, Choices, ChoicesFile, SmallModels, WhereChoice};
use crate::general::{self, Fit, Located, Placement};
use crate::hardware::{choose_build, free_space, Gpu, Hardware, Vendor, MIN_GPU_MEMORY_MIB};
use crate::profiles::Profile;
use crate::speed::{cpu_speed, Speed};
use crate::split::MIN_CTX;
use anyhow::Result;
use mango_common::catalog::Sampling;
use mango_common::{tr, Build, Paths};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The model, the setup it would run with and where: what every verdict is made of.
pub(crate) struct Assessed {
    pub setup: Result<Setup>,
    pub located: Located,
}

/// Where `cfg` runs on `hw` with the choices saved for `key`, and why: the profile if the choice is «auto» and there is
/// one, otherwise the general plan; what the plan itself would do at start, with the cards in `lent` lent to another job.
pub(crate) fn assess(paths: &Paths, file: &ModelsFile, key: &str, cfg: &ModelCfg, hw: &Hardware, choices: &ChoicesFile, lent: &[u32]) -> Assessed {
    let scope = choices.scope(key);
    let setup = setup_for(paths, key, cfg, hw, &scope.choices);
    let located = match &setup {
        Err(e) => Located { fit: None, reason: format!("{e:#}") },
        Ok(Setup::General { build }) => general::evaluate(file, cfg, hw, *build, &scope, lent),
        Ok(Setup::Profile(p)) => profile_located(cfg, p, hw, &scope, lent),
    };
    Assessed { setup, located }
}

fn profile_located(cfg: &ModelCfg, p: &Profile, hw: &Hardware, scope: &choices::Scope, lent: &[u32]) -> Located {
    let unused = general::unused_indexes(hw, scope);
    let left: Vec<u32> = unused.iter().chain(lent).copied().collect();
    let fit = crate::profile_fit(cfg, p, hw, &left, scope.choices.context).and_then(|(ctx, gpus)| {
        crate::check_left(&cfg.label, &gpus, lent, &unused)?;
        Ok((ctx, gpus))
    });
    let (ctx, gpus) = match fit {
        Ok(f) => f,
        Err(e) => return Located { fit: None, reason: format!("{e:#}") },
    };
    let reason = if p.tailored() {
        let measured = match &p.measurements.date {
            Some(d) => tr!("misurato il {d}", "measured on {d}"),
            None => tr!("non ancora misurato", "not measured yet"),
        };
        tr!("Ha un assetto su misura per questo PC, {measured}.", "It has a setup tailored to this PC, {measured}.")
    } else {
        let k = crate::split::context_label(ctx);
        tr!("Ci sta col suo motore, con {k} di contesto.", "It fits with its own engine, with {k} of context.")
    };
    Located { fit: Some(Fit { placement: p.placement(), ctx, gpus }), reason }
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
    /// A model for small graphics cards (catalog `fallback`): proposed only when no other one fits on the cards.
    pub fallback: bool,
    /// Only on request (catalog `on_request`): never preselected nor the fastest.
    pub on_request: bool,
    /// How fast it writes, when it runs on the processor (`speed.rs`).
    pub speed: Option<Speed>,
    /// Its memory is estimated (a model of the user's that the count doesn't know): the verdict may be wrong.
    pub estimated: bool,
}

/// A local model of the catalog assessed on a PC.
struct Ranked {
    cfg: ModelCfg,
    assessed: Assessed,
    recommendation: Recommendation,
}

/// The catalog's local models, in its order, each with the verdict for `hw` and the user's choices: with the profile
/// if the choice is «auto» and there is one, otherwise with the general plan.
fn rank(paths: &Paths, file: &ModelsFile, choices: &ChoicesFile, hw: &Hardware) -> Result<Vec<Ranked>> {
    let mut assessed = Vec::new();
    let mut recommendations = Vec::new();
    // The bytes of weights read for every token, next to each recommendation: they only serve to find the fastest.
    let mut read = Vec::new();
    for key in file.local() {
        let cfg = model_cfg(file, key)?;
        let a = assess(paths, file, key, &cfg, hw, choices, &[]);
        let engine = cfg.engine_with(&a.setup);
        let placement = a.located.fit.as_ref().map(|f| f.placement);
        let read_per_token = cfg.read_per_token(engine);
        read.push(read_per_token);
        recommendations.push(Recommendation {
            model: key.to_string(),
            placement,
            context: a.located.fit.as_ref().map_or(0, |f| f.ctx),
            reason: a.located.reason.clone(),
            bytes: cfg.files_for(engine).map(|f| f.size).sum(),
            profile: matches!(&a.setup, Ok(Setup::Profile(p)) if p.tailored()),
            origin: file.origin(key),
            fastest: false,
            fallback: cfg.fallback,
            on_request: cfg.on_request,
            speed: (placement == Some(Placement::Cpu)).then(|| cpu_speed(read_per_token)),
            estimated: cfg.memory_estimated(),
        });
        assessed.push((cfg, a));
    }
    mark_fastest(&mut recommendations, &read);
    Ok(assessed.into_iter().zip(recommendations).map(|((cfg, assessed), recommendation)| Ranked { cfg, assessed, recommendation }).collect())
}

/// The catalog's local models, in its order, each with the verdict for `hw`.
pub fn recommended(paths: &Paths, hw: &Hardware) -> Result<Vec<Recommendation>> {
    let (file, choices) = (load_models(paths)?, choices::read(paths)?);
    Ok(rank(paths, &file, &choices, hw)?.into_iter().map(|r| r.recommendation).collect())
}

/// Among the recommended ones that fit, the probably fastest to write: on the cards beats the processor; at equal
/// place, whoever reads fewer weights for each token wins (a MoE reads only the chosen experts). On a tie, the first.
/// A `fallback` model takes part only if no other one fits on the cards; an `on_request` one never.
fn mark_fastest(v: &mut [Recommendation], read: &[u64]) {
    let recommended = |c: &Recommendation| c.origin == Origin::Recommended && !c.on_request;
    let others_on_cards = v.iter().any(|c| !c.fallback && recommended(c) && c.placement == Some(Placement::Gpu));
    let best = v
        .iter()
        .zip(read)
        .enumerate()
        .filter(|(_, (c, _))| recommended(c) && !(c.fallback && others_on_cards))
        .filter_map(|(i, (c, &l))| Some((c.placement? == Placement::Cpu, l, i)))
        .min();
    if let Some((_, _, i)) = best {
        v[i].fastest = true;
    }
}

/// Where a model runs and with what context: the cards by name, none on the processor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Where {
    pub placement: Placement,
    pub gpus: Vec<String>,
    pub context: u32,
}

/// Whether a model fits this computer with the user's choices, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub fits: bool,
    /// `None` if it doesn't fit.
    #[serde(rename = "where")]
    pub place: Option<Where>,
    /// One sentence: why it fits like this, or why it doesn't.
    pub reason: String,
    /// Only on the processor.
    pub speed: Option<Speed>,
    pub fastest: bool,
    /// The memory the model asks is estimated from the size of its files (a model of the user's that Mango Code doesn't
    /// know yet): the verdict may be wrong.
    pub estimated: bool,
}

/// What can be chosen for a model here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Limits {
    /// The «where it runs» choices that work on this computer: a model that needs its own engine only has «auto»,
    /// and with Vulkan and a card that can't be left out only the processor is left.
    #[serde(rename = "where")]
    pub places: Vec<WhereChoice>,
    /// The contexts offered with the current choice of where: 32k, 64k, 128k... up to the largest that fits, which is
    /// the last one. Empty if the model doesn't fit.
    pub context: Vec<u32>,
    /// The model can think before it answers: the switch makes sense.
    pub reasoning: bool,
}

/// A local model of the catalog for the app: what the plan says about it here, what can be chosen and what is chosen.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelView {
    pub key: String,
    pub label: String,
    /// The catalog's line in the app's language; empty if the model has none.
    pub about: String,
    pub images: bool,
    /// Added by the user («Another model»).
    pub user: bool,
    /// Its files that Mango Code never downloaded (a GGUF the user chose on the computer), where they are: «Togli» takes
    /// the model off the list and leaves them. Empty for a model whose files Mango Code downloads.
    pub own_files: Vec<String>,
    /// Weights, image encoder and engine are on disk: it can be used.
    pub present: bool,
    /// Its files are on the disk and it waits for the new version of its engine, whose old version is on the disk: the
    /// update of the engine brings it (`engine_updates`). It stays with the models on the computer.
    pub waits_engine: bool,
    /// What a download brings here: its files for its engine that are not on the disk yet, and the engine if it is
    /// missing. For a model that is there, or that waits for its engine, what its files weigh.
    pub bytes: u64,
    pub sampling: Option<Sampling>,
    pub verdict: Verdict,
    /// The one to propose to whoever has no model yet (`mark_recommended`).
    pub recommended: bool,
    /// Only on request: never proposed.
    pub on_request: bool,
    pub limits: Limits,
    /// There is a setup tailored to this computer for the model (it counts when the choice is «auto»).
    pub tailored: bool,
    pub choices: Choices,
}

/// The local models of the catalog in its order, the user's last, each with its `ModelView` on `hw`.
pub fn models_view(paths: &Paths, hw: &Hardware) -> Result<Vec<ModelView>> {
    let (file, choices) = (load_models(paths)?, choices::read(paths)?);
    let build = choose_build(hw);
    let mut views = Vec::new();
    let mut fallback = Vec::new();
    for r in rank(paths, &file, &choices, hw)? {
        let key = r.recommendation.model.as_str();
        let scope = choices.scope(key);
        let fit = r.assessed.located.fit.as_ref();
        // The largest context is the one without the user's own limit on it.
        let largest = match scope.choices.context {
            None => fit.map(|f| f.ctx),
            Some(_) => {
                let mut open = choices.clone();
                open.models.entry(key.to_string()).or_default().context = None;
                assess(paths, &file, key, &r.cfg, hw, &open, &[]).located.fit.map(|f| f.ctx)
            }
        };
        let places = if r.cfg.requires_engine.is_some() { vec![WhereChoice::Auto] } else { general::places(hw, build, &scope) };
        let (present, waits_engine, bytes) = match &r.assessed.setup {
            Ok(setup) => {
                use mango_common::download::{engine_size, installed_engine, older_engine};
                let weights = r.cfg.weights_on_disk(paths, setup.engine());
                // An engine catalog that cannot be read counts nothing here: the download itself says why it can't start.
                let engine = engine_size(paths, setup.engine(), setup.build()).unwrap_or(0);
                let installed = installed_engine(paths, setup.engine(), setup.build()).is_some();
                let present = weights && installed;
                let waits = weights && !installed && older_engine(paths, setup.engine(), setup.build());
                let bytes = if present || waits { r.recommendation.bytes } else { engine + if weights { 0 } else { r.recommendation.bytes } };
                (present, waits, bytes)
            }
            Err(_) => (false, false, r.recommendation.bytes),
        };
        fallback.push(r.recommendation.fallback);
        views.push(ModelView {
            key: key.to_string(),
            label: r.cfg.label.clone(),
            about: r.cfg.about.as_ref().map_or_else(String::new, |a| a.text().to_string()),
            images: r.cfg.mmproj.is_some(),
            user: r.recommendation.origin == Origin::User,
            own_files: r
                .cfg
                .files_for(r.cfg.engine_with(&r.assessed.setup))
                .filter_map(|f| mango_common::download::users_file(paths, &f.path, &f.sha256))
                .map(|p| p.display().to_string())
                .collect(),
            present,
            waits_engine,
            bytes,
            recommended: false,
            on_request: r.recommendation.on_request,
            sampling: r.cfg.sampling,
            verdict: Verdict {
                fits: fit.is_some(),
                place: fit.map(|f| Where { placement: f.placement, gpus: f.gpus.iter().map(|g| g.name.clone()).collect(), context: f.ctx }),
                reason: r.assessed.located.reason.clone(),
                speed: r.recommendation.speed,
                fastest: r.recommendation.fastest,
                estimated: r.recommendation.estimated,
            },
            limits: Limits { places, context: largest.map_or_else(Vec::new, offered_contexts), reasoning: r.cfg.reasoning },
            tailored: crate::profiles::lookup(paths, key, hw)?.is_some_and(|p| p.tailored()),
            choices: scope.choices,
        });
    }
    mark_recommended(&mut views, &fallback);
    Ok(views)
}

/// A start that failed, seen from now.
#[derive(Debug, Clone, PartialEq)]
pub struct AfterFailure {
    /// A model on the disk that fits now: not the failed one, not the one in use, never one only on request or for small
    /// cards (`fallback`). The default if it fits, otherwise the first in the catalog.
    pub proposal: Option<ModelView>,
    /// When the failed model fits this computer but does not fit at all in the memory the other programs leave on its
    /// cards: which cards and how much is in use there, in the sentence of a start refused for that (`taken_before_start`).
    pub taken: Option<String>,
}

/// What a card holds beyond what Windows takes on it (`split::SYSTEM_RESERVE_MIB`) counts as another program's only from
/// here: a large screen, or two, make the desktop take more than the reserve measured with one.
const TAKEN_MIB: u64 = 1024;

/// What to say after the start of `failed` did not work. `used` is `(card index, used MiB, total MiB)` of the NVIDIA cards
/// (`gpu_memory`), read while no model of Mango Code is on them (empty otherwise): `now` is this computer without what the
/// other programs hold. `in_use`: the model of Mango Code that runs meanwhile, if any.
pub fn after_failure(paths: &Paths, hw: &Hardware, used: &[(u32, u64, u64)], failed: &str, default: Option<&str>, in_use: Option<&str>) -> Result<AfterFailure> {
    let now = left_by_others(hw, used);
    let (file, choices) = (load_models(paths)?, choices::read(paths)?);
    let fallback = |key: &str| model_cfg(&file, key).is_ok_and(|c| c.fallback);
    // A model that fits the memory the others leave only in the verdict (a setup measured with its cards free) would be
    // refused at its start: it is not proposed.
    let beside_others = |key: &str| model_cfg(&file, key).is_ok_and(|cfg| crowded(paths, &file, &choices, key, &cfg, hw, used, &[]).is_empty());
    let views = models_view(paths, &now)?;
    let proposable = |v: &&ModelView| {
        v.key != failed && Some(v.key.as_str()) != in_use && v.present && v.verdict.fits && !v.on_request && !fallback(&v.key) && beside_others(&v.key)
    };
    let proposal = views.iter().filter(proposable).find(|v| Some(v.key.as_str()) == default).or_else(|| views.iter().find(proposable)).cloned();

    // Only a model that does not fit at all now: one that still fits, with less context or on another card, failed for
    // another reason, and the manager's sentence says which.
    let fits_now = views.iter().find(|v| v.key == failed).is_some_and(|v| v.verdict.fits);
    let full = models_view(paths, hw)?.into_iter().find(|v| v.key == failed);
    let taken = match full.as_ref().and_then(|v| v.verdict.place.as_ref().map(|p| (v, p))) {
        Some((_, before)) if !fits_now => {
            let cards: Vec<Gpu> = hw.gpus.iter().filter(|g| before.gpus.contains(&g.name) && held_by_others(g, used) > 0).cloned().collect();
            (!cards.is_empty()).then(|| in_use_sentence(&cards, used))
        }
        _ => None,
    };
    Ok(AfterFailure { proposal, taken })
}

/// Other programs hold memory that a model about to start counts on (`taken_before_start`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardsTaken {
    /// For the user: which cards, and how much memory is in use on each.
    pub sentence: String,
    /// The cards (indexes).
    pub cards: Vec<u32>,
}

/// Before `key` starts: whether it fits beside what the other programs hold on its cards now.
/// `used` as `gpu_memory` gives it, read while no model of Mango Code is on the cards; the cards in `lent` are lent to
/// another job, which holds them: the plan leaves them out, and what is used there is not looked at. `None` when it fits,
/// and when nothing is known of the cards (an empty `used`, cards that are not NVIDIA, a model on the processor).
pub fn taken_before_start(paths: &Paths, hw: &Hardware, used: &[(u32, u64, u64)], key: &str, lent: &[u32]) -> Result<Option<CardsTaken>> {
    let used: Vec<(u32, u64, u64)> = used.iter().filter(|u| !lent.contains(&u.0)).copied().collect();
    if hw.gpus.iter().all(|g| held_by_others(g, &used) == 0) {
        return Ok(None);
    }
    let (file, choices) = (load_models(paths)?, choices::read(paths)?);
    let cfg = model_cfg(&file, key)?;
    let held = crowded(paths, &file, &choices, key, &cfg, hw, &used, lent);
    if held.is_empty() {
        return Ok(None);
    }
    Ok(Some(CardsTaken { sentence: in_use_sentence(&held, &used), cards: held.iter().map(|g| g.index).collect() }))
}

/// For the user: the memory in use on each of `cards` (at least one), held by another program.
fn in_use_sentence(cards: &[Gpu], used: &[(u32, u64, u64)]) -> String {
    let in_use = |g: &Gpu| general::gb(used.iter().find(|u| u.0 == g.index).map_or(0, |u| u.1));
    let more: String = cards[1..].iter().map(|g| tr!(", sulla {} {} GB", ", on the {} {} GB", g.name, in_use(g))).collect();
    tr!(
        "Sulla {} un altro programma sta usando {} GB{more}: per questo modello non resta abbastanza memoria.",
        "On the {} another program is using {} GB{more}: there is not enough memory left for this model.",
        cards[0].name,
        in_use(&cards[0])
    )
}

/// What the other programs hold on `g`, in MiB, beyond what every plan leaves to Windows (`split::SYSTEM_RESERVE_MIB`):
/// 0 under `TAKEN_MIB`, and for a card `used` does not tell.
fn held_by_others(g: &Gpu, used: &[(u32, u64, u64)]) -> u64 {
    let held = used.iter().find(|(i, _, _)| g.vendor == Vendor::Nvidia && *i == g.index).map_or(0, |(_, u, _)| u.saturating_sub(crate::split::SYSTEM_RESERVE_MIB));
    if held >= TAKEN_MIB { held } else { 0 }
}

/// `hw` without what the other programs hold on its cards.
fn left_by_others(hw: &Hardware, used: &[(u32, u64, u64)]) -> Hardware {
    let mut now = hw.clone();
    for g in now.gpus.iter_mut() {
        g.memory_mib -= held_by_others(g, used).min(g.memory_mib);
    }
    now
}

/// The cards of `key` where other programs hold memory its plan on `hw` counts on; empty when it fits beside them. A plan
/// computed from the memory fits when the memory the others leave gives the same plan: the same cards, the same
/// context. A setup measured with its cards free (a profile that names its cards, or splits the model with its own
/// proportions) counts on all their memory: whatever another program holds there beyond `TAKEN_MIB` is too much. `lent`:
/// the cards lent to another job, which the plan leaves out.
#[allow(clippy::too_many_arguments)]
fn crowded(paths: &Paths, file: &ModelsFile, choices: &ChoicesFile, key: &str, cfg: &ModelCfg, hw: &Hardware, used: &[(u32, u64, u64)], lent: &[u32]) -> Vec<Gpu> {
    let planned = assess(paths, file, key, cfg, hw, choices, lent);
    let Some(fit) = planned.located.fit else { return Vec::new() };
    let held: Vec<Gpu> = fit.gpus.iter().filter(|g| held_by_others(g, used) > 0).cloned().collect();
    if held.is_empty() {
        return held;
    }
    let measured = matches!(&planned.setup, Ok(Setup::Profile(p)) if !crate::auto_split(p));
    let same = |f: &Fit| (f.placement, f.ctx, f.gpus.iter().map(|g| g.index).collect::<Vec<_>>()) == (fit.placement, fit.ctx, fit.gpus.iter().map(|g| g.index).collect());
    if !measured && assess(paths, file, key, cfg, &left_by_others(hw, used), choices, lent).located.fit.as_ref().is_some_and(same) {
        return Vec::new();
    }
    held
}

/// The model to propose to whoever has none yet: the first of Mango Code's own that fits and is not on disk yet, on
/// the cards if one fits there, otherwise on the processor. Never one that is only on request; a model for small cards
/// (`fallback`, one flag per view) only if no other fits on the cards, downloaded or not.
pub(crate) fn mark_recommended(views: &mut [ModelView], fallback: &[bool]) {
    let ours = |v: &ModelView| !v.user && !v.on_request;
    let on_cards = |v: &ModelView| v.verdict.place.as_ref().is_some_and(|w| w.placement == Placement::Gpu);
    let others_on_cards = views.iter().zip(fallback).any(|(v, small)| ours(v) && !small && on_cards(v));
    let candidates: Vec<usize> = (0..views.len()).filter(|&i| ours(&views[i]) && views[i].verdict.fits && !views[i].present && !(fallback[i] && others_on_cards)).collect();
    if let Some(&i) = candidates.iter().find(|&&i| on_cards(&views[i])).or(candidates.first()) {
        views[i].recommended = true;
    }
}

/// 32k, 64k, 128k... below `largest`, and `largest` as the last.
fn offered_contexts(largest: u32) -> Vec<u32> {
    let mut v: Vec<u32> = std::iter::successors(Some(MIN_CTX), |c| c.checked_mul(2)).take_while(|&c| c < largest).collect();
    v.push(largest);
    v
}

/// A graphics card of the computer, for the list where the user chooses which ones the models use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GpuView {
    pub name: String,
    pub memory_mib: u64,
    /// The models use it.
    pub used: bool,
    /// Empty if the card can be used or left out as the user wants; otherwise why it can't, in a sentence.
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskView {
    pub path: PathBuf,
    /// What the models' folder holds, partial downloads included.
    pub used_bytes: u64,
    /// Free on the disk of the models' folder.
    pub free_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TailoredView {
    pub models: usize,
}

/// The engine that runs the models here when none has one of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineView {
    /// For the user: «llama.cpp for the graphics cards».
    pub label: String,
    pub installed: bool,
    /// The app came with a new version of an engine whose old one is on the disk, and a model on the disk waits for it
    /// (`engine_updates`): `label` is that engine.
    pub update: bool,
}

/// An engine's name for the user, with what it runs on: the build's name says nothing the user can act on.
pub fn engine_label(engine: &str, build: Build) -> String {
    let program = if engine == crate::catalog::GENERAL_ENGINE { "llama.cpp" } else { engine };
    let target = match build {
        Build::Cpu => tr!("il processore", "the processor"),
        Build::Vulkan | Build::Cuda12 | Build::Cuda12Gtx16 | Build::Cuda13 => tr!("le schede video", "the graphics cards"),
    };
    tr!("{program} per {target}", "{program} for {target}")
}

/// The computer, for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ComputerView {
    pub gpus: Vec<GpuView>,
    pub small_models: SmallModels,
    pub cpu: String,
    pub cores: u32,
    pub ram_mib: u64,
    pub disk: DiskView,
    pub engine: EngineView,
    /// How many models have a setup tailored to this computer; `None` if none.
    pub tailored: Option<TailoredView>,
}

pub fn computer_view(paths: &Paths, hw: &Hardware) -> Result<ComputerView> {
    let (file, choices) = (load_models(paths)?, choices::read(paths)?);
    let build = choose_build(hw);
    let mut tailored = 0;
    for key in file.local() {
        tailored += usize::from(crate::profiles::lookup(paths, key, hw)?.is_some_and(|p| p.tailored()));
    }
    let update = engine_updates(paths, hw)?.into_iter().next();
    Ok(ComputerView {
        gpus: hw.gpus.iter().map(|g| gpu_view(g, hw, build, &choices)).collect(),
        small_models: choices.computer.small_models,
        cpu: hw.cpu.name.clone(),
        cores: hw.cpu.cores,
        ram_mib: hw.ram_mib,
        disk: disk_view(&paths.models)?,
        engine: EngineView {
            label: update.as_ref().map_or_else(|| engine_label(crate::catalog::GENERAL_ENGINE, build), |u| u.label.clone()),
            installed: mango_common::download::installed_engine(paths, crate::catalog::GENERAL_ENGINE, build).is_some(),
            update: update.is_some(),
        },
        tailored: (tailored > 0).then_some(TailoredView { models: tailored }),
    })
}

/// An engine to update: the app came with a new version of it, its old version is on the disk, and a model on the disk
/// that fits here waits for it. The download of `model`, the first of them in the catalog's order, brings it; `label` is
/// the engine for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineUpdate {
    pub model: String,
    pub label: String,
}

/// The engines to update, one for each engine and build. An engine never installed is not among them: the download of a
/// model brings it. One without an engine for this computer (`download_of` refuses it) waits for nothing. None while the
/// engine in use is another PC's: this PC's is updated once the user is back to it.
pub fn engine_updates(paths: &Paths, hw: &Hardware) -> Result<Vec<EngineUpdate>> {
    if paths.remote_engine().is_file() {
        return Ok(Vec::new());
    }
    let mut seen = Vec::new();
    let mut updates = Vec::new();
    for m in models_view(paths, hw)?.into_iter().filter(|m| m.waits_engine) {
        let Ok(plan) = crate::download_of(paths, &m.key, hw) else { continue };
        if plan.fits.is_err() || seen.contains(&(plan.engine.clone(), plan.build)) {
            continue;
        }
        updates.push(EngineUpdate { model: m.key, label: engine_label(&plan.engine, plan.build) });
        seen.push((plan.engine, plan.build));
    }
    Ok(updates)
}

fn gpu_view(g: &crate::hardware::Gpu, hw: &Hardware, build: Build, choices: &ChoicesFile) -> GpuView {
    let (name, memory_mib) = (g.name.clone(), g.memory_mib);
    let off = |note: String| GpuView { name: name.clone(), memory_mib, used: false, note };
    if g.memory_mib < MIN_GPU_MEMORY_MIB {
        return off(tr!("Ha troppa poca memoria per far girare un modello.", "It has too little memory to run a model."));
    }
    if build != Build::Vulkan && g.vendor != Vendor::Nvidia {
        return off(tr!("Il motore di questo computer usa solo le schede NVIDIA.", "This computer's engine only uses NVIDIA cards."));
    }
    let note = if build == Build::Vulkan && hw.usable().count() > 1 {
        tr!("Con il motore di questo computer non si può escludere una scheda sola.", "With this computer's engine a single card can't be left out.")
    } else {
        String::new()
    };
    GpuView { name: name.clone(), memory_mib, used: !choices.computer.unused_gpus.contains(&name), note }
}

fn disk_view(models: &Path) -> Result<DiskView> {
    let used_bytes = folder_size(models).map_err(|e| {
        mango_common::user_error(&tr!("Non riesco a leggere la cartella dei modelli.", "I can't read the models folder."), format!("{}: {e}", models.display()))
    })?;
    Ok(DiskView { path: models.to_path_buf(), used_bytes, free_bytes: free_space(models)? })
}

/// Bytes of the files under `dir`; a folder that isn't there holds nothing.
fn folder_size(dir: &Path) -> std::io::Result<u64> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut total = 0;
    for entry in entries {
        let entry = entry?;
        total += match entry.metadata() {
            Ok(m) if m.is_dir() => folder_size(&entry.path())?,
            Ok(m) => m.len(),
            // A file that goes away while we count (a download that ends) is not there.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e),
        };
    }
    Ok(total)
}
