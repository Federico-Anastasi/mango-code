//! Types shared between the app's pieces: where the files are (`Paths`) and how a process is started
//! (`ProcSpec`). The configuration crates produce `ProcSpec`; only the supervisor (src-tauri) really starts them.

mod engine_build;
pub mod catalog;
pub mod credentials;
pub mod download;
pub mod i18n;
pub mod internet;
pub mod network;

pub use engine_build::Build;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// An error for a non-technical user, with the detail after it.
pub fn user_error(msg: &str, detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{msg} {}", tr!("(dettaglio tecnico: {detail})", "(technical detail: {detail})"))
}

/// The error for a connection that does not work, the same text wherever the app reaches the internet.
pub fn network_error(detail: impl std::fmt::Display) -> anyhow::Error {
    user_error(&tr!("Non riesco a collegarmi a internet. Controlla la connessione e riprova.", "Can't reach the internet. Check your connection and try again."), detail)
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
        let agent = internet::agent_with_replies(&self.url, std::time::Duration::from_secs(self.timeout_s));
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

/// File with the zoom of the app's window (absent: 100%).
pub fn zoom_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("zoom.txt"))
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

/// A path as the engine's command line can carry it. The engines (the forks above all) read it in the ANSI code page
/// and do not open a file whose path has other letters, such as a user called José: its short name (8.3) is plain
/// ASCII and opens the same file. An ASCII path, or one on a volume without short names, stays as it is.
pub fn engine_path(p: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;
    let long = p.display().to_string();
    if long.is_ascii() {
        return long;
    }
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain([0]).collect();
    let mut short = vec![0u16; 1024];
    // SAFETY: `wide` ends with 0 and `short` is as long as the length passed.
    let n = unsafe { windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) } as usize;
    match String::from_utf16(&short[..n.min(short.len())]) {
        Ok(s) if n > 0 && n < short.len() && s.is_ascii() => s,
        _ => long,
    }
}

/// Writes a file whole or not at all: to `<file>.tmp` first, then renamed over the old one. A write cut short (power,
/// disk full) leaves the old file, not a broken one that the next start refuses.
pub fn write_atomic(file: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, file)
}

/// True if the `Host` header names this computer by the loopback address: `127.0.0.1` or `localhost`, with or without a
/// port. The services on the local ports answer only these: a web page that reaches them through a name of its own
/// pointing to 127.0.0.1 (DNS rebinding) sends another `Host`.
pub fn loopback_host(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(name, port)| if port.bytes().all(|b| b.is_ascii_digit()) { name } else { host });
    name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost")
}

/// The engine manager's port: the agent and the apps that integrate talk to it.
pub const ENGINE_PORT: u16 = 8080;
/// `CreateProcess` flag: the program starts without a console window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A free TCP port on 127.0.0.1 chosen by the system.
pub fn random_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// A free TCP port on 127.0.0.1, preferring `preferred`.
pub fn free_port(preferred: u16) -> Result<u16> {
    if std::net::TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return Ok(preferred);
    }
    Ok(random_port()?)
}

/// Last `n` non-empty lines of a log, for the error messages.
pub fn tail(path: &Path, n: usize) -> String {
    let txt = std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let lines: Vec<&str> = txt.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// `true` if someone is already listening on 127.0.0.1:`port`.
pub fn port_busy(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Constant-time comparison (at equal length: the lengths of keys and hashes are fixed and known).
pub fn equal_ct(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `n` random bytes from the system, in hex.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("system random generator");
    hex(&b)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_loopback_names_are_this_computer() {
        for yes in ["127.0.0.1", "127.0.0.1:8080", "localhost", "LocalHost:4097"] {
            assert!(loopback_host(yes), "{yes}");
        }
        for no in ["", "evil.example", "evil.example:8080", "127.0.0.1.evil.example", "localhost.evil.example:80", "127.0.0.2", "192.168.1.5:8080", "[::1]:8080", "localhost:x"] {
            assert!(!loopback_host(no), "{no}");
        }
    }

    #[test]
    fn write_atomic_replaces_the_file_whole_and_leaves_no_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.json");
        write_atomic(&f, "one").unwrap();
        write_atomic(&f, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        // a temporary that cannot be written leaves the old file as it was
        std::fs::create_dir(dir.path().join("b.json.tmp")).unwrap();
        std::fs::write(dir.path().join("b.json"), "old").unwrap();
        assert!(write_atomic(&dir.path().join("b.json"), "new").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("b.json")).unwrap(), "old");
    }

    #[test]
    fn a_path_with_accents_goes_to_the_engine_by_its_short_ascii_name() {
        let dir = tempfile::Builder::new().prefix("José Łukasz ").tempdir().unwrap();
        let file = dir.path().join("modello è.gguf");
        std::fs::write(&file, b"x").unwrap();
        let given = engine_path(&file);
        assert!(given.is_ascii(), "{given}");
        assert_eq!(std::fs::canonicalize(&given).unwrap(), std::fs::canonicalize(&file).unwrap());
        // what is already ASCII does not change
        assert_eq!(engine_path(Path::new(r"C:\models\a.gguf")), r"C:\models\a.gguf");
    }
}
