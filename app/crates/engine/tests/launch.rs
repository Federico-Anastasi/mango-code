//! `mango-launch` end to end, on fake hardware (`--hardware`): the plan the terminal runs is the app's, for a PC
//! without a profile (CPU, one NVIDIA GPU, one AMD GPU) and for one that has the profile.
//! No engine is started; data and distribution belong to a temporary folder. The language is set to Italian in the
//! data folder, so the texts asserted below don't depend on the PC's language.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const LAUNCH: &str = env!("CARGO_BIN_EXE_mango-launch");

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    /// A distribution with a model without a profile (`small`), one that only runs on its own engine (`toq`) and
    /// `toq`'s profile for two GPUs; the engines and the weights are empty files where the app looks for them.
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().to_path_buf();
        let write = |rel: &str, text: &str| {
            let f = r.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, text).unwrap();
        };
        write("data/settings.json", r#"{ "language": "it" }"#);
        write(
            "dist/mango-models.json",
            &json!({
              "ctx": 131072, "default": "small", "order": ["small", "toq", "double"],
              "models": {
                "small": { "label": "Small model", "gguf": "small.gguf", "ctx": 262144,
                  "files": [ { "path": "small.gguf", "size": 2_740_937_888u64 } ],
                  "memory": { "kv_kib_token": 32, "state_mib": 53 } },
                "double": { "label": "Two variants", "gguf": "double-prism.gguf", "ctx": 262144,
                  "files": [ { "path": "double-official.gguf", "size": 2_000_000_000u64, "engine": "llamacpp" },
                             { "path": "double-prism.gguf", "size": 1_900_000_000u64, "engine": "prism" } ],
                  "memory": { "kv_kib_token": 32, "state_mib": 53 } },
                "toq": { "label": "TOQ", "gguf": "toq.gguf", "ctx": 262144, "requires_engine": "toq",
                  "files": [ { "path": "toq.gguf", "size": 9_489_952_128u64 } ],
                  "memory": { "kv_kib_token": 64, "state_mib": 150 } } } })
            .to_string(),
        );
        write("dist/mango-engines.json", r#"{ "llamacpp": { "version": "b1", "build": {} } }"#);
        write(
            "dist/profiles/test/toq.json",
            &json!({
              "id": "test/toq", "model": "toq", "engine": "toq", "build": "cuda-12",
              "hardware": { "gpus": ["NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce GTX 1080"] },
              "env": { "CUDA_VISIBLE_DEVICES": "0,1" },
              "args": ["-ngl", "999"], "ctx": 100000, "ub": 512,
              "measurements": { "date": "2026-10-30", "note": "trial" } })
            .to_string(),
        );
        for b in ["cpu", "vulkan", "cuda-12", "cuda-13"] {
            write(&format!("data/engine/llamacpp/b1-{b}/llama-server.exe"), "");
        }
        write("data/engine/toq/llama-server.exe", "");
        write("data/models/small.gguf", "");
        write("data/models/toq.gguf", "");
        write("data/models/double-official.gguf", "");
        Fixture { _dir: dir, root: r }
    }

    fn data(&self) -> PathBuf {
        self.root.join("data")
    }

    fn launch(&self, args: &[&str], hardware: &Value) -> Output {
        let f = self.root.join("hardware.json");
        std::fs::write(&f, hardware.to_string()).unwrap();
        Command::new(LAUNCH)
            .args(args)
            .args(["--hardware", f.to_str().unwrap()])
            .env("MANGO_DIST", self.root.join("dist"))
            .env("MANGO_DATA", self.data())
            .output()
            .unwrap()
    }

    fn plan(&self, model: &str, hardware: &Value) -> Value {
        let o = self.launch(&["plan", "--model", model, "--port", "9"], hardware);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        serde_json::from_slice(&o.stdout).unwrap()
    }
}

fn nvidia(index: u32, name: &str, mib: u64, cc: [u32; 2], driver: [u32; 2]) -> Value {
    json!({ "index": index, "name": name, "vendor": "nvidia", "memory_mib": mib, "cc": cc, "cuda_driver": driver })
}

fn pc(gpus: Vec<Value>, ram_mib: u64) -> Value {
    json!({ "gpus": gpus, "cpu": { "name": "Fake CPU", "cores": 8, "avx2": true, "avx512": false }, "ram_mib": ram_mib })
}

fn args_of(p: &Value) -> Vec<&str> {
    p["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect()
}

fn engine_dir(p: &Value) -> String {
    let exe = Path::new(p["executable"].as_str().unwrap());
    exe.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn without_gpus_the_model_runs_on_the_cpu_with_the_official_engine() {
    let b = Fixture::new();
    let p = b.plan("small", &pc(vec![], 16_384));
    assert_eq!(engine_dir(&p), "b1-cpu");
    let a = args_of(&p);
    assert!(a.windows(2).any(|w| w == ["-t", "8"]), "{a:?}");
    assert!(a.windows(2).any(|w| w[0] == "-m" && w[1].ends_with("small.gguf")), "{a:?}");
    assert!(a.windows(2).any(|w| w == ["--port", "9"]), "{a:?}");
    assert!(!a.contains(&"--cache-disk"), "the on-disk memory belongs to the profiles' engines: {a:?}");
    assert_eq!(p["context"], 131_072);
    assert_eq!((p["placement"].as_str(), p["gpus"].as_u64()), (Some("cpu"), Some(0)));
    // the official engine saves the conversation in a slot and restores it on resume
    assert_eq!(p["shutdown"]["url"], "http://127.0.0.1:9/slots/0?action=save");
    assert_eq!(p["startup"], Value::Null, "no saved conversation to restore");
    assert!(Path::new(p["workdir"].as_str().unwrap()).ends_with("logs"), "{p}");
}

#[test]
fn an_nvidia_gpu_without_a_profile_uses_cuda_12_and_sees_only_that_gpu() {
    let b = Fixture::new();
    let p = b.plan("small", &pc(vec![nvidia(0, "NVIDIA GeForce RTX 3060", 8192, [8, 6], [12, 6])], 32_768));
    assert_eq!(engine_dir(&p), "b1-cuda-12");
    assert_eq!(p["env"]["CUDA_VISIBLE_DEVICES"], "0");
    assert_eq!((p["placement"].as_str(), p["gpus"].as_u64()), (Some("gpu"), Some(1)));
    let a = args_of(&p);
    // all on the GPU: `-fit`, on by default, would move layers to RAM if memory weren't enough
    assert!(a.windows(2).any(|w| w == ["-fit", "off"]) && a.windows(2).any(|w| w == ["-ngl", "all"]), "{a:?}");
    // the f16 cache for 131072 tokens doesn't fit in 8 GB: q8_0
    assert!(a.windows(2).any(|w| w == ["-ctk", "q8_0"]), "{a:?}");
}

/// A GPU too small for the model: the terminal gets the plan entirely on the CPU, with the GPU build (already
/// downloaded) and no GPU visible; the list says where each model runs.
#[test]
fn with_a_gpu_too_small_the_terminal_runs_it_on_the_cpu() {
    let b = Fixture::new();
    let hw = pc(vec![nvidia(0, "NVIDIA GeForce GTX 1650", 4096, [7, 5], [12, 6])], 16_384);
    let p = b.plan("small", &hw);
    assert_eq!((engine_dir(&p).as_str(), p["placement"].as_str(), p["gpus"].as_u64()), ("b1-cuda-12", Some("cpu"), Some(0)));
    let a = args_of(&p);
    assert!(a.windows(2).any(|w| w == ["-dev", "none"]) && a.windows(2).any(|w| w == ["-t", "8"]) && !a.contains(&"-ngl"), "{a:?}");
    assert!(p["env"].as_object().unwrap().is_empty(), "{p}");

    let o = b.launch(&["models"], &hw);
    let m: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(m["models"][0]["placement"], "cpu", "{m}");
    assert_eq!(m["models"][1]["placement"], Value::Null, "toq doesn't run here: {m}");

    // Without enough memory, the terminal receives the sentence that says why and what to do.
    let o = b.launch(&["plan", "--model", "small"], &pc(vec![], 4096));
    let e = String::from_utf8_lossy(&o.stderr);
    assert!(!o.status.success() && e.contains("non ci sta in questo computer") && e.contains("Scegli un modello più piccolo"), "{e}");
}

/// The same sentences, in English when the language setting says so.
#[test]
fn the_error_sentences_follow_the_language_setting() {
    let b = Fixture::new();
    std::fs::write(b.data().join("settings.json"), r#"{ "language": "en" }"#).unwrap();
    let o = b.launch(&["plan", "--model", "small"], &pc(vec![], 4096));
    let e = String::from_utf8_lossy(&o.stderr);
    assert!(!o.status.success() && !e.contains("non ci sta") && e.contains("smaller model"), "{e}");
}

#[test]
fn a_model_with_two_variants_opens_the_one_of_the_engine_that_runs_it() {
    let b = Fixture::new();
    let p = b.plan("double", &pc(vec![], 16_384));
    let a = args_of(&p);
    assert!(a.windows(2).any(|w| w[0] == "-m" && w[1].ends_with("double-official.gguf")), "without a profile the engine is official llama.cpp: {a:?}");
}

#[test]
fn an_amd_gpu_uses_vulkan() {
    let b = Fixture::new();
    let amd = json!({ "index": 0, "name": "AMD Radeon RX 6700", "vendor": "amd", "memory_mib": 10240, "cc": null, "cuda_driver": null });
    let p = b.plan("small", &pc(vec![amd], 32_768));
    assert_eq!(engine_dir(&p), "b1-vulkan");
    assert!(p["env"].as_object().unwrap().is_empty(), "{p}");
}

#[test]
fn the_profile_applies_only_with_its_gpus_and_brings_its_engine() {
    let b = Fixture::new();
    let its_own = pc(
        vec![
            nvidia(0, "NVIDIA GeForce RTX 3060 Ti", 8192, [8, 6], [12, 6]),
            nvidia(1, "NVIDIA GeForce GTX 1080", 8192, [6, 1], [12, 6]),
        ],
        65_536,
    );
    let p = b.plan("toq", &its_own);
    assert_eq!(engine_dir(&p), "toq");
    assert_eq!(p["context"], 100_000);
    let a = args_of(&p);
    assert!(a.windows(2).any(|w| w[0] == "--cache-disk"), "the profiles' on-disk memory: {a:?}");
    assert!(a.windows(2).any(|w| w == ["-ub", "512"]), "{a:?}");
    assert_eq!(p["shutdown"]["url"], "http://127.0.0.1:9/slots/0?action=persist");

    // other GPUs: a model that only runs on its own engine doesn't start, and the terminal says so
    let o = b.launch(&["plan", "--model", "toq"], &pc(vec![], 16_384));
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("gira solo sul motore"), "{}", String::from_utf8_lossy(&o.stderr));
}

#[test]
fn the_users_models_and_profiles_are_in_the_plan_and_in_the_list() {
    let b = Fixture::new();
    std::fs::write(b.data().join("models").join("mine.gguf"), "").unwrap();
    std::fs::write(
        b.data().join("user-models.json"),
        json!({ "models": { "mine": { "label": "Mine", "gguf": "mine.gguf", "ctx": 32768,
            "files": [ { "path": "mine.gguf", "size": 1_000_000_000u64 } ], "memory": { "kv_kib_token": 16, "state_mib": 10 } } } }).to_string(),
    )
    .unwrap();
    let hw = pc(vec![], 16_384);
    let p = b.plan("mine", &hw);
    assert_eq!(p["label"], "Mine");
    assert_eq!(p["context"], 32_768);

    let o = b.launch(&["models"], &hw);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let m: Value = serde_json::from_slice(&o.stdout).unwrap();
    let keys: Vec<&str> = m["models"].as_array().unwrap().iter().map(|x| x["model"].as_str().unwrap()).collect();
    assert_eq!(keys, ["small", "toq", "double", "mine"], "first the recommended ones, then the user's");
    assert_eq!(m["default"], "small");
    // the recommended one that doesn't run on this PC says why; the others don't
    assert_eq!(m["models"][0]["missing"], Value::Null);
    assert!(m["models"][1]["missing"].as_str().unwrap().contains("gira solo sul motore"), "{m}");
    assert_eq!(m["models"][3]["context"], 32_768);
}

#[test]
fn an_unknown_model_or_one_without_weights_on_disk_is_a_readable_error() {
    let b = Fixture::new();
    let hw = pc(vec![], 16_384);
    let o = b.launch(&["plan", "--model", "does-not-exist"], &hw);
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("non è tra quelli"), "{}", String::from_utf8_lossy(&o.stderr));

    std::fs::remove_file(b.data().join("models").join("small.gguf")).unwrap();
    let o = b.launch(&["plan", "--model", "small"], &hw);
    assert!(!o.status.success() && String::from_utf8_lossy(&o.stderr).contains("non è sul disco"), "{}", String::from_utf8_lossy(&o.stderr));
}
