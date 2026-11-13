//! The engine shared with the user's other PCs ("Share the engine with my PCs", in the settings' Connections).
//!
//! **Off by default.** When on, a thread opens a port (`<port>`) on each address the page shows (the home network's and
//! Tailscale's, never all the networks), re-reading the addresses every few seconds because the Wi-Fi changes them. The
//! requests are served by the engine manager (`http.rs`) like the ones of this PC, but only with the key
//! (`Authorization: Bearer <key>`, 24 random bytes, compared in constant time) and only on the routes that a PC using the
//! engine needs: `/v1/*`, the reads `/health`, `/props`, `/metrics`, `/slots`, `/engine` and `/mango/models`, the models
//! this PC offers. The GPUs' loans (`/engine/release`, `/engine/resume`, `/engine/model`) stay for the apps of this PC.
//! `llama-server` stays on `127.0.0.1`.
//!
//! Turning off closes the ports and the open connections and removes the key, so a code copied earlier does not reopen
//! access when it is turned on again. The state is in `<data>\engine-share.json`; the lines of the use are in
//! `manager.log`, never the key.

use crate::{http, EngineManager};
use anyhow::{Context, Result};
use mango_common::{equal_ct, network, random_hex, tr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Connections open at once: past this a new one is closed unanswered.
const MAX_CONNECTIONS: usize = 32;
/// How often the addresses are read again.
const RECHECK: Duration = Duration::from_secs(3);
/// Refusals written to the log in a minute (counted from the first one): the rest is one line that says so.
const REFUSALS_PER_MINUTE: usize = 30;

/// A model this PC offers to the others.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SharedModel {
    pub key: String,
    pub label: String,
    pub context: u32,
    pub images: bool,
}

/// The share service. Cloning is cheap: all copies are the same service.
#[derive(Clone)]
pub struct Share(Arc<Inner>);

struct Inner {
    file: PathBuf,
    port: u16,
    /// Tests: only `127.0.0.1`, so no network is touched and Windows asks nothing.
    only_here: bool,
    manager: EngineManager,
    models: Mutex<Vec<SharedModel>>,
    saved: Mutex<Saved>,
    open: Mutex<Option<Open>>,
    /// The addresses with an open port.
    bound: Mutex<Vec<Ipv4Addr>>,
    /// Why a port is not open though on (the port in use), until the next try.
    error: Mutex<Option<String>>,
    connections: Mutex<HashMap<u64, TcpStream>>,
    next_id: AtomicU64,
    refusals: Mutex<(Option<Instant>, usize)>,
}

struct Open {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Saved {
    enabled: bool,
    key: Option<String>,
}

/// What the page shows: whether it is on, whether a port is open and the codes to copy.
#[derive(Serialize, Debug)]
pub struct State {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub error: Option<String>,
    /// On the home network; `null` if off or without a network.
    pub home: Option<Access>,
    /// From outside, with Tailscale; `null` if off or if the computer has no Tailscale address.
    pub away: Option<Access>,
}

#[derive(Serialize, Debug)]
pub struct Access {
    /// `ip:port`.
    pub address: String,
    /// What the other PC pastes: `mango://ip:port/key`.
    pub code: String,
}

impl Share {
    /// Reads `<data>\engine-share.json` (if it is not there, off) and, if it was on, reopens the ports.
    pub fn new(data: &Path, manager: EngineManager, port: u16, only_here: bool) -> Result<Share> {
        let file = data.join("engine-share.json");
        let saved = match std::fs::read_to_string(&file) {
            Ok(t) => serde_json::from_str(&t).with_context(|| tr!("{} non si legge", "{} cannot be read", file.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(e) => return Err(e).with_context(|| tr!("lettura di {}", "reading {}", file.display())),
        };
        let enabled = saved.enabled;
        let share = Share(Arc::new(Inner {
            file,
            port,
            only_here,
            manager,
            models: Mutex::new(Vec::new()),
            saved: Mutex::new(saved),
            open: Mutex::new(None),
            bound: Mutex::new(Vec::new()),
            error: Mutex::new(None),
            connections: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            refusals: Mutex::new((None, 0)),
        }));
        if enabled {
            share.open();
        }
        Ok(share)
    }

    /// The models this PC offers (those that are on disk and fit): changes at every start of the app.
    pub fn set_models(&self, models: Vec<SharedModel>) {
        *self.0.models.lock().unwrap() = models;
    }

    pub fn state(&self) -> State {
        let (enabled, key) = {
            let s = self.0.saved.lock().unwrap();
            (s.enabled, s.key.clone())
        };
        let bound = self.0.bound.lock().unwrap().clone();
        let (home, away) = match key.filter(|_| enabled) {
            Some(k) => {
                let (home, away) = self.0.places();
                let access = |ip: Ipv4Addr| {
                    let address = format!("{ip}:{}", self.0.port);
                    Access { code: format!("mango://{address}/{k}"), address }
                };
                (home.filter(|ip| bound.contains(ip)).map(access), away.filter(|ip| bound.contains(ip)).map(access))
            }
            None => (None, None),
        };
        State { enabled, listening: !bound.is_empty(), port: self.0.port, error: self.0.error.lock().unwrap().clone(), home, away }
    }

    /// Turns on (with a new key if there is none) or off (ports closed, key removed).
    pub fn set_enabled(&self, enabled: bool) -> Result<State> {
        if enabled {
            {
                let mut s = self.0.saved.lock().unwrap();
                s.enabled = true;
                if s.key.is_none() {
                    s.key = Some(random_hex(24));
                }
            }
            self.0.write(&self.0.saved.lock().unwrap().clone())?;
            self.open();
            self.0.manager.log(serde_json::json!({ "event": "share on" }));
            return Ok(self.state());
        }
        // The file first: if it cannot be written the service stays as it is, and the user is told.
        self.0.write(&Saved::default())?;
        self.close();
        *self.0.error.lock().unwrap() = None;
        *self.0.saved.lock().unwrap() = Saved::default();
        self.0.close_connections();
        self.0.manager.log(serde_json::json!({ "event": "share off" }));
        Ok(self.state())
    }

    /// A new key: the earlier code is no longer valid and the open connections close.
    pub fn new_key(&self) -> Result<State> {
        {
            let mut s = self.0.saved.lock().unwrap();
            anyhow::ensure!(s.enabled, "{}", tr!("la condivisione del motore è spenta", "sharing the engine is off"));
            let next = Saved { key: Some(random_hex(24)), ..s.clone() };
            self.0.write(&next)?;
            *s = next;
        }
        self.0.close_connections();
        self.0.manager.log(serde_json::json!({ "event": "share new key" }));
        Ok(self.state())
    }

    /// Opens the ports (one for each address) if they are not open, and keeps them following the addresses.
    fn open(&self) {
        let mut open = self.0.open.lock().unwrap();
        if open.is_some() {
            return;
        }
        let mut listeners = Vec::new();
        self.0.reconcile(&mut listeners);
        let stop = Arc::new(AtomicBool::new(false));
        let (inner, flag) = (self.0.clone(), stop.clone());
        let spawned = std::thread::Builder::new().name("engine-share".into()).spawn(move || inner.run(listeners, &flag));
        match spawned {
            Ok(thread) => *open = Some(Open { stop, thread }),
            Err(e) => *self.0.error.lock().unwrap() = Some(format!("{e}")),
        }
    }

    fn close(&self) {
        if let Some(open) = self.0.open.lock().unwrap().take() {
            open.stop.store(true, Ordering::SeqCst);
            let _ = open.thread.join();
        }
        self.0.bound.lock().unwrap().clear();
    }
}

impl Inner {
    fn write(&self, saved: &Saved) -> Result<()> {
        let text = serde_json::to_string_pretty(saved)?;
        let unsaved = || mango_common::user_text(&tr!("Non riesco a salvare la condivisione del motore.", "I can't save the sharing of the engine."), self.file.display());
        if let Some(folder) = self.file.parent() {
            std::fs::create_dir_all(folder).with_context(unsaved)?;
        }
        mango_common::write_atomic(&self.file, text).with_context(unsaved)
    }

    /// True if it is the current key.
    pub(crate) fn right_key(&self, given: &str) -> bool {
        let s = self.saved.lock().unwrap();
        s.enabled && s.key.as_deref().is_some_and(|k| equal_ct(k.as_bytes(), given.as_bytes()))
    }

    /// The addresses to listen on: the home network's and Tailscale's.
    fn places(&self) -> (Option<Ipv4Addr>, Option<Ipv4Addr>) {
        if self.only_here {
            return (Some(Ipv4Addr::LOCALHOST), None);
        }
        let a = network::addresses();
        (a.home, a.away)
    }

    /// Opens the ports of the addresses that have none, closes those of addresses that are gone.
    fn reconcile(&self, listeners: &mut Vec<(Ipv4Addr, TcpListener)>) {
        let (home, away) = self.places();
        let wanted: Vec<Ipv4Addr> = home.into_iter().chain(away).collect();
        *self.error.lock().unwrap() = network::reconcile(listeners, &wanted, self.port);
        *self.bound.lock().unwrap() = listeners.iter().map(|(ip, _)| *ip).collect();
    }

    fn run(self: Arc<Self>, mut listeners: Vec<(Ipv4Addr, TcpListener)>, stop: &AtomicBool) {
        let mut checked = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            if checked.elapsed() >= RECHECK {
                self.reconcile(&mut listeners);
                checked = Instant::now();
            }
            let mut idle = true;
            for (_, l) in &listeners {
                let Ok((c, _)) = l.accept() else { continue };
                idle = false;
                // On Windows the connection inherits the port's «non-blocking». It is registered before it goes to its
                // thread: whoever turns off while the port closes finds it already among those to close.
                if c.set_nonblocking(false).is_err() || self.connections.lock().unwrap().len() >= MAX_CONNECTIONS {
                    continue;
                }
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let Ok(copy) = c.try_clone() else { continue };
                self.connections.lock().unwrap().insert(id, copy);
                let share = Share(self.clone());
                let _ = std::thread::Builder::new().name("engine-share-request".into()).spawn(move || {
                    http::handle_network(c, &share);
                    share.0.connections.lock().unwrap().remove(&id);
                });
            }
            if idle {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    fn close_connections(&self) {
        for (_, c) in self.connections.lock().unwrap().drain() {
            let _ = c.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Share {
    pub(crate) fn manager(&self) -> &EngineManager {
        &self.0.manager
    }

    pub(crate) fn right_key(&self, given: &str) -> bool {
        self.0.right_key(given)
    }

    /// The reply to `GET /mango/models`: what this PC offers and which one is running.
    pub(crate) fn offered(&self) -> serde_json::Value {
        serde_json::json!({ "models": *self.0.models.lock().unwrap(), "running": self.0.manager.state().model })
    }

    /// A refusal in `manager.log` (never the key). Anyone on the network can cause refusals, so a minute has a limit.
    pub(crate) fn refused(&self, address: &str, status: u16, reason: &str, path: &str) {
        let (began, count) = &mut *self.0.refusals.lock().unwrap();
        if began.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
            (*began, *count) = (Some(Instant::now()), 0);
        }
        *count += 1;
        if *count > REFUSALS_PER_MINUTE {
            if *count == REFUSALS_PER_MINUTE + 1 {
                self.0.manager.log(serde_json::json!({ "event": "share log limit", "reason": "more refusals not written this minute" }));
            }
            return;
        }
        let path: String = path.chars().take(200).collect();
        self.0.manager.log(serde_json::json!({ "event": "share refused", "outcome": status, "reason": reason, "address": address, "path": path }));
    }
}
