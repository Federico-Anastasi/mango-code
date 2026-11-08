//! `mango-tune` end to end, with the fake engine instead of `llama-server` (no GPUs): a trial, its variation
//! compared with the base, the base repeated (the noise), an engine that does not start, the log and the profile.
//! The language is set to English in the data folder, so the engine messages asserted below don't depend on the
//! PC's language.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const TUNE: &str = env!("CARGO_BIN_EXE_mango-tune");
const FAKE: &str = env!("CARGO_BIN_EXE_fake-engine");

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    /// A folder with an "engine" (the fake one, called `llama-server.exe`), a "model", a text and the log.
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().to_path_buf();
        std::fs::create_dir_all(r.join("engines").join("llamacpp").join("b1-cpu")).unwrap();
        std::fs::copy(FAKE, r.join("engines").join("llamacpp").join("b1-cpu").join("llama-server.exe")).unwrap();
        std::fs::write(r.join("model.gguf"), b"").unwrap();
        std::fs::write(r.join("settings.json"), r#"{ "language": "en" }"#).unwrap();
        // a text of arbitrary words, long enough for the largest points
        std::fs::write(r.join("text.md"), "word ".repeat(30_000)).unwrap();
        Fixture { _dir: dir, root: r }
    }

    fn engine(&self) -> PathBuf {
        self.root.join("engines").join("llamacpp").join("b1-cpu")
    }

    fn log_file(&self) -> PathBuf {
        self.root.join("log.jsonl")
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut c = Command::new(TUNE);
        c.args(args).env("MANGO_DATA", &self.root);
        for (k, v) in env {
            c.env(k, v);
        }
        c.output().unwrap()
    }

    /// A trial with the fake engine: points 100, 400 and 1k, 8 tokens per point.
    fn trial(&self, extra: &[&str], env: &[(&str, &str)]) -> Output {
        let (engine, model, text, log_file) = (self.engine(), self.root.join("model.gguf"), self.root.join("text.md"), self.log_file());
        let mut a: Vec<&str> = vec!["trial", "--text", text.to_str().unwrap(), "--log", log_file.to_str().unwrap(), "--points", "100,400,1k", "--token", "8"];
        let (m, g) = (engine.to_str().unwrap().to_string(), model.to_str().unwrap().to_string());
        if !extra.contains(&"--base") {
            a.extend(["--engine", &m, "--model", &g]);
        }
        a.extend(extra);
        self.run(&a, env)
    }
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

fn lines(b: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(b.log_file()).unwrap().lines().map(|r| serde_json::from_str(r).unwrap()).collect()
}

#[test]
fn a_trial_a_variation_and_the_profile() {
    let b = Fixture::new();

    // 1. the base: three points measured, written to the log
    let o = b.trial(&["--name", "base", "--", "-c", "4096", "-ngl", "0", "-ctk", "q8_0", "-ub", "256"], &[("FAKE_ENGINE_DECODE_TOK_S", "10")]);
    assert!(o.status.success(), "{}", text(&o));
    let t = text(&o);
    assert!(t.contains("trial 1: base (ok)") && t.contains("100: prefill 1000 tok/s") && t.contains("1k: prefill 1000 tok/s") && t.contains("decode 10.0 tok/s"), "{t}");
    let r = lines(&b);
    assert_eq!((r.len(), r[0]["n"].as_u64(), r[0]["outcome"].as_str()), (1, Some(1), Some("ok")));
    assert_eq!(r[0]["points"].as_array().unwrap().len(), 3);
    assert_eq!(r[0]["ctx"], 4096);

    // 2. a variation (decode goes to 13): compared with the base, noise not yet known
    let o = b.trial(&["--base", "1", "--name", "fast", "--change", "-ctk f16"], &[("FAKE_ENGINE_DECODE_TOK_S", "13")]);
    let t = text(&o);
    assert!(o.status.success(), "{t}");
    assert!(t.contains("-ctk f16") && t.contains("compared with trial 1 (noise 5%, assumed"), "{t}");
    assert!(t.contains("100: prefill +0% (same), decode +30% (better)"), "{t}");
    assert_eq!(lines(&b)[1]["tune"]["args"], serde_json::json!(["-c", "4096", "-ngl", "0", "-ctk", "f16", "-ub", "256"]));

    // 3. the base repeated (decode 10.2): now the noise is known and is 2%
    let o = b.trial(&["--base", "1", "--name", "repeat"], &[("FAKE_ENGINE_DECODE_TOK_S", "10.2")]);
    let t = text(&o);
    assert!(o.status.success() && t.contains("measured noise 2%"), "{t}");
    assert_eq!(lines(&b)[2]["change"], serde_json::json!(["repeat"]));
    // 4. and the variation is judged with the real noise
    let o = b.trial(&["--base", "1", "--name", "almost-same", "--env", "X=1"], &[("FAKE_ENGINE_DECODE_TOK_S", "10.3")]);
    let t = text(&o);
    assert!(t.contains("(noise 2%)") && t.contains("decode +3% (better)"), "{t}");

    // 4b. without --points or --token a variation measures like its base
    let (text_file, log_file) = (b.root.join("text.md"), b.log_file());
    let o = b.run(&["trial", "--base", "1", "--name", "inherits", "--text", text_file.to_str().unwrap(), "--log", log_file.to_str().unwrap()], &[]);
    assert!(o.status.success(), "{}", text(&o));
    let r = lines(&b);
    let last = r.last().unwrap();
    let points: Vec<&str> = last["points"].as_array().unwrap().iter().map(|p| p["point"].as_str().unwrap()).collect();
    assert_eq!((points, last["token"].as_u64()), (vec!["100", "400", "1k"], Some(8)));

    // the log
    let o = b.run(&["log", "--log", log_file.to_str().unwrap()], &[]);
    let t = text(&o);
    assert!(o.status.success() && t.contains("fast") && t.contains("repeat") && t.contains("100 1000/13.0"), "{t}");

    // 5. the fast variation's profile: contract format, plan arguments removed
    let out_dir = b.root.join("profiles");
    let o = b.run(&["profile", "--from", "2", "--model", "small", "--id", "test/small", "--gpus", "", "--out", out_dir.to_str().unwrap(), "--log", log_file.to_str().unwrap()], &[]);
    assert!(o.status.success(), "{}", text(&o));
    let j: Value = serde_json::from_str(&std::fs::read_to_string(out_dir.join("test-small.json")).unwrap()).unwrap();
    assert_eq!((j["engine"].as_str(), j["build"].as_str(), j["model"].as_str()), (Some("llamacpp"), Some("cpu"), Some("small")));
    assert_eq!((j["ctx"].as_u64(), j["ub"].as_u64()), (Some(4096), Some(256)));
    assert_eq!(j["args"], serde_json::json!(["-ngl", "0", "-ctk", "f16"]));
    assert_eq!(j["hardware"]["gpus"], serde_json::json!([]));
    assert_eq!(j["measurements"]["decode_tok_s"], 13.0);
}

#[test]
fn an_engine_that_does_not_start_ends_up_in_the_log_with_the_reason() {
    let b = Fixture::new();
    // an executable that exits at once, instead of the engine
    let broken = b.root.join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::copy(Path::new(&std::env::var("SystemRoot").unwrap()).join("System32").join("hostname.exe"), broken.join("llama-server.exe")).unwrap();
    let (model, text_file, log_file) = (b.root.join("model.gguf"), b.root.join("text.md"), b.log_file());
    let o = b.run(
        &["trial", "--engine", broken.to_str().unwrap(), "--model", model.to_str().unwrap(), "--text", text_file.to_str().unwrap(), "--log", log_file.to_str().unwrap(), "--points", "100", "--", "-c", "4096"],
        &[],
    );
    let t = text(&o);
    assert!(!o.status.success() && t.contains("does not start") && t.contains("closed right away"), "{t}");
    let r = lines(&b);
    assert_eq!((r[0]["outcome"].as_str(), r[0]["points"].as_array().map(Vec::len)), (Some("does not start"), Some(0)));
    assert!(r[0]["error"].as_str().unwrap().contains("closed right away"));
    // from the failed trial one doesn't start, and its profile isn't written
    let o = b.trial(&["--base", "1"], &[]);
    assert!(!o.status.success() && text(&o).contains("did not succeed"), "{}", text(&o));
    let o = b.run(&["profile", "--from", "1", "--model", "x", "--log", log_file.to_str().unwrap(), "--out", b.root.to_str().unwrap()], &[]);
    assert!(!o.status.success() && text(&o).contains("did not succeed"), "{}", text(&o));
}

#[test]
fn usage_errors_say_what_to_fix() {
    let b = Fixture::new();
    // without -c we don't know how far to measure
    let o = b.trial(&["--", "-ngl", "0"], &[]);
    assert!(!o.status.success() && text(&o).contains("lack -c"), "{}", text(&o));
    // a point larger than the context
    let o = b.trial(&["--points", "8k", "--", "-c", "4096"], &[]);
    assert!(!o.status.success() && text(&o).contains("does not fit in -c 4096"), "{}", text(&o));
    // a variation without a base
    let o = b.trial(&["--change", "-ctk f16", "--", "-c", "4096"], &[]);
    assert!(!o.status.success() && text(&o).contains("needs --base"), "{}", text(&o));
    // nothing was written to the log
    assert!(!b.log_file().exists());
}
