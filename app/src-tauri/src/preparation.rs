//! Model preparation: during startup the engine reads the system prompt and the tools of
//! a new conversation and saves its base on its disk, so the user's first message does not
//! wait for that read (~30 s).
//!
//! What the server (opencode) does: `POST /mango/warmup?directory=<folder>` builds the request that
//! a new conversation in that folder would send (same code as the conversation loop:
//! same prompt, same MCP tools already connected) with a single message and a single token of reply.
//! If the engine already has the base of that prompt it answers at once without reading anything (`promptTokens` 0).
//!
//! The base depends on the folder: the system prompt contains the working folder, the project
//! root, whether it is a git repository and the AGENTS.md / CLAUDE.md files found going up. So the
//! folder of the last conversation opened is prepared (the one the window reopens); without it, the
//! projects folder. A different folder has another base and its first conversation reads it.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Beyond this time the read is considered broken: the engine works at hundreds of tokens per second,
/// but on a slow GPU 20,000 tokens take minutes.
const TIME_MAX: Duration = Duration::from_secs(600);
/// The loading page shows the phase only if the preparation lasts longer than this: with the base already
/// ready the answer arrives in a flash and there is nothing to announce.
const VISIBLE_AFTER: Duration = Duration::from_millis(1500);
const STEP: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The engine already had the base of this prompt.
    AlreadyReady,
    /// The engine read `tokens` tokens in `ms` milliseconds and saved the base.
    Prepared { tokens: u64, ms: f64 },
    /// Nothing to do, with the reason given by the server (the model is not on the local engine).
    Skipped(String),
}

/// The response of `POST /mango/warmup`.
pub fn read_response(json: &str) -> Result<Outcome> {
    let v: Value = serde_json::from_str(json).context("the /mango/warmup response is not JSON")?;
    if let Some(m) = v.get("skipped").and_then(Value::as_str) {
        return Ok(Outcome::Skipped(m.to_string()));
    }
    if v.get("ready").and_then(Value::as_bool) != Some(true) {
        let m = v.get("error").and_then(Value::as_str).unwrap_or("no reason given");
        return Err(anyhow!("the engine did not prepare the prompt: {m}"));
    }
    let tokens = v
        .get("promptTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("the response does not say how many tokens the engine read"))?;
    let ms = v.get("promptMs").and_then(Value::as_f64).unwrap_or(0.0);
    Ok(if tokens == 0 { Outcome::AlreadyReady } else { Outcome::Prepared { tokens, ms } })
}

/// Runs `job` and, if it lasts longer than `threshold`, calls `notice(seconds elapsed)` every `step`.
pub fn with_progress<T: Send>(
    job: impl FnOnce() -> T + Send,
    threshold: Duration,
    step: Duration,
    notice: &mut dyn FnMut(u64),
) -> T {
    std::thread::scope(|s| {
        let (tx, rx) = mpsc::channel::<()>();
        let h = s.spawn(move || {
            let r = job();
            let _ = tx.send(());
            r
        });
        let t0 = Instant::now();
        // The channel closes (Disconnected) also if the job panics: the join reports it.
        while let Err(mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(step) {
            if t0.elapsed() >= threshold {
                notice(t0.elapsed().as_secs());
            }
        }
        h.join().unwrap_or_else(|p| std::panic::resume_unwind(p))
    })
}

/// The folder to prepare: the one of the last conversation opened, otherwise the projects
/// folder. `None` if neither exists (first install): there is nothing to prepare.
pub fn folder_to_prepare(last_folder: Option<String>, projects_root: &Path) -> Option<String> {
    last_folder
        .filter(|c| Path::new(c).is_dir())
        .or_else(|| projects_root.is_dir().then(|| projects_root.display().to_string()))
}

/// Prepares the engine for `folder` by talking to the agent server. `notice` receives the seconds
/// elapsed, from when the preparation becomes visible.
pub fn prepare(agent_url: &str, folder: &str, notice: &mut dyn FnMut(u64)) -> Result<Outcome> {
    let url = format!("{}/mango/warmup", agent_url.trim_end_matches('/'));
    let call = move || -> Result<Outcome> {
        let r = ureq::post(&url).query("directory", folder).timeout(TIME_MAX).send_string("");
        match r {
            Ok(r) => read_response(&r.into_string()?),
            Err(ureq::Error::Status(code, r)) => {
                Err(anyhow!("the server answered {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => Err(e.into()),
        }
    };
    with_progress(call, VISIBLE_AFTER, STEP, notice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn server_responses() {
        assert_eq!(read_response(r#"{"directory":"C:\\p","ready":true,"promptTokens":0,"promptMs":0}"#).unwrap(), Outcome::AlreadyReady);
        assert_eq!(
            read_response(r#"{"directory":"C:\\p","ready":true,"promptTokens":21500,"promptMs":31200.5}"#).unwrap(),
            Outcome::Prepared { tokens: 21500, ms: 31200.5 }
        );
        assert_eq!(
            read_response(r#"{"directory":"C:\\p","ready":false,"skipped":"model x is not on the local engine"}"#).unwrap(),
            Outcome::Skipped("model x is not on the local engine".into())
        );
        let e = read_response(r#"{"directory":"C:\\p","ready":false,"error":"connection refused"}"#).unwrap_err();
        assert!(e.to_string().contains("connection refused"), "{e}");
        // ready but without saying how much it read: we cannot know, better an error than an invented "already ready"
        assert!(read_response(r#"{"directory":"C:\\p","ready":true}"#).is_err());
        assert!(read_response("not json").is_err());
    }

    #[test]
    fn progress_only_if_it_lasts() {
        let mut seen = vec![];
        let r = with_progress(|| 7, Duration::from_millis(200), Duration::from_millis(10), &mut |s| seen.push(s));
        assert_eq!(r, 7);
        assert!(seen.is_empty(), "an instant preparation is not announced: {seen:?}");

        let mut seen = vec![];
        let r = with_progress(
            || {
                std::thread::sleep(Duration::from_millis(350));
                "done"
            },
            Duration::from_millis(100),
            Duration::from_millis(40),
            &mut |s| seen.push(s),
        );
        assert_eq!(r, "done");
        assert!(!seen.is_empty(), "a long preparation is announced");
    }

    #[test]
    fn last_folder_or_projects() {
        let base = std::env::temp_dir().join(format!("mango-prep-{}", std::process::id()));
        let last = base.join("last");
        let root = base.join("Mango Code");
        std::fs::create_dir_all(&last).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let u = last.display().to_string();
        let r = root.display().to_string();
        assert_eq!(folder_to_prepare(Some(u.clone()), &root), Some(u));
        // the last conversation is in a folder that no longer exists: we fall back to the projects
        assert_eq!(folder_to_prepare(Some(base.join("gone").display().to_string()), &root), Some(r.clone()));
        assert_eq!(folder_to_prepare(None, &root), Some(r));
        assert_eq!(folder_to_prepare(None, &base.join("does-not-exist")), None);
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Real HTTP: the fake server answers the POST with the folder in the parameter.
    #[test]
    fn with_real_http() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = c.read(&mut buf).unwrap();
            let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
            let body = r#"{"directory":"x","ready":true,"promptTokens":0,"promptMs":0}"#;
            let _ = write!(
                c,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            line
        });
        let e = prepare(&format!("http://127.0.0.1:{port}"), r"C:\Users\Zoë\project one", &mut |_| {}).unwrap();
        assert_eq!(e, Outcome::AlreadyReady);
        assert_eq!(h.join().unwrap(), "POST /mango/warmup?directory=C%3A%5CUsers%5CZo%C3%AB%5Cproject+one HTTP/1.1");
    }

    #[test]
    fn server_error_with_the_code() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = c.read(&mut buf).unwrap();
            let body = r#"{"error":"directory missing"}"#;
            let _ = write!(c, "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        });
        let e = prepare(&format!("http://127.0.0.1:{port}"), "x", &mut |_| {}).unwrap_err();
        assert!(e.to_string().contains("400") && e.to_string().contains("directory missing"), "{e}");
    }
}
