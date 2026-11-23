//! Renders a model's chat template (Jinja) the way the engine's minja does for what Mango Code sends: shared by the
//! check of an added model and by the tests that render the templates of real models.

use minijinja::value::{Kwargs, Serde};
use minijinja::{Environment, Error, ErrorKind};
use std::sync::{Arc, Mutex};

/// How rendering a conversation goes.
#[derive(Debug)]
pub enum Probe {
    /// The model wrote the conversation.
    Text(String),
    /// The template itself rejected the conversation (`raise_exception`), with its message.
    Rejects(String),
    /// The template uses something that can't be run here: it says nothing about the model.
    Unverifiable(String),
}

/// `template` without the `generation` blocks Hugging Face templates mark the model's own text with, for training: they write
/// nothing, and minijinja does not know them, so without this a template that has them could not be tried at all.
pub(crate) fn without_generation_tags(template: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{%") {
        let Some(len) = rest[start..].find("%}") else { break };
        let tag = &rest[start..start + len + 2];
        let name = tag[2..tag.len() - 2].trim_matches(|c: char| c == '-' || c == '+' || c.is_whitespace());
        out.push_str(&rest[..start]);
        if name != "generation" && name != "endgeneration" {
            out.push_str(tag);
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

pub fn probe(template: &str, context: &serde_json::Value) -> Probe {
    let template = &without_generation_tags(template);
    // `raise_exception` is the function templates use to reject a conversation: if it is what fails, we know from the
    // message it received, and not from how the rendering ends.
    let rejection: Arc<Mutex<Option<String>>> = Arc::default();
    let mut env = Environment::new();
    env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
    let r = rejection.clone();
    env.add_function("raise_exception", move |message: String| -> Result<String, Error> {
        *r.lock().unwrap() = Some(message.clone());
        Err(Error::new(ErrorKind::InvalidOperation, message))
    });
    env.add_function("strftime_now", |_format: String| "2026-01-01".to_string());
    // minijinja's doesn't accept the parameters Hugging Face templates pass (`ensure_ascii`...).
    env.add_filter("tojson", |value: minijinja::Value, _params: Kwargs| -> Result<String, Error> {
        serde_json::to_string(&value).map_err(|e| Error::new(ErrorKind::InvalidOperation, e.to_string()))
    });
    match env.render_str(template, Serde(context)) {
        Ok(t) => Probe::Text(t),
        Err(e) => match rejection.lock().unwrap().take() {
            Some(m) => Probe::Rejects(m),
            None => Probe::Unverifiable(e.to_string().lines().next().unwrap_or_default().to_string()),
        },
    }
}
