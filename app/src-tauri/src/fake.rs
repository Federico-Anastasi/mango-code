//! A `System` for the tests: hardware, catalog and recommendations are in a JSON file, and the downloads
//! are real, from a local server. The files arrive where the app would look for them (models in
//! `paths.models`, engines in `paths.engines`): a model is "present" and an engine "installed" if
//! their file is there. Development builds only (see `system::choose`).

use crate::first_run::{CatalogEntry, Computer, Engine, Recommendation, System};
use anyhow::{bail, Context, Result};
use mango_common::Paths;
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub struct FakeSystem {
    computer: Computer,
    recommendations: Vec<Recommendation>,
    models: Vec<FakeModel>,
    engines: Vec<FakeEngine>,
    /// The name of the general engine, among `engines`.
    general: String,
    #[serde(skip)]
    paths: Option<Paths>,
}

#[derive(Deserialize)]
struct FakeModel {
    key: String,
    label: String,
    images: bool,
    /// Relative to `paths.models`.
    file: String,
    url: String,
    /// The name of its engine, among `engines`.
    engine: String,
    profile: Option<String>,
}

#[derive(Deserialize)]
struct FakeEngine {
    name: String,
    build: String,
    bytes: u64,
    /// Relative to `paths.engines`.
    file: String,
    url: String,
}

impl FakeSystem {
    pub fn from_file(f: &Path, paths: &Paths) -> Result<FakeSystem> {
        let text = std::fs::read_to_string(f).with_context(|| format!("reading {}", f.display()))?;
        let mut fake: FakeSystem = serde_json::from_str(&text)
            .with_context(|| format!("{} is not a valid fake system", f.display()))?;
        fake.paths = Some(paths.clone());
        Ok(fake)
    }

    fn paths(&self) -> &Paths {
        self.paths.as_ref().expect("from_file sets the paths")
    }

    fn engine(&self, name: &str, profile: Option<String>) -> Result<Engine> {
        let m = self
            .engines
            .iter()
            .find(|m| m.name == name)
            .with_context(|| format!("unknown fake engine \"{name}\""))?;
        let installed = self.paths().engines.join(&m.file).is_file();
        Ok(Engine::new(&m.name, &m.build, profile, installed, if installed { 0 } else { m.bytes }))
    }
}

/// Downloads `url` into `dest` through `dest.part`; `progress(done, total)` at every chunk.
fn download(url: &str, dest: &PathBuf, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let response = mango_common::internet::config(url).build();
    let response = ureq::Agent::new_with_config(response).get(url).call().with_context(|| format!("GET {url}"))?;
    let total: u64 = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    if let Some(folder) = dest.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let partial = dest.with_extension("part");
    let mut file = std::fs::File::create(&partial)?;
    let mut reader = response.into_body().into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        progress(done, total);
    }
    if total != 0 && done != total {
        bail!("{url}: received {done} bytes out of {total}");
    }
    drop(file);
    std::fs::rename(&partial, dest).with_context(|| format!("renaming {}", partial.display()))
}

impl System for FakeSystem {
    fn computer(&self) -> Result<Computer> {
        Ok(self.computer.clone())
    }

    fn catalog(&self) -> Result<Vec<CatalogEntry>> {
        Ok(self
            .models
            .iter()
            .map(|m| CatalogEntry {
                key: m.key.clone(),
                label: m.label.clone(),
                images: m.images,
                present: self.paths().models.join(&m.file).is_file(),
            })
            .collect())
    }

    fn recommendations(&self) -> Result<Vec<Recommendation>> {
        Ok(self.recommendations.clone())
    }

    fn general_engine(&self) -> Result<Engine> {
        self.engine(&self.general, None)
    }

    fn engine_for(&self, model: &str) -> Result<Engine> {
        let m = self
            .models
            .iter()
            .find(|m| m.key == model)
            .with_context(|| format!("unknown fake model \"{model}\""))?;
        self.engine(&m.engine, m.profile.clone())
    }

    fn download_engine(&self, engine: &Engine, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        let m = self
            .engines
            .iter()
            .find(|m| m.name == engine.name)
            .with_context(|| format!("unknown fake engine \"{}\"", engine.name))?;
        download(&m.url, &self.paths().engines.join(&m.file), progress)
    }

    fn download_model(&self, model: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        let m = self
            .models
            .iter()
            .find(|m| m.key == model)
            .with_context(|| format!("unknown fake model \"{model}\""))?;
        download(&m.url, &self.paths().models.join(&m.file), progress)
    }
}
