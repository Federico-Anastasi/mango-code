//! The routes for pictures, under `/control/image` on the control server (the engine manager's port, on this
//! computer only): what the interface and the other apps of the computer call. Errors have the shape of the other
//! routes there (`{"error": {"message", "type"}}`).
//!
//! * `GET /control/image` → `{ models, default, loaded, jobs }`: the models that make images as `models` reads them,
//!   the model of the engine that stayed on, the jobs that are remembered.
//! * `POST /control/image/generate` `{ prompt, width, height, model?, seed?, stay_on?, file? }` → 202 and the job
//!   (`JobView`). Without `model`, the default one. `stay_on`: the engine stays on after the picture. `file`: an
//!   absolute path the picture is also written to; a file that is there is never replaced (the picture takes the next
//!   free name, and the job's `file` says which).
//! * `GET /control/image/jobs/<id>` → the job, with the small picture of the step it is at (`preview`).
//! * `GET /control/image/jobs/<id>/picture` → `{ "png": <base64> }` once the job is `done`.
//! * `POST /control/image/jobs/<id>/cancel` → the job, which ends as `cancelled` within a moment.
//! * `POST /control/image/unload` → stops the engine that stayed on; the answer is that of `GET /control/image`.

use crate::jobs::{Jobs, Status};
use crate::{ImageManager, Request};
use anyhow::Result;
use base64::Engine;
use mango_common::tr;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// The models that make images on this computer and the default one: `{ "models": [...], "default": key | null }`.
pub type Models = dyn Fn() -> Result<Value> + Send + Sync;

/// The largest side of a picture: beyond it no model of the catalog draws.
const MAX_SIDE: u32 = 4096;

pub struct Routes {
    jobs: Jobs,
    models: Box<Models>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Asked {
    prompt: String,
    width: u32,
    height: u32,
    model: Option<String>,
    seed: Option<u32>,
    #[serde(default)]
    stay_on: bool,
    file: Option<PathBuf>,
}

impl Routes {
    pub fn new(manager: ImageManager, models: Box<Models>) -> Routes {
        Routes { jobs: Jobs::new(manager), models }
    }

    /// The engine of the pictures: who shows its state or takes a model off the computer asks it.
    pub fn manager(&self) -> &ImageManager {
        self.jobs.manager()
    }

    /// Gets a model ready to be taken off the computer: its pictures that are asked or being made are stopped, new ones
    /// are refused until the answer is dropped, and its engine is off. See `ImageManager::retire`.
    pub fn retire(&self, model: &str) -> Result<crate::Retired> {
        self.jobs.manager().retire(model, &|| self.jobs.stop_model(model))
    }

    /// The status and the JSON for a request; `None` if the path is not one of these routes.
    pub fn handle(&self, method: &str, path: &str, body: &[u8]) -> Option<(u16, Value)> {
        let rest = path.strip_prefix("/control/image")?;
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        Some(match (method, parts.as_slice()) {
            ("GET", []) => self.state(),
            ("POST", ["unload"]) => {
                self.jobs.manager().unload();
                self.state()
            }
            ("POST", ["generate"]) => self.generate(body),
            ("GET", ["jobs", id]) => self.jobs.view(id, true).map_or_else(no_job, |job| (200, json!(job))),
            ("GET", ["jobs", id, "picture"]) => match (self.jobs.picture(id), self.jobs.view(id, false)) {
                (Some(png), _) => (200, json!({ "png": base64::engine::general_purpose::STANDARD.encode(png) })),
                (None, Some(job)) if job.status == Status::Done => (410, error(&tr!("L'immagine di questo lavoro non è più in memoria.", "The picture of this job is no longer in memory."))),
                (None, Some(_)) => (409, error(&tr!("L'immagine non è ancora fatta.", "The picture is not made yet."))),
                (None, None) => no_job(),
            },
            ("POST", ["jobs", id, "cancel"]) => self.jobs.cancel(id).map_or_else(no_job, |job| (200, json!(job))),
            _ => (404, error(&tr!("rotta sconosciuta: {path}", "unknown route: {path}"))),
        })
    }

    fn state(&self) -> (u16, Value) {
        match (self.models)() {
            Ok(mut models) => {
                models["loaded"] = json!(self.jobs.manager().loaded());
                models["jobs"] = json!(self.jobs.views());
                (200, models)
            }
            Err(e) => (500, error(&format!("{e:#}"))),
        }
    }

    fn generate(&self, body: &[u8]) -> (u16, Value) {
        let asked: Asked = match serde_json::from_slice(body) {
            Ok(a) => a,
            Err(e) => return (400, error(&tr!("richiesta non valida: {e}", "the request is not valid: {e}"))),
        };
        if asked.prompt.trim().is_empty() {
            return (400, error(&tr!("manca la richiesta («prompt»)", "the request («prompt») is missing")));
        }
        if !(1..=MAX_SIDE).contains(&asked.width) || !(1..=MAX_SIDE).contains(&asked.height) {
            return (400, error(&tr!("«width» e «height» vanno da 1 a {MAX_SIDE}", "«width» and «height» go from 1 to {MAX_SIDE}")));
        }
        if asked.file.as_ref().is_some_and(|f| !f.is_absolute()) {
            return (400, error(&tr!("«file» deve essere un percorso assoluto", "«file» must be an absolute path")));
        }
        let model = match asked.model {
            Some(model) => model,
            None => match (self.models)().map(|m| m["default"].as_str().map(str::to_string)) {
                Ok(Some(model)) => model,
                Ok(None) => return (400, error(&tr!("manca «model», e non c'è un modello di immagini predefinito", "«model» is missing, and there is no default image model"))),
                Err(e) => return (500, error(&format!("{e:#}"))),
            },
        };
        let request = Request { model, prompt: asked.prompt, width: asked.width, height: asked.height, seed: asked.seed, stay_on: asked.stay_on };
        (202, json!(self.jobs.submit(request, asked.file)))
    }
}

fn no_job() -> (u16, Value) {
    (404, error(&tr!("Questo lavoro non c'è, o è troppo vecchio.", "There is no such job, or it is too old.")))
}

fn error(message: &str) -> Value {
    json!({ "error": { "message": message, "type": "mango_image" } })
}
