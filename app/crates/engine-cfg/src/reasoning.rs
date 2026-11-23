//! What a model can do about its reasoning, read from the model's own chat template: a level of effort
//! (`reasoning_effort`), an on/off switch (`enable_thinking`) or nothing. The catalog does not say it by hand, and a model
//! the user added is read the same way. The template is in the GGUF, so a model that is not on the disk offers nothing yet.

use crate::catalog::ModelCfg;
use crate::gguf::read_header;
use crate::chat_template::{probe, Probe};
use crate::other_models::context;
use mango_common::Paths;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// The levels of a model with `reasoning_effort`; its template may name the highest one otherwise (`Reasoning::high`).
const EFFORT: [&str; 3] = ["low", "medium", "high"];
const SWITCH: [&str; 2] = ["off", "on"];
const EFFORT_OR_OFF: [&str; 4] = ["off", "low", "medium", "high"];
/// The names of the highest level a template may use, the one it prefers first.
const HIGHEST: [&str; 2] = ["xhigh", "high"];

/// What the template of a model lets the user choose.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) enum Reasoning {
    /// Nothing: the model reasons as it does, or does not.
    #[default]
    None,
    /// `enable_thinking`: off or on.
    Switch,
    /// `reasoning_effort`: low, medium or high; `high` is the value the template takes for its highest level. `off`: the
    /// template also turns the reasoning off (`enable_thinking`), offered before the levels.
    Effort { high: &'static str, off: bool },
}

impl Reasoning {
    /// The levels offered, in order, as the app names them. Empty when there is nothing to choose.
    pub(crate) fn levels(&self) -> Vec<String> {
        self.own().iter().map(|n| n.to_string()).collect()
    }

    fn own(&self) -> &'static [&'static str] {
        match self {
            Reasoning::None => &[],
            Reasoning::Switch => &SWITCH,
            Reasoning::Effort { off: false, .. } => &EFFORT,
            Reasoning::Effort { off: true, .. } => &EFFORT_OR_OFF,
        }
    }

    /// What was chosen, as a level of this model: a level it has stays; the on/off of a choice saved as a switch becomes
    /// the highest and the lowest level of a model that has levels; anything else is not a choice for this model.
    pub(crate) fn resolve(&self, chosen: &str) -> Option<&'static str> {
        if let Some(level) = self.own().iter().find(|l| **l == chosen) {
            return Some(level);
        }
        match (self, chosen) {
            (Reasoning::Effort { .. }, "on") => Some("high"),
            (Reasoning::Effort { .. }, "off") => Some("low"),
            _ => None,
        }
    }

    /// The field of `chat_template_kwargs` that carries the choice to the template, with its value.
    pub(crate) fn kwarg(&self, chosen: &str) -> Option<(&'static str, Value)> {
        let level = self.resolve(chosen)?;
        match self {
            Reasoning::None => None,
            Reasoning::Switch => Some(("enable_thinking", (level == "on").into())),
            Reasoning::Effort { .. } if level == "off" => Some(("enable_thinking", false.into())),
            Reasoning::Effort { high, .. } => Some(("reasoning_effort", if level == "high" { *high } else { level }.into())),
        }
    }
}

/// What `template` lets the user choose, found by writing a short conversation with each value: the template must write
/// something else for the values it offers, and must not refuse them.
pub(crate) fn of_template(template: &str) -> Reasoning {
    let request = json!({ "messages": [{ "role": "system", "content": "Be brief." }, { "role": "user", "content": "Hello." }] });
    let write = |name: &str, value: Value| {
        let mut context = context(&request, false);
        context[name] = value;
        match probe(template, &context) {
            Probe::Text(text) => Some(text),
            _ => None,
        }
    };
    let switch = template.contains("enable_thinking") && matches!((write("enable_thinking", true.into()), write("enable_thinking", false.into())), (Some(on), Some(off)) if on != off);
    if template.contains("reasoning_effort") {
        let effort = |value: &str| write("reasoning_effort", value.into());
        if let (Some(low), Some(medium)) = (effort("low"), effort("medium")) {
            let high = HIGHEST.into_iter().find(|v| effort(v).is_some_and(|text| text != medium && text != low));
            if let (true, Some(high)) = (low != medium, high) {
                return Reasoning::Effort { high, off: switch };
            }
        }
    }
    if switch { Reasoning::Switch } else { Reasoning::None }
}

/// What was read of a file, and the file as it was then: the size and the time of its last change.
type Read = (u64, SystemTime, Reasoning);

/// The files read so far. A GGUF of tens of gigabytes is not opened again to answer a view or a request: only its size and
/// date are looked at.
static READ: LazyLock<Mutex<HashMap<PathBuf, Read>>> = LazyLock::new(Mutex::default);

/// What the template in the GGUF at `path` lets the user choose; nothing if the file is not there or has no template.
fn of_file(path: &Path) -> Reasoning {
    let Some(meta) = mango_common::model_files::listed(path) else { return Reasoning::None };
    let Ok(changed) = meta.modified() else { return Reasoning::None };
    let kept = READ.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(path).filter(|(len, at, _)| (*len, *at) == (meta.len(), changed)).map(|(_, _, r)| r.clone());
    if let Some(reasoning) = kept {
        return reasoning;
    }
    let Ok(header) = read_header(path) else { return Reasoning::None };
    let reasoning = header.strings.get("tokenizer.chat_template").map_or(Reasoning::None, |t| of_template(t));
    READ.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(path.to_path_buf(), (meta.len(), changed, reasoning.clone()));
    reasoning
}

/// What the model's template lets the user choose: read from its weights, the first of its files that is on the disk.
pub(crate) fn of_model(paths: &Paths, cfg: &ModelCfg) -> Reasoning {
    let weights = cfg.gguf.iter().map(String::as_str).chain(cfg.files.iter().map(|f| f.path.as_str()).filter(|p| p.ends_with(".gguf") && cfg.mmproj.as_deref() != Some(p)));
    weights.map(|rel| paths.models.join(rel)).find(|p| mango_common::model_files::listed(p).is_some_and(|m| m.is_file())).map_or(Reasoning::None, |p| of_file(&p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{write_gguf_with_template, EFFORT_TEMPLATE, SWITCH_TEMPLATE};

    fn levels(template: &str) -> Vec<String> {
        of_template(template).levels()
    }

    #[test]
    fn a_template_with_a_switch_offers_off_and_on() {
        assert_eq!(of_template(SWITCH_TEMPLATE), Reasoning::Switch);
        assert_eq!(levels(SWITCH_TEMPLATE), ["off", "on"]);
    }

    #[test]
    fn a_template_with_levels_offers_low_medium_and_high_and_knows_the_name_of_the_highest() {
        assert_eq!(of_template(EFFORT_TEMPLATE), Reasoning::Effort { high: "xhigh", off: false });
        assert_eq!(levels(EFFORT_TEMPLATE), ["low", "medium", "high"]);
        // a template that refuses xhigh and takes high
        let refuses_xhigh = EFFORT_TEMPLATE.replace("('xhigh', 'medium', 'low')", "('high', 'medium', 'low')").replace("'xhigh'", "'high'");
        assert_eq!(of_template(&refuses_xhigh), Reasoning::Effort { high: "high", off: false });
    }

    #[test]
    fn a_template_with_levels_and_a_switch_offers_off_and_the_levels() {
        let both = format!("{{% if enable_thinking is defined and enable_thinking is false %}}no thinking{{% endif %}}{EFFORT_TEMPLATE}");
        assert_eq!(of_template(&both), Reasoning::Effort { high: "xhigh", off: true });
        assert_eq!(levels(&both), ["off", "low", "medium", "high"]);
        let effort = Reasoning::Effort { high: "xhigh", off: true };
        assert_eq!(effort.kwarg("off"), Some(("enable_thinking", json!(false))));
        assert_eq!(effort.kwarg("medium"), Some(("reasoning_effort", json!("medium"))));
    }

    #[test]
    fn a_template_that_names_the_controls_without_using_them_offers_nothing() {
        let plain = "{% for m in messages %}{{ m.content }}{% endfor %}";
        assert_eq!(of_template(plain), Reasoning::None);
        assert_eq!(of_template(&format!("{{# enable_thinking reasoning_effort #}}{plain}")), Reasoning::None);
        assert_eq!(of_template(&format!("{{% if enable_thinking is defined %}}{{% endif %}}{plain}")), Reasoning::None, "the switch writes the same");
        assert_eq!(of_template(&format!("{{% if reasoning_effort is defined %}}{{% endif %}}{plain}")), Reasoning::None, "the levels write the same");
        // a template that cannot be written here says nothing
        assert_eq!(of_template("{% if %}broken enable_thinking reasoning_effort"), Reasoning::None);
        // a model that always reasons (no switch in its template)
        assert!(levels("{% for m in messages %}{{ m.content }}{% endfor %}<think>").is_empty());
    }

    #[test]
    fn a_choice_is_a_level_of_the_model_or_nothing() {
        let (switch, effort, none) = (Reasoning::Switch, Reasoning::Effort { high: "xhigh", off: false }, Reasoning::None);
        assert_eq!([switch.resolve("off"), switch.resolve("on"), switch.resolve("high"), switch.resolve("")], [Some("off"), Some("on"), None, None]);
        assert_eq!([effort.resolve("low"), effort.resolve("medium"), effort.resolve("high"), effort.resolve("xhigh")], [Some("low"), Some("medium"), Some("high"), None]);
        assert_eq!([effort.resolve("on"), effort.resolve("off"), none.resolve("on")], [Some("high"), Some("low"), None]);
    }

    #[test]
    fn the_choice_goes_to_the_template_under_the_name_it_reads() {
        assert_eq!(Reasoning::Switch.kwarg("off"), Some(("enable_thinking", json!(false))));
        assert_eq!(Reasoning::Switch.kwarg("on"), Some(("enable_thinking", json!(true))));
        let effort = Reasoning::Effort { high: "xhigh", off: false };
        assert_eq!(effort.kwarg("low"), Some(("reasoning_effort", json!("low"))));
        assert_eq!(effort.kwarg("high"), Some(("reasoning_effort", json!("xhigh"))));
        assert_eq!(effort.kwarg("off"), Some(("reasoning_effort", json!("low"))));
        assert_eq!(Reasoning::Switch.kwarg("medium"), None);
        assert_eq!(Reasoning::None.kwarg("on"), None);
    }

    /// The template is read from the GGUF once: the file is read again only when its size or date changes.
    #[test]
    fn a_gguf_is_read_again_only_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("m.gguf");
        assert_eq!(of_file(&file), Reasoning::None, "not on the disk");
        write_gguf_with_template(&file, SWITCH_TEMPLATE);
        assert_eq!(of_file(&file), Reasoning::Switch);
        // the same size and date: what was read is kept, even if the content is not what it was
        let (len, at) = (std::fs::metadata(&file).unwrap().len(), std::fs::metadata(&file).unwrap().modified().unwrap());
        let swapped = SWITCH_TEMPLATE.replace("enable_thinking", "enable_thinkinx");
        write_gguf_with_template(&file, &swapped);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(at).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().len(), len);
        assert_eq!(of_file(&file), Reasoning::Switch);
        // another size: read again
        write_gguf_with_template(&file, EFFORT_TEMPLATE);
        assert_eq!(of_file(&file), Reasoning::Effort { high: "xhigh", off: false });
        std::fs::write(&file, b"not a gguf").unwrap();
        assert_eq!(of_file(&file), Reasoning::None);
    }

    /// By hand, on real GGUFs (only the header is read): `MANGO_TEST_REASONING="<a.gguf>=low,medium,high;<b.gguf>=off,on;<c.gguf>="
    /// cargo test -p engine-cfg --lib reasoning::tests::real -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads real GGUFs from the disk: MANGO_TEST_REASONING says which and what to expect"]
    fn real_models_offer_what_their_templates_say() {
        let cases = std::env::var("MANGO_TEST_REASONING").expect("MANGO_TEST_REASONING");
        for case in cases.split(';').filter(|c| !c.is_empty()) {
            let (file, expected) = case.rsplit_once('=').expect("<file>=<levels>");
            let found = of_file(Path::new(file)).levels();
            println!("{file}: {found:?}");
            assert_eq!(found.join(","), expected, "{file}");
        }
    }
}
