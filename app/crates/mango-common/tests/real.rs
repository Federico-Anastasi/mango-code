//! Tests against the real network (GitHub and Hugging Face) and the catalog's real files: they weigh hundreds of
//! MB, so run them by hand:
//! `cargo test -p mango-common --test real -- --ignored --test-threads=1`
//!
//! They load no model: `--version` loads no backend; installing a CUDA build also asks the engine for its GPUs
//! (`--list-devices`).

use mango_common::download::{install_model, install_engine, installed_engine, download_stoppable, sha256_file, RemoteFile};
use mango_common::{Build, Paths};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

fn launcher() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap()
}

/// An empty temporary folder for this test.
fn folder(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mango-real-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn paths(dist: &Path, base: &Path) -> Paths {
    Paths { dist: dist.to_path_buf(), engines: base.join("engines"), models: base.join("models"), opencode: base.join("opencode"), data: base.join("data") }
}

fn engine_catalog() -> Value {
    serde_json::from_str(&fs::read_to_string(launcher().join("mango-engines.json")).unwrap()).unwrap()
}

fn catalog_file(v: &Value) -> RemoteFile {
    RemoteFile { url: v["url"].as_str().unwrap().into(), size: v["size"].as_u64().unwrap(), sha256: v["sha256"].as_str().unwrap().into() }
}

#[test]
#[ignore = "downloads ~60 MB from GitHub"]
fn the_cpu_and_vulkan_builds_install_and_start() {
    let base = folder("cpu-vulkan");
    let p = paths(&launcher(), &base);
    let version = engine_catalog()["llamacpp"]["version"].as_str().unwrap().to_string();
    for build in [Build::Cpu, Build::Vulkan] {
        assert_eq!(installed_engine(&p, "llamacpp", build), None);
        let mut last = (0, 0);
        let dir = install_engine(&p, "llamacpp", build, &AtomicBool::new(false), &mut |a, t| last = (a, t)).unwrap();
        assert_eq!(dir, p.engines.join("llamacpp").join(format!("{version}-{build}")));
        assert_eq!(last.0, last.1);
        assert!(last.1 > 20_000_000, "{last:?}");
        assert_eq!(installed_engine(&p, "llamacpp", build), Some(dir.clone()));

        let out = Command::new(dir.join("llama-server.exe")).arg("--version").current_dir(&dir).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success() && text.contains(&format!("build {}", version.trim_start_matches('b'))), "{text}");
        println!("{build}: {}", text.lines().next().unwrap_or_default());
    }
    // the second time it doesn't download again
    assert!(install_engine(&p, "llamacpp", Build::Cpu, &AtomicBool::new(false), &mut |_, _| panic!("downloaded again")).is_ok());
    let _ = fs::remove_dir_all(&base);
}

#[test]
#[ignore = "downloads ~1.3 GB from GitHub"]
fn the_cuda_12_and_13_files_have_the_catalog_size_and_hash() {
    let base = folder("cuda");
    let cat = engine_catalog();
    for build in ["cuda-12", "cuda-13"] {
        let b = &cat["llamacpp"]["build"][build];
        for (name, v) in [("build", b), ("runtime", &b["runtime"])] {
            let f = catalog_file(v);
            let dest = base.join(format!("{build}-{name}.zip"));
            download_stoppable(&f, &dest, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
            assert_eq!(fs::metadata(&dest).unwrap().len(), f.size, "{build} {name}");
            assert_eq!(sha256_file(&dest).unwrap(), f.sha256, "{build} {name}");
            fs::remove_file(&dest).unwrap();
        }
    }
    let _ = fs::remove_dir_all(&base);
}

/// The engines of our forks, every build of the catalog: installed from the release's zips, then `--version`.
/// For CUDA 12 the install also brings the runtime and, where the catalog asks for it, checks that the engine sees a
/// GPU: it needs an NVIDIA card.
#[test]
#[ignore = "downloads ~1.5 GB from GitHub; CUDA 12 needs an NVIDIA GPU"]
fn the_forked_engines_install_and_start() {
    let base = folder("forks");
    let p = paths(&launcher(), &base);
    for (engine, builds) in [("prism", &[Build::Cpu, Build::Vulkan, Build::Cuda12, Build::Cuda12Gtx16][..]), ("toq", &[Build::Cpu, Build::Vulkan, Build::Cuda12])] {
        for &build in builds {
            let dir = install_engine(&p, engine, build, &AtomicBool::new(false), &mut |_, _| {}).unwrap_or_else(|e| panic!("{engine} {build}: {e:#}"));
            let out = Command::new(dir.join("llama-server.exe")).arg("--version").current_dir(&dir).output().unwrap();
            let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success(), "{engine} {build}: {text}");
            println!("{engine} {build}: {}", text.lines().next().unwrap_or_default());
        }
    }
    let _ = fs::remove_dir_all(&base);
}

/// This PC's driver (560.94) supports CUDA 12.6: the CUDA 13 build downloads and extracts, but the engine sees
/// no GPU and the install says so. On a PC with a newer driver this test makes no sense.
#[test]
#[ignore = "downloads ~170 MB from GitHub; only valid with an NVIDIA driver that doesn't support CUDA 13"]
fn cuda_13_with_an_old_driver_does_not_install_and_the_error_says_so() {
    let base = folder("cuda13");
    let p = paths(&launcher(), &base);

    let err = format!("{:#}", install_engine(&p, "llamacpp", Build::Cuda13, &AtomicBool::new(false), &mut |_, _| {}).unwrap_err());

    println!("{err}");
    assert!(err.contains(&mango_common::tr!("non vede nessuna scheda", "sees no GPU")) && err.contains("cuda-13"), "{err}");
    assert_eq!(installed_engine(&p, "llamacpp", Build::Cuda13), None);
    let _ = fs::remove_dir_all(&base);
}

/// `install_model` against the real Hugging Face, with a fake 885 KB model (Silero VAD).
#[test]
#[ignore = "downloads 885 KB from Hugging Face"]
fn a_model_downloads_from_hugging_face_and_then_does_not_download_again() {
    let base = folder("model");
    let dist = base.join("dist");
    fs::create_dir_all(&dist).unwrap();
    fs::write(
        dist.join("mango-models.json"),
        r#"{ "models": { "vad": { "repo": "ggml-org/whisper-vad", "revision": "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
            "files": [ { "path": "vad/ggml-silero-v5.1.2.bin", "size": 885098,
                         "sha256": "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf" } ] } } }"#,
    )
    .unwrap();
    let p = paths(&dist, &base);

    install_model(&p, "vad", "llamacpp", &AtomicBool::new(false), &mut |_, _| {}).unwrap();

    let f = p.models.join("vad").join("ggml-silero-v5.1.2.bin");
    assert_eq!(sha256_file(&f).unwrap(), "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf");
    install_model(&p, "vad", "llamacpp", &AtomicBool::new(false), &mut |_, _| panic!("downloaded again")).unwrap();
    let _ = fs::remove_dir_all(&base);
}
