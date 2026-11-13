//! The optimized profiles: a model on specific hardware, with the engine, the arguments and the measured numbers.
//! They live in `<dist>/profiles/<family>/<model>.json` (e.g. `profiles/3060ti-1080-1660s/3.6.json`, id `3060ti-1080-1660s/3.6`); the
//! user's, even for a model of their own, in `<data>/profiles/` (same shape; `mango-tune profile` writes there).
//! A profile applies if the PC's GPUs are exactly those it asks for, or, if it asks for no GPUs, if the PC's build is
//! among its own (`profiles/general/`: a model official llama.cpp doesn't read, on every PC its engine supports).
//! Otherwise the general plan applies.

use crate::choices::WhereChoice;
use crate::general::Placement;
use crate::hardware::{choose_build, Hardware};
use crate::user;
use anyhow::Result;
use mango_common::download::has_build;
use mango_common::{tr, Build, Paths};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct Profile {
    /// `<family>/<model>`, like the file's path under `profiles/`.
    pub id: String,
    /// Model key in mango-models.json.
    pub model: String,
    /// The engine (folder in `<engines>`): `prism`, `toq`...
    pub engine: String,
    pub build: Build,
    pub hardware: ProfileHardware,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// llama-server arguments beyond those common to all models.
    #[serde(default)]
    pub args: Vec<String>,
    /// Context the profile was measured with.
    pub ctx: u32,
    /// The layers split themselves across the GPUs (`split.rs`): only valid for the trellis engine, which reads
    /// `LLAMA_LAYER_DEVICES`. Without it, the profile uses all the GPUs with its own `-ts`.
    #[serde(default)]
    pub split: bool,
    /// Ubatch size (`-ub`).
    pub ub: Option<u32>,
    /// Tensor-split (`-ts`), for engines that don't split by themselves.
    pub ts: Option<String>,
    /// Tokens anticipated by the MTP layer at each step; absent = MTP off.
    pub mtp: Option<u32>,
    pub measurements: Measurements,
}

/// On which PCs the profile applies: the exact GPUs it was measured on, or every PC with a build (`profiles/general/`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileHardware {
    /// The names of the GPUs the profile requires: the same as the PC's, in any order.
    pub gpus: Option<Vec<String>>,
    /// The PC builds (`choose_build`) it applies to, whatever GPU they have.
    pub build: Option<Vec<Build>>,
}

impl Profile {
    /// The profile is for the GPUs of a specific PC, not for all PCs with a build.
    pub fn tailored(&self) -> bool {
        self.hardware.gpus.is_some()
    }

    /// A profile runs entirely on the GPUs (`-ngl`), or entirely on the processor if it is for the CPU build.
    pub fn placement(&self) -> Placement {
        if self.build == Build::Cpu {
            Placement::Cpu
        } else {
            Placement::Gpu
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Measurements {
    /// When it was measured; absent = tune not measured yet.
    pub date: Option<String>,
    pub decode_tok_s: Option<f64>,
    pub prefill_tok_s: Option<f64>,
    /// What was measured and why the tune is this one.
    #[serde(default)]
    pub note: String,
}

/// The profile of `model` that applies to `hw` and to the user's choice for the model, if any: only with «auto» does a
/// profile count, any other choice runs the general plan (`choices.rs`). Use `lookup` to know whether one exists.
pub fn profile_for(paths: &Paths, model: &str, hw: &Hardware) -> Result<Option<Profile>> {
    if crate::choices::read(paths)?.models.get(model).is_some_and(|c| c.place != WhereChoice::Auto) {
        return Ok(None);
    }
    lookup(paths, model, hw)
}

/// The profile of `model` that applies to `hw`, if any: first the one for the PC's GPUs, then the one for its build.
/// An unreadable profile is an error (the distribution is damaged), not a reason to silently fall back on the general
/// one. A CUDA 12 profile runs on its engine's build for the GTX 16 family where the PC's cards ask for it
/// (`Hardware::turing_without_tensor_cores`) and the engine has one.
pub(crate) fn lookup(paths: &Paths, model: &str, hw: &Hardware) -> Result<Option<Profile>> {
    let profiles = for_model(paths, model)?;
    let build = choose_build(hw);
    Ok(profiles
        .iter()
        .find(|p| p.hardware.gpus.as_ref().is_some_and(|s| same_gpus(s, hw)))
        .or_else(|| profiles.iter().find(|p| p.hardware.build.as_ref().is_some_and(|b| b.contains(&build))))
        .cloned()
        .map(|mut p| {
            if p.build == Build::Cuda12 && hw.turing_without_tensor_cores() && has_build(paths, &p.engine, Build::Cuda12Gtx16) {
                p.build = Build::Cuda12Gtx16;
            }
            p
        }))
}

/// The profiles of `model`, in the order they count.
fn for_model(paths: &Paths, model: &str) -> Result<Vec<Profile>> {
    // First the user's profiles (`<data>/profiles`, where `mango-tune` writes them): for the same model and GPUs
    // theirs wins.
    let folders = [
        (
            paths.data.join("profiles"),
            tr!("Non riesco a leggere un tuo profilo.", "I can't read one of your profiles."),
            tr!("Un tuo profilo è danneggiato: correggilo o toglilo.", "One of your profiles is damaged: fix it or remove it."),
        ),
        (
            paths.dist.join("profiles"),
            tr!("Non riesco a leggere un profilo di Mango Code. Reinstalla l'applicazione.", "I can't read a Mango Code profile. Reinstall the application."),
            tr!("Un profilo di Mango Code è danneggiato. Reinstalla l'applicazione.", "A Mango Code profile is damaged. Reinstall the application."),
        ),
    ];
    let mut profiles = Vec::new();
    for (dir, cannot_read, damaged) in &folders {
        let mut files = Vec::new();
        list_json(dir, &mut files);
        files.sort();
        for f in files {
            let txt = std::fs::read_to_string(&f).map_err(|e| user(cannot_read, format!("{}: {e}", f.display())))?;
            let p: Profile = serde_json::from_str(txt.trim_start_matches('\u{feff}')).map_err(|e| user(damaged, format!("{}: {e}", f.display())))?;
            if p.hardware.gpus.is_some() == p.hardware.build.is_some() {
                return Err(user(damaged, format!("{}: «hardware» must say the GPUs or the builds, one of the two", f.display())));
            }
            if p.model == model {
                profiles.push(p);
            }
        }
    }
    Ok(profiles)
}

/// The PC's GPUs that count are the `required` ones, neither more nor fewer.
fn same_gpus(required: &[String], hw: &Hardware) -> bool {
    let mut required: Vec<&str> = required.iter().map(String::as_str).collect();
    let mut present: Vec<&str> = hw.usable().map(|s| s.name.as_str()).collect();
    required.sort_unstable();
    present.sort_unstable();
    required == present
}

/// All the `.json` files under `dir`, at any depth. A folder that isn't there has no profiles.
fn list_json(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            list_json(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::fixture::*;
    use crate::hardware::Vendor;

    pub fn profile_json(model: &str, gpus: &[&str]) -> String {
        let gpus: Vec<String> = gpus.iter().map(|s| format!("\"{s}\"")).collect();
        format!(
            r#"{{ "id": "test/{model}", "model": "{model}", "engine": "prism", "build": "cuda-12",
               "hardware": {{ "gpus": [{}] }}, "ctx": 65536,
               "measurements": {{ "date": "2026-11-05", "note": "test" }} }}"#,
            gpus.join(",")
        )
    }

    fn dist_with(profiles: &[(&str, String)]) -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        let paths = Paths { dist: r.join("dist"), engines: r.join("e"), models: r.join("m"), opencode: r.join("o"), data: r.join("d") };
        for (rel, txt) in profiles {
            let f = paths.dist.join("profiles").join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, txt).unwrap();
        }
        (dir, paths)
    }

    const THREE: [&str; 3] = ["NVIDIA GeForce GTX 1660 SUPER", "NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce GTX 1080"];

    #[test]
    fn the_profile_applies_with_the_same_gpus_in_any_order() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", profile_json("3.6", &THREE))]);
        let p = profile_for(&paths, "3.6", &three_gpus()).unwrap().unwrap();
        assert_eq!((p.id.as_str(), p.engine.as_str(), p.build, p.ctx), ("test/3.6", "prism", Build::Cuda12, 65_536));
    }

    #[test]
    fn with_one_more_or_one_fewer_gpu_the_profile_does_not_apply() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", profile_json("3.6", &THREE))]);
        let mut more = three_gpus();
        more.gpus.push(other(3, "AMD Radeon RX 6600", Vendor::Amd, 8176));
        assert!(profile_for(&paths, "3.6", &more).unwrap().is_none());
        let mut fewer = three_gpus();
        fewer.gpus.pop();
        assert!(profile_for(&paths, "3.6", &fewer).unwrap().is_none());
    }

    #[test]
    fn integrated_graphics_does_not_remove_the_profile() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", profile_json("3.6", &THREE))]);
        let mut hw = three_gpus();
        hw.gpus.push(other(3, "Intel(R) UHD Graphics 770", Vendor::Intel, 128));
        assert!(profile_for(&paths, "3.6", &hw).unwrap().is_some());
    }

    #[test]
    fn the_profile_is_for_one_model_only() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", profile_json("3.6", &THREE))]);
        assert!(profile_for(&paths, "3.8", &three_gpus()).unwrap().is_none());
    }

    #[test]
    fn without_a_profiles_folder_the_general_plan_applies() {
        let (_d, paths) = dist_with(&[]);
        assert!(profile_for(&paths, "3.6", &three_gpus()).unwrap().is_none());
    }

    fn write_user(paths: &Paths, rel: &str, txt: &str) {
        let f = paths.data.join("profiles").join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, txt).unwrap();
    }

    #[test]
    fn the_users_profiles_count_like_mango_codes() {
        let (_d, paths) = dist_with(&[]);
        write_user(&paths, "my-pc/mine.json", &profile_json("mine", &THREE));
        // Also flat, as `mango-tune profile` writes them.
        write_user(&paths, "my-pc-3.6.json", &profile_json("3.6", &THREE));
        assert_eq!(profile_for(&paths, "mine", &three_gpus()).unwrap().unwrap().id, "test/mine");
        assert!(profile_for(&paths, "3.6", &three_gpus()).unwrap().is_some());
        assert!(profile_for(&paths, "other", &three_gpus()).unwrap().is_none());
    }

    #[test]
    fn for_the_same_model_and_gpus_the_users_profile_wins() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", profile_json("3.6", &THREE))]);
        write_user(&paths, "mine/3.6.json", &profile_json("3.6", &THREE).replace("test/3.6", "mine/3.6"));
        assert_eq!(profile_for(&paths, "3.6", &three_gpus()).unwrap().unwrap().id, "mine/3.6");
    }

    #[test]
    fn a_damaged_user_profile_is_an_error_that_names_it_without_saying_to_reinstall() {
        let (_d, paths) = dist_with(&[]);
        write_user(&paths, "mine/broken.json", "{ not json");
        let e = profile_for(&paths, "3.6", &three_gpus()).unwrap_err().to_string();
        assert!(e.contains("broken.json") && e.contains(&tr!("Un tuo profilo", "One of your profiles")) && !e.contains(&tr!("Reinstalla", "Reinstall")), "{e}");
    }

    fn profile_for_build(model: &str, build: &[&str]) -> String {
        let build: Vec<String> = build.iter().map(|b| format!("\"{b}\"")).collect();
        profile_json(model, &[]).replace(r#""gpus": []"#, &format!(r#""build": [{}]"#, build.join(",")))
    }

    /// A profile for a build applies on every PC whose build is among its own, whatever GPU it has.
    #[test]
    fn a_build_profile_applies_on_every_pc_with_that_build() {
        let (_d, paths) = dist_with(&[("general/toq.json", profile_for_build("toq", &["cuda-12", "cuda-13"]))]);
        let p4090 = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (12, 6))], 65_536);
        let p5070 = pc(vec![nvidia(0, "NVIDIA GeForce RTX 5070", 12_227, (12, 0), (13, 4))], 32_768);
        for hw in [three_gpus(), p4090, p5070] {
            let p = profile_for(&paths, "toq", &hw).unwrap().unwrap();
            assert!(!p.tailored(), "{}", p.id);
        }
        for hw in [pc(vec![], 32_768), pc(vec![other(0, "AMD Radeon RX 7800 XT", Vendor::Amd, 16_368)], 32_768)] {
            assert!(profile_for(&paths, "toq", &hw).unwrap().is_none());
        }
    }

    /// The profile for the PC's GPUs wins over the one for the build, even if it comes first in file order.
    #[test]
    fn the_gpu_profile_wins_over_the_build_one() {
        let (_d, paths) = dist_with(&[
            ("a-general/toq.json", profile_for_build("toq", &["cuda-12"]).replace("test/toq", "general/toq")),
            ("three-gpus/toq.json", profile_json("toq", &THREE)),
        ]);
        let p = profile_for(&paths, "toq", &three_gpus()).unwrap().unwrap();
        assert!(p.tailored() && p.id == "test/toq", "{}", p.id);
        let other_pc = pc(vec![nvidia(0, "NVIDIA GeForce RTX 4090", 24_564, (8, 9), (12, 6))], 65_536);
        assert_eq!(profile_for(&paths, "toq", &other_pc).unwrap().unwrap().id, "general/toq");
    }

    /// The engines of the catalog, each with these builds.
    fn engines(paths: &Paths, engines: &[(&str, &[&str])]) {
        let cat: serde_json::Map<String, serde_json::Value> = engines
            .iter()
            .map(|(engine, builds)| {
                let builds: serde_json::Map<String, serde_json::Value> = builds.iter().map(|b| (b.to_string(), serde_json::json!({ "url": "", "size": 0, "sha256": "" }))).collect();
                (engine.to_string(), serde_json::json!({ "version": "v1", "build": builds }))
            })
            .collect();
        std::fs::write(paths.dist.join("mango-engines.json"), serde_json::Value::Object(cat).to_string()).unwrap();
    }

    /// A CUDA 12 profile runs on its engine's build for the GTX 16 family where the PC's Turing cards are all of that
    /// family and the engine has that build; with an RTX 20 beside them, without a Turing card, or with an engine that
    /// has only the plain build, it runs on the one it names.
    #[test]
    fn a_cuda_12_profile_takes_the_engines_build_for_the_gtx_16_family() {
        let gtx1650 = || pc(vec![nvidia(0, "NVIDIA GeForce GTX 1650", 4096, (7, 5), (12, 6))], 16_384);
        let rtx3060 = || pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060", 12_288, (8, 6), (12, 6))], 32_768);
        let mixed = || pc(vec![nvidia(0, "NVIDIA GeForce RTX 2060", 6144, (7, 5), (12, 6)), nvidia(1, "NVIDIA GeForce GTX 1660", 6144, (7, 5), (12, 6))], 32_768);
        let (_d, paths) = dist_with(&[("general/3.6.json", profile_for_build("3.6", &["cuda-12"])), ("general/toq.json", profile_for_build("toq", &["cuda-12"]).replace("\"prism\"", "\"toq\""))]);
        let build = |model: &str, hw: Hardware| profile_for(&paths, model, &hw).unwrap().unwrap().build;

        engines(&paths, &[("prism", &["cuda-12", "cuda-12-gtx16"]), ("toq", &["cuda-12"])]);
        assert_eq!(build("3.6", three_gpus()), Build::Cuda12Gtx16);
        assert_eq!(build("3.6", gtx1650()), Build::Cuda12Gtx16);
        assert_eq!(build("3.6", mixed()), Build::Cuda12, "the RTX 20 would lose its tensor cores");
        assert_eq!(build("3.6", rtx3060()), Build::Cuda12);
        assert_eq!(build("toq", three_gpus()), Build::Cuda12, "the engine has no build for them");

        engines(&paths, &[("prism", &["cuda-12"])]);
        assert_eq!(build("3.6", three_gpus()), Build::Cuda12);
    }

    /// A profile says the GPUs or the builds, not both nor neither.
    #[test]
    fn a_profile_with_gpus_and_build_or_with_neither_is_damaged() {
        let both = profile_json("toq", &THREE).replace(r#""hardware": {"#, r#""hardware": { "build": ["cuda-12"],"#);
        let neither = profile_json("toq", &[]).replace(r#""gpus": []"#, "");
        for txt in [both, neither] {
            let (_d, paths) = dist_with(&[("three-gpus/toq.json", txt)]);
            let e = profile_for(&paths, "toq", &three_gpus()).unwrap_err().to_string();
            assert!(e.contains(&tr!("danneggiato", "damaged")) && e.contains("toq.json"), "{e}");
        }
    }

    #[test]
    fn a_damaged_profile_is_an_error() {
        let (_d, paths) = dist_with(&[("three-gpus/3.6.json", "{ not json".into())]);
        let e = profile_for(&paths, "3.6", &three_gpus()).unwrap_err().to_string();
        assert!(e.contains(&tr!("danneggiato", "damaged")) && e.contains("3.6.json"), "{e}");
    }
}
