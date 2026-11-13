//! The general plan: for hardware without a profile, official llama.cpp with the build chosen by `choose_build` and
//! the arguments computed from the hardware. The memory estimate also lives here: it serves the plan (where the
//! model runs and what context it holds) and the verdicts (`view.rs`: which models fit, and where).
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
//!
//! **Which cards** depends on the model's choice (`choices.rs`), with the cards the user leaves out removed:
//! - `auto`: the fewest cards that give `AUTO_CTX` tokens of context (65,536 in practice), the fastest first (`by_speed`); cards are
//!   added only to reach it, and if no set reaches it, the fewest that give the largest context there is. The
//!   computer's choice «small models on all the cards» makes a model that would fit one card take all of them.
//! - `one`: the fastest card. `all`: every card. `pick`: the cards named. They don't fall back on the processor if
//!   the model doesn't fit: the plan says so. `cpu`: the processor.
//!
//! The context is the model's target, or the one the user chose if smaller, when it fits; otherwise the largest that
//! fits. With the Vulkan build the engine numbers its devices in its own order, not `Gpu::index`: it takes all the
//! cards, and a card can be left out (or lent) only if all of them are.

use crate::catalog::{ModelCfg, ModelsFile, GENERAL_ENGINE};
use crate::choices::{Scope, WhereChoice};
use crate::hardware::{choose_build, Gpu, Hardware, Vendor, GPU_RESERVE_MIB};
use crate::split::{context_label, MIN_CTX};
use anyhow::{bail, Result};
use mango_common::i18n::{lang, Lang};
use mango_common::{tr, Build};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;

/// The context is chosen in multiples of this step.
const CTX_STEP: u32 = 4096;
/// The context `auto` wants from as few cards as it can before adding another. It is compared with the context the
/// plan really gets, which goes down in multiples of `CTX_STEP` (4096): 61,440 is under it, so "at least 64,000" means
/// 65,536 tokens in practice. A model whose target is lower wants its target.
pub(crate) const AUTO_CTX: u32 = 64_000;
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
    /// The context we want to have: the common target, or the one the user chose if smaller, if the model holds it.
    target: u32,
}

impl Needs {
    /// The minimum to run: weights, state and q8_0 cache for `MIN_CTX` tokens (or the target, if it is lower).
    fn minimum_mib(&self) -> u64 {
        let kv = KvType::Q8_0.bytes_per_token(self.kv_f16_bytes_per_token) * u64::from(MIN_CTX.min(self.target));
        self.weights_mib + self.state_mib + kv.div_ceil(MIB)
    }
}

/// `chosen`: the context the user chose, if any.
fn needs(file: &ModelsFile, cfg: &ModelCfg, chosen: Option<u32>) -> Result<Needs> {
    let Some(m) = &cfg.memory else {
        bail!(
            "{}",
            tr!(
                "Il catalogo non dice quanta memoria chiede il modello «{}». Reinstalla l'applicazione.",
                "The catalog doesn't say how much memory the model «{}» needs. Reinstall the application.",
                cfg.label
            )
        )
    };
    if cfg.files.is_empty() {
        bail!(
            "{}",
            tr!(
                "Il catalogo non dice quanto pesano i file del modello «{}». Reinstalla l'applicazione.",
                "The catalog doesn't say how much the files of the model «{}» weigh. Reinstall the application.",
                cfg.label
            )
        );
    }
    let bytes: u64 = cfg.files_for(GENERAL_ENGINE).map(|f| f.size).sum::<u64>() + cfg.encoder_compute_bytes();
    Ok(Needs {
        weights_mib: bytes.div_ceil(MIB),
        kv_f16_bytes_per_token: m.kv_kib_token * 1024,
        state_mib: m.state_mib,
        target: cfg.ctx.unwrap_or(file.ctx).min(file.ctx).min(chosen.unwrap_or(u32::MAX)),
    })
}

/// The cards the general engine uses: with CUDA only the NVIDIA ones, with Vulkan all of them, with the CPU none.
/// Without the `excluded` ones (indexes of the cards lent to another job or left out by the user).
fn engine_gpus<'a>(hw: &'a Hardware, build: Build, excluded: &[u32]) -> Vec<&'a Gpu> {
    match build {
        Build::Cpu => Vec::new(),
        Build::Vulkan => hw.usable().filter(|s| !excluded.contains(&s.index)).collect(),
        Build::Cuda12 | Build::Cuda12Gtx16 | Build::Cuda13 => hw.usable().filter(|s| s.vendor == Vendor::Nvidia && !excluded.contains(&s.index)).collect(),
    }
}

/// Sort key that puts the fastest card first. The cards with tensor cores come first; among those without, the
/// Turing ones that declare compute capability 7.5 without having them (the GTX 16 family) come last, because
/// llama.cpp counts on the tensor cores there and reads the prompt several times slower than on a Pascal (measured:
/// GTX 1660 SUPER 264 tokens/s, GTX 1080 1383). At equal footing, more memory, then compute capability, then PCI
/// order. (The profiles' split, `split::by_power`, ranks by compute capability: it was measured that way.)
pub(crate) fn by_speed(g: &Gpu) -> impl Ord {
    let tensor = g.has_tensor_cores();
    (!tensor, !tensor && g.cc == Some((7, 5)), Reverse(g.memory_mib), Reverse(g.cc), g.index)
}

/// The first set of `k` of `items`, in the order given and lexicographically among the sets, that `accept`.
fn first_set<T: Copy>(items: &[T], k: usize, accept: impl Fn(&[T]) -> bool) -> Option<Vec<T>> {
    let n = items.len();
    // The k-subsets as increasing positions, in lexicographic order.
    let mut pos: Vec<usize> = (0..k).collect();
    loop {
        let set: Vec<T> = pos.iter().map(|&i| items[i]).collect();
        if accept(&set) {
            return Some(set);
        }
        let i = (0..k).rev().find(|&i| pos[i] < n - k + i)?;
        pos[i] += 1;
        for j in i + 1..k {
            pos[j] = pos[j - 1] + 1;
        }
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

/// The indexes of the cards of the PC that count and that the user left out, by name.
pub(crate) fn unused_indexes(hw: &Hardware, scope: &Scope) -> Vec<u32> {
    hw.usable().filter(|g| scope.unused.contains(&g.name)).map(|g| g.index).collect()
}

/// Whether the plan can leave out the `unused` cards. With Vulkan only all of them together: the engine numbers its
/// devices its own way, so a single card can't be told apart.
fn removable(hw: &Hardware, build: Build, unused: &[u32]) -> bool {
    build != Build::Vulkan || unused.len() == hw.usable().count()
}

/// Where the model runs: the context and the cards it takes.
struct Placed<'a> {
    fit: ContextFit,
    gpus: Vec<&'a Gpu>,
}

/// What a try on some cards gives: where the model sits, or the cards where it doesn't fit.
enum Tried<'a> {
    Fits(Placed<'a>),
    Short(Vec<&'a Gpu>),
}

/// A model, the PC and what the user asked for, to decide where it runs.
struct Situation<'a> {
    need: Needs,
    cfg: &'a ModelCfg,
    hw: &'a Hardware,
    build: Build,
    scope: &'a Scope,
    /// The cards lent to another job (indexes): they are free again later, so they don't change the decision of
    /// where the model runs, only the cards it takes at start.
    lent: &'a [u32],
    /// The cards the user left out (indexes).
    unused: Vec<u32>,
    /// Those of them that the plan really leaves out: all, except with Vulkan, where only all the cards together.
    removed: Vec<u32>,
}

impl<'a> Situation<'a> {
    fn new(file: &ModelsFile, cfg: &'a ModelCfg, hw: &'a Hardware, build: Build, scope: &'a Scope, lent: &'a [u32]) -> Result<Self> {
        let unused = unused_indexes(hw, scope);
        let removed = if removable(hw, build, &unused) { unused.clone() } else { Vec::new() };
        Ok(Situation { need: needs(file, cfg, scope.choices.context)?, cfg, hw, build, scope, lent, unused, removed })
    }

    /// The cards the engine can use, without those left out and, if `without_lent`, those lent.
    fn cards(&self, without_lent: bool) -> Vec<&'a Gpu> {
        let mut left = self.removed.clone();
        if without_lent {
            left.extend(self.lent);
        }
        engine_gpus(self.hw, self.build, &left)
    }

    /// Where the model runs: on the cards if the choice allows it and it fits, otherwise on the processor if the choice
    /// is `auto` or `cpu` and it fits in RAM.
    fn place(&self) -> Result<Placed<'a>> {
        let choice = self.scope.choices.place;
        if choice != WhereChoice::Cpu {
            match self.on_gpus(self.cards(false))? {
                Tried::Fits(p) => return Ok(p),
                Tried::Short(cards) if choice != WhereChoice::Auto => bail!("{}", self.not_in(&cards)),
                Tried::Short(_) => {}
            }
        }
        match context(&self.need, ram_memory_mib(self.hw), Placement::Cpu) {
            Some(fit) => Ok(Placed { fit, gpus: Vec::new() }),
            None => bail!("{}", self.does_not_fit()),
        }
    }

    /// The model on the `cards` the choice calls for.
    fn on_gpus(&self, cards: Vec<&'a Gpu>) -> Result<Tried<'a>> {
        let choice = self.scope.choices.place;
        if cards.is_empty() {
            if choice == WhereChoice::Auto {
                return Ok(Tried::Short(cards));
            }
            bail!(
                "{}",
                tr!(
                    "Per il modello «{}» non c'è nessuna scheda video da usare: mancano, hanno troppa poca memoria o sono segnate come non usate.",
                    "There is no graphics card to use for the model «{}»: there are none, they have too little memory or they are marked as not used.",
                    self.cfg.label
                )
            );
        }
        let mut set = match choice {
            WhereChoice::Auto => return Ok(self.auto(cards)),
            WhereChoice::All => cards,
            WhereChoice::One | WhereChoice::Pick if self.build == Build::Vulkan => bail!(
                "{}",
                tr!(
                    "Con il motore di questo computer non si può scegliere una scheda: le usa tutte. Il modello «{}» può girare su tutte le schede o sul processore.",
                    "With this computer's engine a card can't be chosen: it uses all of them. The model «{}» can run on all the cards or on the processor.",
                    self.cfg.label
                )
            ),
            WhereChoice::One => vec![cards.into_iter().min_by_key(|g| by_speed(g)).expect("the cards are not empty")],
            WhereChoice::Pick => self.picked(&cards)?,
            WhereChoice::Cpu => unreachable!("the processor is not a try on the cards"),
        };
        set.sort_by_key(|g| g.index);
        Ok(match context(&self.need, gpus_memory_mib(&set), Placement::Gpu) {
            Some(fit) => Tried::Fits(Placed { fit, gpus: set }),
            None => Tried::Short(set),
        })
    }

    /// `auto`: the fewest cards that give `AUTO_CTX` tokens (the target, if lower), the fastest first. If not even all
    /// of them do, the fewest that give the context all of them give.
    fn auto(&self, mut cards: Vec<&'a Gpu>) -> Tried<'a> {
        let Some(all) = context(&self.need, gpus_memory_mib(&cards), Placement::Gpu) else { return Tried::Short(cards) };
        cards.sort_by_key(|g| by_speed(g));
        // Vulkan: the cards can't be told apart from here, so it takes them all.
        if self.build != Build::Vulkan {
            // The goal is compared with the rounded context `c.ctx` (see `AUTO_CTX`), not with the memory in tokens.
            let want = AUTO_CTX.min(self.need.target);
            let fit_of = |set: &[&Gpu]| context(&self.need, gpus_memory_mib(set), Placement::Gpu).filter(|c| c.ctx >= want || *c == all);
            for k in 1..cards.len() {
                let Some(mut set) = first_set(&cards, k, |s| fit_of(s).is_some()) else { continue };
                // A model that fits one card, on a computer that wants small models on all of them.
                if k == 1 && self.scope.small_all {
                    break;
                }
                let fit = fit_of(&set).expect("the set was accepted");
                set.sort_by_key(|g| g.index);
                return Tried::Fits(Placed { fit, gpus: set });
            }
        }
        cards.sort_by_key(|g| g.index);
        Tried::Fits(Placed { fit: all, gpus: cards })
    }

    /// The cards named in the choice, among `cards`; a name without a card says why.
    fn picked(&self, cards: &[&'a Gpu]) -> Result<Vec<&'a Gpu>> {
        let mut set: Vec<&Gpu> = Vec::new();
        for name in &self.scope.choices.gpus {
            let mut found = cards.iter().copied().filter(|g| &g.name == name).peekable();
            if found.peek().is_none() {
                bail!("{}", self.missing_card(name));
            }
            for g in found {
                if !set.contains(&g) {
                    set.push(g);
                }
            }
        }
        Ok(set)
    }

    /// Why a card named in the choice isn't among the cards.
    fn missing_card(&self, name: &str) -> String {
        let label = &self.cfg.label;
        let in_pc: Vec<&Gpu> = self.hw.gpus.iter().filter(|g| g.name == name).collect();
        if in_pc.is_empty() {
            return tr!("La scheda «{name}» scelta per il modello «{label}» non c'è più in questo computer.", "The card «{name}» chosen for the model «{label}» is no longer in this computer.");
        }
        let engine = engine_gpus(self.hw, self.build, &[]);
        if !in_pc.iter().any(|g| engine.iter().any(|e| e.index == g.index)) {
            return tr!(
                "La scheda «{name}» scelta per il modello «{label}» non può essere usata dal motore di questo computer.",
                "The card «{name}» chosen for the model «{label}» can't be used by this computer's engine."
            );
        }
        if self.scope.unused.iter().any(|n| n == name) {
            return tr!("La scheda «{name}» scelta per il modello «{label}» è segnata come non usata.", "The card «{name}» chosen for the model «{label}» is marked as not used.");
        }
        tr!("La scheda «{name}» scelta per il modello «{label}» è prestata a un altro lavoro.", "The card «{name}» chosen for the model «{label}» is lent to another job.")
    }

    /// With Vulkan a card can't be hidden: a model on the cards that must leave one out says so, instead of using it.
    fn check_vulkan(&self, placed: &Placed) -> Result<()> {
        if self.build != Build::Vulkan || placed.fit.placement != Placement::Gpu {
            return Ok(());
        }
        if !self.unused.is_empty() && !removable(self.hw, self.build, &self.unused) {
            bail!(
                "{}",
                tr!(
                    "Con il motore di questo computer non si può escludere una scheda singola: il modello «{}» usa tutte le schede. Rimetti in uso quella che hai escluso, oppure escludile tutte.",
                    "With this computer's engine a single card can't be left out: the model «{}» uses all the cards. Use again the one you left out, or leave all of them out.",
                    self.cfg.label
                )
            );
        }
        if !self.lent.is_empty() {
            bail!(
                "{}",
                tr!(
                    "Con il motore di questo computer non si può liberare una scheda singola: il modello «{}» usa tutte le schede.",
                    "With this computer's engine a single card can't be released: the model «{}» uses all the cards.",
                    self.cfg.label
                )
            );
        }
        Ok(())
    }

    /// The model on the cards left when the lent ones are taken away: the cards it takes at start.
    fn after_loans(&self) -> Result<Placed<'a>> {
        let cards = self.cards(true);
        if cards.is_empty() {
            bail!(
                "{}",
                tr!(
                    "Il modello «{}» ha bisogno di una scheda video, e tutte quelle del PC sono state liberate per un altro lavoro.",
                    "The model «{}» needs a graphics card, and all the PC's cards have been released for another job.",
                    self.cfg.label
                )
            );
        }
        match self.on_gpus(cards)? {
            Tried::Fits(p) => Ok(p),
            Tried::Short(_) => bail!(
                "{}",
                tr!(
                    "Il modello «{}» non ci sta nelle schede video rimaste: le altre sono prestate a un altro lavoro. Riprova quando tornano libere.",
                    "The model «{}» doesn't fit in the remaining graphics cards: the others are lent to another job. Try again when they are free.",
                    self.cfg.label
                )
            ),
        }
    }

    /// The model doesn't fit where the choice puts it: how much it needs and how much there is.
    fn not_in(&self, cards: &[&Gpu]) -> String {
        tr!(
            "Il modello «{}» non ci sta nelle schede indicate ({}): servono almeno {} GB (pesi e cache per {} token), ne hanno {}. Cambia dove gira, o scegli un modello più piccolo.",
            "The model «{}» doesn't fit in the cards indicated ({}): at least {} GB are needed (weights and cache for {} tokens), they have {}. Change where it runs, or choose a smaller model.",
            self.cfg.label,
            cards.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "),
            gb(self.need.minimum_mib()),
            context_label(MIN_CTX.min(self.need.target)),
            gb(gpus_memory_mib(cards))
        )
    }

    /// The model fits neither where the choice puts it nor the RAM.
    fn does_not_fit(&self) -> String {
        let cards = if self.scope.choices.place == WhereChoice::Cpu { Vec::new() } else { self.cards(false) };
        let placement = if cards.is_empty() {
            tr!(" e la RAM ne ha {}", " and the RAM has {}", gb(ram_memory_mib(self.hw)))
        } else {
            tr!(", le schede video ne hanno {} e la RAM {}", ", the graphics cards have {} and the RAM {}", gb(gpus_memory_mib(&cards)), gb(ram_memory_mib(self.hw)))
        };
        tr!(
            "Il modello «{}» non ci sta in questo computer: servono almeno {} GB (pesi e cache per {} token){placement}. Scegli un modello più piccolo.",
            "The model «{}» doesn't fit on this computer: at least {} GB are needed (weights and cache for {} tokens){placement}. Choose a smaller model.",
            self.cfg.label,
            gb(self.need.minimum_mib()),
            context_label(MIN_CTX.min(self.need.target)),
        )
    }
}

/// The choices of «where it runs» that work on this PC for a model the general engine runs: «one» and «pick» need
/// two cards to mean something and a build that can tell them apart; with Vulkan and a card that can't be left out
/// only the processor is left.
pub(crate) fn places(hw: &Hardware, build: Build, scope: &Scope) -> Vec<WhereChoice> {
    let unused = unused_indexes(hw, scope);
    if !unused.is_empty() && !removable(hw, build, &unused) {
        return vec![WhereChoice::Cpu];
    }
    let several = build != Build::Vulkan && engine_gpus(hw, build, &unused).len() >= 2;
    let any = !engine_gpus(hw, build, &unused).is_empty();
    let all = [(WhereChoice::Auto, true), (WhereChoice::One, several), (WhereChoice::All, any), (WhereChoice::Cpu, true), (WhereChoice::Pick, several)];
    all.into_iter().filter_map(|(choice, works)| works.then_some(choice)).collect()
}

/// A model's general plan: what is started, with which arguments.
pub(crate) struct GeneralPlan {
    pub ctx: u32,
    pub gpus: Vec<Gpu>,
    pub env: Vec<(String, String)>,
    /// The hardware's own arguments, after those common to all engines.
    pub args: Vec<String>,
}

/// A model's general plan. Where the model runs is decided on the cards the user leaves out removed; the cards lent
/// to another job (`lent`) don't send a GPU model to the processor, it runs on the remaining cards if it fits.
pub(crate) fn plan(file: &ModelsFile, cfg: &ModelCfg, hw: &Hardware, lent: &[u32], scope: &Scope) -> Result<GeneralPlan> {
    let build = choose_build(hw);
    let s = Situation::new(file, cfg, hw, build, scope, lent)?;
    let mut placed = s.place()?;
    // `-fit` is on by default and, if the cards' memory isn't enough, would move parts of the model to RAM.
    let mut args = vec!["-fit".to_string(), "off".to_string()];
    let mut env = Vec::new();
    if placed.fit.placement == Placement::Cpu {
        args.extend(["-dev".to_string(), "none".to_string(), "-t".to_string(), hw.cpu.cores.to_string()]);
        args.extend(cache_q8(placed.fit.kv));
        return Ok(GeneralPlan { ctx: placed.fit.ctx, gpus: Vec::new(), env, args });
    }
    s.check_vulkan(&placed)?;
    if !lent.is_empty() {
        placed = s.after_loans()?;
    }
    if build.cuda_major().is_some() {
        let visible: Vec<String> = placed.gpus.iter().map(|s| s.index.to_string()).collect();
        env.push(("CUDA_DEVICE_ORDER".to_string(), "PCI_BUS_ID".to_string()));
        env.push(("CUDA_VISIBLE_DEVICES".to_string(), visible.join(",")));
    }
    args.extend(["-ngl".to_string(), "all".to_string()]);
    args.extend(cache_q8(placed.fit.kv));
    Ok(GeneralPlan { ctx: placed.fit.ctx, gpus: placed.gpus.into_iter().cloned().collect(), env, args })
}

fn cache_q8(kv: KvType) -> Vec<String> {
    match kv {
        KvType::F16 => Vec::new(),
        KvType::Q8_0 => ["-ctk", "q8_0", "-ctv", "q8_0", "-fa", "on"].map(String::from).to_vec(),
    }
}

/// GB with one decimal, written as the current language writes them (comma in Italian, point in English).
pub(crate) fn gb(mib: u64) -> String {
    let s = format!("{:.1}", mib as f64 / 1024.0);
    if lang() == Lang::It { s.replace('.', ",") } else { s }
}

/// Where a model runs, with what context and on which cards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Fit {
    pub placement: Placement,
    pub ctx: u32,
    /// The cards it takes; none on the processor.
    pub gpus: Vec<Gpu>,
}

/// Where a model would run and the reason written for whoever reads, or why it doesn't fit.
pub(crate) struct Located {
    pub fit: Option<Fit>,
    pub reason: String,
}

/// What the plan would do for the model on `hw` with `build` and the user's choices, with the reason. `lent`: the cards
/// lent to another job, which the plan leaves out as `plan` does.
pub(crate) fn evaluate(file: &ModelsFile, cfg: &ModelCfg, hw: &Hardware, build: Build, scope: &Scope, lent: &[u32]) -> Located {
    let unfit = |reason: String| Located { fit: None, reason };
    let s = match Situation::new(file, cfg, hw, build, scope, lent) {
        Ok(s) => s,
        Err(e) => return unfit(e.to_string()),
    };
    let placed = match s.place().and_then(|p| s.check_vulkan(&p).map(|()| p)).and_then(|p| if p.fit.placement == Placement::Gpu && !lent.is_empty() { s.after_loans() } else { Ok(p) }) {
        Ok(p) => p,
        Err(e) => return unfit(e.to_string()),
    };
    let (c, used) = (placed.fit, placed.gpus);
    let f = &s.need;
    let kv = (c.kv.bytes_per_token(f.kv_f16_bytes_per_token) * u64::from(c.ctx)).div_ceil(MIB);
    let how_much = tr!(
        "{} GB di pesi e {} GB di cache per {} token",
        "{} GB of weights and {} GB of cache for {} tokens",
        gb(f.weights_mib + f.state_mib),
        gb(kv),
        context_label(c.ctx)
    );
    let cards = s.cards(false);
    let reason = match c.placement {
        Placement::Gpu => tr!(
            "Ci sta nella memoria delle schede video: {how_much}, su {} GB disponibili.",
            "It fits in the graphics cards' memory: {how_much}, out of {} GB available.",
            gb(gpus_memory_mib(&used))
        ),
        Placement::Cpu if scope.choices.place == WhereChoice::Cpu => {
            tr!("Gira sul processore, come hai scelto: {how_much}, su {} GB di RAM disponibili.", "It runs on the processor, as you chose: {how_much}, out of {} GB of RAM available.", gb(ram_memory_mib(hw)))
        }
        Placement::Cpu if cards.is_empty() => {
            tr!("Ci sta nella RAM: {how_much}, su {} GB disponibili.", "It fits in RAM: {how_much}, out of {} GB available.", gb(ram_memory_mib(hw)))
        }
        Placement::Cpu => tr!(
            "Nelle schede video non ci sta (servono almeno {} GB, ne hanno {}): gira sul processore, più lento. Nella RAM: {how_much}, su {} GB disponibili.",
            "It doesn't fit in the graphics cards (at least {} GB are needed, they have {}): it runs on the processor, slower. In RAM: {how_much}, out of {} GB available.",
            gb(f.minimum_mib()),
            gb(gpus_memory_mib(&cards)),
            gb(ram_memory_mib(hw))
        ),
    };
    Located { fit: Some(Fit { placement: c.placement, ctx: c.ctx, gpus: used.into_iter().cloned().collect() }), reason }
}
