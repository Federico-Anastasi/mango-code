//! The image manager with the real engine and a real model, on one graphics card of this computer. By hand:
//! `cargo test -p images --test real -- --ignored --nocapture`
//! - `MANGO_TEST_GPU`: the card, by its PCI index (the one `nvidia-smi` shows);
//! - `MANGO_TEST_MODELS`: a models folder that has the model's files at the catalog's paths;
//! - `MANGO_TEST_IMAGE_MODEL`: the catalog key (default `z-image-turbo`); `MANGO_TEST_IMAGE_SIDE`: the side (default 512).
//! The engine is downloaded from the catalog into a temporary folder (about 370 MB, plus the CUDA libraries if the
//! computer lacks them), where the picture stays; the folder's path is printed.

use engine::EngineManager;
use images::{Cancelled, ImageManager, Request, Stage};
use mango_common::{Build, Paths};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn used_mib(card: u32) -> u64 {
    engine_cfg::gpu_memory().into_iter().find(|m| m.0 == card).map_or(0, |m| m.1)
}

#[test]
#[ignore = "downloads ~370 MB from GitHub, needs an NVIDIA GPU and a model on disk (MANGO_TEST_GPU, MANGO_TEST_MODELS)"]
fn a_picture_is_made_and_one_is_stopped_on_a_real_card() {
    let card: u32 = std::env::var("MANGO_TEST_GPU").expect("MANGO_TEST_GPU").parse().unwrap();
    let key = std::env::var("MANGO_TEST_IMAGE_MODEL").unwrap_or_else(|_| "z-image-turbo".into());
    let side: u32 = std::env::var("MANGO_TEST_IMAGE_SIDE").map_or(512, |s| s.parse().unwrap());
    let base = std::env::temp_dir().join(format!("mango-real-images-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let paths = Paths {
        dist: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap(),
        engines: base.join("engines"),
        models: PathBuf::from(std::env::var_os("MANGO_TEST_MODELS").expect("MANGO_TEST_MODELS")),
        opencode: base.join("opencode"),
        data: base.join("data"),
    };
    mango_common::download::install_engine(&paths, "sd", Build::Cuda12, &AtomicBool::new(false), &mut |_, _| {}).unwrap();

    // The computer with that card alone: the plan draws there.
    let mut hw = engine_cfg::detect().unwrap();
    hw.gpus.retain(|g| g.index == card);
    assert_eq!(hw.gpus.len(), 1, "no card {card} here");
    println!("card {card}: {}, {} MiB in use before", hw.gpus[0].name, used_mib(card));
    let engine = EngineManager::new(Box::new(|key, _, _| anyhow::bail!("no model that writes in this test ({key})")), Box::new(engine_cfg::gpu_memory), &base);
    let p = paths.clone();
    let m = ImageManager::new(Box::new(move |key, port| engine_cfg::image_plan_for(&p, key, port, &hw)), images::lender(engine.clone()), &base);
    let request = Request { model: key.clone(), prompt: "a red vespa parked in front of the Colosseum, photograph".into(), width: side, height: side, seed: Some(42), stay_on: true };

    let (mut told, mut previews, mut peak) = (Vec::new(), 0, 0);
    let picture = m
        .generate(&request, &AtomicBool::new(false), &mut |p| {
            told.push(format!("{:?} {}/{} at {} s", p.stage, p.step, p.steps, p.seconds));
            previews += usize::from(p.preview.is_some());
            peak = peak.max(used_mib(card));
            if p.stage == Stage::Drawing {
                assert_eq!(engine.state().released, [card], "the card is on loan while the picture is drawn");
            }
        })
        .unwrap();
    let after: Vec<u64> = (0..6).map(|i| (std::thread::sleep(Duration::from_millis(if i == 0 { 0 } else { 500 })), used_mib(card)).1).collect();
    println!("{key} at {side}: {:.1} s, seed {}, {} previews, peak {peak} MiB", picture.seconds, picture.seed, previews);
    println!("  {}", told.join("\n  "));
    println!("  memory in use on the card when the picture is back, then every half second: {after:?} MiB");

    let file = base.join("picture.png");
    std::fs::write(&file, &picture.png).unwrap();
    assert_eq!(&picture.png[..8], b"\x89PNG\r\n\x1a\n");
    let number = |at: usize| u32::from_be_bytes(picture.png[at..at + 4].try_into().unwrap());
    assert_eq!((number(16), number(20), picture.seed), (side, side, 42));
    assert!(picture.png.len() > 50_000, "{} bytes: a flat picture?", picture.png.len());
    assert!(previews > 0 && told.iter().any(|t| t.starts_with("Drawing")));
    println!("  {}", file.display());

    // The engine stayed on: the next picture finds the model loaded. Then a single picture stops it.
    assert_eq!(m.loaded().as_deref(), Some(key.as_str()));
    let again = m.generate(&Request { seed: Some(7), ..request.clone() }, &AtomicBool::new(false), &mut |_| {}).unwrap();
    println!("second picture with the engine on: {:.1} s; {} MiB on the card after it", again.seconds, used_mib(card));
    let single = m.generate(&Request { seed: Some(8), stay_on: false, ..request.clone() }, &AtomicBool::new(false), &mut |_| {}).unwrap();
    println!("a single picture, the engine stopped after it: {:.1} s; {} MiB on the card after it", single.seconds, used_mib(card));
    assert!(m.loaded().is_none());

    // A picture stopped at its second step: it ends within a moment, and the card is given back.
    let stop = AtomicBool::new(false);
    let stopped = std::sync::Arc::new(std::sync::Mutex::new(None));
    let at = stopped.clone();
    let e = m
        .generate(&request, &stop, &mut |p| {
            if p.stage == Stage::Drawing && p.step >= 2 && at.lock().unwrap().is_none() {
                *at.lock().unwrap() = Some(Instant::now());
                stop.store(true, Ordering::SeqCst);
            }
        })
        .unwrap_err();
    let took = stopped.lock().unwrap().expect("it reached the second step").elapsed();
    assert!(e.is::<Cancelled>(), "{e:#}");
    assert!(took < Duration::from_secs(3), "{took:?}");
    let after: Vec<u64> = (0..6).map(|i| (std::thread::sleep(Duration::from_millis(if i == 0 { 0 } else { 500 })), used_mib(card)).1).collect();
    println!("stopped in {took:.1?}; memory in use on the card after, every half second: {after:?} MiB");
    assert!(m.loaded().is_none(), "a picture that was stopped leaves no engine on");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !engine.state().loans.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(engine.state().loans.is_empty(), "the card went back");
    let _ = std::fs::remove_dir_all(base.join("engines"));
}

/// Stops what the test started, also when it fails halfway: nothing is left on the card.
struct Cleanup(EngineManager, String);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = call("POST", &format!("{}/control/image/unload", self.1), None);
        self.0.stop();
    }
}

struct Pictures(images::routes::Routes);

impl engine::http::Control for Pictures {
    fn handle(&self, method: &str, path: &str, body: &[u8]) -> (u16, serde_json::Value) {
        self.0.handle(method, path, body).unwrap_or((404, serde_json::Value::Null))
    }
}

fn call(method: &str, url: &str, body: Option<serde_json::Value>) -> (u16, serde_json::Value) {
    let agent = mango_common::internet::agent_with_replies(url, Duration::from_secs(600));
    let mut reply = match (method, body) {
        ("POST", Some(body)) => agent.post(url).header("Content-Type", "application/json").send(body.to_string()),
        ("POST", None) => agent.post(url).send_empty(),
        _ => agent.get(url).call(),
    }
    .unwrap_or_else(|e| panic!("{method} {url}: {e}"));
    let text = reply.body_mut().with_config().limit(256 << 20).read_to_string().unwrap();
    (reply.status().as_u16(), serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)))
}

/// The two managers together on one card, as in the app: a model that writes is running there, a picture is asked
/// over the routes, the model is put aside while the picture is drawn and comes back by itself, with its conversation.
/// Then the same with the image engine left on, which holds some memory on the card the model counts on.
/// - `MANGO_TEST_GPU`, `MANGO_TEST_MODELS` as above, with the files of the model that writes too;
/// - `MANGO_TEST_ENGINES`: an engines folder with `sd` and `llamacpp` installed for CUDA 12;
/// - `MANGO_TEST_MODEL`: the model that writes (default `ling`).
#[test]
#[ignore = "needs an NVIDIA GPU, the engines and the models on disk (MANGO_TEST_GPU, MANGO_TEST_ENGINES, MANGO_TEST_MODELS)"]
fn a_model_that_writes_is_put_aside_for_a_picture_and_comes_back() {
    use serde_json::json;
    let card: u32 = std::env::var("MANGO_TEST_GPU").expect("MANGO_TEST_GPU").parse().unwrap();
    let writer = std::env::var("MANGO_TEST_MODEL").unwrap_or_else(|_| "ling".into());
    let base = std::env::temp_dir().join(format!("mango-real-two-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let paths = Paths {
        dist: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher").canonicalize().unwrap(),
        engines: PathBuf::from(std::env::var_os("MANGO_TEST_ENGINES").expect("MANGO_TEST_ENGINES")),
        models: PathBuf::from(std::env::var_os("MANGO_TEST_MODELS").expect("MANGO_TEST_MODELS")),
        opencode: base.join("opencode"),
        data: base.join("data"),
    };
    let mut hw = engine_cfg::detect().unwrap();
    hw.gpus.retain(|g| g.index == card);
    assert_eq!(hw.gpus.len(), 1, "no card {card} here");

    // The managers as the app builds them, on a computer that has that card alone.
    let (p, h) = (paths.clone(), hw.clone());
    let engine = EngineManager::new(Box::new(move |key, port, excluded| engine_cfg::plan_for(&p, Some(key), port, &h, excluded)), Box::new(engine_cfg::gpu_memory), &base);
    let (p, h) = (paths.clone(), hw.clone());
    engine.set_room_check(Box::new(move |key, lent, used| engine_cfg::taken_before_start(&p, &h, used, key, lent)));
    let (p, h) = (paths.clone(), hw.clone());
    let pictures = ImageManager::new(Box::new(move |key, port| engine_cfg::image_plan_for(&p, key, port, &h)), images::lender(engine.clone()), &base);
    let (p, h) = (paths.clone(), hw.clone());
    let routes = images::routes::Routes::new(pictures, Box::new(move || Ok(serde_json::to_value(engine_cfg::image_models(&p, &h)?)?)));
    let port = mango_common::random_port().unwrap();
    engine::http::serve(engine.clone(), port, Some(std::sync::Arc::new(Pictures(routes)))).unwrap();
    let url = format!("http://127.0.0.1:{port}");
    let _cleanup = Cleanup(engine.clone(), url.clone());

    let chat = |said: &str| {
        let start = Instant::now();
        let (status, reply) = call("POST", &format!("{url}/v1/chat/completions"), Some(json!({ "model": writer, "max_tokens": 300, "messages": [{ "role": "user", "content": said }] })));
        assert_eq!(status, 200, "{reply}");
        println!("  the model answers in {:.1} s ({} MiB on the card)", start.elapsed().as_secs_f64(), used_mib(card));
    };
    let picture = |stay_on: bool| {
        let (status, job) = call("POST", &format!("{url}/control/image/generate"), Some(json!({ "prompt": "a red vespa parked in front of the Colosseum, photograph", "width": 512, "height": 512, "seed": 42, "stay_on": stay_on })));
        assert_eq!(status, 202, "{job}");
        let id = job["id"].as_str().unwrap().to_string();
        let mut lent = false;
        let done = loop {
            std::thread::sleep(Duration::from_millis(500));
            let job = call("GET", &format!("{url}/control/image/jobs/{id}"), None).1;
            if job["status"] == "drawing" && !lent {
                let state = call("GET", &format!("{url}/engine"), None).1;
                assert_eq!((state["phase"].as_str(), state["released_gpus"][0].as_u64(), state["loans"][0]["who"].as_str()), (Some("released"), Some(u64::from(card)), Some("Mango Code: image")), "{state}");
                lent = true;
            }
            if ["done", "failed", "cancelled"].contains(&job["status"].as_str().unwrap()) {
                break job;
            }
        };
        assert_eq!(done["status"], "done", "{done}");
        assert!(lent, "the card was on loan while the picture was drawn");
        let (status, got) = call("GET", &format!("{url}/control/image/jobs/{id}/picture"), None);
        assert!(status == 200 && got["png"].as_str().unwrap().len() > 60_000);
        println!("  picture in {} s, seed {}", done["seconds"], done["seed"]);
        // the model that was put aside comes back by itself
        let start = Instant::now();
        loop {
            let state = call("GET", &format!("{url}/engine"), None).1;
            if state["phase"] == "running" {
                break println!("  the model is back {:.1} s after the picture ({} MiB on the card)", start.elapsed().as_secs_f64(), used_mib(card));
            }
            assert!(state["failed"].is_null() && state["phase"] != "error", "the model did not come back: {state}");
            assert!(start.elapsed() < Duration::from_secs(180), "the model does not come back: {state}");
            std::thread::sleep(Duration::from_millis(500));
        }
    };

    println!("card {card}: {}, {} MiB in use before", hw.gpus[0].name, used_mib(card));
    chat("Rispondi solo con la parola: pronto");
    println!("a single picture");
    picture(false);
    assert_eq!(call("GET", &format!("{url}/control/image"), None).1["loaded"], serde_json::Value::Null);
    chat("Che parola ti ho chiesto di dire prima? Rispondi solo con quella.");
    println!("a picture of a conversation about images: the image engine stays on");
    picture(true);
    assert_eq!(call("GET", &format!("{url}/control/image"), None).1["loaded"], "z-image-turbo");
    chat("Dimmi ancora quella parola.");
    let (status, state) = call("POST", &format!("{url}/control/image/unload"), None);
    assert_eq!((status, &state["loaded"]), (200, &serde_json::Value::Null));
    std::thread::sleep(Duration::from_secs(1));
    println!("after the unload: {} MiB on the card", used_mib(card));
}
