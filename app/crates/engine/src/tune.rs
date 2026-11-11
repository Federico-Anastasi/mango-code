//! The log of a tune's trials (engine, model, arguments, variables) and the profile derived from it.
//!
//! A trial is a tune started and measured at several context lengths. The log is a JSON file with one line per
//! trial, numbered: every variation is compared with the trial it starts from (`base`) and the measurement noise
//! is estimated from trials repeated with the same tune. The profile (`profiles/<id>.json`) is written from a
//! successful trial.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

/// How much a measurement may differ from itself when we haven't measured its noise yet.
pub const ASSUMED_NOISE: f64 = 0.05;

/// A tune: what is started and with which arguments. Without `-m` and `--port`, which the tool adds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tune {
    /// The folder with `llama-server.exe`.
    pub engine: String,
    /// The GGUF file.
    pub model: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasuredPoint {
    pub point: String,
    pub prefill_tok: u64,
    pub prefill_tok_s: f64,
    pub decode_tok: u64,
    pub decode_tok_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trial {
    pub n: u32,
    pub when: String,
    pub name: String,
    /// The trial it starts from, if this one is a variation.
    pub base: Option<u32>,
    /// What changed from the base, in words (`-ctk f16`, `remove -fa`, `env X=1`).
    pub change: Vec<String>,
    pub tune: Tune,
    /// `ok`, `does not start` (the engine closed or didn't answer) or `error` (a measurement failed).
    pub outcome: String,
    pub error: Option<String>,
    /// The context it was started with (`-c`).
    pub ctx: u32,
    /// Tokens written at each point.
    pub token: u32,
    pub points: Vec<MeasuredPoint>,
    /// Extra memory the engine holds on each GPU (MiB, in PCI order) once measurements are done; empty without NVIDIA GPUs.
    pub memory_mib: Vec<u64>,
}

impl Trial {
    pub fn succeeded(&self) -> bool {
        self.outcome == "ok" && !self.points.is_empty()
    }

    /// A profile is written only for a tune that has run.
    pub fn require_success(&self) -> Result<()> {
        if !self.succeeded() {
            bail!("trial {} did not succeed ({}): a profile is written only for a tune that has run", self.n, self.outcome);
        }
        Ok(())
    }
}

/// The value of `-c` / `--ctx-size` in the arguments: without it, we don't know how much context the engine has and
/// can't tell whether a measurement point fits.
pub fn ctx_from_args(args: &[String]) -> Result<u32> {
    let v = args
        .windows(2)
        .find(|w| w[0] == "-c" || w[0] == "--ctx-size")
        .map(|w| w[1].as_str())
        .context("the arguments lack -c (the context, for example -c 8192): it is needed to know how far to measure")?;
    v.parse().with_context(|| format!("-c {v}: the context is a number of tokens"))
}

/// The token after `args[i]` is its value (not another flag; a negative number is a value).
fn has_value(args: &[String], i: usize) -> bool {
    args.get(i + 1).is_some_and(|v| !v.starts_with('-') || v.parse::<f64>().is_ok())
}

/// Applies a variation to `base`. `change`: `"-ctk f16"` (changes the value if the flag is there, otherwise adds it)
/// or `"-fa"` (a flag without value, added if missing); `remove`: flags to remove with their value; `env`: `K=V`
/// (`K=` removes the variable). Returns the new tune and its description in words.
pub fn apply(base: &Tune, change: &[String], remove: &[String], env: &[String]) -> Result<(Tune, Vec<String>)> {
    let mut a = base.clone();
    let mut descr = Vec::new();
    for c in change {
        let (flag, value) = match c.trim().split_once(' ') {
            Some((f, v)) => (f.trim(), Some(v.trim())),
            None => (c.trim(), None),
        };
        if !flag.starts_with('-') {
            bail!("--change «{c}»: it must start with a flag, for example \"-ctk f16\"");
        }
        match (a.args.iter().position(|x| x == flag), value) {
            (Some(i), Some(v)) if has_value(&a.args, i) => a.args[i + 1] = v.to_string(),
            (Some(i), Some(v)) => a.args.insert(i + 1, v.to_string()),
            (Some(_), None) => {} // already on: the variation changes nothing, and the comparison will show it
            (None, v) => {
                a.args.push(flag.to_string());
                a.args.extend(v.map(str::to_string));
            }
        }
        descr.push(c.trim().to_string());
    }
    for flag in remove {
        let i = a.args.iter().position(|x| x == flag).with_context(|| format!("--remove {flag}: the flag is not in the base's arguments"))?;
        let n = if has_value(&a.args, i) { 2 } else { 1 };
        a.args.drain(i..i + n);
        descr.push(format!("remove {flag}"));
    }
    for e in env {
        let (k, v) = e.split_once('=').with_context(|| format!("--env «{e}»: write NAME=value"))?;
        if v.is_empty() {
            a.env.remove(k);
        } else {
            a.env.insert(k.to_string(), v.to_string());
        }
        descr.push(format!("env {e}"));
    }
    Ok((a, descr))
}

/// Relative difference of every common point: `(point, prefill, decode)`, +0.10 = 10% more.
pub fn compare(base: &Trial, new: &Trial) -> Vec<(String, f64, f64)> {
    new.points
        .iter()
        .filter_map(|p| {
            let b = base.points.iter().find(|b| b.point == p.point)?;
            Some((p.point.clone(), p.prefill_tok_s / b.prefill_tok_s - 1.0, p.decode_tok_s / b.decode_tok_s - 1.0))
        })
        .collect()
}

/// The measurement noise: the maximum relative difference between two trials with the same tune as `base` (itself
/// included). `None` if the base was never repeated: then it isn't known.
pub fn noise(trials: &[Trial], base: &Trial) -> Option<f64> {
    let same: Vec<&Trial> = trials.iter().filter(|p| p.succeeded() && p.tune == base.tune).collect();
    if same.len() < 2 {
        return None;
    }
    let mut max = 0.0f64;
    for p in &base.points {
        for metric in [|x: &MeasuredPoint| x.prefill_tok_s, |x: &MeasuredPoint| x.decode_tok_s] {
            let values: Vec<f64> = same.iter().filter_map(|u| u.points.iter().find(|x| x.point == p.point)).map(metric).collect();
            let (lo, hi) = values.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
            if values.len() >= 2 && hi > 0.0 {
                max = max.max((hi - lo) / hi);
            }
        }
    }
    Some(max)
}

/// `better`, `worse` or `same` (within the noise).
pub fn verdict(difference: f64, threshold: f64) -> &'static str {
    if difference > threshold {
        "better"
    } else if difference < -threshold {
        "worse"
    } else {
        "same"
    }
}

/// A trial's comparison with its base, in words, one line per point.
pub fn describe_comparison(base: &Trial, new: &Trial, threshold: f64) -> String {
    let mut s = String::new();
    for (point, l, w) in compare(base, new) {
        s.push_str(&format!(
            "  {point}: prefill {:+.0}% ({}), decode {:+.0}% ({})\n",
            l * 100.0,
            verdict(l, threshold),
            w * 100.0,
            verdict(w, threshold)
        ));
    }
    s
}

/// A trial's row for the log table.
pub fn table_row(p: &Trial) -> String {
    let measurements = if p.succeeded() {
        p.points.iter().map(|x| format!("{} {:.0}/{:.1}", x.point, x.prefill_tok_s, x.decode_tok_s)).collect::<Vec<_>>().join(" | ")
    } else {
        p.error.as_deref().unwrap_or("").lines().next().unwrap_or("").to_string()
    };
    format!(
        "{:>3} | {:<18} | {:<9} | base {:<4} | {}",
        p.n,
        p.name,
        p.outcome,
        p.base.map(|b| b.to_string()).unwrap_or("-".into()),
        measurements
    )
}

// --- the log on file ----------------------------------------------------------------------------

pub fn read(file: &Path) -> Result<Vec<Trial>> {
    if !file.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(file).with_context(|| format!("log {}", file.display()))?;
    text
        .lines()
        .filter(|r| !r.trim().is_empty())
        .enumerate()
        .map(|(i, r)| serde_json::from_str(r).with_context(|| format!("{} line {}: not a trial", file.display(), i + 1)))
        .collect()
}

/// Numbers the trial and writes it at the end of the log.
pub fn add(file: &Path, mut trial: Trial) -> Result<Trial> {
    let previous = read(file)?;
    trial.n = previous.iter().map(|p| p.n).max().unwrap_or(0) + 1;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(file).with_context(|| format!("log {}", file.display()))?;
    writeln!(f, "{}", serde_json::to_string(&trial)?)?;
    Ok(trial)
}

pub fn find(trials: &[Trial], n: u32) -> Result<&Trial> {
    trials.iter().find(|p| p.n == n).with_context(|| format!("trial {n} is not in the log"))
}

// --- the profile --------------------------------------------------------------------------------

/// The profile of a successful trial, in the format of `profiles/<id>.json`. `gpus`: the names of the PC's graphics
/// cards (empty for a PC without). `engine`, `build`: which engine and which build of the tune (for example
/// `llamacpp` and `cuda-12`).
pub fn profile(trial: &Trial, id: &str, model: &str, engine: &str, build: &str, gpus: &[String], note: &str) -> Result<Value> {
    trial.require_success()?;
    // The app's plan adds `-m`, the port, the address, `-np` and `--jinja` by itself; context and ubatch have their own field.
    let (mut args, mut ub) = (Vec::new(), None);
    let a = &trial.tune.args;
    let mut i = 0;
    while i < a.len() {
        match a[i].as_str() {
            "--jinja" => i += 1,
            "-m" | "--model" | "--port" | "--host" | "-np" | "-c" | "--ctx-size" => i += 2,
            "-ub" | "--ubatch-size" => {
                ub = a.get(i + 1).and_then(|v| v.parse::<u32>().ok());
                i += 2;
            }
            _ => {
                args.push(a[i].clone());
                i += 1;
            }
        }
    }
    let first = &trial.points[0];
    let table = trial
        .points
        .iter()
        .map(|x| format!("{}: prefill {:.0}, decode {:.1}", x.point, x.prefill_tok_s, x.decode_tok_s))
        .collect::<Vec<_>>()
        .join("; ");
    let note = format!("{note} Numbers at {} (tok/s). All points, {table}. Trial {} of the log, {} tokens written per point.", first.point, trial.n, trial.token);
    let mut p = json!({
        "id": id, "model": model, "engine": engine, "build": build,
        "hardware": { "gpus": gpus },
        "env": trial.tune.env, "args": args, "ctx": trial.ctx, "split": false,
        "measurements": {
            "date": trial.when.split('T').next().unwrap_or(""),
            "decode_tok_s": (first.decode_tok_s * 10.0).round() / 10.0,
            "prefill_tok_s": first.prefill_tok_s.round(),
            "note": note.trim(),
        },
    });
    if let Some(ub) = ub {
        p["ub"] = json!(ub);
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    fn base() -> Tune {
        Tune { engine: "m".into(), model: "x.gguf".into(), args: v("-ngl 99 -fa on -ctk q8_0 -ctv q8_0 -c 8192"), env: BTreeMap::new() }
    }

    fn point(p: &str, l: f64, w: f64) -> MeasuredPoint {
        MeasuredPoint { point: p.into(), prefill_tok: 1000, prefill_tok_s: l, decode_tok: 128, decode_tok_s: w }
    }

    fn trial(n: u32, a: Tune, points: Vec<MeasuredPoint>) -> Trial {
        Trial { n, when: "2026-11-05T10:00:00".into(), name: format!("p{n}"), base: None, change: vec![], tune: a, outcome: "ok".into(), error: None, ctx: 8192, token: 128, points, memory_mib: vec![] }
    }

    #[test]
    fn the_context_is_read_from_the_arguments() {
        assert_eq!(ctx_from_args(&v("-ngl 9 -c 4096")).unwrap(), 4096);
        assert_eq!(ctx_from_args(&v("--ctx-size 512")).unwrap(), 512);
        assert!(ctx_from_args(&v("-ngl 9")).unwrap_err().to_string().contains("-c"));
        assert!(ctx_from_args(&v("-c much")).is_err());
    }

    #[test]
    fn a_variation_changes_one_value_and_nothing_else() {
        let (a, d) = apply(&base(), &["-ctk f16".into()], &[], &[]).unwrap();
        assert_eq!(a.args, v("-ngl 99 -fa on -ctk f16 -ctv q8_0 -c 8192"));
        assert_eq!(d, vec!["-ctk f16"]);
    }

    #[test]
    fn a_missing_flag_is_added_and_an_existing_one_is_removed() {
        let (a, _) = apply(&base(), &["-ub 256".into(), "--no-mmap".into()], &["-fa".into()], &[]).unwrap();
        assert_eq!(a.args, v("-ngl 99 -ctk q8_0 -ctv q8_0 -c 8192 -ub 256 --no-mmap"));
        assert!(apply(&base(), &[], &["--not-there".into()], &[]).is_err());
        assert!(apply(&base(), &["ctk f16".into()], &[], &[]).is_err());
    }

    #[test]
    fn a_flag_without_a_value_does_not_eat_the_next_one() {
        let a = Tune { args: v("--no-mmap -ngl 9"), ..base() };
        let (a, _) = apply(&a, &[], &["--no-mmap".into()], &[]).unwrap();
        assert_eq!(a.args, v("-ngl 9"));
        // a negative value stays a value
        let a = Tune { args: v("-ngl -1 -fa on"), ..base() };
        let (a, _) = apply(&a, &["-ngl 99".into()], &[], &[]).unwrap();
        assert_eq!(a.args, v("-ngl 99 -fa on"));
    }

    #[test]
    fn variables_are_set_and_removed() {
        let (a, _) = apply(&base(), &[], &[], &["GGML_X=1".into()]).unwrap();
        assert_eq!(a.env["GGML_X"], "1");
        let (a, _) = apply(&a, &[], &[], &["GGML_X=".into()]).unwrap();
        assert!(a.env.is_empty());
        assert!(apply(&base(), &[], &[], &["no_equals".into()]).is_err());
    }

    #[test]
    fn the_comparison_and_the_verdict() {
        let b = trial(1, base(), vec![point("1k", 100.0, 10.0), point("8k", 80.0, 8.0)]);
        let n = trial(2, base(), vec![point("1k", 100.0, 13.0), point("8k", 60.0, 8.1)]);
        let c = compare(&b, &n);
        assert_eq!(c.len(), 2);
        assert!((c[0].2 - 0.3).abs() < 1e-9 && c[0].1.abs() < 1e-9);
        assert_eq!(verdict(0.3, 0.05), "better");
        assert_eq!(verdict(-0.25, 0.05), "worse");
        assert_eq!(verdict(0.012, 0.05), "same");
        let text = describe_comparison(&b, &n, 0.05);
        assert!(text.contains("1k: prefill +0% (same), decode +30% (better)"), "{text}");
        assert!(text.contains("8k: prefill -25% (worse), decode +1% (same)"), "{text}");
    }

    #[test]
    fn the_noise_is_measured_only_if_the_base_was_repeated() {
        let b = trial(1, base(), vec![point("1k", 100.0, 10.0)]);
        assert_eq!(noise(std::slice::from_ref(&b), &b), None);
        let repeated = trial(2, base(), vec![point("1k", 96.0, 10.2)]);
        let other = trial(3, Tune { args: v("-c 1"), ..base() }, vec![point("1k", 10.0, 1.0)]);
        let r = noise(&[b.clone(), repeated, other], &b).unwrap();
        assert!((r - 0.04).abs() < 1e-9, "{r}"); // prefill 96 against 100: 4%; the other tune doesn't count
    }

    #[test]
    fn the_log_numbers_and_rereads() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("sub").join("log.jsonl");
        assert!(read(&f).unwrap().is_empty());
        let a = add(&f, trial(0, base(), vec![point("1k", 1.0, 1.0)])).unwrap();
        let b = add(&f, trial(0, base(), vec![])).unwrap();
        assert_eq!((a.n, b.n), (1, 2));
        let all = read(&f).unwrap();
        assert_eq!(all, vec![a, b]);
        assert!(find(&all, 3).is_err());
        std::fs::write(&f, "not json\n").unwrap();
        assert!(read(&f).unwrap_err().to_string().contains("line 1"));
    }

    /// The format of `profiles/<id>.json` from the jobs contract (same names and field types).
    #[derive(Deserialize, Debug)]
    #[serde(deny_unknown_fields)]
    struct ContractProfile {
        id: String,
        model: String,
        engine: String,
        build: String,
        hardware: Hardware,
        env: BTreeMap<String, String>,
        args: Vec<String>,
        ctx: u32,
        split: bool,
        ub: Option<u32>,
        mtp: Option<u32>,
        measurements: Measurements,
    }
    #[derive(Deserialize, Debug)]
    #[serde(deny_unknown_fields)]
    struct Hardware {
        gpus: Vec<String>,
    }
    #[derive(Deserialize, Debug)]
    #[serde(deny_unknown_fields)]
    struct Measurements {
        date: String,
        decode_tok_s: f64,
        prefill_tok_s: f64,
        note: String,
    }

    #[test]
    fn the_profile_reads_with_the_contract_format() {
        let mut a = base();
        a.args = v("-m x.gguf --port 9 --host 127.0.0.1 -np 1 --jinja -ngl 99 -fa on -ctk f16 -c 8192 -ub 256 -ts 3,2");
        a.env.insert("GGML_X".into(), "1".into());
        let p = trial(4, a, vec![point("1k", 120.4, 9.87), point("8k", 80.0, 8.0)]);
        let j = profile(&p, "my-pc/small", "small", "llamacpp", "cpu", &["NVIDIA GeForce GTX 1080".into()], "Test tune.").unwrap();
        let c: ContractProfile = serde_json::from_value(j).unwrap();
        assert_eq!((c.id.as_str(), c.model.as_str(), c.engine.as_str(), c.build.as_str()), ("my-pc/small", "small", "llamacpp", "cpu"));
        assert_eq!(c.hardware.gpus, vec!["NVIDIA GeForce GTX 1080"]);
        assert_eq!(c.args, v("-ngl 99 -fa on -ctk f16 -ts 3,2"));
        assert_eq!((c.ctx, c.ub, c.mtp, c.split), (8192, Some(256), None, false));
        assert_eq!(c.env["GGML_X"], "1");
        assert_eq!((c.measurements.date.as_str(), c.measurements.decode_tok_s, c.measurements.prefill_tok_s), ("2026-11-05", 9.9, 120.0));
        assert!(c.measurements.note.starts_with("Test tune. Numbers at 1k") && c.measurements.note.contains("8k: prefill 80, decode 8.0"), "{}", c.measurements.note);
    }

    #[test]
    fn the_profile_of_a_failed_trial_is_not_written() {
        let mut p = trial(1, base(), vec![]);
        p.outcome = "does not start".into();
        assert!(profile(&p, "x", "m", "llamacpp", "cpu", &[], "").unwrap_err().to_string().contains("did not succeed"));
    }
}
