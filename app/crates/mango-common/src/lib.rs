//! Types shared between the app's pieces: where the files are (`Paths`) and how a process is started
//! (`ProcSpec`). The configuration crates produce `ProcSpec`; only the supervisor (src-tauri) really starts them.

mod engine_build;
pub mod catalog;
pub mod credentials;
pub mod download;
pub mod i18n;

pub use engine_build::Build;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// An error for a non-technical user, with the detail after it.
pub fn user_error(msg: &str, detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{msg} {}", tr!("(dettaglio tecnico: {detail})", "(technical detail: {detail})"))
}

/// A process to start, described but not yet launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcSpec {
    /// Short name for logs and error messages ("engine", "agent", ...).
    pub name: String,
    pub exe: PathBuf,
    pub args: Vec<String>,
    /// Variables added to the inherited environment.
    pub env: Vec<(String, String)>,
    /// Variables removed from the inherited environment.
    pub env_remove: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// URL that answers 200 when the process is ready.
    pub health_url: Option<String>,
    /// How long to wait for health before declaring the process broken.
    pub ready_timeout_s: u64,
    /// POST to send before stopping the process (the engine saves the conversation).
    pub shutdown_post: Option<PostCall>,
    /// POST to send as soon as the process is ready (the engine restores the saved conversation).
    pub startup_post: Option<PostCall>,
}

/// A POST to a process: where, with which JSON body (empty: no body), and how long to wait for it at most.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostCall {
    pub url: String,
    pub body: String,
    pub timeout_s: u64,
}

impl PostCall {
    /// Sends the POST and returns the JSON reply; an error status from the process is an error, with its message.
    pub fn send(&self) -> Result<serde_json::Value> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(self.timeout_s)))
            .http_status_as_error(false)
            .build()
            .into();
        let mut r = if self.body.is_empty() {
            agent.post(&self.url).send_empty()
        } else {
            agent.post(&self.url).header("Content-Type", "application/json").send(self.body.as_str())
        }
        .with_context(|| format!("POST {}", self.url))?;
        let status = r.status().as_u16();
        let text = r.body_mut().read_to_string().unwrap_or_default();
        if status != 200 {
            bail!("POST {} answered {status}: {}", self.url, text.chars().take(300).collect::<String>());
        }
        serde_json::from_str(&text).with_context(|| format!("POST {}: reply is not JSON", self.url))
    }
}

/// Where the files are on this machine.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Root of the distribution: mango-models.json, chat-templates/, opencode-home/, MCP, plugin.
    pub dist: PathBuf,
    /// Engines dir (contains <engine>/llama-server.exe).
    pub engines: PathBuf,
    /// GGUF models dir.
    pub models: PathBuf,
    /// opencode build dir (contains web/mango-code.exe).
    pub opencode: PathBuf,
    /// The app's data for this user: %LOCALAPPDATA%\MangoCode (logs, generated configs, state).
    pub data: PathBuf,
}

#[derive(Deserialize)]
struct PathsFile {
    llama: Option<PathBuf>,
    models: Option<PathBuf>,
    opencode: Option<PathBuf>,
}

impl Paths {
    /// Finds the distribution: the `MANGO_DIST` variable; otherwise, walking up from the executable, the repo's
    /// `launcher/` (the app built in `app/target` uses the live files, not the copy Tauri puts next to the
    /// executable in `target/<profile>/resources`); otherwise the first folder with `mango-models.json`, alone or
    /// in `resources/` (installed app).
    /// `<dist>/mango-paths.json` (optional: it exists on the development PC) moves engines, models and opencode;
    /// without it the installed app's paths apply: `<dist>/opencode` and, among the user's data (an app update
    /// doesn't touch them), `%LOCALAPPDATA%\MangoCode\engine` for downloaded engines and
    /// `%LOCALAPPDATA%\MangoCode\models` for models.
    pub fn discover() -> Result<Paths> {
        let dist = find_dist()?;
        let data = data_dir()?;
        std::fs::create_dir_all(data.join("logs"))?;
        let f = dist.join("mango-paths.json");
        let pf: PathsFile = if f.is_file() {
            let txt = std::fs::read_to_string(&f)?;
            serde_json::from_str(txt.trim_start_matches('\u{feff}'))
                .with_context(|| tr!("{} non è JSON valido", "{} is not valid JSON", f.display()))?
        } else {
            PathsFile { llama: None, models: None, opencode: None }
        };
        Ok(Paths {
            engines: pf.llama.unwrap_or_else(|| data.join("engine")),
            models: pf.models.unwrap_or_else(|| data.join("models")),
            opencode: pf.opencode.unwrap_or_else(|| dist.join("opencode")),
            dist,
            data,
        })
    }

    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }
}

/// The app's data for this user: `%LOCALAPPDATA%\MangoCode`, or `MANGO_DATA` (the automated tests use a folder
/// of their own, so they don't touch real conversations and memory).
pub fn data_dir() -> Result<PathBuf> {
    if let Some(d) = std::env::var_os("MANGO_DATA") {
        return Ok(PathBuf::from(d));
    }
    let local = std::env::var_os("LOCALAPPDATA").with_context(|| tr!("LOCALAPPDATA non impostata", "LOCALAPPDATA is not set"))?;
    Ok(PathBuf::from(local).join("MangoCode"))
}

/// The file another app uses to find a running Mango Code (see docs/INTEGRATION.md).
pub fn service_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("service.json"))
}

/// File with the last web UI page that was open (to reopen the app where it was).
pub fn last_page_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("last-page.txt"))
}

fn is_dist(p: &Path) -> bool {
    p.join("mango-models.json").is_file()
}

fn find_dist() -> Result<PathBuf> {
    if let Some(d) = std::env::var_os("MANGO_DIST") {
        let d = PathBuf::from(d);
        if is_dist(&d) {
            return Ok(d);
        }
        bail!("{}", tr!("MANGO_DIST={} non contiene mango-models.json", "MANGO_DIST={} does not contain mango-models.json", d.display()));
    }
    let exe = std::env::current_exe()?;
    if let Some(r) = exe.ancestors().map(|a| a.join("launcher")).find(|r| is_dist(r)) {
        return Ok(r);
    }
    for a in exe.ancestors().skip(1) {
        if is_dist(a) {
            return Ok(a.to_path_buf());
        }
        let r = a.join("resources");
        if is_dist(&r) {
            return Ok(r);
        }
    }
    bail!(
        "{}",
        tr!(
            "distribuzione di Mango Code non trovata (nessun mango-models.json sopra {})",
            "Mango Code distribution not found (no mango-models.json above {})",
            exe.display()
        )
    )
}

/// A free TCP port on 127.0.0.1, preferring `preferred`.
pub fn free_port(preferred: u16) -> Result<u16> {
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return Ok(preferred);
    }
    let l = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(l.local_addr()?.port())
}

/// `true` if someone is already listening on 127.0.0.1:`port`.
pub fn port_busy(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}
