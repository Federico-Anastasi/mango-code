//! How fast a model writes when it runs on the processor, told in bands and not in numbers.
//!
//! On the processor the speed of writing is limited by the memory: tokens per second ≈ the bandwidth the processor really
//! gets ÷ the bytes read for each token (`ModelCfg::read_per_token`: the whole file for a dense model, the chosen experts
//! and the always-on parts for a MoE). The app knows the bytes; it does not know the PC's memory (speed, channels).
//! The two PCs measured in `optimize/knowledge` (general.md, G90-G92) run the same 35B MoE at 13.5 GiB/s (a laptop, one
//! DDR4-2400 channel) and about 24 GiB/s (a desktop, DDR4-3600, compute-bound): a single bandwidth is 26% over for the
//! first and 30% under for the second, and the PCs nobody measured (DDR5, soldered LPDDR, one stick on a desktop) are
//! further off. A figure would be wrong by more than half for many of them, so the page says a band that stays true under
//! a factor two: the words come from `first-run.js`.

use serde::{Deserialize, Serialize};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Effective bandwidth taken for any PC, in GiB/s: between the two measured ones.
const BANDWIDTH_GIB_S: f64 = 17.0;

/// A band of speed of writing on the processor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Speed {
    /// Under 1 token/s: less than a word a second, a long answer takes minutes.
    VerySlow,
    /// 1 to 4 tokens/s: a word or two a second.
    Slow,
    /// 4 to 12 tokens/s: a few words a second, about as fast as one reads.
    Fair,
    /// 12 tokens/s or more: faster than one reads.
    Quick,
}

impl Speed {
    /// The name the web UI knows it by (the same as serialized).
    pub fn as_str(self) -> &'static str {
        match self {
            Speed::VerySlow => "very_slow",
            Speed::Slow => "slow",
            Speed::Fair => "fair",
            Speed::Quick => "quick",
        }
    }
}

/// The band of a model that reads `bytes` of weights for each token it writes.
pub fn cpu_speed(read_per_token: u64) -> Speed {
    let tokens_per_second = BANDWIDTH_GIB_S * GIB / read_per_token.max(1) as f64;
    match tokens_per_second {
        t if t < 1.0 => Speed::VerySlow,
        t if t < 4.0 => Speed::Slow,
        t if t < 12.0 => Speed::Fair,
        _ => Speed::Quick,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    /// The measurements of the repository against the band: the 2-bit 35B MoE reads 1.57 GiB for each token and writes 8.6
    /// tokens/s on the laptop (band: a few words a second, right) and 15.5 on the desktop with official llama.cpp (faster than
    /// one reads: the estimate is one band low); a 27B dense model at 2 bits (about 8 GiB) writes 2-4 on the desktop (a word
    /// or two, right).
    #[test]
    fn the_bands_hold_the_repositorys_measures() {
        let gib = |x: f64| (x * GIB) as u64;
        assert_eq!(cpu_speed(gib(1.57)), Speed::Fair);
        assert_eq!(cpu_speed(gib(8.0)), Speed::Slow);
    }

    /// The catalog's models on a processor, with what each token reads (weights × the share a MoE reads).
    #[test]
    fn the_catalog_models_fall_where_their_bytes_say() {
        assert_eq!(cpu_speed(18_209_036_576 * 170 / 1000), Speed::Fair, "Qwen3.6-35B-A3B, 3 B active of 35");
        assert_eq!(cpu_speed(13_578_190_880 * 108 / 1000), Speed::Quick, "LFM2.5-24B-A2B, 2 B active of 24");
        assert_eq!(cpu_speed(14_252_845_984), Speed::Slow, "Qwen3.8-27B, dense");
        assert_eq!(cpu_speed(2_740_937_888), Speed::Fair, "Qwen3.5-4B");
        assert_eq!(cpu_speed(1_280_835_840), Speed::Quick, "Qwen3.5-2B");
        assert_eq!(cpu_speed(30 * GB), Speed::VerySlow, "a 70B dense model at 3 bits");
    }

    #[test]
    fn the_names_are_the_serialized_ones() {
        for s in [Speed::VerySlow, Speed::Slow, Speed::Fair, Speed::Quick] {
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
    }

    #[test]
    fn the_edges_are_between_the_bands() {
        let at = |tokens_per_second: f64| cpu_speed((BANDWIDTH_GIB_S * GIB / tokens_per_second) as u64);
        assert_eq!((at(0.99), at(1.01)), (Speed::VerySlow, Speed::Slow));
        assert_eq!((at(3.99), at(4.01)), (Speed::Slow, Speed::Fair));
        assert_eq!((at(11.9), at(12.1)), (Speed::Fair, Speed::Quick));
        assert_eq!(cpu_speed(0), Speed::Quick, "a file with no weights does not divide by zero");
    }
}
