//! The agent's MCP tools (browser, web search, documents) must be connected before
//! the app declares the server ready.
//!
//! Why: the tool list is in the system prompt (at the top, before the messages). If the
//! first request starts with an MCP not connected, the prompt differs from the one of the next
//! request, and the conversation memory on the engine is not reused (full reread, ~30 s).
//!
//! What the server (opencode) does: MCPs start per working folder, at the first request
//! that uses them, and that request waits until each one is connected or failed. A failed MCP
//! (start went wrong, process died) stays out until someone reconnects it with
//! `POST /mcp/<name>/connect`: nobody does it by itself. Here, for the conversation the window is
//! about to reopen, the server is made to connect before "ready" and the failures are reconnected
//! (the order of the tools in the request is already stable: the server sorts them by name).

use anyhow::{anyhow, Context, Result};
use mango_common::tr;
use serde_json::Value;
use std::time::{Duration, Instant};

/// How many times a failed MCP is reconnected.
const RETRIES: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpState {
    Connected,
    /// Off in the config: not a failure.
    Disabled,
    /// Not connected, with the reason given by the server.
    NotConnected(String),
}

/// `GET /mcp`: `{"chrome-devtools":{"status":"connected"},"x":{"status":"failed","error":"..."}}`.
pub fn read_states(json: &str) -> Result<Vec<(String, McpState)>> {
    let v: Value = serde_json::from_str(json).context("the /mcp response is not JSON")?;
    let m = v.as_object().ok_or_else(|| anyhow!("the /mcp response is not an object"))?;
    let mut out: Vec<(String, McpState)> = m
        .iter()
        .map(|(name, s)| {
            let state = match s.get("status").and_then(Value::as_str) {
                Some("connected") => McpState::Connected,
                Some("disabled") => McpState::Disabled,
                Some("failed") => {
                    McpState::NotConnected(s.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string())
                }
                Some(other) => McpState::NotConnected(other.to_string()),
                None => McpState::NotConnected("status missing".to_string()),
            };
            (name.clone(), state)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// The name the user understands.
pub fn user_name(mcp: &str) -> String {
    match mcp {
        "chrome-devtools" => tr!("il browser", "the browser"),
        "web-search" => tr!("la ricerca web", "web search"),
        "documents" => tr!("la lettura dei documenti", "document reading"),
        other => other.to_string(),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// MCPs that are not connected in the end: (name, reason).
    pub missing: Vec<(String, String)>,
}

/// Waits for the connection and reconnects the failures. `read(t)` does `GET /mcp` (the first time the server
/// answers only when every MCP is connected or failed) with maximum time `t`; `reconnect(name, t)`
/// does `POST /mcp/<name>/connect`. `notice` receives the sentences for the loading page.
pub fn wait_with(
    read: &(dyn Fn(Duration) -> Result<String> + Sync),
    reconnect: &(dyn Fn(&str, Duration) -> Result<()> + Sync),
    max_time: Duration,
    notice: &mut dyn FnMut(&str),
) -> Outcome {
    let end = Instant::now() + max_time;
    let mut round = 0;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        let states = match read(left).and_then(|t| read_states(&t)) {
            Ok(s) => s,
            Err(e) => {
                return Outcome { missing: vec![("tools".into(), format!("the server does not report the state of the tools: {e:#}"))] }
            }
        };
        let failed: Vec<(String, String)> = states
            .into_iter()
            .filter_map(|(n, s)| match s {
                McpState::NotConnected(m) => Some((n, m)),
                _ => None,
            })
            .collect();
        let left = end.saturating_duration_since(Instant::now());
        if failed.is_empty() || round >= RETRIES || left.is_zero() {
            return Outcome { missing: failed };
        }
        round += 1;
        let names: Vec<String> = failed.iter().map(|(n, _)| user_name(n)).collect();
        notice(&tr!("Ricollego {}", "Reconnecting {}", names.join(", ")));
        std::thread::scope(|s| {
            for (name, reason) in &failed {
                s.spawn(move || {
                    eprintln!("MCP {name}: not connected ({reason}), retrying ({round}/{RETRIES})");
                    if let Err(e) = reconnect(name, left) {
                        eprintln!("MCP {name}: reconnection failed: {e:#}");
                    }
                });
            }
        });
    }
}

/// Like `wait_with`, talking to the agent server `agent_url` for the folder `folder`.
pub fn wait(agent_url: &str, folder: &str, max_time: Duration, notice: &mut dyn FnMut(&str)) -> Outcome {
    let base = agent_url.trim_end_matches('/').to_string();
    let read = |t: Duration| -> Result<String> {
        Ok(ureq::get(&format!("{base}/mcp")).query("directory", folder).timeout(t.max(Duration::from_secs(1))).call()?.into_string()?)
    };
    let reconnect = |name: &str, t: Duration| -> Result<()> {
        ureq::post(&format!("{base}/mcp/{name}/connect"))
            .query("directory", folder)
            .timeout(t.max(Duration::from_secs(1)))
            .send_string("")?;
        Ok(())
    };
    wait_with(&read, &reconnect, max_time, notice)
}

/// The working folder of the conversation the window will reopen (from the last page seen),
/// asked to the server. `None` if the last page is not a conversation or the server does not know it.
pub fn last_session_dir(agent_url: &str) -> Option<String> {
    let page = std::fs::read_to_string(mango_common::last_page_file().ok()?).ok()?;
    let id = session_id(page.trim())?;
    let r = ureq::get(&format!("{}/session/{id}", agent_url.trim_end_matches('/'))).timeout(Duration::from_secs(5)).call().ok()?;
    let v: Value = serde_json::from_str(&r.into_string().ok()?).ok()?;
    v.get("directory").and_then(Value::as_str).map(str::to_string)
}

/// `…/session/ses_abc123?x=1#y` → `ses_abc123`.
fn session_id(url: &str) -> Option<&str> {
    let after = url.rsplit_once("/session/")?.1;
    let id = after.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).next()?;
    id.starts_with("ses_").then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const ALL: &str = r#"{"chrome-devtools":{"status":"connected"},"documents":{"status":"connected"},"web-search":{"status":"connected"}}"#;

    #[test]
    fn states_from_the_server_json() {
        let s = read_states(
            r#"{"web-search":{"status":"failed","error":"Connection closed"},"a":{"status":"disabled"},"chrome-devtools":{"status":"connected"},"x":{"status":"needs_auth"}}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            vec![
                ("a".to_string(), McpState::Disabled),
                ("chrome-devtools".to_string(), McpState::Connected),
                ("web-search".to_string(), McpState::NotConnected("Connection closed".into())),
                ("x".to_string(), McpState::NotConnected("needs_auth".into())),
            ]
        );
        assert!(read_states("not json").is_err());
        assert!(read_states("[]").is_err());
    }

    #[test]
    fn session_id_from_the_url() {
        assert_eq!(session_id("http://127.0.0.1:4096/server/aHR0/session/ses_e726c98a6ffeALrn"), Some("ses_e726c98a6ffeALrn"));
        assert_eq!(session_id("http://127.0.0.1:4096/L1VzZXJz/session/ses_abc?x=1#y"), Some("ses_abc"));
        assert_eq!(session_id("http://127.0.0.1:4096/L1VzZXJz/session"), None);
        assert_eq!(session_id("http://127.0.0.1:4096/x/session/nonid"), None);
    }

    type ReadFn = Box<dyn Fn(Duration) -> Result<String> + Sync>;
    type ReconnectFn = Box<dyn Fn(&str, Duration) -> Result<()> + Sync>;

    /// Fake server: failures are restored at `connect` number `after` (0 = never).
    fn sim(states: Vec<(&str, bool)>, after: usize) -> (ReadFn, ReconnectFn, Arc<Mutex<Vec<String>>>) {
        let st: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(states.into_iter().map(|(n, ok)| (n.to_string(), ok)).collect()));
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let (s1, s2, c2) = (st.clone(), st, calls.clone());
        let read = move |_t: Duration| -> Result<String> {
            let m = s1.lock().unwrap();
            let mut o = serde_json::Map::new();
            for (n, ok) in m.iter() {
                o.insert(n.clone(), if *ok { serde_json::json!({"status": "connected"}) } else { serde_json::json!({"status": "failed", "error": "Connection closed"}) });
            }
            Ok(Value::Object(o).to_string())
        };
        let reconnect = move |n: &str, _t: Duration| -> Result<()> {
            let mut c = c2.lock().unwrap();
            c.push(n.to_string());
            if after > 0 && c.iter().filter(|x| *x == n).count() >= after {
                s2.lock().unwrap().insert(n.to_string(), true);
            }
            Ok(())
        };
        (Box::new(read), Box::new(reconnect), calls)
    }

    #[test]
    fn everything_connected_reconnects_nothing() {
        let (l, r, c) = sim(vec![("chrome-devtools", true), ("web-search", true)], 1);
        let mut phrases = vec![];
        let e = wait_with(&l, &r, Duration::from_secs(5), &mut |f| phrases.push(f.to_string()));
        assert_eq!(e, Outcome::default());
        assert!(c.lock().unwrap().is_empty() && phrases.is_empty());
    }

    #[test]
    fn a_failure_is_reconnected() {
        let (l, r, c) = sim(vec![("chrome-devtools", false), ("web-search", true)], 1);
        let mut phrases = vec![];
        let e = wait_with(&l, &r, Duration::from_secs(5), &mut |f| phrases.push(f.to_string()));
        assert_eq!(e, Outcome::default());
        assert_eq!(*c.lock().unwrap(), vec!["chrome-devtools".to_string()]);
        assert_eq!(phrases, vec![tr!("Ricollego il browser", "Reconnecting the browser")]);
    }

    #[test]
    fn a_failure_that_does_not_pass_is_retried_twice_then_reported() {
        let (l, r, c) = sim(vec![("chrome-devtools", false), ("web-search", true)], 0);
        let e = wait_with(&l, &r, Duration::from_secs(5), &mut |_| {});
        assert_eq!(e.missing, vec![("chrome-devtools".to_string(), "Connection closed".to_string())]);
        assert_eq!(c.lock().unwrap().len(), RETRIES);
    }

    #[test]
    fn if_the_server_does_not_answer_it_does_not_block() {
        let l = |_t: Duration| -> Result<String> { Err(anyhow!("timeout")) };
        let r = |_n: &str, _t: Duration| -> Result<()> { panic!("no reconnecting without knowing the state") };
        let e = wait_with(&l, &r, Duration::from_secs(5), &mut |_| {});
        assert_eq!(e.missing.len(), 1);
        assert!(e.missing[0].1.contains("timeout"));
    }

    #[test]
    fn without_time_it_does_not_retry() {
        let (l, r, c) = sim(vec![("chrome-devtools", false)], 1);
        let e = wait_with(&l, &r, Duration::ZERO, &mut |_| {});
        assert_eq!(e.missing.len(), 1);
        assert!(c.lock().unwrap().is_empty());
    }

    /// Test with real HTTP: a mini server answers `GET /mcp` and `POST /mcp/<name>/connect`.
    #[test]
    fn with_real_http() {
        let ok = Arc::new(Mutex::new(false));
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (ok2, req2) = (ok.clone(), requests.clone());
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let mut c = conn.unwrap();
                let mut buf = [0u8; 2048];
                let n = c.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                req2.lock().unwrap().push(line.clone());
                let body = if line.starts_with("POST /mcp/chrome-devtools/connect") {
                    *ok2.lock().unwrap() = true;
                    "true".to_string()
                } else if *ok2.lock().unwrap() {
                    ALL.to_string()
                } else {
                    ALL.replace(r#""chrome-devtools":{"status":"connected"}"#, r#""chrome-devtools":{"status":"failed","error":"spawn"}"#)
                };
                let _ = write!(c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let e = wait(&format!("http://127.0.0.1:{port}"), r"C:\Users\Zoë\project one", Duration::from_secs(10), &mut |_| {});
        assert_eq!(e, Outcome::default());
        let r = requests.lock().unwrap().clone();
        // the folder travels as an encoded parameter (the server reads "+" as a space)
        assert_eq!(r[0], "GET /mcp?directory=C%3A%5CUsers%5CZo%C3%AB%5Cproject+one HTTP/1.1");
        assert!(r.iter().any(|x| x.starts_with("POST /mcp/chrome-devtools/connect?directory=")), "{r:?}");
    }
}
