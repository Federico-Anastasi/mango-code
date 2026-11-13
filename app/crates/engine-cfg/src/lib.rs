//! Engine (llama-server) configuration: given a model and the PC's hardware, produces the `ProcSpec` the supervisor
//! starts. It starts nothing.
//!
//! Two levels:
//! - a **profile** (`profiles.rs`) if the PC's GPUs are those it was measured for, or if it is a profile for the
//!   PC's build (the models official llama.cpp doesn't read): its engine, its arguments, the split of the layers and
//!   of the image encoder across the GPUs (`split.rs`);
//! - otherwise the **general plan** (`general.rs`): official llama.cpp with the arguments computed from the
//!   hardware.

pub mod other_models;
pub mod choices;
mod catalog;
mod general;
mod gguf;
pub mod hardware;
pub mod memory;
mod profiles;
#[cfg(test)]
mod fixtures;
mod speed;
mod split;
mod view;

pub use catalog::{catalog, catalog_for, default_to_save, download_of, startup_model, DownloadPlan, Origin, ModelEntry};
pub use general::Placement;
pub use view::{after_failure, taken_before_start, CardsTaken, computer_view, engine_label, engine_updates, models_view, recommended, AfterFailure, ComputerView, EngineUpdate, Limits, ModelView, Recommendation, Verdict, Where};
pub use speed::{cpu_speed, Speed};
pub use hardware::{gpu_memory, detect, choose_build, Cpu, Hardware, Vendor, Gpu};
pub use profiles::{profile_for, ProfileHardware, Measurements, Profile};

use anyhow::{bail, Result};
use catalog::{load_models, model_cfg, require, setup_for, ModelsFile, Setup};
use mango_common::download::installed_engine;
use mango_common::{tr, PostCall, Paths, ProcSpec};
use std::path::{Path, PathBuf};

/// The engine to start and what is needed downstream.
#[derive(Debug, Clone)]
pub struct EnginePlan {
    /// Model key in mango-models.json (e.g. "toq").
    pub key: String,
    pub spec: ProcSpec,
    /// E.g. "http://127.0.0.1:8080".
    pub url: String,
    /// Model name for the interface (e.g. "TOQ-v1").
    pub label: String,
    /// Effective context in tokens.
    pub ctx: u32,
    /// The model accepts images (it has the mmproj).
    pub images: bool,
    /// The GPUs it runs on (empty on the CPU).
    pub gpus_used: Vec<Gpu>,
    /// Path of the loaded GGUF (to recognize an engine already running the same model).
    pub gguf: PathBuf,
}

impl EnginePlan {
    /// Where it runs: all on the GPUs it uses, or all on the CPU if it uses none.
    pub fn placement(&self) -> Placement {
        if self.gpus_used.is_empty() {
            Placement::Cpu
        } else {
            Placement::Gpu
        }
    }
}

/// Loading the 27B takes 20-60 s on an RTX 3060 Ti + GTX 1080 + GTX 1660 SUPER; the rest is margin for slow disks.
const READY_TIMEOUT_S: u64 = 300;

/// Before stopping, the engine saves the open conversation: a couple of seconds for 100 thousand tokens, the rest is
/// margin for slow disks.
const MEMORY_SAVE_S: u64 = 60;

pub(crate) use mango_common::user_error as user;

/// Value that follows one of the options `names` in the engine arguments.
fn arg_value<'a>(args: &'a [String], names: &[&str]) -> Option<&'a str> {
    args.windows(2).find(|w| names.contains(&w[0].as_str())).map(|w| w[1].as_str())
}

fn set_env(env: &mut Vec<(String, String)>, k: &str, v: String) {
    match env.iter_mut().find(|e| e.0 == k) {
        Some(e) => e.1 = v,
        None => env.push((k.to_string(), v)),
    }
}

/// `model_key`: key in mango-models.json; `None` = the file's default.
pub fn plan(paths: &Paths, model_key: Option<&str>, port: u16) -> Result<EnginePlan> {
    plan_excluding(paths, model_key, port, &[])
}

/// Like `plan`, without the `excluded` GPUs (GPU indexes): they have been released for another job.
/// A model that needs one doesn't start (error with the reason).
pub fn plan_excluding(paths: &Paths, model_key: Option<&str>, port: u16, excluded: &[u32]) -> Result<EnginePlan> {
    plan_for(paths, model_key, port, &detect()?, excluded)
}

/// Like `plan_excluding`, on given hardware instead of this PC's.
pub fn plan_for(paths: &Paths, model_key: Option<&str>, port: u16, hw: &Hardware, excluded: &[u32]) -> Result<EnginePlan> {
    let file = load_models(paths)?;
    build_plan(paths, &file, model_key, port, hw, excluded, gguf::read_shape)
}

/// How the start is composed: the engine, the context, the GPUs, the environment, the setup's own arguments, and
/// whether the engine can save the conversation before stopping.
struct Parts {
    ctx: u32,
    gpus_used: Vec<Gpu>,
    env: Vec<(String, String)>,
    /// The arguments after those common to all (the `-m`, the port...) and before mmproj and template.
    args: Vec<String>,
    /// Arguments after mmproj and template (`-ub`, `-ts`: the order is the measured one).
    args_after: Vec<String>,
    disk_memory: bool,
}

/// The body of `plan` with hardware and GGUF reading passed in from outside, to test it without a GPU.
fn build_plan(
    paths: &Paths,
    file: &ModelsFile,
    model_key: Option<&str>,
    port: u16,
    hw: &Hardware,
    excluded: &[u32],
    read_shape: impl FnOnce(&Path, &str, &str) -> Result<split::ModelShape>,
) -> Result<EnginePlan> {
    let key = model_key.unwrap_or(&file.default);
    let cfg = model_cfg(file, key)?;
    if cfg.cloud.is_some() {
        bail!("{}", tr!("Il modello «{key}» è un modello online, non si avvia in locale.", "The model «{key}» is an online model, it doesn't start locally."));
    }
    let scope = choices::read(paths)?.scope(key);

    let setup = setup_for(paths, key, &cfg, hw, &scope.choices)?;
    let gguf_rel = cfg.gguf_for(setup.engine()).ok_or_else(|| {
        user(
            &tr!("La configurazione del modello è incompleta. Reinstalla l'applicazione.", "The model configuration is incomplete. Reinstall the application."),
            format!("model «{key}» without gguf"),
        )
    })?;
    let gguf = paths.models.join(gguf_rel);
    let remedy = tr!(
        "Scaricalo da Impostazioni › Modelli.",
        "Download it from Settings › Models."
    );
    require(&gguf, &tr!("Il modello «{}» non è sul disco.", "The model «{}» is not on disk.", cfg.label), &remedy)?;
    let mmproj = match &cfg.mmproj {
        Some(rel) => {
            let p = paths.models.join(rel);
            require(&p, &tr!("Manca la parte del modello che legge le immagini.", "The part of the model that reads images is missing."), &remedy)?;
            Some(p)
        }
        None => None,
    };
    let template = match &cfg.chat_template {
        Some(name) => {
            let p = paths.dist.join("chat-templates").join(name);
            require(
                &p,
                &tr!("Manca un file di Mango Code (il formato della conversazione).", "A Mango Code file is missing (the conversation format)."),
                &tr!("Reinstalla l'applicazione.", "Reinstall the application."),
            )?;
            Some(p)
        }
        None => None,
    };

    let dir = installed_engine(paths, setup.engine(), setup.build()).ok_or_else(|| {
        user(
            &tr!("Manca il motore che esegue il modello. Reinstalla l'applicazione.", "The engine that runs the model is missing. Reinstall the application."),
            format!("no llama-server.exe for «{}» ({}) in {}", setup.engine(), setup.build().as_str(), paths.engines.join(setup.engine()).display()),
        )
    })?;
    let exe = dir.join("llama-server.exe");

    // The cards the plan leaves out: those lent to another job and those the user doesn't use.
    let unused = general::unused_indexes(hw, &scope);
    let parts = match &setup {
        Setup::Profile(p) => {
            let left: Vec<u32> = excluded.iter().chain(&unused).copied().collect();
            profile_parts(p, &gguf, cfg.encoder_bytes(), hw, &left, scope.choices.context, read_shape)?
        }
        Setup::General { .. } => {
            let g = general::plan(file, &cfg, hw, excluded, &scope)?;
            Parts { ctx: g.ctx, gpus_used: g.gpus, env: g.env, args: g.args, args_after: vec![], disk_memory: false }
        }
    };
    let Parts { ctx, gpus_used, env, args: setup_args, args_after, disk_memory } = parts;
    check_left(&cfg.label, &gpus_used, excluded, &unused)?;
    let slots = paths.data.join("slots");
    std::fs::create_dir_all(&slots).map_err(|e| {
        user(&tr!("Non riesco a preparare la cartella di lavoro di Mango Code.", "I can't prepare Mango Code's working folder."), format!("{}: {e}", slots.display()))
    })?;
    let mut args: Vec<String> = vec![
        "-m".into(),
        mango_common::engine_path(&gguf),
        "-c".into(),
        ctx.to_string(),
        "--jinja".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--slot-save-path".into(),
        mango_common::engine_path(&slots),
        "-np".into(),
        "1".into(),
        "--no-warmup".into(),
        "--metrics".into(),
    ];
    // On-disk memory (the profiles' engines): conversations and system prompts stay ready between one stop and the
    // next (GPUs lent, model switch, shutdown) and when moving from one conversation to another.
    if disk_memory {
        let (dir, mib) = memory::prepare(&paths.data.join("memory"), key).map_err(|e| {
            user(&tr!("Non riesco a preparare la cartella di lavoro di Mango Code.", "I can't prepare Mango Code's working folder."), format!("{e:#}"))
        })?;
        args.extend([
            "--cache-disk".into(),
            mango_common::engine_path(&dir),
            "--cache-disk-mib".into(),
            mib.to_string(),
            "--cache-disk-hours".into(),
            memory::MEMORY_HOURS.to_string(),
        ]);
    }
    args.extend(setup_args);
    if let Some(p) = &mmproj {
        args.extend(["--mmproj".into(), mango_common::engine_path(p)]);
    }
    if let Some(p) = &template {
        args.extend(["--chat-template-file".into(), mango_common::engine_path(p)]);
    }
    args.extend(args_after);

    let url = format!("http://127.0.0.1:{port}");
    // The open conversation is saved before stopping and restored on restart, with every engine: the profiles'
    // ones with the on-disk memory (which restores itself), official llama.cpp with the slot saved in
    // `slots/<model>.bin`.
    let (shutdown_post, startup_post) = if disk_memory {
        (Some(PostCall { url: format!("{url}/slots/0?action=persist"), body: String::new(), timeout_s: MEMORY_SAVE_S }), None)
    } else {
        let file = format!("{key}.bin");
        let body = serde_json::json!({ "filename": file }).to_string();
        let restore = slots.join(&file).is_file().then(|| PostCall { url: format!("{url}/slots/0?action=restore"), body: body.clone(), timeout_s: MEMORY_SAVE_S });
        (Some(PostCall { url: format!("{url}/slots/0?action=save"), body, timeout_s: MEMORY_SAVE_S }), restore)
    };
    Ok(EnginePlan {
        key: key.to_string(),
        spec: ProcSpec {
            name: "engine".into(),
            exe,
            args,
            env,
            env_remove: vec![],
            cwd: None,
            health_url: Some(format!("{url}/health")),
            ready_timeout_s: READY_TIMEOUT_S,
            shutdown_post,
            startup_post,
        },
        url,
        label: cfg.label,
        ctx,
        images: mmproj.is_some(),
        gpus_used,
        gguf,
    })
}

/// The profile splits the layers across the GPUs by itself. If it declares the GPUs or the layer map by hand, it
/// wins (explicit override) and the automatic plan touches neither the GPUs nor the context; a profile without
/// `split` uses all the GPUs, with its own `-ts`.
pub(crate) fn auto_split(p: &Profile) -> bool {
    p.split && !p.env.contains_key("CUDA_VISIBLE_DEVICES") && !p.env.contains_key("LLAMA_LAYER_DEVICES")
}

/// The K and V cache types in the profile's arguments (`f16` if it doesn't say).
fn cache_types(p: &Profile) -> (&str, &str) {
    (arg_value(&p.args, &["-ctk", "--cache-type-k"]).unwrap_or("f16"), arg_value(&p.args, &["-ctv", "--cache-type-v"]).unwrap_or("f16"))
}

/// A profile's context and cards on `hw` before starting, when the model may not be on disk yet: with the automatic
/// split what the model's shape in the catalog leaves on the cards (error if it doesn't fit), otherwise the profile's.
/// Without the shape in the catalog the profile's context holds, on all the cards that are left: the plan confirms
/// it, reading the GGUF. `excluded`: the cards lent or left out; `chosen`: the context the user chose, if any.
pub(crate) fn profile_fit(cfg: &catalog::ModelCfg, p: &Profile, hw: &Hardware, excluded: &[u32], chosen: Option<u32>) -> Result<(u32, Vec<Gpu>)> {
    let gpus: Vec<Gpu> = hw.usable().cloned().collect();
    let want = chosen.map_or(p.ctx, |c| c.min(p.ctx));
    if !auto_split(p) {
        return Ok((want, manual_gpus(p, gpus)?));
    }
    let available: Vec<Gpu> = gpus.into_iter().filter(|g| !excluded.contains(&g.index)).collect();
    let (ctk, ctv) = cache_types(p);
    let Some(shape) = cfg.shape(ctk, ctv)? else { return Ok((want, available)) };
    let placement = split::partition(&available, &shape, want, p.mtp.is_some(), cfg.encoder_bytes())?;
    let used = placement_cards(&placement);
    Ok((placement.ctx, used.into_iter().map(|i| available[i].clone()).collect()))
}

/// The cards a profile that declares them by hand uses: those of its `CUDA_VISIBLE_DEVICES`, or all.
fn manual_gpus(p: &Profile, gpus: Vec<Gpu>) -> Result<Vec<Gpu>> {
    let Some(list) = p.env.get("CUDA_VISIBLE_DEVICES") else { return Ok(gpus) };
    list.split(',')
        .map(|s| {
            let i: u32 = s.trim().parse().map_err(|_| {
                user(&tr!("La configurazione delle schede video è errata.", "The graphics card configuration is wrong."), format!("CUDA_VISIBLE_DEVICES={list}"))
            })?;
            gpus.iter().find(|g| g.index == i).cloned().ok_or_else(|| {
                user(
                    &tr!("La configurazione indica una scheda video che non c'è.", "The configuration names a graphics card that isn't there."),
                    format!("CUDA_VISIBLE_DEVICES={list}, GPUs found: {}", gpus.len()),
                )
            })
        })
        .collect()
}

/// The model's cards in order (the main one is CUDA0), then the image encoder's if the model doesn't use it.
fn placement_cards(placement: &split::Placement) -> Vec<usize> {
    let mut used = placement.gpus.clone();
    used.extend(placement.encoder.filter(|e| !used.contains(e)));
    used
}

/// A plan that needs a card lent to another job or left out by the user doesn't start, and says which of the two.
pub(crate) fn check_left(label: &str, used: &[Gpu], lent: &[u32], unused: &[u32]) -> Result<()> {
    let Some(g) = used.iter().find(|g| lent.contains(&g.index) || unused.contains(&g.index)) else { return Ok(()) };
    if unused.contains(&g.index) {
        bail!(
            "{}",
            tr!(
                "Il modello «{}» ha bisogno della scheda {} ({}), che hai segnato come non usata.",
                "The model «{}» needs graphics card {} ({}), which you marked as not used.",
                label,
                g.index,
                g.name
            )
        );
    }
    bail!(
        "{}",
        tr!(
            "Il modello «{}» ha bisogno della scheda {} ({}), che è stata liberata per un altro lavoro.",
            "The model «{}» needs graphics card {} ({}), which has been released for another job.",
            label,
            g.index,
            g.name
        )
    )
}

/// A profile's setup: its GPUs, its context (the profile's, or the user's if smaller), its environment and its
/// arguments. `encoder`: bytes of the image encoder, 0 if the model doesn't read images.
fn profile_parts(
    p: &Profile,
    gguf: &Path,
    encoder: u64,
    hw: &Hardware,
    excluded: &[u32],
    chosen: Option<u32>,
    read_shape: impl FnOnce(&Path, &str, &str) -> Result<split::ModelShape>,
) -> Result<Parts> {
    let manual = !auto_split(p);
    let gpus: Vec<Gpu> = hw.usable().cloned().collect();
    let available: Vec<Gpu> = gpus.iter().filter(|g| !excluded.contains(&g.index)).cloned().collect();
    let mut ctx = chosen.map_or(p.ctx, |c| c.min(p.ctx));
    // The engines (patched forks) turn on CUDA graphs even on Pascal/Turing with this variable.
    let mut env: Vec<(String, String)> =
        vec![("CUDA_DEVICE_ORDER".into(), "PCI_BUS_ID".into()), ("GGML_CUDA_GRAPHS_ANY_ARCH".into(), "1".into())];
    let gpus_used = if manual {
        manual_gpus(p, gpus)?
    } else {
        let (ctk, ctv) = cache_types(p);
        let shape = read_shape(gguf, ctk, ctv)
            .map_err(|e| user(&tr!("Non riesco a leggere il modello.", "I can't read the model."), format!("{}: {e:#}", gguf.display())))?;
        let placement = split::partition(&available, &shape, ctx, p.mtp.is_some(), encoder)?;
        ctx = placement.ctx;
        let used = placement_cards(&placement);
        let visible: Vec<String> = used.iter().map(|&i| available[i].index.to_string()).collect();
        env.push(("CUDA_VISIBLE_DEVICES".into(), visible.join(",")));
        // With a single GPU visible the map isn't needed: the engine puts everything on the only GPU. With the
        // encoder's GPU added it is, so that no layer goes there.
        if used.len() > 1 {
            let map: Vec<String> = placement.layer_devices.iter().map(|d| d.to_string()).collect();
            env.push(("LLAMA_LAYER_DEVICES".into(), map.join(",")));
        }
        if let Some(e) = placement.encoder {
            let pos = used.iter().position(|&i| i == e).expect("the encoder's GPU is among the visible ones");
            env.push(("MTMD_BACKEND_DEVICE".into(), format!("CUDA{pos}")));
        }
        used.into_iter().map(|i| available[i].clone()).collect()
    };
    for (k, v) in &p.env {
        set_env(&mut env, k, v.clone());
    }

    let mut args = p.args.clone();
    if let Some(n) = p.mtp {
        args.extend(["--spec-type".into(), format!("mtp:n_max={n},p_min=0.0")]);
    }
    let mut args_after = Vec::new();
    if let Some(ub) = p.ub {
        args_after.extend(["-ub".into(), ub.to_string()]);
    }
    if let Some(ts) = &p.ts {
        args_after.extend(["-ts".into(), ts.clone()]);
    }
    Ok(Parts { ctx, gpus_used, env, args, args_after, disk_memory: true })
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod choice_tests;
