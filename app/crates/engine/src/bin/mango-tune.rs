//! Mango Code tuning on the PC of whoever uses it: detects the hardware, measures a tune (prefill and decode at
//! three context lengths), tries one variation at a time keeping a log, writes the profile.
//! Used by the `optimize` skill (`optimize/SKILL.md`).
//!
//! ```text
//! mango-tune detect [--engine <folder>]
//! mango-tune trial --engine <folder> --model <file.gguf> [--name N] [--points 1k,8k,32k] [--token 128]
//!                     [--repeat 1] [--text <file>] [--log <file>] [--wait 600] -- <llama-server arguments>
//! mango-tune trial --base <n> [--name N] [--change "-ctk f16"]... [--remove -fa]... [--env K=V]...
//!                     [--engine <folder>] [--model <file.gguf>]
//! mango-tune log [--log <file>]
//! mango-tune profile --from <n> --model <key> [--id <id>] [--gpus "Name;Name"] [--engine-name X --build Y]
//!                       [--note "..."] [--out <folder>] [--log <file>]
//! ```

use anyhow::{bail, Context, Result};
use engine_cfg::{EnginePlan, Gpu};
use mango_common::{data_dir, Paths, ProcSpec};
use engine::tune::{self, Tune, Trial, MeasuredPoint};
use engine::{bench, EngineManager};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

const USAGE: &str = "usage: mango-tune detect | trial | log | profile (see the optimize skill)";
const KEY: &str = "trial";
/// The build folders in the installation: `<engine>/<version>-<build>`.
const BUILD: [&str; 4] = ["cuda-12", "cuda-13", "vulkan", "cpu"];

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().context(USAGE)?;
    let rest: Vec<String> = args.collect();
    match command.as_str() {
        "detect" => detect(Options::read(&rest, &["--engine"])?),
        "trial" => trial(Options::read(
            &rest,
            &["--engine", "--model", "--name", "--points", "--token", "--repeat", "--text", "--log", "--wait", "--base", "--change", "--remove", "--env"],
        )?),
        "log" => log(Options::read(&rest, &["--log"])?),
        "profile" => profile(Options::read(
            &rest,
            &["--from", "--model", "--id", "--gpus", "--engine-name", "--build", "--note", "--out", "--log"],
        )?),
        _ => bail!(USAGE),
    }
}

/// The `--name value` options (repeatable) and, after `--`, the engine's arguments.
struct Options {
    values: BTreeMap<String, Vec<String>>,
    engine: Vec<String>,
}

impl Options {
    fn read(args: &[String], allowed: &[&str]) -> Result<Options> {
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            if a == "--" {
                return Ok(Options { values, engine: args[i + 1..].to_vec() });
            }
            if !allowed.contains(&a) {
                bail!("unknown option: {a} (allowed: {})", allowed.join(" "));
            }
            let v = args.get(i + 1).with_context(|| format!("{a} without a value"))?;
            values.entry(a.to_string()).or_default().push(v.clone());
            i += 2;
        }
        Ok(Options { values, engine: Vec::new() })
    }

    fn one(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.last()).map(String::as_str)
    }

    fn all(&self, name: &str) -> Vec<String> {
        self.values.get(name).cloned().unwrap_or_default()
    }

    fn log_file(&self) -> Result<PathBuf> {
        match self.one("--log") {
            Some(f) => Ok(f.into()),
            None => Ok(data_dir()?.join("optimize").join("log.jsonl")),
        }
    }
}

// --- detect -------------------------------------------------------------------------------------

/// The PC as it is: GPUs of every brand, processor, RAM, and the general engine's build that suits it.
fn hardware() -> Result<Value> {
    let hw = engine_cfg::detect()?;
    Ok(json!({
        "gpus": hw.gpus.iter().map(|g| json!({
            "index": g.index, "name": g.name, "vendor": g.vendor, "memory_mib": g.memory_mib,
            "cc": g.cc.map(|(a, b)| format!("{a}.{b}")), "cuda_driver": g.cuda_driver.map(|(a, b)| format!("{a}.{b}")),
        })).collect::<Vec<_>>(),
        "cpu": { "name": hw.cpu.name, "cores": hw.cpu.cores, "avx2": hw.cpu.avx2, "avx512": hw.cpu.avx512 },
        "ram_mib": hw.ram_mib,
        "build": engine_cfg::choose_build(&hw).as_str(),
    }))
}

/// The folders under `dir` (up to two levels) that contain `llama-server.exe`.
fn engines_in(dir: &Path) -> Vec<String> {
    let mut v = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return v };
    for e in rd.flatten().filter(|e| e.path().is_dir()) {
        if e.path().join("llama-server.exe").is_file() {
            v.push(e.path().display().to_string());
        } else {
            v.extend(engines_in(&e.path()).into_iter().filter(|p| Path::new(p).parent() == Some(&e.path())));
        }
    }
    v
}

/// The GGUFs under `dir` (up to three levels), with the size in MiB.
fn models_in(dir: &Path, level: u32) -> Vec<Value> {
    let mut v = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return v };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && level < 3 {
            v.extend(models_in(&p, level + 1));
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("gguf")) {
            let mib = e.metadata().map(|m| m.len() >> 20).unwrap_or(0);
            v.push(json!({ "file": p.display().to_string(), "mib": mib }));
        }
    }
    v
}

fn detect(o: Options) -> Result<()> {
    let mut r = hardware()?;
    match Paths::discover() {
        Ok(p) => {
            r["installed_engines"] = json!(engines_in(&p.engines));
            r["downloaded_models"] = json!(models_in(&p.models, 0));
        }
        Err(e) => r["dist_error"] = json!(format!("{e:#}")),
    }
    if let Some(m) = o.one("--engine") {
        // What the engine sees: it's the only list that holds for every GPU brand, with free memory as it declares it.
        let out = std::process::Command::new(Path::new(m).join("llama-server.exe"))
            .arg("--list-devices")
            .output()
            .with_context(|| format!("cannot start {m}\\llama-server.exe"))?;
        r["engine_devices"] = json!(String::from_utf8_lossy(&[out.stdout, out.stderr].concat()).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>());
    }
    println!("{}", serde_json::to_string_pretty(&r)?);
    Ok(())
}

// --- trial --------------------------------------------------------------------------------------

fn trial(o: Options) -> Result<()> {
    let log_file = o.log_file()?;
    let trials = tune::read(&log_file)?;
    let name = o.one("--name").unwrap_or("unnamed").to_string();

    // The tune: new, or a variation of a trial in the log.
    let (cfg, base, change) = match o.one("--base") {
        Some(n) => {
            let b = tune::find(&trials, n.parse().context("--base: the number of a trial")?)?;
            if !b.succeeded() {
                bail!("trial {} did not succeed ({}): can't start from it", b.n, b.outcome);
            }
            let mut start = b.tune.clone();
            let mut change = Vec::new();
            for (flag, field) in [("--engine", 0), ("--model", 1)] {
                if let Some(v) = o.one(flag) {
                    if field == 0 { start.engine = v.to_string() } else { start.model = v.to_string() }
                    change.push(format!("{} {v}", &flag[2..]));
                }
            }
            let (a, mut c) = tune::apply(&start, &o.all("--change"), &o.all("--remove"), &o.all("--env"))?;
            change.append(&mut c);
            if change.is_empty() {
                // The same base repeated: it measures the noise.
                change.push("repeat".into());
            }
            (a, Some(b), change)
        }
        None => {
            for flag in ["--change", "--remove"] {
                if o.one(flag).is_some() {
                    bail!("{flag} needs --base: a variation is always of a trial that already exists");
                }
            }
            let (engine, model) = (o.one("--engine").context("--engine is missing")?, o.one("--model").context("--model is missing")?);
            if o.engine.is_empty() {
                bail!("the engine arguments after `--` are missing (for example: -- -c 8192 -t 8)");
            }
            let base = Tune { engine: engine.into(), model: model.into(), args: o.engine.clone(), env: BTreeMap::new() };
            let (a, _) = tune::apply(&base, &[], &[], &o.all("--env"))?;
            (a, None, Vec::new())
        }
    };

    // A variation is compared with the base point by point: by default the same points and the same tokens.
    let points: Vec<String> = match (o.one("--points"), base) {
        (Some(p), _) => p.split(',').map(str::to_string).collect(),
        (None, Some(b)) => b.points.iter().map(|x| x.point.clone()).collect(),
        (None, None) => vec!["1k".into(), "8k".into(), "32k".into()],
    };
    let token: u32 = match (o.one("--token"), base) {
        (Some(t), _) => t.parse().context("--token")?,
        (None, Some(b)) => b.token,
        (None, None) => 128,
    };
    let repeat: usize = o.one("--repeat").unwrap_or("1").parse().context("--repeat")?;
    let wait: u64 = o.one("--wait").unwrap_or("600").parse().context("--wait")?;
    let ctx = tune::ctx_from_args(&cfg.args)?;
    let mut requested = Vec::new();
    for p in &points {
        let n = bench::tokens_for_point(p, ctx, token)?;
        if n as u32 + token + 512 > ctx {
            bail!("point {p} ({n} tokens) does not fit in -c {ctx}: choose shorter points with --points, or a larger -c");
        }
        requested.push(n);
    }
    let exe = Path::new(&cfg.engine).join("llama-server.exe");
    if !exe.is_file() {
        bail!("{} is not there: --engine is the folder that contains llama-server.exe", exe.display());
    }
    if !Path::new(&cfg.model).is_file() {
        bail!("the model {} is not there", cfg.model);
    }
    let text = match o.one("--text") {
        Some(f) => std::fs::read_to_string(f).with_context(|| format!("--text {f}"))?,
        None => {
            let dist = Paths::discover().context("without --text the text comes from the Mango Code distribution")?.dist;
            bench::corpus(std::slice::from_ref(&dist), &dist)?
        }
    };

    let mut p = Trial {
        n: 0,
        when: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        name,
        base: base.map(|b| b.n),
        change,
        tune: cfg.clone(),
        outcome: "does not start".into(),
        error: None,
        ctx,
        token,
        points: Vec::new(),
        memory_mib: Vec::new(),
    };
    eprintln!("== starting: {} {}", exe.display(), cfg.args.join(" "));
    if let Err(e) = measure_tune(&mut p, &points, &requested, repeat, &text, wait) {
        p.error = Some(format!("{e:#}"));
    }
    let p = tune::add(&log_file, p)?;

    println!("trial {}: {} ({})", p.n, p.name, p.outcome);
    println!("  tune: {}", p.tune.args.join(" "));
    if !p.tune.env.is_empty() {
        println!("  variables: {}", p.tune.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" "));
    }
    if let Some(e) = &p.error {
        println!("  {e}");
        bail!("trial {} did not succeed: it is in the log as «{}»", p.n, p.outcome);
    }
    for x in &p.points {
        println!("  {}: prefill {:.0} tok/s ({} tok), decode {:.1} tok/s", x.point, x.prefill_tok_s, x.prefill_tok, x.decode_tok_s);
    }
    if !p.memory_mib.is_empty() {
        println!("  engine memory on the GPUs (MiB): {:?}", p.memory_mib);
    }
    if let Some(b) = p.base.map(|n| tune::find(&trials, n)).transpose()? {
        if p.change == ["repeat"] {
            // The repeated base isn't a variation: it only says how much the measurement varies.
            let with_this: Vec<Trial> = trials.iter().cloned().chain([p.clone()]).collect();
            let r = tune::noise(&with_this, b).unwrap_or(0.0);
            println!("repetition of trial {}: measured noise {:.0}% (maximum difference between repetitions, in prefill and decode)", b.n, r * 100.0);
        } else {
            let (threshold, known) = match tune::noise(&trials, b) {
                Some(r) => (r.max(0.01), true),
                None => (tune::ASSUMED_NOISE, false),
            };
            println!("compared with trial {} (noise {:.0}%{}):", b.n, threshold * 100.0, if known { "" } else { ", assumed: repeat the base to measure it" });
            print!("{}", tune::describe_comparison(b, &p, threshold));
        }
    }
    Ok(())
}

/// Starts the tune's engine, measures it at all points, stops it. The outcome of `p` is `does not start` until the
/// engine answers, `error` until the measurements are done, then `ok`; a failed measurement leaves in `p.points` the
/// ones already made.
fn measure_tune(p: &mut Trial, points: &[String], point_tokens: &[usize], repeat: usize, text: &str, wait: u64) -> Result<()> {
    let logs = data_dir()?.join("optimize").join("log");
    std::fs::create_dir_all(&logs)?;
    let a = p.tune.clone();
    let planner = Box::new(move |_: &str, port: u16, _: &[u32]| -> Result<EnginePlan> {
        let url = format!("http://127.0.0.1:{port}");
        let mut args: Vec<String> = ["-m", &a.model, "--port", &port.to_string(), "--host", "127.0.0.1", "-np", "1", "--jinja"].map(String::from).into();
        args.extend(a.args.iter().cloned());
        let mut env: Vec<(String, String)> = vec![("CUDA_DEVICE_ORDER".into(), "PCI_BUS_ID".into())];
        env.extend(a.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        Ok(EnginePlan {
            key: KEY.into(),
            spec: ProcSpec {
                name: "trial-engine".into(),
                exe: Path::new(&a.engine).join("llama-server.exe"),
                args,
                env,
                env_remove: vec![],
                cwd: None,
                health_url: Some(format!("{url}/health")),
                ready_timeout_s: wait,
                shutdown_post: None,
                startup_post: None,
            },
            url,
            label: KEY.into(),
            ctx: 0,
            images: false,
            gpus_used: Vec::<Gpu>::new(),
            gguf: PathBuf::from(&a.model),
        })
    });
    let m = EngineManager::new(planner, Box::new(engine_cfg::gpu_memory), &logs, None);
    let before = engine_cfg::gpu_memory();
    let t0 = Instant::now();
    m.start(KEY, &mut |_| {})?;
    p.outcome = "error".into();
    eprintln!("   ready in {:.0} s", t0.elapsed().as_secs_f32());
    let url = m.running_plan().context("the engine stopped")?.url;
    let outcome = (|| -> Result<()> {
        let tokens = bench::tokenize(&url, text)?;
        // The first request pays for the start of kernels and caches: it's thrown away.
        bench::measure_point(&url, KEY, &tokens, "warmup", 64, 8)?;
        for (point, &n) in points.iter().zip(point_tokens) {
            let mut rounds = Vec::new();
            for _ in 0..repeat {
                let r = bench::measure_point(&url, KEY, &tokens, point, n, p.token).with_context(|| format!("measurement at {point}"))?;
                rounds.push(serde_json::from_value::<MeasuredPoint>(r)?);
            }
            p.points.push(median(rounds));
            eprintln!("   {point}: done");
        }
        Ok(())
    })();
    let after = engine_cfg::gpu_memory();
    p.memory_mib = after.iter().map(|&(i, used, _)| used.saturating_sub(before.iter().find(|x| x.0 == i).map_or(0, |x| x.1))).collect();
    m.stop();
    if outcome.is_ok() {
        p.outcome = "ok".into();
    }
    outcome
}

/// For each quantity the middle value among the rounds (with a single round, that one).
fn median(mut rounds: Vec<MeasuredPoint>) -> MeasuredPoint {
    let middle = |f: fn(&MeasuredPoint) -> f64, rounds: &[MeasuredPoint]| {
        let mut v: Vec<f64> = rounds.iter().map(f).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    };
    let (l, w) = (middle(|x| x.prefill_tok_s, &rounds), middle(|x| x.decode_tok_s, &rounds));
    let mut p = rounds.remove(0);
    p.prefill_tok_s = l;
    p.decode_tok_s = w;
    p
}

// --- log and profile ----------------------------------------------------------------------------

fn log(o: Options) -> Result<()> {
    let file = o.log_file()?;
    let trials = tune::read(&file)?;
    if trials.is_empty() {
        bail!("the log {} is empty: no trial yet", file.display());
    }
    println!("  n | name               | outcome   | base     | per point: prefill tok/s / decode tok/s");
    for p in &trials {
        println!("{}", tune::table_row(p));
    }
    Ok(())
}

fn profile(o: Options) -> Result<()> {
    let trials = tune::read(&o.log_file()?)?;
    let from: u32 = o.one("--from").context("--from is missing (the trial number)")?.parse().context("--from")?;
    let trial = tune::find(&trials, from)?;
    trial.require_success()?;
    let model = o.one("--model").context("--model is missing (the model key in the catalog, for example 3.6)")?;
    let folder = Path::new(&trial.tune.engine);
    let build_name = folder.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let derived_build = BUILD.iter().find(|b| build_name.ends_with(&format!("-{b}"))).copied();
    let derived_engine = folder.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str());
    let (engine, build) = match (o.one("--engine-name"), o.one("--build"), derived_build, derived_engine) {
        (Some(m), Some(b), _, _) => (m.to_string(), b.to_string()),
        (None, None, Some(b), Some(m)) => (m.to_string(), b.to_string()),
        _ => bail!("the engine can't be told from the folder {}: give --engine-name (for example llamacpp) and --build ({})", folder.display(), BUILD.join(", ")),
    };
    let gpus: Vec<String> = match o.one("--gpus") {
        Some(s) => s.split(';').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        None => engine_cfg::detect()?.gpus.into_iter().map(|g| g.name).collect(),
    };
    let id = o.one("--id").map(String::from).unwrap_or_else(|| format!("my-pc/{model}"));
    let j = tune::profile(trial, &id, model, &engine, &build, &gpus, o.one("--note").unwrap_or(""))?;
    let out: PathBuf = match o.one("--out") {
        Some(d) => d.into(),
        None => data_dir()?.join("profiles"),
    };
    std::fs::create_dir_all(&out)?;
    let file = out.join(format!("{}.json", id.replace('/', "-")));
    std::fs::write(&file, serde_json::to_string_pretty(&j)? + "\n")?;
    println!("profile written: {}", file.display());
    Ok(())
}
