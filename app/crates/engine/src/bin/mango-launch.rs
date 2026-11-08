//! What the terminal asks of the app's logic: the same engine plan (the PC's profile if it applies, otherwise
//! official llama.cpp with the arguments computed from the hardware), the same model list, the same downloads. The
//! terminal starts the process and decides nothing.
//!
//! ```text
//! mango-launch plan --model <key> [--port 8080] [--hardware <file.json>]
//! mango-launch models [--hardware <file.json>]
//! mango-launch install --model <key> [--hardware <file.json>]
//! ```
//!
//! Distribution and data are the app's (`MANGO_DIST`, `MANGO_DATA`). `--hardware` describes a PC that isn't this
//! one (`engine_cfg::Hardware` as JSON): it's for seeing the plan elsewhere. A JSON object on stdout; errors (and
//! `install` progress) on stderr, with exit code 1.

use anyhow::{bail, Context, Result};
use engine_cfg::Hardware;
use mango_common::download::{install_model, install_engine};
use mango_common::{tr, Paths};
use serde_json::{json, Value};
use std::io::Write;

const DEFAULT_PORT: u16 = 8080;

fn main() {
    if let Err(e) = run() {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

fn usage() -> String {
    tr!(
        "uso: mango-launch plan --model <chiave> [--port N] | models | install --model <chiave>  (ciascuno con [--hardware <file.json>])",
        "usage: mango-launch plan --model <key> [--port N] | models | install --model <key>  (each with [--hardware <file.json>])"
    )
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().with_context(usage)?;
    let value = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].as_str());
    let paths = Paths::discover()?;
    let hw = match value("--hardware") {
        Some(f) => serde_json::from_str::<Hardware>(&std::fs::read_to_string(f).with_context(|| format!("--hardware {f}"))?)
            .with_context(|| tr!("{f} non descrive un hardware", "{f} does not describe hardware"))?,
        None => engine_cfg::detect()?,
    };
    let model = || value("--model").with_context(|| tr!("manca --model", "--model is missing"));
    let output = match command.as_str() {
        "plan" => plan(&paths, &hw, model()?, value("--port").map_or(Ok(DEFAULT_PORT), str::parse).context("--port")?)?,
        "models" => models(&paths, &hw)?,
        "install" => install(&paths, &hw, model()?)?,
        _ => bail!(usage()),
    };
    println!("{output}");
    Ok(())
}

/// What is needed to start the model: the process (executable, arguments, environment, working dir) and the two
/// calls to the engine that save and restore the conversation.
fn plan(paths: &Paths, hw: &Hardware, model: &str, port: u16) -> Result<Value> {
    let p = engine_cfg::plan_for(paths, Some(model), port, hw, &[])?;
    let call = |c: &Option<mango_common::PostCall>| c.as_ref().map(|c| json!({ "url": c.url, "body": c.body, "timeout_s": c.timeout_s }));
    Ok(json!({
        "model": p.key,
        "label": p.label,
        "context": p.ctx,
        "images": p.images,
        "placement": p.placement(),
        "gpus": p.gpus_used.len(),
        "url": p.url,
        "executable": p.spec.exe,
        "args": p.spec.args,
        "env": p.spec.env.iter().cloned().collect::<std::collections::BTreeMap<String, String>>(),
        "workdir": p.spec.cwd.clone().unwrap_or_else(|| paths.logs()),
        "wait_s": p.spec.ready_timeout_s,
        "shutdown": call(&p.spec.shutdown_post),
        "startup": call(&p.spec.startup_post),
    }))
}

/// The local models in catalog order, with where and with which context they run on this hardware (`placement` null:
/// doesn't fit) and, for those that don't start, what's missing.
fn models(paths: &Paths, hw: &Hardware) -> Result<Value> {
    let (entries, default) = engine_cfg::catalog_for(paths, hw)?;
    Ok(json!({
        "default": default,
        "models": entries.iter().map(|v| json!({ "model": v.key, "context": v.ctx, "placement": v.placement, "images": v.images, "missing": v.missing })).collect::<Vec<_>>(),
    }))
}

/// Downloads the plan's engine and the model's weights, if they aren't already on disk.
fn install(paths: &Paths, hw: &Hardware, model: &str) -> Result<Value> {
    let (engine, build) = engine_cfg::engine_of(paths, model, hw)?;
    eprintln!("{}", tr!("motore {engine} ({})", "engine {engine} ({})", build.as_str()));
    let dir = install_engine(paths, &engine, build, &mut progress())?;
    eprintln!("\n{}", tr!("modello {model}", "model {model}"));
    install_model(paths, model, &engine, &mut progress())?;
    eprintln!();
    Ok(json!({ "engine": dir, "models": paths.models }))
}

/// A line that updates itself, at every whole percentage point.
fn progress() -> impl FnMut(u64, u64) {
    let mut last = u64::MAX;
    move |done, total| {
        let percent = (done * 100).checked_div(total).unwrap_or(0);
        if percent != last {
            last = percent;
            eprint!("\r  {}", tr!("{percent}% ({} di {} MiB)", "{percent}% ({} of {} MiB)", done >> 20, total >> 20));
            let _ = std::io::stderr().flush();
        }
    }
}
