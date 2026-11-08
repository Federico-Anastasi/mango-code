//! Speed measurements on an already running engine: real text cut to an exact number of tokens, a request like
//! the agent's (temperature 0, no prompt cache), timings read from the engine itself.
//! Used by `mango-bench` (the catalog's models) and `mango-tune` (any tune).

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const QUESTION: &str = "\n\nSummarize in five lines what the code above does.";

/// How many tokens a measurement point needs: `1k` = 1024, `512` = 512, `full` = what the context leaves free
/// after the answer and a margin for the question and the conversation format.
pub fn tokens_for_point(point: &str, context: u32, decode: u32) -> Result<usize> {
    if point == "full" {
        return Ok(context.saturating_sub(decode + 512) as usize);
    }
    let (num, multiplier) = match point.strip_suffix('k') {
        Some(n) => (n, 1024),
        None => (point, 1),
    };
    let n: usize = num.parse().with_context(|| format!("measurement point «{point}»: write 512, 8k or full"))?;
    Ok(n * multiplier)
}

/// The text files under `roots` (sources and documents), in path order, each with its header.
/// `base` is only used to write the relative paths in the header.
pub fn corpus(roots: &[PathBuf], base: &Path) -> Result<String> {
    let mut files = Vec::new();
    for d in roots {
        collect(d, &mut files);
    }
    files.sort();
    let mut s = String::new();
    for f in files {
        if let Ok(t) = std::fs::read_to_string(&f) {
            s.push_str(&format!("\n\n// ---- {}\n", f.strip_prefix(base).unwrap_or(&f).display()));
            s.push_str(&t);
        }
    }
    if s.len() < 100_000 {
        bail!("text too short ({} bytes): at least a folder with about a hundred KB of sources or documents is needed", s.len());
    }
    Ok(s)
}

fn collect(d: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(d) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !matches!(name.as_str(), "node_modules" | "target" | "runtime" | "staging" | "gen" | "icons") && !name.starts_with('.') {
                collect(&p, out);
            }
        } else if [".rs", ".ps1", ".md", ".js", ".mjs"].iter().any(|x| name.ends_with(x)) {
            out.push(p);
        }
    }
}

/// The first `n` tokens, repeating the text if it isn't enough (for full contexts).
pub fn repeat(tokens: &[Value], n: usize) -> Vec<Value> {
    tokens.iter().cycle().take(n).cloned().collect()
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).build()
}

fn post(url: &str, body: Value) -> Result<Value> {
    let r = http_agent().post(url).set("Content-Type", "application/json").send_string(&body.to_string());
    let r = match r {
        Ok(r) => r,
        Err(ureq::Error::Status(c, r)) => bail!("{c}: {}", r.into_string().unwrap_or_default()),
        Err(e) => return Err(e.into()),
    };
    Ok(serde_json::from_reader(r.into_reader())?)
}

pub fn tokenize(url: &str, text: &str) -> Result<Vec<Value>> {
    let v = post(&format!("{url}/tokenize"), json!({ "content": text }))?;
    v["tokens"].as_array().cloned().context("reply of /tokenize without tokens")
}

pub fn detokenize(url: &str, tokens: &[Value]) -> Result<String> {
    let v = post(&format!("{url}/detokenize"), json!({ "tokens": tokens }))?;
    v["content"].as_str().map(str::to_string).context("reply of /detokenize without content")
}

/// A request like the agent's, without cache: returns the engine's `timings`.
pub fn measure(url: &str, key: &str, text: &str, token: u32) -> Result<Value> {
    let v = post(
        &format!("{url}/v1/chat/completions"),
        json!({
            "model": key,
            "messages": [{ "role": "user", "content": format!("{text}{QUESTION}") }],
            "max_tokens": token, "temperature": 0, "cache_prompt": false,
        }),
    )?;
    v.get("timings").cloned().context("reply without timings")
}

/// The text of `n` tokens from `tokens` (repeated if needed), measured at `point`: the JSON line of a point.
pub fn measure_point(url: &str, key: &str, tokens: &[Value], point: &str, n: usize, token: u32) -> Result<Value> {
    let text = detokenize(url, &repeat(tokens, n))?;
    let t = measure(url, key, &text, token)?;
    Ok(json!({
        "point": point,
        "prefill_tok": t["prompt_n"], "prefill_tok_s": t["prompt_per_second"],
        "decode_tok": t["predicted_n"], "decode_tok_s": t["predicted_per_second"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_are_read() {
        assert_eq!(tokens_for_point("1k", 0, 0).unwrap(), 1024);
        assert_eq!(tokens_for_point("32k", 0, 0).unwrap(), 32768);
        assert_eq!(tokens_for_point("512", 0, 0).unwrap(), 512);
        assert_eq!(tokens_for_point("full", 8192, 256).unwrap(), 8192 - 256 - 512);
        assert!(tokens_for_point("much", 0, 0).is_err());
        assert!(tokens_for_point("", 0, 0).is_err());
    }
}
