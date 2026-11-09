//! Mango Code from the phone: the agent's web UI over the network, from the home Wi-Fi or from outside with Tailscale.
//!
//! **Off by default.** When on, it listens on a port of its own (`0.0.0.0:<port>`) and forwards the requests to the
//! agent's server, which stays on `127.0.0.1` and doesn't change for whoever uses it from the PC. Next to it a second
//! port, for the pages of the computer's browser panel (`site.rs`). When off, neither port is open.
//!
//! * You get in with the link that carries the key (`GET /phone?key=…`, 24 random bytes, compared in constant time):
//!   the reply sets the `mango_phone` cookie (a random value of one session, never the key, `HttpOnly;
//!   SameSite=Strict`, 90 days) and sends to `/`. Of the sessions only the SHA-256 hash and the expiry are kept, 20 at
//!   most.
//! * Every other request passes only with a valid session, only if the requested address is numeric (a name is
//!   another site's that points to the computer, DNS rebinding) and, if there is an `Origin`, only if it is that of
//!   the requested address. The checks and the forwarding are in `http.rs`.
//! * The second port accepts the same session, address and origin, and sends only to the page the panel on the computer
//!   shows at that moment: a server on the computer's loopback, or a local file's folder, read-only.
//! * Turning off and remaking the key drop all the sessions and close the open connections; turning off also removes
//!   the key, so a link seen earlier doesn't reopen access when it is turned on again.
//!
//! **A session is worth the computer**: it commands an agent that has the shell. The state lives in
//! `<data>\phone.json`, every entry and every refusal in `<logs>\phone.log` (never the key).

mod files;
mod http;
mod network;
mod qr;
mod site;

use anyhow::{Context, Result};
use mango_common::tr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a session is worth: the cookie isn't renewed, afterwards you get back in with the link.
const SESSION_DURATION_S: u64 = 90 * 24 * 3600;
const MAX_SESSIONS: usize = 20;

/// What the app does for the problem reports that come from the phone (`GET` and `POST /phone/report`).
pub trait Reports: Send + Sync {
    /// The most bytes a report may carry: a bigger one is refused (`413`) before being read.
    fn max_body(&self) -> u64;
    /// What the phone's page needs to know before showing the form: the reply to `GET /phone/report`.
    fn info(&self) -> serde_json::Value;
    /// A report as the phone sent it. Ok: the reply; Err: the HTTP status and the sentence for the user.
    fn submit(&self, body: Vec<u8>) -> std::result::Result<serde_json::Value, (u16, String)>;
}

/// The page the browser panel on the computer is showing.
#[derive(Clone, Debug)]
pub struct Shown {
    /// Its address, as the panel has it.
    pub url: String,
    pub title: String,
    /// The file, if the address is a local one (`file://`).
    pub file: Option<PathBuf>,
}

/// A page the phone asks the panel to open. The phone port has checked it: an address of the computer's own, or an HTML
/// file inside a project.
pub enum Page {
    Url(String),
    File(PathBuf),
}

/// What the app knows of the computer that the phone's pages and files need.
pub trait Computer: Send + Sync {
    /// The page the panel shows now; `None` if it shows nothing.
    fn shown(&self) -> Option<Shown>;
    /// Makes the panel open `page`. Err: the HTTP status and the sentence for the user.
    fn open(&self, page: Page) -> std::result::Result<(), (u16, String)>;
    /// The project folders the agent knows. Err: why they could not be read.
    fn project_folders(&self) -> std::result::Result<Vec<PathBuf>, String>;
}

/// The phone service. Cloning is cheap: all copies are the same service.
#[derive(Clone)]
pub struct Phone {
    d: Arc<Inner>,
}

struct Inner {
    file: PathBuf,
    log: PathBuf,
    /// Where the port is opened: `0.0.0.0` (all networks); tests use `127.0.0.1`.
    listen_on: std::net::Ipv4Addr,
    port: u16,
    /// The second port, for the browser panel's pages.
    preview_port: u16,
    agent_port: u16,
    reports: Arc<dyn Reports>,
    computer: Arc<dyn Computer>,
    saved: Mutex<Saved>,
    listener: Mutex<Option<http::Listener>>,
    /// The error of the last start (the port in use), until it is retried.
    error: Mutex<Option<String>>,
    /// The connections open from the phone: turning off and remaking the key close them, ongoing events too.
    connections: Mutex<HashMap<u64, TcpStream>>,
    next_id: AtomicU64,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    enabled: bool,
    key: Option<String>,
    sessions: Vec<Session>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    /// SHA-256 of the cookie's value, in hex.
    hash: String,
    /// Seconds since the Unix epoch.
    expires: u64,
}

/// What the app shows: whether it's on, whether the port is open and the two links (with the key) with their QR.
#[derive(Serialize, Debug)]
pub struct State {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    /// Why the port isn't open though on.
    pub error: Option<String>,
    /// On the Wi-Fi or the home network; `null` if off or without a network.
    pub home: Option<Access>,
    /// From outside, with Tailscale; `null` if off or if the computer has no Tailscale address.
    pub away: Option<Access>,
}

#[derive(Serialize, Debug)]
pub struct Access {
    pub address: String,
    pub link: String,
    /// The link's QR, as SVG.
    pub qr: String,
}

impl Phone {
    /// Reads the state from `<data>\phone.json` (if it's not there, off) and, if it was on, reopens the port on
    /// `listen_on:port`.
    pub fn new(
        data: &Path,
        logs: &Path,
        listen_on: std::net::Ipv4Addr,
        port: u16,
        preview_port: u16,
        agent_port: u16,
        reports: Arc<dyn Reports>,
        computer: Arc<dyn Computer>,
    ) -> Result<Phone> {
        let file = data.join("phone.json");
        let saved = match std::fs::read_to_string(&file) {
            Ok(t) => serde_json::from_str(&t).with_context(|| tr!("{} non si legge", "{} cannot be read", file.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(e) => return Err(e).with_context(|| tr!("lettura di {}", "reading {}", file.display())),
        };
        std::fs::create_dir_all(logs).with_context(|| tr!("cartella dei log {}", "logs folder {}", logs.display()))?;
        let t = Phone {
            d: Arc::new(Inner {
                file,
                log: logs.join("phone.log"),
                listen_on,
                port,
                preview_port,
                agent_port,
                reports,
                computer,
                saved: Mutex::new(saved),
                listener: Mutex::new(None),
                error: Mutex::new(None),
                connections: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
            }),
        };
        if t.d.saved.lock().unwrap().enabled {
            t.open();
        }
        Ok(t)
    }

    pub fn state(&self) -> State {
        let (enabled, key) = {
            let s = self.d.saved.lock().unwrap();
            (s.enabled, s.key.clone())
        };
        let listening = self.d.listener.lock().unwrap().is_some();
        let (home, away) = match key.filter(|_| enabled) {
            Some(k) => {
                let addresses = network::addresses();
                let access = |ip: std::net::Ipv4Addr| {
                    let link = format!("http://{ip}:{}/phone?key={k}", self.d.port);
                    Access { address: ip.to_string(), qr: qr::svg(&link), link }
                };
                (addresses.home.map(access), addresses.away.map(access))
            }
            None => (None, None),
        };
        State { enabled, listening, port: self.d.port, error: self.d.error.lock().unwrap().clone(), home, away }
    }

    /// Turns on (with a new key if there isn't one) or off (port closed, sessions and key removed).
    pub fn set_enabled(&self, enabled: bool) -> Result<State> {
        if enabled {
            {
                let mut s = self.d.saved.lock().unwrap();
                s.enabled = true;
                if s.key.is_none() {
                    s.key = Some(random_hex(24));
                }
            }
            self.d.save()?;
            self.open();
            self.d.log(serde_json::json!({ "event": "on" }));
            return Ok(self.state());
        }
        if let Some(a) = self.d.listener.lock().unwrap().take() {
            a.close();
        }
        *self.d.error.lock().unwrap() = None;
        *self.d.saved.lock().unwrap() = Saved::default();
        self.d.close_connections();
        self.d.save()?;
        self.d.log(serde_json::json!({ "event": "off" }));
        Ok(self.state())
    }

    /// A new key: the earlier link is no longer valid, sessions drop and open connections close.
    pub fn new_key(&self) -> Result<State> {
        {
            let mut s = self.d.saved.lock().unwrap();
            anyhow::ensure!(s.enabled, "{}", tr!("il servizio per il telefono è spento", "the phone service is off"));
            s.key = Some(random_hex(24));
            s.sessions.clear();
        }
        self.d.close_connections();
        self.d.save()?;
        self.d.log(serde_json::json!({ "event": "new key" }));
        Ok(self.state())
    }

    /// Opens the ports if they aren't already open; if one doesn't open, neither does, and the error stays in the state.
    fn open(&self) {
        let mut listener = self.d.listener.lock().unwrap();
        if listener.is_some() {
            return;
        }
        match http::listen(self.d.clone()) {
            Ok(a) => {
                *listener = Some(a);
                *self.d.error.lock().unwrap() = None;
            }
            Err(e) => {
                self.d.log(serde_json::json!({ "event": "port not open", "reason": format!("{e:#}") }));
                *self.d.error.lock().unwrap() = Some(format!("{e:#}"));
            }
        }
    }
}

impl Inner {
    fn save(&self) -> Result<()> {
        let text = serde_json::to_string_pretty(&*self.saved.lock().unwrap())?;
        if let Some(folder) = self.file.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &self.file).with_context(|| tr!("scrittura di {}", "writing {}", self.file.display()))
    }

    /// True if it's the current key. The hashes are compared, in constant time.
    fn right_key(&self, given: &str) -> bool {
        let s = self.saved.lock().unwrap();
        s.enabled && s.key.as_deref().is_some_and(|k| equal_ct(&Sha256::digest(k), &Sha256::digest(given)))
    }

    /// A new session: the cookie's value (which isn't saved).
    fn new_session(&self) -> Result<String> {
        let value = random_hex(32);
        {
            let mut s = self.saved.lock().unwrap();
            let now = now_secs();
            s.sessions.retain(|x| x.expires > now);
            s.sessions.sort_by_key(|x| x.expires);
            while s.sessions.len() >= MAX_SESSIONS {
                s.sessions.remove(0);
            }
            s.sessions.push(Session { hash: hex(&Sha256::digest(&value)), expires: now + SESSION_DURATION_S });
        }
        self.save()?;
        Ok(value)
    }

    fn valid_session(&self, value: &str) -> bool {
        let hash = hex(&Sha256::digest(value));
        let s = self.saved.lock().unwrap();
        let now = now_secs();
        // All are looked at, without stopping at the first: the time doesn't tell which one there was.
        s.enabled && s.sessions.iter().fold(false, |found, x| (equal_ct(x.hash.as_bytes(), hash.as_bytes()) && x.expires > now) | found)
    }

    fn track(&self, c: &TcpStream) -> Option<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.connections.lock().unwrap().insert(id, c.try_clone().ok()?);
        Some(id)
    }

    fn untrack(&self, id: Option<u64>) {
        if let Some(id) = id {
            self.connections.lock().unwrap().remove(&id);
        }
    }

    fn close_connections(&self) {
        for (_, c) in self.connections.lock().unwrap().drain() {
            let _ = c.shutdown(std::net::Shutdown::Both);
        }
    }

    /// A JSON line in `phone.log`, with local time.
    fn log(&self, mut line: serde_json::Value) {
        use std::io::Write;
        line["time"] = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string().into();
        let outcome = std::fs::OpenOptions::new().create(true).append(true).open(&self.log).and_then(|mut f| writeln!(f, "{line}"));
        if let Err(e) = outcome {
            eprintln!("phone.log not written ({}): {e}", self.log.display());
        }
    }
}

/// Constant-time comparison (at equal length: the hashes' lengths are fixed and known).
fn equal_ct(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `n` random bytes from the system, in hex.
fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("system random generator");
    hex(&b)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests;
