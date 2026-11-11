//! A fake distribution for tests: catalog, profile and (empty) files in a temporary folder.

use crate::catalog::{load_models, ModelsFile};
use crate::split::fixture::MAP_A;
use mango_common::Paths;
use serde_json::{json, Value};

pub(crate) struct Fake {
    pub _dir: tempfile::TempDir,
    pub paths: Paths,
    /// The content of mango-models.json.
    pub catalog: Value,
    /// The profile of `toq` (profiles/test/toq.json), or `Null` to not write it.
    pub profile: Value,
}

/// The catalog with the sole `toq` entry as it is today (without the tune, which lives in the profile).
fn toq_catalog() -> Value {
    json!({
      "ctx": 131072, "default": "toq", "order": ["toq"],
      "models": { "toq": {
        "label": "TOQ-v1", "gguf": "Qwen3.8-27B-TOQ-v1.gguf", "chat_template": "qwen3.8-mango.jinja",
        "ctx": 262144, "requires_engine": "toq",
        "files": [ { "path": "Qwen3.8-27B-TOQ-v1.gguf", "size": 9_489_952_128u64 } ],
        "memory": { "kv_kib_token": 64, "state_mib": 150 } } } })
}

/// The tune of `toq` on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER (with that hardware's specific env).
fn toq_profile() -> Value {
    json!({
      "id": "test/toq", "model": "toq", "engine": "toq", "build": "cuda-12",
      "hardware": { "gpus": ["NVIDIA GeForce RTX 3060 Ti", "NVIDIA GeForce GTX 1080", "NVIDIA GeForce GTX 1660 SUPER"] },
      "env": {
        "CUDA_VISIBLE_DEVICES": "0,2",
        "LLAMA_LAYER_DEVICES": MAP_A,
        "GGML_CUDA_GRAPHS_PRE_AMPERE": "1", "LLAMA_PREFILL_MAIN_MIN": "16" },
      "args": ["-ngl","999","-fa","1","-wgt","1","-sm","layer","-ctk","q8_0","-ctv","q8_0"],
      "ctx": 122880, "split": true, "ub": 512,
      "measurements": { "date": "2026-10-30", "note": "test" } })
}

impl Fake {
    /// The files are there (empty); the GGUF's content is supplied by the test.
    pub fn new() -> Fake {
        Fake::in_dir(tempfile::tempdir().unwrap())
    }

    /// Like `new`, in a folder whose name has letters the engines' command line does not carry (a user called José).
    pub fn with_accents() -> Fake {
        Fake::in_dir(tempfile::Builder::new().prefix("José Nicolò è ñ ").tempdir().unwrap())
    }

    fn in_dir(dir: tempfile::TempDir) -> Fake {
        let r = dir.path();
        let paths = Paths {
            dist: r.join("dist"),
            engines: r.join("engines"),
            models: r.join("models"),
            opencode: r.join("opencode"),
            data: r.join("data"),
        };
        for (d, f) in [
            (&paths.engines.join("toq"), "llama-server.exe"),
            (&paths.models, "Qwen3.8-27B-TOQ-v1.gguf"),
            (&paths.dist.join("chat-templates"), "qwen3.8-mango.jinja"),
        ] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join(f), b"").unwrap();
        }
        Fake { _dir: dir, paths, catalog: toq_catalog(), profile: toq_profile() }
    }

    /// A distribution without profiles with only Qwen3.5-4B (as in the real catalog) and official llama.cpp.
    pub fn small() -> Fake {
        let mut t = Fake::new();
        t.catalog = json!({
          "ctx": 131072, "default": "4b", "order": ["4b"],
          "models": { "4b": {
            "label": "Qwen3.5-4B", "gguf": "4b.gguf", "ctx": 262144,
            "files": [ { "path": "4b.gguf", "size": 2_740_937_888u64 } ],
            "memory": { "kv_kib_token": 32, "state_mib": 53 } } } });
        t.profile = Value::Null;
        std::fs::write(t.paths.models.join("4b.gguf"), b"").unwrap();
        t.llamacpp_installed();
        t
    }

    /// Official llama.cpp downloaded, for each build, where `mango_common::download` puts it.
    pub fn llamacpp_installed(&self) {
        std::fs::create_dir_all(&self.paths.dist).unwrap();
        std::fs::write(self.paths.dist.join("mango-engines.json"), r#"{ "llamacpp": { "version": "b12110", "build": {} } }"#).unwrap();
        for b in ["cpu", "vulkan", "cuda-12", "cuda-13"] {
            let d = self.paths.engines.join("llamacpp").join(format!("b12110-{b}"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("llama-server.exe"), b"").unwrap();
        }
    }

    /// Writes catalog and profile as they are now and rereads the catalog.
    pub fn save(&self) -> ModelsFile {
        self.write_and_load().unwrap()
    }

    /// Like `save`, but returns the catalog's error instead of stopping.
    pub fn write_and_load(&self) -> anyhow::Result<ModelsFile> {
        std::fs::create_dir_all(&self.paths.dist).unwrap();
        std::fs::write(self.paths.dist.join("mango-models.json"), self.catalog.to_string()).unwrap();
        if !self.profile.is_null() {
            let f = self.paths.dist.join("profiles").join("test").join("toq.json");
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, self.profile.to_string()).unwrap();
        }
        load_models(&self.paths)
    }

    /// The profile without the hand-written GPUs: the automatic plan chooses them.
    pub fn without_gpu_env(mut self) -> Fake {
        let env = self.profile["env"].as_object_mut().unwrap();
        env.remove("CUDA_VISIBLE_DEVICES");
        env.remove("LLAMA_LAYER_DEVICES");
        self
    }

    pub fn toq(&mut self) -> &mut Value {
        &mut self.catalog["models"]["toq"]
    }
}
