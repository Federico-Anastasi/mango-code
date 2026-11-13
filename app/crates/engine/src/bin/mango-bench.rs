//! The speed bench: starts each model the way the app does (engine-cfg plan, engine manager) and measures prefill
//! and decode at different contexts.
//!
//! Usage: `mango-bench [--points 1k,32k,64k|full] [--token 256] [--repo <folder>] <key> [<key> ...]`
//! (`--repo`: the repo to take the text from, if the distribution isn't inside it).
//!
//! The text is real: Mango Code's sources and documents (`launcher/`, `app/`), in a fixed order, cut to the exact
//! number of tokens with the model's tokenizer; the question at the end asks for a summary. Temperature 0, no
//! prompt cache (every point rereads everything), and the calls that restore and save the user's open conversation
//! are not made. One JSON line per point on stdout, the table at the end.

use anyhow::{bail, Context, Result};
use mango_common::Paths;
use engine::bench;
use engine::EngineManager;
use serde_json::json;
use std::path::PathBuf;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut points = vec!["1k".to_string(), "32k".into(), "64k".into()];
    let mut token = 256u32;
    let mut keys = Vec::new();
    let mut repo: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--points" => {
                points = args.get(i + 1).context("--points without a value")?.split(',').map(str::to_string).collect();
                i += 1;
            }
            "--repo" => {
                repo = Some(args.get(i + 1).context("--repo without a value")?.into());
                i += 1;
            }
            "--token" => {
                token = args.get(i + 1).context("--token without a value")?.parse()?;
                i += 1;
            }
            k => keys.push(k.to_string()),
        }
        i += 1;
    }
    if keys.is_empty() {
        bail!("usage: mango-bench [--points 1k,32k,64k|full] [--token 256] <key> [<key> ...]");
    }

    let paths = Paths::discover()?;
    let repo = match repo {
        Some(r) => r,
        None => paths.dist.parent().context("the distribution is not inside a repo: use --repo")?.to_path_buf(),
    };
    let corpus = bench::corpus(&["launcher", "app/crates", "app/src-tauri/src"].map(|d| repo.join(d)), &repo)?;
    let logs = paths.data.join("bench");
    std::fs::create_dir_all(&logs)?;
    let p = paths.clone();
    let m = EngineManager::new(
        // The bench is not a conversation: it neither restores the one the user left open nor saves its own text over it.
        Box::new(move |k, port, excluded| {
            let mut plan = engine_cfg::plan_excluding(&p, Some(k), port, excluded)?;
            plan.spec.startup_post = None;
            plan.spec.shutdown_post = None;
            Ok(plan)
        }),
        Box::new(engine_cfg::gpu_memory),
        &logs,
    );
    let mut lines = Vec::new();
    for k in &keys {
        eprintln!("== {k}: starting");
        let t0 = std::time::Instant::now();
        if let Err(e) = m.start(k, &mut |_| {}) {
            eprintln!("{k}: does not start: {e:#}");
            continue;
        }
        let plan = m.running_plan().context("engine stopped")?;
        eprintln!("   ready in {:.0} s, context {}", t0.elapsed().as_secs_f32(), plan.ctx);
        let tokens = bench::tokenize(&plan.url, &corpus)?;
        for point in &points {
            let n = bench::tokens_for_point(point, plan.ctx, token)?;
            match bench::measure_point(&plan.url, k, &tokens, point, n, token) {
                Ok(mut r) => {
                    r["model"] = json!(k);
                    r["context"] = json!(plan.ctx);
                    println!("{r}");
                    lines.push(r);
                }
                Err(e) => eprintln!("{k} {point}: {e:#}"),
            }
        }
    }
    m.stop();
    eprintln!("\n| model | point | prefill tok/s | decode tok/s |\n|---|---|---:|---:|");
    for r in &lines {
        eprintln!(
            "| {} | {} ({} tok) | {:.0} | {:.1} |",
            r["model"].as_str().unwrap_or(""),
            r["point"].as_str().unwrap_or(""),
            r["prefill_tok"],
            r["prefill_tok_s"].as_f64().unwrap_or(0.0),
            r["decode_tok_s"].as_f64().unwrap_or(0.0)
        );
    }
    Ok(())
}
