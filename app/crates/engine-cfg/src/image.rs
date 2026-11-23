//! How a model that makes images is started on this computer: the program of the image engine, the model's files and
//! the graphics card it draws on.

use crate::catalog::{image_build, load_models, model_cfg, ModelCfg, IMAGE_ENGINE};
use crate::choices;
use crate::general::Placement;
use crate::hardware::{Gpu, Hardware, Vendor};
use crate::user;
use anyhow::Result;
use mango_common::download::installed_program;
use mango_common::{tr, Build, Paths, ProcSpec};
use serde::Serialize;
use std::sync::Mutex;

/// The server answers within a second or two: it loads the model at the first picture, not when it starts.
const READY_TIMEOUT_S: u64 = 60;

/// A model that makes images, ready to be started.
#[derive(Debug, Clone, PartialEq)]
pub struct ImagePlan {
    /// Model key in mango-models.json.
    pub key: String,
    /// Model name for the interface.
    pub label: String,
    pub spec: ProcSpec,
    /// E.g. "http://127.0.0.1:8090".
    pub url: String,
    /// The cards the engine may draw on: the one chosen for it with CUDA, all of them with Vulkan (the engine picks
    /// one by itself), none on the processor. They are the cards a model that writes has to leave meanwhile.
    pub gpus: Vec<Gpu>,
    /// The values whoever made the model gives for it.
    pub steps: u32,
    pub cfg_scale: f64,
}

/// A model that makes images, for whoever lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageEntry {
    pub key: String,
    pub label: String,
    pub license: Option<String>,
    /// The bytes of its files.
    pub bytes: u64,
    /// Its files and the image engine for this computer are on disk: a picture can be asked.
    pub ready: bool,
}

/// The models that make images, the catalog's default first and then by key, and the default's key: the one the user
/// chose (`choices::set_image_default`) or, without a choice, the catalog's; another that is on this computer when
/// that one is not (`default_here`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageCatalog {
    pub models: Vec<ImageEntry>,
    pub default: Option<String>,
}

pub fn image_models(paths: &Paths, hw: &Hardware) -> Result<ImageCatalog> {
    let file = load_models(paths)?;
    let default = default_of(paths, &file);
    let engine = installed_program(paths, IMAGE_ENGINE, image_build(hw)).is_some();
    let mut models = Vec::new();
    for key in file.models.keys().filter(|k| file.is_image(k)) {
        let cfg = model_cfg(&file, key)?;
        let on_disk = files_on_disk(paths, &cfg);
        models.push(ImageEntry { key: key.clone(), label: cfg.label.clone(), license: cfg.license.clone(), bytes: files_bytes(&cfg), ready: engine && on_disk });
    }
    models.sort_by_key(|m| file.image_default.as_ref() != Some(&m.key));
    let default = default_here(default, models.iter().map(|m| (m.key.as_str(), m.ready)));
    Ok(ImageCatalog { models, default })
}

/// The model a picture is made with when the request names none: `wanted` (the user's choice, otherwise the catalog's)
/// when it is on this computer, otherwise the first of the list that is. With none here it stays `wanted`: the answer
/// to a request then says which model to get.
fn default_here<'a>(wanted: Option<String>, mut models: impl Iterator<Item = (&'a str, bool)> + Clone) -> Option<String> {
    let here = |key: &str| models.clone().any(|(k, ready)| ready && k == key);
    match &wanted {
        Some(key) if here(key) => wanted,
        _ => models.find(|(_, ready)| *ready).map(|(key, _)| key.to_string()).or(wanted),
    }
}

/// The user's choice of default, if it is still a model that makes images; otherwise the catalog's. A choices file that
/// cannot be read does not stop the models from being listed or a picture from being asked: its choice of default is
/// ignored, with a line in the log (once, not at every look). The plans and verdicts of the models that write still
/// report that file as an error.
fn default_of(paths: &Paths, file: &crate::catalog::ModelsFile) -> Option<String> {
    let chosen = match choices::read(paths) {
        Ok(c) => {
            *IGNORED.lock().unwrap_or_else(|e| e.into_inner()) = None;
            c.image_default
        }
        Err(e) => {
            let said = format!("{}: {e:#}", paths.data.display());
            let mut last = IGNORED.lock().unwrap_or_else(|e| e.into_inner());
            if last.as_deref() != Some(&said) {
                mango_common::startup_log(paths, &format!("image models: the choices are not read, the catalog's default model is used: {e:#}"));
                *last = Some(said);
            }
            None
        }
    };
    chosen.filter(|k| file.is_image(k)).or_else(|| file.image_default.clone())
}

/// What the log was last told about a choices file that cannot be read: the lists are asked for every second or so.
static IGNORED: Mutex<Option<String>> = Mutex::new(None);

fn files_on_disk(paths: &Paths, cfg: &ModelCfg) -> bool {
    cfg.files.iter().all(|f| mango_common::model_files::listed(&paths.models.join(&f.path)).is_some_and(|m| m.is_file()))
}

fn files_bytes(cfg: &ModelCfg) -> u64 {
    cfg.files.iter().map(|f| f.size).sum()
}

/// Where a picture is drawn on this computer: the cards of its plan, or the processor when it has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Draws {
    pub placement: Placement,
    pub gpus: Vec<String>,
}

/// A model that makes images for the settings, as `ModelView` is for one that writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageView {
    pub key: String,
    pub label: String,
    /// The catalog's line in the app's language; empty if the model has none.
    pub about: String,
    pub license: Option<String>,
    /// Its files and the image engine are on disk: a picture can be asked.
    pub present: bool,
    /// What a download brings here: its files and the image engine, those that are not on the disk yet. For a model that
    /// is there, what its files weigh.
    pub bytes: u64,
    /// Where it draws (`cards`). Whether it fits is not told: what these models ask of a card and of the processor is not
    /// measured.
    #[serde(rename = "where")]
    pub place: Draws,
}

/// The models that make images with the one used by default, for the settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageViews {
    pub models: Vec<ImageView>,
    pub default: Option<String>,
}

pub fn image_views(paths: &Paths, hw: &Hardware) -> Result<ImageViews> {
    let file = load_models(paths)?;
    let default = default_of(paths, &file);
    let build = image_build(hw);
    let installed = installed_program(paths, IMAGE_ENGINE, build).is_some();
    let gpus: Vec<String> = cards(hw, build).into_iter().map(|g| g.name).collect();
    let place = Draws { placement: if gpus.is_empty() { Placement::Cpu } else { Placement::Gpu }, gpus };
    let mut models = Vec::new();
    for key in file.models.keys().filter(|k| file.is_image(k)) {
        let cfg = model_cfg(&file, key)?;
        let weights = files_on_disk(paths, &cfg);
        let present = installed && weights;
        let bytes = if present {
            files_bytes(&cfg)
        } else {
            // An engine catalog that cannot be read counts nothing here: the download itself says why it can't start.
            let engine = mango_common::download::engine_size(paths, IMAGE_ENGINE, build).unwrap_or(0);
            engine + if weights { 0 } else { files_bytes(&cfg) }
        };
        models.push(ImageView {
            key: key.clone(),
            about: cfg.about.as_ref().map_or_else(String::new, |a| a.text().to_string()),
            label: cfg.label,
            license: cfg.license,
            present,
            bytes,
            place: place.clone(),
        });
    }
    models.sort_by_key(|m| file.image_default.as_ref() != Some(&m.key));
    let default = default_here(default, models.iter().map(|m| (m.key.as_str(), m.present)));
    Ok(ImageViews { models, default })
}

/// The plan for `key` on this computer, with the engine's server on `port`.
pub fn image_plan(paths: &Paths, key: &str, port: u16) -> Result<ImagePlan> {
    image_plan_for(paths, key, port, &crate::hardware::detect()?)
}

pub fn image_plan_for(paths: &Paths, key: &str, port: u16, hw: &Hardware) -> Result<ImagePlan> {
    let file = load_models(paths)?;
    let cfg = model_cfg(&file, key)?;
    let Some(image) = cfg.image else {
        return Err(user(&tr!("Il modello «{}» non fa immagini.", "The model «{}» does not make images.", cfg.label), format!("«{key}» has no «image»")));
    };
    let build = image_build(hw);
    let exe = installed_program(paths, IMAGE_ENGINE, build).ok_or_else(|| {
        user(
            &tr!("Il motore delle immagini non è ancora su questo computer.", "The image engine is not on this computer yet."),
            format!("engine «{IMAGE_ENGINE}» ({build}) is not installed"),
        )
    })?;
    let files = [&image.diffusion, &image.encoder, &image.vae].map(|rel| paths.models.join(rel));
    if let Some(missing) = files.iter().find(|f| !mango_common::model_files::listed(f).is_some_and(|m| m.is_file())) {
        return Err(user(
            &tr!("Il modello «{}» non è ancora su questo computer.", "The model «{}» is not on this computer yet.", cfg.label),
            format!("missing {}", missing.display()),
        ));
    }
    let [diffusion, encoder, vae] = files.map(|f| f.display().to_string());

    let gpus = cards(hw, build);
    let env = match build.cuda_major() {
        Some(_) => vec![
            ("CUDA_DEVICE_ORDER".to_string(), "PCI_BUS_ID".to_string()),
            ("CUDA_VISIBLE_DEVICES".to_string(), gpus.iter().map(|g| g.index.to_string()).collect::<Vec<_>>().join(",")),
        ],
        None => Vec::new(),
    };
    let url = format!("http://127.0.0.1:{port}");
    Ok(ImagePlan {
        key: key.to_string(),
        label: cfg.label,
        spec: ProcSpec {
            name: "image".to_string(),
            cwd: exe.parent().map(std::path::Path::to_path_buf),
            exe,
            // The weights stay in RAM and each part goes on the card when it is used: on a card of 8 GB it is as fast
            // as keeping them all there, and takes about half the memory.
            args: ["--diffusion-model", &diffusion, "--llm", &encoder, "--vae", &vae, "--offload-to-cpu", "--listen-ip", "127.0.0.1", "--listen-port", &port.to_string()]
                .map(String::from)
                .to_vec(),
            env,
            env_remove: Vec::new(),
            health_url: Some(format!("{url}/sdcpp/v1/models/status")),
            ready_timeout_s: READY_TIMEOUT_S,
            shutdown_post: None,
            startup_post: None,
        },
        url,
        gpus,
        steps: image.steps,
        cfg_scale: image.cfg_scale,
    })
}

/// The cards for a picture. With CUDA one NVIDIA card: one with tensor cores before one without (the engine's fast
/// paths count on them), then the one with more memory. With Vulkan all the usable ones: the engine picks.
fn cards(hw: &Hardware, build: Build) -> Vec<Gpu> {
    match build {
        Build::Cpu => Vec::new(),
        Build::Vulkan => hw.usable().cloned().collect(),
        Build::Cuda12 | Build::Cuda12Gtx16 | Build::Cuda13 => hw
            .usable()
            .filter(|g| g.vendor == Vendor::Nvidia)
            .max_by_key(|g| (g.has_tensor_cores(), g.memory_mib, std::cmp::Reverse(g.index)))
            .cloned()
            .into_iter()
            .collect(),
    }
}
