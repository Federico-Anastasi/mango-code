//! Splitting the layers across the graphics cards: a pure function (no I/O), so it can be tested with fake
//! configurations. A generalized port of `motore/mappa_strati.py` from the trellis bench.
//!
//! Structure (the measured one, «configuration A» of the engine's README):
//! - the **main card** holds the full-attention layers with their context cache, the output head and the prompt
//!   reading work (`prefill_main`: the tensor units are there); it is the card with the highest compute
//!   capability, at equal capability the one with more VRAM;
//! - the recurrent layers (DeltaNet) go to the **secondary card** as long as they fit; the main one keeps only
//!   what is left over. Every free MiB on the main card is extra context;
//! - **at most two cards**: the weights outside the main card (4.4 GB on the 27B) sit in pinned memory for
//!   reading, and with three cards WDDM's pinned memory ceiling runs out (measured on the engine: with
//!   36 layers streaming it works, with 48 it doesn't). The rule is on the number of cards, not on names: when
//!   streaming moves to a small ring, the limit is raised here;
//! - the context is the requested one if it fits; otherwise it goes down in steps of 4096 to `MIN_CTX`. At equal
//!   context the solution with fewer cards wins, then the one with the better cards;
//! - the **image encoder** (if the model reads images) goes on a card the model leaves free and that can hold it
//!   (like the GTX 1080 next to the RTX 3060 Ti and GTX 1660 SUPER); if there is none, on the main one, and the context pays for its memory. On the CPU
//!   this engine gives random text for images: the encoder is always on a card.

use crate::hardware::Gpu;
use anyhow::{bail, Result};
use mango_common::tr;

pub const MIB: u64 = 1 << 20;
/// Memory that Windows (screen, DWM) and the CUDA context take from each card. Measured on 30/10 from the engine
/// log: 3060 Ti 8191 - 7128 free = 1063 MiB, 1660 S 6143 - 5134 = 1009 MiB.
pub(crate) const SYSTEM_RESERVE_MIB: u64 = 1100;
/// Margin above the measurement: the user's desktop may take more than ours.
const SAFETY_MARGIN_MIB: u64 = 256;
/// Compute buffer of the main card at `-ub 512 -wgt 1` (engine log: 242 MiB).
const COMPUTE_MAIN_MIB: u64 = 242;
/// Compute buffer of a secondary card (engine log: 5.62 MiB).
const COMPUTE_OTHER_MIB: u64 = 6;
/// `prefill_main` buffer on the main card when there are layers on another card: two streaming slots, fixed small
/// weights, states (engine log: 527.08 MiB with 48 layers outside).
const PREFILL_MAIN_MIB: u64 = 527;
/// Compute buffer of the MTP layer's context, which has its own cache and graph (batches of 128 tokens; engine log:
/// 49.5 MiB).
const MTP_COMPUTE_MIB: u64 = 50;
/// Below this context the agent isn't usable: the system prompt alone weighs ~18 600 tokens.
pub const MIN_CTX: u32 = 32_768;
const CTX_STEP: u32 = 4096;
/// The engine's trellis kernels start at sm_61 (Pascal): below that they don't run.
const MIN_CC: (u32, u32) = (6, 1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerKind {
    /// Full attention: it has the K/V cache that grows with the context.
    Attention,
    /// Recurrent (DeltaNet): fixed-size state.
    Recurrent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layer {
    pub kind: LayerKind,
    pub weight_bytes: u64,
    /// `Attention` only: bytes of K+V cache per token.
    pub cache_bytes_per_token: u64,
    /// `Recurrent` only: bytes of state.
    pub state_bytes: u64,
}

/// What needs to be known about the model to split it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelShape {
    /// The model's layers, in order, without the MTP ones.
    pub layers: Vec<Layer>,
    /// MTP layers (full attention), after the `layers` in the engine's map. They take memory only with MTP on:
    /// then their context has its own cache and compute buffer.
    pub mtp: Vec<Layer>,
    /// Output head (weights + norm).
    pub output_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    /// Indexes in the input slice: the main one first, then (if any) the secondary.
    pub gpus: Vec<usize>,
    /// For each layer (then the MTP ones, then the head): index inside `gpus`.
    pub layer_devices: Vec<usize>,
    pub ctx: u32,
    /// The image encoder's card (index in the input slice): the main one or one the model doesn't use. `None`
    /// without images.
    pub encoder: Option<usize>,
}

/// Where the MTP layer sits: with MTP off it takes nothing and in the map it stays on the main card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mtp {
    Off,
    Main,
    Secondary,
}

fn capacity(g: &Gpu) -> u64 {
    g.memory_mib.saturating_sub(SYSTEM_RESERVE_MIB + SAFETY_MARGIN_MIB) * MIB
}

/// Sort key that puts the strongest card first: compute capability, at equal capability more VRAM, then PCI order.
pub(crate) fn by_power(g: &Gpu) -> (std::cmp::Reverse<Option<(u32, u32)>>, std::cmp::Reverse<u64>, u32) {
    (std::cmp::Reverse(g.cc), std::cmp::Reverse(g.memory_mib), g.index)
}

fn layer_bytes(l: &Layer) -> u64 {
    l.weight_bytes + l.state_bytes
}

/// Memory the main card must have anyway: attention (weights + cache), head, buffers.
fn main_fixed(shape: &ModelShape, ctx: u32, streaming: bool) -> u64 {
    let attn: u64 = shape
        .layers
        .iter()
        .filter(|l| l.kind == LayerKind::Attention)
        .map(|l| l.weight_bytes + l.cache_bytes_per_token * u64::from(ctx))
        .sum();
    let prefill = if streaming { PREFILL_MAIN_MIB } else { 0 };
    attn + shape.output_bytes + (COMPUTE_MAIN_MIB + prefill) * MIB
}

/// Memory of the MTP layer when on: weights, its context's cache, compute buffer.
fn mtp_bytes(shape: &ModelShape, ctx: u32) -> u64 {
    if shape.mtp.is_empty() {
        return 0;
    }
    let layers: u64 = shape.mtp.iter().map(|l| l.weight_bytes + l.cache_bytes_per_token * u64::from(ctx)).sum();
    layers + MTP_COMPUTE_MIB * MIB
}

fn recurrent(shape: &ModelShape) -> Vec<&Layer> {
    shape.layers.iter().filter(|l| l.kind == LayerKind::Recurrent).collect()
}

/// A single card: the whole model on the main one, plus `extra` (the encoder, if it sits there).
fn fits_single(shape: &ModelShape, ctx: u32, main: &Gpu, mtp: Mtp, extra: u64) -> bool {
    let rec: u64 = recurrent(shape).into_iter().map(layer_bytes).sum();
    let mtp = if mtp == Mtp::Off { 0 } else { mtp_bytes(shape, ctx) };
    main_fixed(shape, ctx, false) + rec + mtp + extra <= capacity(main)
}

/// Two cards: how many recurrent layers stay on the main one (which also holds `extra`), if the pair holds up.
fn fits_pair(shape: &ModelShape, ctx: u32, main: &Gpu, sec: &Gpu, mtp: Mtp, extra: u64) -> Option<usize> {
    let rec = recurrent(shape);
    let (mtp_main, mtp_sec) = match mtp {
        Mtp::Off => (0, 0),
        Mtp::Main => (mtp_bytes(shape, ctx), 0),
        Mtp::Secondary => (0, mtp_bytes(shape, ctx)),
    };
    let budget = capacity(sec).checked_sub(COMPUTE_OTHER_MIB * MIB + mtp_sec)?;
    // The secondary takes the last DeltaNets (contiguous, as in `mappa_strati.py`).
    let mut used = 0;
    let mut n_sec = 0;
    for l in rec.iter().rev() {
        if used + layer_bytes(l) > budget {
            break;
        }
        used += layer_bytes(l);
        n_sec += 1;
    }
    if n_sec == 0 {
        return None;
    }
    let n_main = rec.len() - n_sec;
    let on_main: u64 = rec[..n_main].iter().map(|l| layer_bytes(l)).sum();
    (main_fixed(shape, ctx, true) + on_main + mtp_main + extra <= capacity(main)).then_some(n_main)
}

/// `n_main_rec`: how many DeltaNets (the first ones) stay on the main card.
fn layer_devices(shape: &ModelShape, n_main_rec: usize, mtp: Mtp) -> Vec<usize> {
    let mut d = Vec::with_capacity(shape.layers.len() + shape.mtp.len() + 1);
    let mut r = 0;
    for l in &shape.layers {
        d.push(match l.kind {
            LayerKind::Attention => 0,
            LayerKind::Recurrent => {
                r += 1;
                usize::from(r > n_main_rec)
            }
        });
    }
    d.extend(std::iter::repeat_n(usize::from(mtp == Mtp::Secondary), shape.mtp.len()));
    d.push(0); // output head
    d
}

/// The requested context, then the multiples of 4096 below it down to `MIN_CTX`.
fn ctx_candidates(want: u32) -> Vec<u32> {
    let mut v = vec![want];
    let mut c = (want.saturating_sub(1) / CTX_STEP) * CTX_STEP;
    while c >= MIN_CTX {
        v.push(c);
        c -= CTX_STEP;
    }
    v
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / (MIB * 1024) as f64
}

/// A context as the settings write it: «128k».
pub(crate) fn context_label(tokens: u32) -> String {
    format!("{}k", (tokens + 512) / 1024)
}

fn list(gpus: &[Gpu]) -> String {
    gpus.iter()
        .map(|g| format!("{} ({:.0} GB)", g.name, g.memory_mib as f64 / 1024.0))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A card the model doesn't use and that alone holds the encoder (`encoder` bytes): the first in PCI order.
fn free_gpu(gpus: &[Gpu], ranked: &[usize], model: &[usize], encoder: u64) -> Option<usize> {
    ranked.iter().copied().filter(|i| !model.contains(i) && capacity(&gpus[*i]) >= encoder).min_by_key(|&i| gpus[i].index)
}

/// Chooses the cards, the layer map and the context (≤ `want_ctx`). With `with_mtp` the MTP layer sits on the main
/// card if there is room, otherwise on the secondary (which hands the main card the DeltaNets it can no longer
/// hold). `encoder`: bytes of the image encoder, 0 if the model doesn't read images.
pub fn partition(gpus: &[Gpu], shape: &ModelShape, want_ctx: u32, with_mtp: bool, encoder: u64) -> Result<Placement> {
    // The usable cards, best first: compute capability, VRAM, then PCI order.
    let mut ranked: Vec<usize> = (0..gpus.len()).filter(|&i| gpus[i].cc.is_some_and(|cc| cc >= MIN_CC)).collect();
    ranked.sort_by_key(|&i| by_power(&gpus[i]));
    if ranked.is_empty() {
        bail!(
            "{}",
            tr!(
                "Nessuna delle schede video trovate è abbastanza recente: servono schede NVIDIA GTX 10 o successive \
                 (compute capability 6.1 o più). Trovate: {}.",
                "None of the graphics cards found is recent enough: NVIDIA GTX 10 or later cards are needed \
                 (compute capability 6.1 or more). Found: {}.",
                list(gpus)
            )
        );
    }
    let mtp_main = if with_mtp && !shape.mtp.is_empty() { Mtp::Main } else { Mtp::Off };
    // With the model on `model` (the main one first): where the encoder goes and how much it weighs on the main card.
    let encoder_for = |model: &[usize]| {
        if encoder == 0 {
            return (None, 0);
        }
        match free_gpu(gpus, &ranked, model, encoder) {
            Some(e) => (Some(e), 0),
            None => (Some(model[0]), encoder),
        }
    };
    for ctx in ctx_candidates(want_ctx) {
        for &m in &ranked {
            let (enc, extra) = encoder_for(&[m]);
            if fits_single(shape, ctx, &gpus[m], mtp_main, extra) {
                // No layer outside the main card: `usize::MAX` = all the DeltaNets stay there.
                return Ok(Placement { gpus: vec![m], layer_devices: layer_devices(shape, usize::MAX, mtp_main), ctx, encoder: enc });
            }
        }
        let places: &[Mtp] = if mtp_main == Mtp::Main { &[Mtp::Main, Mtp::Secondary] } else { &[Mtp::Off] };
        for (a, &m) in ranked.iter().enumerate() {
            for &s in &ranked[a + 1..] {
                let (enc, extra) = encoder_for(&[m, s]);
                for &mtp in places {
                    if let Some(n_main) = fits_pair(shape, ctx, &gpus[m], &gpus[s], mtp, extra) {
                        return Ok(Placement { gpus: vec![m, s], layer_devices: layer_devices(shape, n_main, mtp), ctx, encoder: enc });
                    }
                }
            }
        }
    }
    let rec: u64 = recurrent(shape).into_iter().map(layer_bytes).sum();
    let reserve = (SYSTEM_RESERVE_MIB + SAFETY_MARGIN_MIB) * MIB;
    bail!(
        "{}",
        tr!(
            "La memoria delle schede video non basta per questo modello. Trovate: {}. \
             Serve una scheda da almeno {:.0} GB, oppure due schede (ad esempio una da {:.0} GB e una da {:.0} GB), \
             per un contesto minimo di {} token.",
            "The graphics cards' memory is not enough for this model. Found: {}. \
             A card with at least {:.0} GB is needed, or two cards (for example one with {:.0} GB and one with {:.0} GB), \
             for a minimum context of {} tokens.",
            list(gpus),
            gib(main_fixed(shape, MIN_CTX, false) + rec + encoder + reserve).ceil(),
            gib(main_fixed(shape, MIN_CTX, true) + encoder + reserve).ceil(),
            gib(rec + COMPUTE_OTHER_MIB * MIB + reserve).ceil(),
            context_label(MIN_CTX)
        )
    )
}

#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    use crate::hardware::Vendor;

    /// Qwen3.8-27B-TOQ-v1 as it is in the GGUF (header read from the file): 64 layers, one in four with full
    /// attention (the 4th, the 8th, ...), 1 MTP layer (101.6 MiB), q8_0 cache (2176 B/token per layer).
    pub fn qwen38_27b() -> ModelShape {
        let layers = (0..64)
            .map(|il| {
                if il % 4 == 3 {
                    Layer { kind: LayerKind::Attention, weight_bytes: 96_225_280, cache_bytes_per_token: 2176, state_bytes: 0 }
                } else {
                    Layer { kind: LayerKind::Recurrent, weight_bytes: 100_000_640, cache_bytes_per_token: 0, state_bytes: 3_268_608 }
                }
            })
            .collect();
        let mtp = vec![Layer { kind: LayerKind::Attention, weight_bytes: 106_530_816, cache_bytes_per_token: 2176, state_bytes: 0 }];
        ModelShape { layers, mtp, output_bytes: 477_788_160 }
    }

    pub fn gpu(index: u32, name: &str, memory_mib: u64, cc: (u32, u32)) -> Gpu {
        Gpu { index, name: name.into(), vendor: Vendor::Nvidia, memory_mib, cuda_driver: None, cc: Some(cc) }
    }

    /// The three cards RTX 3060 Ti, GTX 1080 and GTX 1660 SUPER, in PCI order.
    pub fn three_cards() -> Vec<Gpu> {
        vec![
            gpu(0, "NVIDIA GeForce RTX 3060 Ti", 8192, (8, 6)),
            gpu(1, "NVIDIA GeForce GTX 1080", 8192, (6, 1)),
            gpu(2, "NVIDIA GeForce GTX 1660 SUPER", 6144, (7, 5)),
        ]
    }

    /// The measured `LLAMA_LAYER_DEVICES` (configuration A, `mappa_strati.py 0`), copied from `mango-models.json`.
    pub const MAP_A: &str = "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,0,0";
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    fn map(p: &Placement) -> String {
        p.layer_devices.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",")
    }

    /// A check that must give zero: the three GPUs reproduce the measured configuration.
    #[test]
    fn three_gpus_reproduce_the_measured_configuration() {
        let g = three_cards();
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus.iter().map(|&i| g[i].index).collect::<Vec<_>>(), [0, 2], "the 1080 stays out");
        assert_eq!(map(&p), MAP_A);
        assert_eq!(p.ctx, 122_880);
    }

    #[test]
    fn three_gpus_do_not_grant_more_than_122880() {
        // Asking for 128k, the plan goes down to where the measurement stopped.
        let p = partition(&three_cards(), &qwen38_27b(), 131_072, false, 0).unwrap();
        assert_eq!(p.ctx, 122_880);
    }

    #[test]
    fn the_input_order_does_not_matter() {
        let mut g = three_cards();
        g.reverse();
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(map(&p), MAP_A);
        assert_eq!(g[p.gpus[0]].index, 0);
        assert_eq!(g[p.gpus[1]].index, 2);
    }

    #[test]
    fn a_24gb_card_holds_everything() {
        let g = [gpu(0, "RTX 4090", 24_564, (8, 9))];
        let p = partition(&g, &qwen38_27b(), 131_072, false, 0).unwrap();
        assert_eq!(p.gpus, [0]);
        assert_eq!(p.ctx, 131_072);
        assert_eq!(p.layer_devices.len(), 66);
        assert!(p.layer_devices.iter().all(|&d| d == 0));
    }

    #[test]
    fn a_12gb_card_lowers_the_context() {
        let g = [gpu(0, "RTX 3060", 12_288, (8, 6))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus, [0]);
        assert!((MIN_CTX..122_880).contains(&p.ctx) && p.ctx.is_multiple_of(4096), "ctx {}", p.ctx);
    }

    #[test]
    fn an_8gb_card_is_not_enough() {
        let g = [gpu(0, "RTX 3060 Ti", 8192, (8, 6))];
        let e = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap_err().to_string();
        assert!(e.contains(&tr!("non basta", "is not enough")) && e.contains("RTX 3060 Ti"), "{e}");
        assert!(e.contains(&tr!("contesto minimo di 32k token", "minimum context of 32k tokens")), "{e}");
    }

    #[test]
    fn two_8gb_cards_hold_the_full_context() {
        let g = [gpu(0, "A", 8192, (8, 6)), gpu(1, "B", 8192, (8, 6))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus, [0, 1]);
        assert_eq!(p.ctx, 122_880);
        assert_eq!(map(&p), MAP_A);
    }

    #[test]
    fn two_6gb_cards_reduce_the_context() {
        let g = [gpu(0, "A", 6144, (7, 5)), gpu(1, "B", 6144, (7, 5))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus, [0, 1]);
        assert!((MIN_CTX..122_880).contains(&p.ctx), "ctx {}", p.ctx);
    }

    #[test]
    fn the_main_card_keeps_the_deltanets_the_secondary_cannot_hold() {
        // 12 GB main card: alone it would make less context; with a 4 GB secondary it holds 122880
        // and the last DeltaNets go there, the first ones stay on the main card.
        let g = [gpu(0, "medium", 12_288, (8, 6)), gpu(1, "small", 4096, (7, 5))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus, [0, 1]);
        assert_eq!(p.ctx, 122_880);
        let sec = p.layer_devices[..64].iter().filter(|&&d| d == 1).count();
        assert!((1..48).contains(&sec), "{sec} layers on the secondary");
        let first = p.layer_devices.iter().position(|&d| d == 1).unwrap();
        // from `first` on every DeltaNet is on the secondary, every attention layer on the main card
        for il in 0..64 {
            let expect = if il % 4 == 3 || il < first { 0 } else { 1 };
            assert_eq!(p.layer_devices[il], expect, "layer {il}");
        }
    }

    #[test]
    fn cards_that_are_too_old_are_excluded() {
        let g = [gpu(0, "GTX 960", 4096, (5, 2))];
        let e = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap_err().to_string();
        assert!(e.contains(&tr!("abbastanza recente", "recent enough")), "{e}");
    }

    #[test]
    fn never_more_than_two_cards() {
        let g = [gpu(0, "A", 6144, (7, 5)), gpu(1, "B", 6144, (7, 5)), gpu(2, "C", 6144, (7, 5))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(p.gpus.len(), 2);
    }

    /// Qwen3.8's image encoder with the compute of one image.
    const ENCODER: u64 = 1525 * MIB;

    /// On the three GPUs the encoder goes on the card the model leaves free, as in the measured profile (the 1080), and the
    /// model stays where it was.
    #[test]
    fn the_encoder_goes_on_the_free_card() {
        let g = three_cards();
        let p = partition(&g, &qwen38_27b(), 122_880, false, ENCODER).unwrap();
        assert_eq!(p.gpus.iter().map(|&i| g[i].index).collect::<Vec<_>>(), [0, 2]);
        assert_eq!(p.encoder.map(|i| g[i].index), Some(1));
        assert_eq!((map(&p), p.ctx), (MAP_A.to_string(), 122_880));
    }

    /// Without a free card the encoder sits on the main one, and the context pays for its memory.
    #[test]
    fn without_a_free_card_the_encoder_sits_on_the_main_one() {
        let g = [gpu(0, "RTX 3060", 12_288, (8, 6))];
        let without = partition(&g, &qwen38_27b(), 131_072, false, 0).unwrap();
        let with = partition(&g, &qwen38_27b(), 131_072, false, ENCODER).unwrap();
        assert_eq!((with.gpus.clone(), with.encoder), (vec![0], Some(0)));
        assert!(with.ctx < without.ctx && with.ctx >= MIN_CTX, "{} against {}", with.ctx, without.ctx);
        assert_eq!(without.encoder, None, "without images there is no encoder");

        let g = [gpu(0, "A", 8192, (8, 6)), gpu(1, "B", 8192, (8, 6))];
        let p = partition(&g, &qwen38_27b(), 131_072, false, ENCODER).unwrap();
        assert_eq!((p.gpus.clone(), p.encoder), (vec![0, 1], Some(0)));
        assert!((MIN_CTX..122_880).contains(&p.ctx), "ctx {}", p.ctx);
    }

    /// A free card too small for the encoder doesn't take it: it stays on the main one.
    #[test]
    fn a_free_card_too_small_does_not_take_the_encoder() {
        let g = [gpu(0, "RTX 4090", 24_564, (8, 9)), gpu(1, "small", 2048, (7, 5))];
        let p = partition(&g, &qwen38_27b(), 131_072, false, ENCODER).unwrap();
        assert_eq!((p.gpus.clone(), p.encoder, p.ctx), (vec![0], Some(0), 131_072));
        let g = [gpu(0, "RTX 4090", 24_564, (8, 9)), gpu(1, "medium", 4096, (7, 5))];
        let p = partition(&g, &qwen38_27b(), 131_072, false, ENCODER).unwrap();
        assert_eq!((p.gpus.clone(), p.encoder), (vec![0], Some(1)));
    }

    #[test]
    fn the_best_card_is_the_main_one_even_with_less_vram() {
        // 3060 Ti (Ampere, 8 GB) + a 24 GB Pascal: the main one stays the Ampere.
        let g = [gpu(0, "Pascal", 24_564, (6, 1)), gpu(1, "Ampere", 8192, (8, 6))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(g[p.gpus[0]].name, "Pascal", "if the Pascal holds everything alone the pair isn't needed");
        let g = [gpu(0, "Pascal", 8192, (6, 1)), gpu(1, "Ampere", 8192, (8, 6))];
        let p = partition(&g, &qwen38_27b(), 122_880, false, 0).unwrap();
        assert_eq!(g[p.gpus[0]].name, "Ampere");
    }
}
