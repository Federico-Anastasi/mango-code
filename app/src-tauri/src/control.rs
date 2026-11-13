//! The app's routes on the control server (`/control/*`, on the engine manager's port): what the
//! interface reads about the model, the models of the catalog and the computer, and the two things it may ask from a
//! phone too, to use a model and to try again one that did not start. The agent forwards its `/mango/*` routes here.
//! Everything that changes the computer goes through the bridge of the app's window instead.

use crate::downloads::Download;
use crate::{engine_remote, AppState};
use engine::http::error;
use engine::{Phase, PublicState};
use engine_cfg::{Placement, Where};
use mango_common::i18n::Lang;
use mango_common::tr;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// What the interface shows about the model, in one of its phases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ModelState {
    /// No model is running, loading or failed: as a rule, none is on the computer.
    None,
    /// `place` is not known until the plan of the load is made: a moment, or while the model before ends its answer.
    Loading {
        model: String,
        label: String,
        seconds: u64,
        #[serde(rename = "where")]
        place: Option<Where>,
    },
    Ready {
        model: String,
        label: String,
        #[serde(rename = "where")]
        place: Where,
    },
    /// `reason` is the manager's sentence. `taken`: the sentence that says another program holds the card, when it does:
    /// the manager's, when it did not start the model for that, otherwise the one seen after the failure. `proposal`: a model
    /// on the disk that fits now.
    Failed { model: String, label: String, reason: String, taken: Option<String>, proposal: Option<Proposal> },
    /// The graphics cards are lent to another job.
    Lent { model: String, label: String },
    /// The engine in use is another PC's. `reachable`: it answered the last time it was asked, a few seconds ago.
    Remote { address: String, models: Vec<String>, reachable: bool },
}

/// A model that fits now, after a start that failed: the interface offers it with `POST /control/model/use {model, once: true}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Proposal {
    pub model: String,
    pub label: String,
    #[serde(rename = "where")]
    pub place: Where,
}

/// What is said about a failed start besides the manager's sentence (`engine_cfg::after_failure`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AfterFailure {
    pub proposal: Option<Proposal>,
    /// Which card another program holds, and how much.
    pub taken: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct State {
    /// Grows whenever what follows changes.
    pub revision: u64,
    /// Grows when what the catalog says changed (a model arrived): whoever shows the catalog reads it again.
    pub catalog_revision: u64,
    pub model: ModelState,
    /// The model the app loads when it opens; none while no model is on the computer.
    pub default_model: Option<String>,
    /// The models being downloaded, in the order they were asked.
    pub downloads: Vec<Download>,
}

/// What the routes remember between one call and the next.
#[derive(Default)]
pub struct Shared {
    known: Mutex<Known>,
    catalog_revision: AtomicU64,
    /// The revision and the state it was given to, as JSON.
    served: Mutex<(u64, String)>,
    /// What is said about the last failed start, looked at once for each failure (`Look`).
    after_failure: Mutex<Option<Look>>,
    /// The models the user asked for (`use`, `retry`): a failure after a new attempt is looked at again.
    attempts: AtomicU64,
    /// The language of the last state served (`speaks`).
    language: Mutex<Option<Lang>>,
}

/// A failed start as it is looked at: the model, the manager's sentence, the catalog's revision, the user's attempts, and
/// the model of Mango Code on the cards meanwhile (then the cards are not read: what they hold is partly ours).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureKey {
    pub model: String,
    pub reason: String,
    pub catalog: u64,
    pub attempts: u64,
    pub in_use: Option<String>,
}

/// What is known of a failed start: being looked at in a thread (with what is said meanwhile), or looked at.
#[derive(Debug, Clone)]
enum Look {
    Looking(FailureKey, AfterFailure),
    Done(FailureKey, AfterFailure),
}

impl FailureKey {
    /// The same failed start, looked at again only because the catalog changed (a model arrived, or the language): what
    /// was found stays said until the new look ends, instead of disappearing for a moment.
    fn same_start(&self, other: &FailureKey) -> bool {
        (&self.model, &self.reason, self.attempts, &self.in_use) == (&other.model, &other.reason, other.attempts, &other.in_use)
    }
}

/// What the catalog said the last time it was read: the names of the models and the one to load when the app opens.
#[derive(Default)]
pub struct Known {
    pub labels: BTreeMap<String, String>,
    pub default_model: Option<String>,
}

impl Shared {
    pub fn set_known(&self, known: Known) {
        *self.known.lock().unwrap() = known;
    }

    pub fn catalog_changed(&self) {
        self.catalog_revision.fetch_add(1, Ordering::SeqCst);
    }

    /// The routes now speak `lang`. The catalog, the computer and what is said about a failure are sentences in the
    /// language of the moment they are read: when the user changes it, the catalog's revision grows, so whoever shows
    /// them reads them again and a failure is looked at again.
    fn speaks(&self, lang: Lang) {
        let mut language = self.language.lock().unwrap();
        if language.is_some_and(|before| before != lang) {
            self.catalog_changed();
        }
        *language = Some(lang);
    }

    /// What is known of the failure `key` now, and whether a look must start. A look that failed is not kept: the next
    /// read starts another. While a look runs, what was found for the same start before is said (`same_start`).
    fn after(&self, key: &FailureKey) -> (AfterFailure, bool) {
        let mut look = self.after_failure.lock().unwrap();
        match look.as_ref() {
            Some(Look::Done(k, after) | Look::Looking(k, after)) if k == key => (after.clone(), false),
            known => {
                let meanwhile = match known {
                    Some(Look::Done(k, after) | Look::Looking(k, after)) if k.same_start(key) => after.clone(),
                    _ => AfterFailure::default(),
                };
                *look = Some(Look::Looking(key.clone(), meanwhile.clone()));
                (meanwhile, true)
            }
        }
    }

    /// The look at `key` ended. Kept only if it worked and the failure is still the one looked at.
    fn looked(&self, key: &FailureKey, found: &anyhow::Result<AfterFailure>) {
        let mut look = self.after_failure.lock().unwrap();
        if matches!(look.as_ref(), Some(Look::Looking(k, _)) if k == key) {
            *look = found.as_ref().ok().map(|after| Look::Done(key.clone(), after.clone()));
        }
    }
}

/// The phase to show for the manager's state. A model picked or loading comes before a start that failed earlier, and that
/// before the model that kept running meanwhile: it is the last thing the user asked for.
pub fn model_state(engine: &PublicState, remote: Option<&engine_remote::Info>, label: &dyn Fn(&str) -> String, after: &AfterFailure) -> ModelState {
    if let Some(remote) = remote {
        return ModelState::Remote { address: remote.address.clone(), models: remote.models.clone(), reachable: remote.reachable.load(Ordering::SeqCst) };
    }
    let named = |model: &String| (model.clone(), label(model));
    if let Some((model, label)) = engine.chosen.as_ref().map(named) {
        return ModelState::Loading { model, label, seconds: 0, place: None };
    }
    if engine.phase == Phase::Starting {
        return match (&engine.loading, &engine.model) {
            (Some(l), _) => ModelState::Loading {
                model: l.model.clone(),
                label: l.name.clone(),
                seconds: l.seconds,
                place: Some(placed(l.gpus.clone(), l.context)),
            },
            (None, Some(model)) => ModelState::Loading { model: model.clone(), label: label(model), seconds: 0, place: None },
            (None, None) => ModelState::None,
        };
    }
    let failed = |model: &String, reason: &str, taken: Option<&String>| ModelState::Failed {
        model: model.clone(),
        label: label(model),
        reason: reason.to_string(),
        taken: taken.or(after.taken.as_ref()).cloned(),
        proposal: after.proposal.clone(),
    };
    if let Some(f) = &engine.failed {
        return failed(&f.model, &f.reason, f.taken.as_ref());
    }
    let Some((model, label)) = engine.model.as_ref().map(named) else { return ModelState::None };
    match engine.phase {
        Phase::Running => match (&engine.name, engine.context) {
            (Some(name), Some(context)) => ModelState::Ready { model, label: name.clone(), place: placed(engine.gpus.iter().map(|g| g.name.clone()).collect(), context) },
            // The engine has just stopped under the read: nothing runs.
            _ => ModelState::None,
        },
        Phase::Releasing | Phase::Released => ModelState::Lent { model, label },
        // The engine closed while it worked: the reason is the manager's sentence.
        Phase::Error => failed(&model, engine.error.as_deref().unwrap_or_default(), None),
        Phase::Stopped | Phase::Starting => ModelState::None,
    }
}

fn placed(gpus: Vec<String>, context: u32) -> Where {
    Where { placement: if gpus.is_empty() { Placement::Cpu } else { Placement::Gpu }, gpus, context }
}

/// The routes, for the engine manager's server.
pub struct Routes(pub AppHandle);

impl engine::http::Control for Routes {
    fn handle(&self, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
        let st = self.0.state::<AppState>();
        let Some(engine) = st.engine.get() else {
            return (503, error(&tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting.")));
        };
        match (method, path) {
            ("GET", "/control/state") => {}
            ("GET", "/control/models" | "/control/computer") => {
                return match about_this_computer(&st, path) {
                    Ok(v) => (200, v),
                    Err(e) => (500, error(&format!("{e:#}"))),
                }
            }
            ("POST", "/control/model/use") => {
                let Some(model) = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string)) else {
                    return (400, error(&tr!("manca «model»", "«model» is missing")));
                };
                if st.remote.lock().unwrap().is_some() {
                    return (
                        409,
                        error(&tr!(
                            "Questo computer usa il motore di un altro PC: il modello si sceglie dalla conversazione.",
                            "This computer uses the engine of another PC: the model is chosen from the conversation."
                        )),
                    );
                }
                st.control.attempts.fetch_add(1, Ordering::SeqCst);
                engine.choose(&model);
            }
            ("POST", "/control/model/retry") => {
                st.control.attempts.fetch_add(1, Ordering::SeqCst);
                let state = engine.state();
                // The model whose start failed, or the one the engine closed under. It starts also beside other programs that
                // hold its memory: the user was told.
                let failed = state.failed.map(|f| f.model).or_else(|| state.model.filter(|_| state.phase == Phase::Error));
                if let Some(model) = failed {
                    engine.retry(&model);
                }
            }
            _ => return (404, error(&tr!("rotta sconosciuta: {path}", "unknown route: {path}"))),
        }
        (200, serde_json::to_value(state(&self.0, &st, &engine.state())).unwrap_or(Value::Null))
    }
}

/// The catalog's local models with their verdict here and the user's choices (`/control/models`), or the computer
/// (`/control/computer`): read when asked, the hardware included.
fn about_this_computer(st: &AppState, path: &str) -> anyhow::Result<Value> {
    use anyhow::Context;
    let paths = st.paths.get().with_context(|| tr!("percorsi non ancora noti", "paths not known yet"))?;
    let hw = engine_cfg::detect().with_context(|| tr!("Non riesco a guardare l'hardware di questo computer", "Cannot look at the hardware of this computer"))?;
    Ok(match path {
        "/control/models" => serde_json::json!({ "models": engine_cfg::models_view(paths, &hw)? }),
        _ => serde_json::to_value(engine_cfg::computer_view(paths, &hw)?)?,
    })
}

/// The start that failed, as the manager tells it, with what it is known by.
fn failure(engine: &PublicState, catalog: u64, attempts: u64) -> Option<FailureKey> {
    let (model, reason) = match (&engine.failed, &engine.model) {
        (Some(f), _) => (f.model.clone(), f.reason.clone()),
        (None, Some(model)) if engine.phase == Phase::Error => (model.clone(), engine.error.clone().unwrap_or_default()),
        _ => return None,
    };
    let in_use = engine.model.clone().filter(|_| !matches!(engine.phase, Phase::Stopped | Phase::Error));
    Some(FailureKey { model, reason, catalog, attempts, in_use })
}

/// What is said about the failure the manager tells now. The route answers from memory: the hardware and the catalog are
/// read in a thread the first time the failure is seen, and the state says it from the read after.
fn after_failure(app: &AppHandle, st: &AppState, engine: &PublicState) -> AfterFailure {
    let Some(key) = failure(engine, st.control.catalog_revision.load(Ordering::SeqCst), st.control.attempts.load(Ordering::SeqCst)) else {
        return AfterFailure::default();
    };
    let (after, start) = st.control.after(&key);
    if start {
        let app = app.clone();
        std::thread::spawn(move || {
            let st = app.state::<AppState>();
            let found = look_after_failure(&st, &key);
            if let (Err(e), Some(paths)) = (&found, st.paths.get()) {
                crate::startup_log(paths, &format!("no model proposed after the failed start of {}: {e:#}", key.model));
            }
            st.control.looked(&key, &found);
        });
    }
    after
}

/// The cards are read only when no model of Mango Code is on them, and once the one that has just closed (the model before a
/// switch, a load that failed) has given its memory back: what is used then is other programs'.
fn look_after_failure(st: &AppState, key: &FailureKey) -> anyhow::Result<AfterFailure> {
    use anyhow::Context;
    let paths = st.paths.get().with_context(|| tr!("percorsi non ancora noti", "paths not known yet"))?;
    let engine = st.engine.get().with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))?;
    let hw = engine_cfg::detect()?;
    let used = if key.in_use.is_some() { Vec::new() } else { engine.memory_of_others() };
    let default = st.control.known.lock().unwrap().default_model.clone();
    let a = engine_cfg::after_failure(paths, &hw, &used, &key.model, default.as_deref(), key.in_use.as_deref())?;
    Ok(AfterFailure {
        proposal: a.proposal.and_then(|v| Some(Proposal { place: v.verdict.place?, model: v.key, label: v.label })),
        taken: a.taken,
    })
}

/// The state to answer, with its revision: one more than the last if anything changed since.
fn state(app: &AppHandle, st: &AppState, engine: &PublicState) -> State {
    st.control.speaks(mango_common::i18n::lang());
    let after = after_failure(app, st, engine);
    let known = st.control.known.lock().unwrap();
    let remote = st.remote.lock().unwrap();
    let label = |key: &str| known.labels.get(key).cloned().unwrap_or_else(|| key.to_string());
    let mut state = State {
        revision: 0,
        catalog_revision: st.control.catalog_revision.load(Ordering::SeqCst),
        model: model_state(engine, remote.as_ref(), &label, &after),
        default_model: known.default_model.clone(),
        downloads: st.downloads.get().map(|d| d.list()).unwrap_or_default(),
    };
    let now = serde_json::to_string(&state).unwrap_or_default();
    let mut served = st.control.served.lock().unwrap();
    if served.1 != now {
        *served = (served.0 + 1, now);
    }
    state.revision = served.0;
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::{PublicFailure, PublicGpu, PublicLoading};
    use serde_json::json;

    fn engine(phase: Phase) -> PublicState {
        PublicState {
            phase,
            model: None,
            name: None,
            context: None,
            gpus: vec![],
            released: vec![],
            all_released: false,
            loans: vec![],
            requests_in_flight: 0,
            error: None,
            loading: None,
            failed: None,
            chosen: None,
        }
    }

    fn label(key: &str) -> String {
        format!("Model {key}")
    }

    fn shown(engine: &PublicState) -> Value {
        serde_json::to_value(model_state(engine, None, &label, &AfterFailure::default())).unwrap()
    }

    fn running(key: &str) -> PublicState {
        PublicState {
            model: Some(key.into()),
            name: Some("Qwen".into()),
            context: Some(131_072),
            gpus: vec![PublicGpu { index: 0, name: "RTX 3060 Ti".into(), memory_used_mib: Some(7000), memory_total_mib: 8192 }],
            ..engine(Phase::Running)
        }
    }

    #[test]
    fn nothing_to_load_is_none() {
        assert_eq!(shown(&engine(Phase::Stopped)), json!({ "phase": "none" }));
    }

    #[test]
    fn a_running_model_is_ready_with_where_it_runs() {
        assert_eq!(
            shown(&running("3.6")),
            json!({ "phase": "ready", "model": "3.6", "label": "Qwen", "where": { "placement": "gpu", "gpus": ["RTX 3060 Ti"], "context": 131_072 } })
        );
        let on_cpu = PublicState { gpus: vec![], ..running("ling") };
        assert_eq!(shown(&on_cpu)["where"], json!({ "placement": "cpu", "gpus": [], "context": 131_072 }));
    }

    #[test]
    fn a_load_says_what_where_and_for_how_long_once_its_plan_is_made() {
        let planned = PublicState {
            model: Some("3.6".into()),
            loading: Some(PublicLoading { model: "3.6".into(), name: "Qwen".into(), context: 65_536, gpus: vec!["A".into(), "B".into()], seconds: 7 }),
            ..engine(Phase::Starting)
        };
        assert_eq!(
            shown(&planned),
            json!({ "phase": "loading", "model": "3.6", "label": "Qwen", "seconds": 7, "where": { "placement": "gpu", "gpus": ["A", "B"], "context": 65_536 } })
        );
        let before_the_plan = PublicState { model: Some("3.6".into()), ..engine(Phase::Starting) };
        assert_eq!(shown(&before_the_plan), json!({ "phase": "loading", "model": "3.6", "label": "Model 3.6", "seconds": 0, "where": null }));
    }

    /// The model the user picked is what the interface shows, also while the one before ends its answer and after a start
    /// that had failed.
    #[test]
    fn a_picked_model_is_loading_before_it_begins() {
        let picked = PublicState {
            chosen: Some("ling".into()),
            failed: Some(PublicFailure { model: "toq".into(), reason: "no".into(), taken: None }),
            ..running("3.6")
        };
        assert_eq!(shown(&picked), json!({ "phase": "loading", "model": "ling", "label": "Model ling", "seconds": 0, "where": null }));
    }

    /// A start that failed is shown with its sentence, also when the model before kept running.
    #[test]
    fn a_failed_start_is_failed_with_its_reason() {
        let failed = PublicState { failed: Some(PublicFailure { model: "toq".into(), reason: "It does not fit.".into(), taken: None }), ..running("3.6") };
        assert_eq!(shown(&failed), json!({ "phase": "failed", "model": "toq", "label": "Model toq", "reason": "It does not fit.", "taken": null, "proposal": null }));
        let crashed = PublicState { model: Some("3.6".into()), error: Some("The engine closed.".into()), ..engine(Phase::Error) };
        assert_eq!(shown(&crashed), json!({ "phase": "failed", "model": "3.6", "label": "Model 3.6", "reason": "The engine closed.", "taken": null, "proposal": null }));
        assert_eq!(
            failure(&crashed, 4, 1),
            Some(FailureKey { model: "3.6".into(), reason: "The engine closed.".into(), catalog: 4, attempts: 1, in_use: None })
        );
        assert_eq!(failure(&running("3.6"), 4, 1), None);
        // A reload that failed while the model before kept running: the cards hold ours.
        assert_eq!(failure(&failed, 0, 0).unwrap().in_use.as_deref(), Some("3.6"));
    }

    fn key(model: &str, catalog: u64, attempts: u64) -> FailureKey {
        FailureKey { model: model.into(), reason: "out of memory".into(), catalog, attempts, in_use: None }
    }

    fn after(model: &str) -> AfterFailure {
        AfterFailure { proposal: Some(Proposal { model: model.into(), label: model.into(), place: placed(vec![], 4096) }), taken: None }
    }

    /// A failure is looked at once; again after a change of the catalog or a new attempt of the user; a look that failed
    /// is not kept, and one that ends after the failure changed is dropped. When only the catalog changed, what was found
    /// stays said while the new look runs.
    #[test]
    fn a_failure_is_looked_at_once_until_the_catalog_or_the_attempts_change() {
        let shared = Shared::default();
        let first = key("toq", 0, 0);
        assert_eq!(shared.after(&first), (AfterFailure::default(), true), "the first read starts the look");
        assert_eq!(shared.after(&first), (AfterFailure::default(), false), "the look is under way: nothing new starts");
        shared.looked(&first, &Ok(after("ling")));
        assert_eq!(shared.after(&first), (after("ling"), false), "from memory");

        // only the catalog changed (a model arrived, the language): looked at again, saying what it found meanwhile
        let catalog = key("toq", 1, 0);
        assert_eq!(shared.after(&catalog), (after("ling"), true));
        assert_eq!(shared.after(&catalog), (after("ling"), false), "still while the look runs");
        shared.looked(&catalog, &Ok(after("lfm")));
        assert_eq!(shared.after(&catalog), (after("lfm"), false));

        // another start: nothing of the one before is said
        for changed in [key("toq", 1, 1), FailureKey { in_use: Some("3.6".into()), ..key("toq", 1, 1) }, FailureKey { model: "ling".into(), ..key("toq", 2, 1) }] {
            assert_eq!(shared.after(&changed), (AfterFailure::default(), true), "{changed:?}");
            shared.looked(&changed, &Ok(after("ling")));
        }

        let erred = key("toq", 2, 2);
        assert!(shared.after(&erred).1);
        shared.looked(&erred, &Err(anyhow::anyhow!("NVML does not answer")));
        assert!(shared.after(&erred).1, "an error is not kept: the next read looks again");

        let late = key("toq", 3, 3);
        assert!(shared.after(&late).1);
        assert!(shared.after(&key("toq", 4, 3)).1, "the catalog changed during the look");
        shared.looked(&late, &Ok(after("ling")));
        assert_eq!(shared.after(&key("toq", 4, 3)), (AfterFailure::default(), false), "the late look is dropped");
    }

    /// A change of language is a change of what the catalog says: its revision grows once, and so does the key of a
    /// failure, which is then looked at again in the new language.
    #[test]
    fn a_change_of_language_makes_the_catalog_and_the_failure_read_again() {
        let shared = Shared::default();
        let revision = || shared.catalog_revision.load(Ordering::SeqCst);
        shared.speaks(Lang::It);
        shared.speaks(Lang::It);
        assert_eq!(revision(), 0, "the first language and the same again change nothing");
        let before = key("toq", revision(), 0);
        assert!(shared.after(&before).1);
        shared.looked(&before, &Ok(after("ling")));

        shared.speaks(Lang::En);
        assert_eq!(revision(), 1);
        assert_eq!(shared.after(&key("toq", revision(), 0)), (after("ling"), true), "looked at again, saying what it found meanwhile");
        shared.speaks(Lang::En);
        assert_eq!(revision(), 1);
        shared.speaks(Lang::It);
        assert_eq!(revision(), 2);
    }

    /// The model proposed after a failed start comes with where it runs; when another program probably holds the card,
    /// the sentence that says so is apart from the manager's.
    #[test]
    fn a_failed_start_proposes_a_model_and_names_the_card_another_program_holds() {
        let failed = PublicState { failed: Some(PublicFailure { model: "toq".into(), reason: "out of memory".into(), taken: None }), ..engine(Phase::Error) };
        let after = AfterFailure {
            proposal: Some(Proposal { model: "ling".into(), label: "Ling".into(), place: placed(vec!["RTX 3060 Ti".into()], 131_072) }),
            taken: Some("Probably another program takes 5.8 GB of the RTX 3060 Ti.".into()),
        };
        assert_eq!(
            serde_json::to_value(model_state(&failed, None, &label, &after)).unwrap(),
            json!({
                "phase": "failed", "model": "toq", "label": "Model toq", "reason": "out of memory",
                "taken": "Probably another program takes 5.8 GB of the RTX 3060 Ti.",
                "proposal": { "model": "ling", "label": "Ling", "where": { "placement": "gpu", "gpus": ["RTX 3060 Ti"], "context": 131_072 } }
            })
        );
    }

    /// A model the manager did not start because other programs hold its card: the sentence that says so is the manager's,
    /// whatever the look after the failure found; the detail stays in `reason`.
    #[test]
    fn a_start_refused_beside_another_program_says_the_managers_sentence() {
        let sentence = "On the GTX 1080 another program is using 4.8 GB: there is not enough memory left for this model.";
        let reason = format!("{sentence} (technical detail: GPU 1: 4915 MiB in use of 8192)");
        let refused = PublicState { failed: Some(PublicFailure { model: "3.6".into(), reason: reason.clone(), taken: Some(sentence.into()) }), ..engine(Phase::Error) };
        for after in [AfterFailure::default(), AfterFailure { proposal: None, taken: Some("Probably another program takes 3.7 GB of the GTX 1080.".into()) }] {
            let shown = serde_json::to_value(model_state(&refused, None, &label, &after)).unwrap();
            assert_eq!((&shown["taken"], &shown["reason"]), (&json!(sentence), &json!(reason)), "{shown}");
        }
    }

    #[test]
    fn lent_cards_and_the_engine_of_another_pc() {
        let lent = PublicState { model: Some("3.6".into()), ..engine(Phase::Released) };
        assert_eq!(shown(&lent), json!({ "phase": "lent", "model": "3.6", "label": "Model 3.6" }));
        let remote = engine_remote::Info { address: "192.168.1.5:47098".into(), models: vec!["Qwen".into()], reachable: std::sync::Arc::new(true.into()) };
        let shown = || serde_json::to_value(model_state(&running("3.6"), Some(&remote), &label, &AfterFailure::default())).unwrap();
        assert_eq!(shown(), json!({ "phase": "remote", "address": "192.168.1.5:47098", "models": ["Qwen"], "reachable": true }));
        // What the watch of the other PC wrote last.
        remote.reachable.store(false, Ordering::SeqCst);
        assert_eq!(shown()["reachable"], json!(false));
    }
}
