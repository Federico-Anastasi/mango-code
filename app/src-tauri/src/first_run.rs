//! First run: what is missing to start a model on this computer, what to propose to the user and
//! what to download. Only the logic is here; the page and the events are in `choice.rs`, and everything
//! that touches the computer or the network goes through the `System` trait (`system.rs`).

use anyhow::{bail, Context, Result};
use engine_cfg::{Placement, Speed};
use mango_common::tr;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gpu {
    pub name: String,
    pub memory_mib: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Computer {
    pub gpus: Vec<Gpu>,
    pub cpu: String,
    pub cores: u32,
    pub ram_mib: u64,
}

/// An engine (the program that runs the model) for a kind of hardware: what gets downloaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Engine {
    /// "llamacpp" for the general engine, otherwise the engine name of an optimized profile.
    pub name: String,
    /// "cpu", "vulkan", "cuda-12" or "cuda-13".
    pub build: String,
    /// The optimized profile the choice comes from; `None` = general engine.
    pub profile: Option<String>,
    pub installed: bool,
    /// How much is left to download if it is missing.
    pub bytes: u64,
    /// For the user: "llama.cpp for NVIDIA graphics cards (CUDA 12)".
    pub label: String,
}

impl Engine {
    pub fn new(name: &str, build: &str, profile: Option<String>, installed: bool, bytes: u64) -> Engine {
        let program = if name == "llamacpp" { "llama.cpp" } else { name };
        let target = match build {
            "cpu" => tr!("il processore", "the processor"),
            "vulkan" => tr!("le schede video (Vulkan)", "graphics cards (Vulkan)"),
            "cuda-12" => tr!("le schede NVIDIA (CUDA 12)", "NVIDIA graphics cards (CUDA 12)"),
            "cuda-13" => tr!("le schede NVIDIA (CUDA 13)", "NVIDIA graphics cards (CUDA 13)"),
            other => other.to_string(),
        };
        Engine {
            name: name.into(),
            build: build.into(),
            profile,
            installed,
            bytes,
            label: tr!("{program} per {target}", "{program} for {target}"),
        }
    }

    fn same_as(&self, other: &Engine) -> bool {
        self.name == other.name && self.build == other.build
    }
}

/// A catalog model, as it is on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub key: String,
    pub label: String,
    pub images: bool,
    /// Weights (and image encoder) on disk.
    pub present: bool,
}

/// Whether the model fits in this computer, where and with what context, and how much it weighs to download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recommendation {
    pub model: String,
    /// All on the GPUs or all on the CPU; `None` if it does not fit.
    pub placement: Option<Placement>,
    pub context: u32,
    pub reason: String,
    pub bytes: u64,
    /// Comes from the user's list, not from the Mango Code catalog.
    #[serde(default)]
    pub user: bool,
    /// Among the recommended ones that fit, probably the fastest.
    #[serde(default)]
    pub fastest: bool,
    /// A model for small graphics cards: recommended only when no other one fits on the cards.
    #[serde(default)]
    pub fallback: bool,
    /// Only on request: in the list, never the one proposed.
    #[serde(default)]
    pub on_request: bool,
    /// How fast it writes, when it runs on the processor.
    #[serde(default)]
    pub speed: Option<Speed>,
}

/// The computer and the disk, seen from outside: the part that the tests replace.
pub trait System: Send + Sync {
    fn computer(&self) -> Result<Computer>;
    /// The local models of the catalog.
    fn catalog(&self) -> Result<Vec<CatalogEntry>>;
    /// One recommendation for each catalog model, best first.
    fn recommendations(&self) -> Result<Vec<Recommendation>>;
    /// The general engine for this computer.
    fn general_engine(&self) -> Result<Engine>;
    /// The engine a model needs: the one of its profile if it applies, otherwise the general one.
    fn engine_for(&self, model: &str) -> Result<Engine>;
    /// `progress(done, total)` in bytes.
    fn download_engine(&self, engine: &Engine, progress: &mut dyn FnMut(u64, u64)) -> Result<()>;
    fn download_model(&self, model: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()>;
}

/// A model as the choice page sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Model {
    pub key: String,
    pub label: String,
    pub images: bool,
    pub present: bool,
    /// Weight of all its files.
    pub bytes: u64,
    /// Where it runs; `None` if it does not fit (and then it cannot be chosen).
    pub placement: Option<Placement>,
    pub context: u32,
    /// Why it fits (and how) or why it does not.
    pub reason: String,
    pub fastest: bool,
    pub engine: Engine,
    /// Comes from the user's list: never recommended.
    pub user: bool,
    /// The one to propose: the first Mango Code recommendation that fits and is not ready yet.
    pub recommended: bool,
    /// See `Recommendation::fallback`.
    pub fallback: bool,
    /// See `Recommendation::on_request`.
    pub on_request: bool,
    /// See `Recommendation::speed`.
    pub speed: Option<Speed>,
}

impl Model {
    fn ready(&self) -> bool {
        self.present && self.engine.installed
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Assessment {
    pub computer: Computer,
    pub engine: Engine,
    pub models: Vec<Model>,
}

impl Assessment {
    /// At least one model can be started now: weights and engine on disk.
    pub fn ready(&self) -> bool {
        self.models.iter().any(Model::ready)
    }

    /// What is missing, in a sentence for the user.
    pub fn missing(&self) -> String {
        if self.models.iter().any(|m| m.present) {
            tr!(
                "Il motore per questo computer ({}) non è ancora installato.",
                "The engine for this computer ({}) is not installed yet.",
                self.engine.label
            )
        } else {
            tr!("Non c'è ancora nessun modello sul computer.", "There is no model on this computer yet.")
        }
    }
}

pub fn assess(s: &dyn System) -> Result<Assessment> {
    let computer = s.computer()?;
    let entries = s.catalog()?;
    let recommendations = s.recommendations()?;
    let engine = s.general_engine()?;
    let mut models = Vec::new();
    for c in recommendations {
        let v = entries
            .iter()
            .find(|v| v.key == c.model)
            .with_context(|| tr!("il modello «{}» è consigliato ma non è nel catalogo", "the model \"{}\" is recommended but is not in the catalog", c.model))?;
        models.push(Model {
            key: v.key.clone(),
            label: v.label.clone(),
            images: v.images,
            present: v.present,
            bytes: c.bytes,
            placement: c.placement,
            context: c.context,
            reason: c.reason,
            fastest: c.fastest,
            engine: s.engine_for(&v.key)?,
            user: c.user,
            recommended: false,
            fallback: c.fallback,
            on_request: c.on_request,
            speed: c.speed,
        });
    }
    // The first one to download that fits on the GPUs; on the CPU only if none fits on the GPUs. A model for small
    // cards only if no other one fits on the cards, downloaded or not.
    let others_on_cards =
        models.iter().any(|m| !m.user && !m.on_request && !m.fallback && m.placement == Some(Placement::Gpu));
    let candidate =
        |m: &Model| !m.user && !m.on_request && m.placement.is_some() && !m.ready() && !(m.fallback && others_on_cards);
    let chosen = models
        .iter()
        .position(|m| candidate(m) && m.placement == Some(Placement::Gpu))
        .or_else(|| models.iter().position(candidate));
    if let Some(i) = chosen {
        models[i].recommended = true;
    }
    Ok(Assessment { computer, engine, models })
}

/// One step of the download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Engine(Engine),
    Model { key: String, label: String },
}

/// What to download to have the chosen models: their engines (only one if they share it) and the
/// missing weights. Empty if everything is already there.
pub fn plan(v: &Assessment, chosen: &[String]) -> Result<Vec<Step>> {
    if chosen.is_empty() {
        bail!("{}", tr!("Non hai scelto nessun modello.", "You have not chosen any model."));
    }
    let mut engines: Vec<Step> = Vec::new();
    let mut weights: Vec<Step> = Vec::new();
    for key in chosen {
        let m = v
            .models
            .iter()
            .find(|m| &m.key == key)
            .with_context(|| tr!("il modello «{key}» non è nel catalogo", "the model \"{key}\" is not in the catalog"))?;
        if m.placement.is_none() {
            bail!("{}", tr!("«{}» non ci sta in questo computer: {}", "\"{}\" does not fit in this computer: {}", m.label, m.reason));
        }
        if !m.engine.installed && !engines.iter().any(|p| matches!(p, Step::Engine(x) if x.same_as(&m.engine))) {
            engines.push(Step::Engine(m.engine.clone()));
        }
        if !m.present && !weights.iter().any(|p| matches!(p, Step::Model { key: k, .. } if k == key)) {
            weights.push(Step::Model { key: key.clone(), label: m.label.clone() });
        }
    }
    engines.extend(weights);
    Ok(engines)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Waiting,
    InProgress,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepView {
    pub name: String,
    pub state: StepState,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub steps: Vec<StepView>,
}

/// How long between two progress updates: the download signals every
/// small chunk, the page does not need that many.
const UPDATE_EVERY: Duration = Duration::from_millis(150);

/// Runs the plan, one step after the other. `show` receives the progress at the start, at every
/// step change and, during a download, at intervals. At the first error it stops: what has already arrived stays.
pub fn run(s: &dyn System, plan: &[Step], show: &mut dyn FnMut(&Progress)) -> Result<()> {
    let mut progress = Progress {
        steps: plan
            .iter()
            .map(|p| StepView {
                name: match p {
                    Step::Engine(m) => tr!("Motore: {}", "Engine: {}", m.label),
                    Step::Model { label, .. } => label.clone(),
                },
                state: StepState::Waiting,
                done: 0,
                total: 0,
            })
            .collect(),
    };
    show(&progress);
    for (i, p) in plan.iter().enumerate() {
        progress.steps[i].state = StepState::InProgress;
        show(&progress);
        let mut last = Instant::now();
        let mut on_bytes = |done: u64, total: u64| {
            progress.steps[i].done = done;
            progress.steps[i].total = total;
            if last.elapsed() >= UPDATE_EVERY {
                last = Instant::now();
                show(&progress);
            }
        };
        match p {
            Step::Engine(m) => s
                .download_engine(m, &mut on_bytes)
                .with_context(|| tr!("Scaricamento del motore ({})", "Downloading the engine ({})", m.label)),
            Step::Model { key, label } => s
                .download_model(key, &mut on_bytes)
                .with_context(|| tr!("Scaricamento del modello {label}", "Downloading the model {label}")),
        }?;
        progress.steps[i].done = progress.steps[i].total;
        progress.steps[i].state = StepState::Done;
        show(&progress);
    }
    Ok(())
}

// --- the choice, remembered between one start and the next ------------------------------------

#[derive(Serialize, Deserialize)]
struct Remembered {
    chosen: Vec<String>,
}

fn choice_file(data: &Path) -> PathBuf {
    data.join("first-run.json")
}

/// Written before starting to download: if the app closes halfway, at the next start the
/// download resumes by itself with the same models.
pub fn remember_choice(data: &Path, chosen: &[String]) -> Result<()> {
    let f = choice_file(data);
    mango_common::write_atomic(&f, serde_json::to_string_pretty(&Remembered { chosen: chosen.to_vec() })?)
        .with_context(|| tr!("scrittura di {}", "writing {}", f.display()))
}

pub fn remembered_choice(data: &Path) -> Option<Vec<String>> {
    let f = choice_file(data);
    let text = std::fs::read_to_string(&f).ok()?;
    match serde_json::from_str::<Remembered>(&text) {
        Ok(r) if !r.chosen.is_empty() => Some(r.chosen),
        _ => {
            // An unreadable note is not worth stopping the startup: the choice is proposed again.
            eprintln!("{} is not readable: ignoring it", f.display());
            None
        }
    }
}

pub fn forget_choice(data: &Path) {
    let _ = std::fs::remove_file(choice_file(data));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// An in-memory computer: what is on disk and what would be downloaded, without touching anything.
    struct TestSystem {
        entries: Vec<CatalogEntry>,
        recommendations: Vec<Recommendation>,
        /// The engine of each model, in the order of `entries`.
        engines: Vec<Engine>,
        general: Engine,
        /// What has been downloaded, in order.
        downloaded: Mutex<Vec<String>>,
        /// The step (from 0) that fails.
        fails_at: Option<usize>,
        pause: Duration,
    }

    fn cuda(installed: bool) -> Engine {
        Engine::new("llamacpp", "cuda-12", None, installed, if installed { 0 } else { 200 })
    }

    fn entry(key: &str, present: bool) -> CatalogEntry {
        CatalogEntry { key: key.into(), label: format!("Modello {key}"), images: false, present }
    }

    fn advice(key: &str, fits: bool) -> Recommendation {
        let (placement, reason) = if fits { (Some(Placement::Gpu), String::new()) } else { (None, "too big".into()) };
        Recommendation { model: key.into(), placement, context: 32768, reason, bytes: 1000, user: false, fastest: false, fallback: false, on_request: false, speed: None }
    }

    /// Three models (a, b, c): c does not fit. Nothing on disk, general engine to download.
    fn empty() -> TestSystem {
        TestSystem {
            entries: vec![entry("a", false), entry("b", false), entry("c", false)],
            recommendations: vec![advice("a", true), advice("b", true), advice("c", false)],
            engines: vec![cuda(false), cuda(false), cuda(false)],
            general: cuda(false),
            downloaded: Mutex::new(Vec::new()),
            fails_at: None,
            pause: Duration::ZERO,
        }
    }

    impl System for TestSystem {
        fn computer(&self) -> Result<Computer> {
            Ok(Computer { gpus: vec![Gpu { name: "NVIDIA Fake".into(), memory_mib: 8192 }], cpu: "Fake CPU".into(), cores: 8, ram_mib: 32768 })
        }
        fn catalog(&self) -> Result<Vec<CatalogEntry>> {
            Ok(self.entries.clone())
        }
        fn recommendations(&self) -> Result<Vec<Recommendation>> {
            Ok(self.recommendations.clone())
        }
        fn general_engine(&self) -> Result<Engine> {
            Ok(self.general.clone())
        }
        fn engine_for(&self, model: &str) -> Result<Engine> {
            let i = self.entries.iter().position(|v| v.key == model).context("unknown model")?;
            Ok(self.engines[i].clone())
        }
        fn download_engine(&self, m: &Engine, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
            self.download(format!("engine {}", m.label), progress)
        }
        fn download_model(&self, model: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
            self.download(format!("model {model}"), progress)
        }
    }

    impl TestSystem {
        fn download(&self, what: String, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
            let n = self.downloaded.lock().unwrap().len();
            if self.fails_at == Some(n) {
                bail!("network down");
            }
            progress(50, 100);
            std::thread::sleep(self.pause);
            progress(100, 100);
            self.downloaded.lock().unwrap().push(what);
            Ok(())
        }
    }

    fn chosen(k: &[&str]) -> Vec<String> {
        k.iter().map(|s| s.to_string()).collect()
    }

    fn recommended_keys(v: &Assessment) -> Vec<&str> {
        v.models.iter().filter(|m| m.recommended).map(|m| m.key.as_str()).collect()
    }

    #[test]
    fn with_nothing_on_disk_it_is_not_ready() {
        let v = assess(&empty()).unwrap();
        assert!(!v.ready());
        assert_eq!(v.missing(), tr!("Non c'è ancora nessun modello sul computer.", "There is no model on this computer yet."));
        assert_eq!(v.models.len(), 3);
    }

    #[test]
    fn a_model_on_disk_without_the_engine_is_not_ready() {
        let mut p = empty();
        p.entries[0].present = true;
        let v = assess(&p).unwrap();
        assert!(!v.ready());
        assert_eq!(
            v.missing(),
            tr!(
                "Il motore per questo computer (llama.cpp per le schede NVIDIA (CUDA 12)) non è ancora installato.",
                "The engine for this computer (llama.cpp for NVIDIA graphics cards (CUDA 12)) is not installed yet."
            )
        );
    }

    #[test]
    fn model_and_engine_on_disk_is_ready() {
        let mut p = empty();
        p.entries[1].present = true;
        p.engines[1] = cuda(true);
        assert!(assess(&p).unwrap().ready());
    }

    /// An installed engine with no model is not enough.
    #[test]
    fn the_engine_without_models_is_not_ready() {
        let mut p = empty();
        p.engines = vec![cuda(true), cuda(true), cuda(true)];
        assert!(!assess(&p).unwrap().ready());
    }

    #[test]
    fn the_recommended_one_is_the_first_that_fits_and_is_not_ready_yet() {
        let v = assess(&empty()).unwrap();
        assert_eq!(recommended_keys(&v), ["a"]);

        // "a" is already ready: it is "b"'s turn. What does not fit is never recommended.
        let mut p = empty();
        p.entries[0].present = true;
        p.engines[0] = cuda(true);
        let v = assess(&p).unwrap();
        assert_eq!(recommended_keys(&v), ["b"]);

        // Everything that fits is ready: nothing to recommend.
        p.entries[1].present = true;
        p.engines[1] = cuda(true);
        assert!(assess(&p).unwrap().models.iter().all(|m| !m.recommended));
    }

    /// A model that fits on the GPUs is recommended first, even if in the catalog order one that would run on the CPU
    /// comes before; on the CPU only if none fits on the GPUs.
    #[test]
    fn the_recommended_one_is_on_the_gpus_if_there_is_one() {
        let mut p = empty();
        p.recommendations[0].placement = Some(Placement::Cpu);
        let v = assess(&p).unwrap();
        assert_eq!(recommended_keys(&v), ["b"]);

        for c in &mut p.recommendations {
            c.placement = c.placement.map(|_| Placement::Cpu);
        }
        let v = assess(&p).unwrap();
        assert_eq!(recommended_keys(&v), ["a"]);
    }

    /// A model for small cards (b) is not proposed when another one fits on the cards, even if that one is already
    /// downloaded; it is when it is the only one on the cards.
    #[test]
    fn the_model_for_small_cards_only_when_nothing_else_fits_on_them() {
        let mut p = empty();
        p.recommendations[1].fallback = true;
        p.entries[0].present = true;
        p.engines[0] = cuda(true);
        assert!(assess(&p).unwrap().models.iter().all(|m| !m.recommended));

        p.recommendations[0].placement = Some(Placement::Cpu);
        assert_eq!(recommended_keys(&assess(&p).unwrap()), ["b"]);
    }

    /// A model only on request (a) stays in the list but is never the one proposed, even when it is the first that fits.
    #[test]
    fn a_model_on_request_is_never_proposed() {
        let mut p = empty();
        p.recommendations[0].on_request = true;
        let v = assess(&p).unwrap();
        assert!(v.models.iter().any(|m| m.key == "a"), "it stays in the list");
        assert_eq!(recommended_keys(&v), ["b"]);
    }

    #[test]
    fn models_keep_the_order_of_the_recommendations_and_user_ones_are_not_recommended() {
        let mut p = empty();
        p.recommendations = vec![advice("c", true), advice("a", true), advice("b", true)];
        p.recommendations[0].user = true;
        let v = assess(&p).unwrap();
        assert_eq!(v.models.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
        assert_eq!(v.models.iter().map(|m| m.user).collect::<Vec<_>>(), [true, false, false]);
        assert_eq!(recommended_keys(&v), ["a"]);

        // If the recommended ones are ready, a user model to download does not become a recommendation.
        for i in [0, 1] {
            p.entries[i].present = true;
            p.engines[i] = cuda(true);
        }
        assert!(assess(&p).unwrap().models.iter().all(|m| !m.recommended));
    }

    #[test]
    fn a_recommendation_for_a_model_outside_the_catalog_is_an_error() {
        let mut p = empty();
        p.recommendations.push(advice("ghost", true));
        let e = assess(&p).unwrap_err().to_string();
        assert!(e.contains("ghost"), "{e}");
    }

    #[test]
    fn the_plan_has_the_engine_and_the_missing_weights() {
        let v = assess(&empty()).unwrap();
        let plan = plan(&v, &chosen(&["a"])).unwrap();
        assert_eq!(plan, vec![Step::Engine(cuda(false)), Step::Model { key: "a".into(), label: "Modello a".into() }]);
    }

    #[test]
    fn two_models_with_the_same_engine_download_it_once() {
        let v = assess(&empty()).unwrap();
        let p = plan(&v, &chosen(&["a", "b", "a"])).unwrap();
        assert_eq!(p.iter().filter(|x| matches!(x, Step::Engine(_))).count(), 1);
        assert_eq!(p.iter().filter(|x| matches!(x, Step::Model { .. })).count(), 2);
        assert!(matches!(p[0], Step::Engine(_)), "the engine before the weights");
    }

    #[test]
    fn models_with_different_engines_download_all_of_them() {
        let mut p = empty();
        p.engines[1] = Engine::new("prism", "cuda-12", Some("three-gpus/b".into()), false, 300);
        let v = assess(&p).unwrap();
        let plan = plan(&v, &chosen(&["a", "b"])).unwrap();
        assert_eq!(plan.iter().filter(|x| matches!(x, Step::Engine(_))).count(), 2);
    }

    #[test]
    fn the_plan_skips_what_is_already_there() {
        let mut p = empty();
        p.entries[0].present = true; // weights on disk, engine not
        p.engines[1] = cuda(true); // engine on disk, weights not
        let v = assess(&p).unwrap();
        assert_eq!(plan(&v, &chosen(&["a"])).unwrap(), vec![Step::Engine(cuda(false))]);
        assert_eq!(plan(&v, &chosen(&["b"])).unwrap(), vec![Step::Model { key: "b".into(), label: "Modello b".into() }]);
        p.engines[0] = cuda(true);
        let v = assess(&p).unwrap();
        assert!(plan(&v, &chosen(&["a"])).unwrap().is_empty());
    }

    #[test]
    fn the_plan_rejects_wrong_choices() {
        let v = assess(&empty()).unwrap();
        assert!(plan(&v, &[]).is_err());
        assert!(plan(&v, &chosen(&["zeta"])).unwrap_err().to_string().contains("zeta"));
        let e = plan(&v, &chosen(&["c"])).unwrap_err().to_string();
        assert!(e.contains("Modello c") && e.contains("too big"), "{e}");
    }

    /// A model that runs on the CPU is chosen and downloaded like the others; one that fits nowhere is not.
    #[test]
    fn a_model_that_runs_on_the_cpu_can_be_chosen() {
        let mut p = empty();
        p.recommendations[2].placement = Some(Placement::Cpu);
        let v = assess(&p).unwrap();
        assert_eq!(plan(&v, &chosen(&["c"])).unwrap(), vec![Step::Engine(cuda(false)), Step::Model { key: "c".into(), label: "Modello c".into() }]);
    }

    #[test]
    fn run_downloads_in_order_and_shows_the_steps() {
        let p = empty();
        let v = assess(&p).unwrap();
        let plan = plan(&v, &chosen(&["a"])).unwrap();
        let mut seen: Vec<Vec<StepState>> = Vec::new();
        run(&p, &plan, &mut |progress| seen.push(progress.steps.iter().map(|x| x.state).collect())).unwrap();
        assert_eq!(*p.downloaded.lock().unwrap(), [format!("engine {}", cuda(false).label), "model a".to_string()]);
        use StepState::*;
        assert_eq!(
            seen,
            vec![vec![Waiting, Waiting], vec![InProgress, Waiting], vec![Done, Waiting], vec![Done, InProgress], vec![Done, Done]]
        );
    }

    #[test]
    fn run_shows_the_bytes_during_the_download_and_at_the_end_of_the_step() {
        let mut p = empty();
        p.pause = UPDATE_EVERY + Duration::from_millis(20);
        let v = assess(&p).unwrap();
        let plan = plan(&v, &chosen(&["a"])).unwrap();
        let mut done: Vec<(u64, u64)> = Vec::new();
        run(&p, &plan[1..], &mut |progress| done.push((progress.steps[0].done, progress.steps[0].total))).unwrap();
        // start, in progress, 100/100 after the pause, and the finished step (the first 50 were dropped: too early)
        assert_eq!(done.first(), Some(&(0, 0)));
        assert!(done.contains(&(100, 100)));
        assert_eq!(done.last(), Some(&(100, 100)));
    }

    #[test]
    fn run_stops_at_the_first_error_and_says_what() {
        let mut p = empty();
        p.fails_at = Some(1);
        let v = assess(&p).unwrap();
        let plan = plan(&v, &chosen(&["a", "b"])).unwrap();
        let e = run(&p, &plan, &mut |_| {}).unwrap_err();
        assert_eq!(e.to_string(), tr!("Scaricamento del modello Modello a", "Downloading the model Modello a"));
        assert!(format!("{e:#}").contains("network down"));
        assert_eq!(p.downloaded.lock().unwrap().len(), 1, "the engine arrived, the models after the error did not");
    }

    #[test]
    fn engine_labels_name_the_gpus() {
        let label = |name, build, profile| Engine::new(name, build, profile, false, 0).label;
        assert_eq!(label("llamacpp", "cpu", None), tr!("llama.cpp per il processore", "llama.cpp for the processor"));
        assert_eq!(label("llamacpp", "vulkan", None), tr!("llama.cpp per le schede video (Vulkan)", "llama.cpp for graphics cards (Vulkan)"));
        assert_eq!(label("llamacpp", "cuda-13", None), tr!("llama.cpp per le schede NVIDIA (CUDA 13)", "llama.cpp for NVIDIA graphics cards (CUDA 13)"));
        assert_eq!(
            label("prism", "cuda-12", Some("three-gpus/3.6".into())),
            tr!("prism per le schede NVIDIA (CUDA 12)", "prism for NVIDIA graphics cards (CUDA 12)")
        );
    }

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mango-first-run-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_choice_is_remembered_and_forgotten() {
        let d = folder("remember");
        assert_eq!(remembered_choice(&d), None);
        remember_choice(&d, &chosen(&["a", "b"])).unwrap();
        assert_eq!(remembered_choice(&d), Some(chosen(&["a", "b"])));
        forget_choice(&d);
        assert_eq!(remembered_choice(&d), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_note_is_ignored() {
        let d = folder("broken");
        std::fs::write(choice_file(&d), "{ not json").unwrap();
        assert_eq!(remembered_choice(&d), None);
        std::fs::write(choice_file(&d), r#"{"chosen":[]}"#).unwrap();
        assert_eq!(remembered_choice(&d), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
