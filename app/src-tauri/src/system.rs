//! The real `System`: the computer's hardware, the profiles and engines of `engine-cfg`, the downloads
//! of `mango-common`. Each method is a call to those functions and a conversion into the types of
//! `first_run`.

use crate::first_run::{CatalogEntry, Computer, Engine, Gpu, Recommendation, System};
use anyhow::{Context, Result};
use engine_cfg::hardware::{detect, choose_build, Hardware};
use engine_cfg::Origin;
use mango_common::download::{engine_size, install_model, install_engine, installed_engine};
use mango_common::{tr, Build, Paths};

/// The general engine, when no profile applies: the official llama.cpp build.
const GENERAL_ENGINE: &str = "llamacpp";

pub struct Real {
    paths: Paths,
    hw: Hardware,
}

impl Real {
    pub fn new(paths: &Paths) -> Result<Real> {
        let hw = detect().with_context(|| tr!("Non riesco a guardare l'hardware di questo computer", "Cannot look at the hardware of this computer"))?;
        Ok(Real { paths: paths.clone(), hw })
    }

    fn engine(&self, name: &str, build: Build, profile: Option<String>) -> Result<Engine> {
        let installed = installed_engine(&self.paths, name, build).is_some();
        let bytes = if installed { 0 } else { engine_size(&self.paths, name, build)? };
        Ok(Engine::new(name, &build_to_text(build), profile, installed, bytes))
    }
}

/// The computer as the page lists it: the graphics cards a model can use. Integrated graphics with a few hundred MiB
/// (`Hardware::usable`) never run a model and would only look like a card that is not used.
fn computer_of(hw: &Hardware) -> Computer {
    Computer {
        gpus: hw.usable().map(|s| Gpu { name: s.name.clone(), memory_mib: s.memory_mib }).collect(),
        cpu: hw.cpu.name.clone(),
        cores: hw.cpu.cores,
        ram_mib: hw.ram_mib,
    }
}

/// "cuda-12", as in the catalogs and profiles.
fn build_to_text(b: Build) -> String {
    serde_json::to_value(b).ok().and_then(|v| v.as_str().map(String::from)).expect("Build is written as text")
}

fn build_from_text(t: &str) -> Result<Build> {
    serde_json::from_value(serde_json::Value::String(t.into())).with_context(|| tr!("build «{t}» sconosciuta", "unknown build \"{t}\""))
}

impl System for Real {
    fn computer(&self) -> Result<Computer> {
        Ok(computer_of(&self.hw))
    }

    fn catalog(&self) -> Result<Vec<CatalogEntry>> {
        let (entries, _) = engine_cfg::catalog(&self.paths)?;
        Ok(entries.into_iter().map(|v| CatalogEntry { key: v.key, label: v.label, images: v.images, present: v.weights }).collect())
    }

    fn recommendations(&self) -> Result<Vec<Recommendation>> {
        Ok(engine_cfg::recommended(&self.paths, &self.hw)?
            .into_iter()
            .map(|c| Recommendation {
                model: c.model,
                placement: c.placement,
                context: c.context,
                reason: c.reason,
                bytes: c.bytes,
                user: c.origin == Origin::User,
                fastest: c.fastest,
                fallback: c.fallback,
                on_request: c.on_request,
                speed: c.speed,
            })
            .collect())
    }

    fn general_engine(&self) -> Result<Engine> {
        self.engine(GENERAL_ENGINE, choose_build(&self.hw), None)
    }

    fn engine_for(&self, model: &str) -> Result<Engine> {
        match engine_cfg::profile_for(&self.paths, model, &self.hw)? {
            // A per-build profile (`profiles/general/`) names the engine, but is not tuned for these GPUs.
            Some(p) => {
                let id = p.tailored().then_some(p.id);
                self.engine(&p.engine, p.build, id)
            }
            None => self.general_engine(),
        }
    }

    fn download_engine(&self, m: &Engine, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        install_engine(&self.paths, &m.name, build_from_text(&m.build)?, progress).map(|_| ())
    }

    /// Only the files the engine the model will run with on this computer reads.
    fn download_model(&self, model: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        install_model(&self.paths, model, &self.engine_for(model)?.name, progress)
    }
}

/// The system to use: the real one, or in the tests (`MANGO_FAKE_SYSTEM`, development builds only)
/// the one described by a file.
pub fn choose(paths: &Paths) -> Result<Box<dyn System>> {
    #[cfg(debug_assertions)]
    if let Some(f) = std::env::var_os("MANGO_FAKE_SYSTEM") {
        return Ok(Box::new(crate::fake::FakeSystem::from_file(std::path::Path::new(&f), paths)?));
    }
    Ok(Box::new(Real::new(paths)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_cfg::{Cpu, Gpu as Card, Vendor};

    #[test]
    fn integrated_graphics_under_2_gib_is_not_listed_among_the_cards() {
        let card = |index, name: &str, vendor, memory_mib| Card { index, name: name.into(), vendor, memory_mib, cuda_driver: None, cc: None };
        let hw = Hardware {
            gpus: vec![card(0, "NVIDIA GeForce GTX 1660 SUPER", Vendor::Nvidia, 6144), card(1, "Intel(R) UHD Graphics 630", Vendor::Intel, 128)],
            cpu: Cpu { name: "Intel Core i7".into(), cores: 8, avx2: true, avx512: false },
            ram_mib: 16384,
        };
        let c = computer_of(&hw);
        assert_eq!(c.gpus.iter().map(|g| (g.name.as_str(), g.memory_mib)).collect::<Vec<_>>(), [("NVIDIA GeForce GTX 1660 SUPER", 6144)]);
        // a PC with only the integrated one lists no card: the page says there is none and the processor is used
        let only = Hardware { gpus: vec![card(0, "Intel(R) UHD Graphics 630", Vendor::Intel, 128)], ..hw };
        assert!(computer_of(&only).gpus.is_empty());
    }
}
