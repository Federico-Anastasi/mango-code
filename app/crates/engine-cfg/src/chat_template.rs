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

/// A character beyond ASCII as `\uXXXX`, two of them past the first plane.
fn ascii_escape(c: char) -> String {
    let mut units = [0u16; 2];
    c.encode_utf16(&mut units).iter().map(|u| format!("\\u{u:04x}")).collect()
}

/// `value` as the engine's `tojson` writes it (`common/jinja/value.cpp`, `value_to_json_internal`): its separators, its
/// indentation, the keys in their order, the strings escaped as it escapes them.
fn engine_json(out: &mut String, value: &minijinja::Value, level: usize, indent: i64, item: &str, key: &str) -> Result<(), Error> {
    use minijinja::value::ValueKind;
    let pad = |level: usize| if indent > 0 { " ".repeat(level * indent as usize) } else { String::new() };
    let newline = if indent >= 0 { "\n" } else { "" };
    match value.kind() {
        ValueKind::Undefined | ValueKind::None => out.push_str("null"),
        ValueKind::Bool => out.push_str(if value.is_true() { "true" } else { "false" }),
        ValueKind::Number => out.push_str(&value.to_string()),
        ValueKind::String => {
            out.push('"');
            for c in value.as_str().unwrap_or_default().chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\u{8}' => out.push_str("\\b"),
                    '\u{c}' => out.push_str("\\f"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        ValueKind::Seq | ValueKind::Iterable => {
            let items: Vec<_> = value.try_iter()?.collect();
            out.push('[');
            if !items.is_empty() {
                out.push_str(newline);
                for (i, it) in items.iter().enumerate() {
                    out.push_str(&pad(level + 1));
                    engine_json(out, it, level + 1, indent, item, key)?;
                    if i + 1 < items.len() {
                        out.push_str(item);
                    }
                    out.push_str(newline);
                }
                out.push_str(&pad(level));
            }
            out.push(']');
        }
        ValueKind::Map => {
            let keys: Vec<_> = value.try_iter()?.collect();
            out.push('{');
            if !keys.is_empty() {
                out.push_str(newline);
                for (i, k) in keys.iter().enumerate() {
                    out.push_str(&pad(level + 1));
                    engine_json(out, &minijinja::Value::from(k.to_string()), level + 1, indent, item, key)?;
                    out.push_str(key);
                    engine_json(out, &value.get_item(k)?, level + 1, indent, item, key)?;
                    if i + 1 < keys.len() {
                        out.push_str(item);
                    }
                    out.push_str(newline);
                }
                out.push_str(&pad(level));
            }
            out.push('}');
        }
        _ => out.push_str("null"),
    }
    Ok(())
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
    // minijinja's doesn't accept the parameters Hugging Face templates pass (`ensure_ascii`...), and writes compact JSON
    // where the engine writes Python's: the tools reach the model as the engine writes them.
    env.add_filter("tojson", |value: minijinja::Value, params: Kwargs| -> Result<String, Error> {
        let indent: Option<i64> = params.get("indent")?;
        let separators: Option<Vec<String>> = params.get("separators")?;
        let ascii: Option<bool> = params.get("ensure_ascii")?;
        let _: Option<minijinja::Value> = params.get("sort_keys")?;
        params.assert_all_used()?;
        let indent = indent.unwrap_or(-1);
        let separators = separators.unwrap_or_default();
        let item = separators.first().cloned().unwrap_or_else(|| if indent < 0 { ", " } else { "," }.to_string());
        let key = separators.get(1).cloned().unwrap_or_else(|| ": ".to_string());
        let mut out = String::new();
        engine_json(&mut out, &value, 0, indent, &item, &key)?;
        Ok(if ascii.unwrap_or(false) { out.chars().map(|c| if c.is_ascii() { c.to_string() } else { ascii_escape(c) }).collect() } else { out })
    });
    match env.render_str(template, Serde(context)) {
        Ok(t) => Probe::Text(t),
        Err(e) => match rejection.lock().unwrap().take() {
            Some(m) => Probe::Rejects(m),
            None => Probe::Unverifiable(e.to_string().lines().next().unwrap_or_default().to_string()),
        },
    }
}
