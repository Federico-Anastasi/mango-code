//! Mango Code from the phone: the agent's web UI over the network, from the home Wi-Fi or from outside with Tailscale.
//!
//! **Off by default.** When on, it listens on a port of its own on the addresses the links show, the home network's and
//! Tailscale's, never on all the networks (`Inner::reconcile` follows them as the Wi-Fi changes), and forwards the requests
//! to the agent's server, which stays on `127.0.0.1` and doesn't change for whoever uses it from the PC. Next to it a second
//! port, for the pages of the computer's browser panel (`site.rs`). When off, neither port is open. If Windows calls the home
//! network public, the link says so (`Access::public`).
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
mod qr;
mod site;

use anyhow::{Context, Result};
use mango_common::{equal_ct, hex, network, random_hex, tr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a session is worth: the cookie isn't renewed, afterwards you get back in with the link.
const SESSION_DURATION_S: u64 = 90 * 24 * 3600;
const MAX_SESSIONS: usize = 20;
/// Above this size `phone.log` becomes `phone.1.log` (the previous one is dropped).
const LOG_MAX: u64 = 1024 * 1024;
/// The path of a request in the log is cut to this many characters: whoever calls chooses it.
const PATH_LOGGED: usize = 200;
/// Refusals written to the log in a minute (counted from the first one): the rest is one line that says so.
const REFUSALS_PER_MINUTE: usize = 60;

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
    /// Tests: only `127.0.0.1`, so no network is touched and Windows asks nothing.
    only_here: bool,
    port: u16,
    /// The second port, for the browser panel's pages.
    preview_port: u16,
    agent_port: u16,
    reports: Arc<dyn Reports>,
    computer: Arc<dyn Computer>,
    saved: Mutex<Saved>,
    listener: Mutex<Option<http::Listener>>,
    /// The addresses with an open port.
    bound: Mutex<Vec<std::net::Ipv4Addr>>,
    /// Why a port is not open though on (the port in use), until the next try.
    error: Mutex<Option<String>>,
    /// The connections open from the phone: turning off and remaking the key close them, ongoing events too.
    connections: Mutex<HashMap<u64, TcpStream>>,
    next_id: AtomicU64,
    /// When the current minute of refusals began and how many it has already had.
    refusals: Mutex<(Option<Instant>, usize)>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
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
    /// Windows calls this network public (a café's): the link travels in the clear for whoever is on it.
    pub public: bool,
}

impl Phone {
    /// Reads the state from `<data>\phone.json` (if it's not there, off) and, if it was on, reopens the port on
    /// the addresses of the links (`only_here`: `127.0.0.1`, for the tests).
    #[allow(clippy::too_many_arguments)] // the service's ports, files and the two things it asks of the app
    pub fn new(
        data: &Path,
        logs: &Path,
        only_here: bool,
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
                only_here,
                port,
                preview_port,
                agent_port,
                reports,
                computer,
                saved: Mutex::new(saved),
                listener: Mutex::new(None),
                bound: Mutex::new(Vec::new()),
                error: Mutex::new(None),
                connections: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
                refusals: Mutex::new((None, 0)),
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
        let listening = !self.d.bound.lock().unwrap().is_empty();
        let (home, away) = match key.filter(|_| enabled) {
            Some(k) => {
                let addresses = network::addresses();
                let access = |ip: std::net::Ipv4Addr, public: bool| {
                    let link = format!("http://{ip}:{}/phone?key={k}", self.d.port);
                    Access { address: ip.to_string(), qr: qr::svg(&link), link, public }
                };
                // Tailscale encrypts what it carries: only the home network can be a café's.
                (addresses.home.map(|ip| access(ip, network::is_public(ip))), addresses.away.map(|ip| access(ip, false)))
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
        // The file first: if it cannot be written the service stays as it is, and the user is told.
        self.d.write(&Saved::default())?;
        if let Some(a) = self.d.listener.lock().unwrap().take() {
            a.close();
        }
        *self.d.error.lock().unwrap() = None;
        self.d.bound.lock().unwrap().clear();
        *self.d.saved.lock().unwrap() = Saved::default();
        self.d.close_connections();
        self.d.log(serde_json::json!({ "event": "off" }));
        Ok(self.state())
    }

    /// A new key: the earlier link is no longer valid, sessions drop and open connections close.
    pub fn new_key(&self) -> Result<State> {
        {
            let mut s = self.d.saved.lock().unwrap();
            anyhow::ensure!(s.enabled, "{}", tr!("il servizio per il telefono è spento", "the phone service is off"));
            let next = Saved { key: Some(random_hex(24)), sessions: Vec::new(), ..s.clone() };
            self.d.write(&next)?;
            *s = next;
        }
        self.d.close_connections();
        self.d.log(serde_json::json!({ "event": "new key" }));
        Ok(self.state())
    }

    /// Opens the ports if they aren't already open; one that doesn't open stays in the state as an error and is tried again.
    fn open(&self) {
        let mut listener = self.d.listener.lock().unwrap();
        if listener.is_some() {
            return;
        }
        match http::listen(self.d.clone()) {
            Ok(a) => *listener = Some(a),
            Err(e) => {
                self.d.log(serde_json::json!({ "event": "port not open", "reason": format!("{e:#}") }));
                *self.d.error.lock().unwrap() = Some(format!("{e:#}"));
            }
        }
    }
}

impl Inner {
    /// The addresses to listen on: the home network's and Tailscale's.
    fn places(&self) -> Vec<std::net::Ipv4Addr> {
        if self.only_here {
            return vec![std::net::Ipv4Addr::LOCALHOST];
        }
        network::addresses().all()
    }

    /// Opens the ports on the addresses that have none, closes those of addresses that are gone. The two ports go together:
    /// on an address where one does not open, the other is closed too, and the error says which.
    fn reconcile(&self, ports: &mut [http::Port; 2]) {
        let wanted = self.places();
        let error = ports.iter_mut().filter_map(|p| network::reconcile(&mut p.listeners, &wanted, p.number)).next();
        let both: Vec<std::net::Ipv4Addr> = ports[0].listeners.iter().map(|(ip, _)| *ip).filter(|ip| ports[1].listeners.iter().any(|(x, _)| x == ip)).collect();
        for p in ports.iter_mut() {
            p.listeners.retain(|(ip, _)| both.contains(ip));
        }
        *self.error.lock().unwrap() = error;
        *self.bound.lock().unwrap() = both;
    }

    fn save(&self) -> Result<()> {
        self.write(&self.saved.lock().unwrap())
    }

    fn write(&self, saved: &Saved) -> Result<()> {
        let text = serde_json::to_string_pretty(saved)?;
        let unsaved = || mango_common::user_text(&tr!("Non riesco a salvare il servizio per il telefono.", "I can't save the service for the phone."), self.file.display());
        if let Some(folder) = self.file.parent() {
            std::fs::create_dir_all(folder).with_context(unsaved)?;
        }
        mango_common::write_atomic(&self.file, text).with_context(unsaved)
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

    /// A JSON line in `phone.log`, with local time. Anyone on the network can cause refusals, so the file is bounded:
    /// the path is cut, the refusals of a minute are limited and the file is rotated.
    fn log(&self, mut line: serde_json::Value) {
        if line["event"] == "refused" {
            let (began, count) = &mut *self.refusals.lock().unwrap();
            if began.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
                (*began, *count) = (Some(Instant::now()), 0);
            }
            *count += 1;
            if *count > REFUSALS_PER_MINUTE {
                if *count == REFUSALS_PER_MINUTE + 1 {
                    self.append(serde_json::json!({ "event": "log limit", "reason": "more refusals not written this minute" }));
                }
                return;
            }
        }
        if let Some(path) = line["path"].as_str().filter(|p| p.chars().count() > PATH_LOGGED) {
            line["path"] = path.chars().take(PATH_LOGGED).collect::<String>().into();
        }
        self.append(line);
    }

    fn append(&self, mut line: serde_json::Value) {
        use std::io::Write;
        line["time"] = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string().into();
        if std::fs::metadata(&self.log).is_ok_and(|m| m.len() > LOG_MAX) {
            let _ = std::fs::rename(&self.log, self.log.with_file_name("phone.1.log"));
        }
        let outcome = std::fs::OpenOptions::new().create(true).append(true).open(&self.log).and_then(|mut f| writeln!(f, "{line}"));
        if let Err(e) = outcome {
            eprintln!("phone.log not written ({}): {e}", self.log.display());
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests;
