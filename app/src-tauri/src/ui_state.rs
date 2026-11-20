//! What the web UI remembers, kept on disk by the app: the list of open and recently closed projects, the preferences, the
//! tabs, the messages waiting to be sent, and the drafts with their attachments.
//!
//! The browser of the window keeps such things per origin (`http://127.0.0.1:<port>`), and the agent's port is not always
//! the same, so the app keeps them itself: `<data>\ui-state.json` (keys of the page's storage and the documents of the
//! drafts, written whole or not at all, with the state before the last write kept as `ui-state.json.bak`) and
//! `<data>\ui-state\blobs\<id>` (the attachments of the drafts, named by the SHA-256 of their bytes). The page reads
//! everything once before it draws (`ui_state_load`), then sends its changes in batches (`ui_state_apply`) and its
//! attachments one by one (`ui_blob_put`, `ui_blob_get`). Before the app closes, or the page goes away, the app asks the
//! page to send what it still holds and waits for its answer (`flush_page`).
//!
//! `UiState` is the one owner: the file is read when it is first needed and then lives in memory. A file whose content
//! cannot be read falls back to the backup; when neither can be read, or the file is of a newer version, or the disk does
//! not give it, it is an error for the page to show, never an empty state, and nothing is written over what is there: it is
//! the user's.

use crate::bridge::{err, shown, BridgeError};
use mango_common::{tr, user_error, write_durable};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The key the page keeps its color scheme under. A copy of it also lives in the page's own storage: the script that
/// paints the page before anything else loads reads it synchronously (`seed_script`).
pub(crate) const THEME_KEY: &str = "opencode-color-scheme";
const VERSION: u32 = 1;

/// The most the app takes in one batch of changes, in bytes of keys and values; one key; one attachment.
const MAX_REQUEST_BYTES: usize = 64 << 20;
const MAX_KEY_BYTES: usize = 4096;
const MAX_BLOB_BYTES: usize = 64 << 20;

/// How long the app waits for the page to answer that it wrote what it held.
const FLUSH_WAIT: Duration = Duration::from_millis(1500);
/// How long the app waits, after that, for a write that is running.
const SETTLE_WAIT: Duration = Duration::from_secs(5);

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Data {
    version: u32,
    /// The old origin's storage was copied here (`ui_state_mark_imported`).
    imported: bool,
    /// The keys of the page's storage.
    entries: BTreeMap<String, String>,
    /// The documents of the drafts (JSON text), by key.
    drafts: BTreeMap<String, String>,
    /// Values the old origin had for keys the app had already written when it was copied: the app's value stayed, and
    /// the old one is kept here.
    superseded: BTreeMap<String, String>,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    Entries,
    Drafts,
    Superseded,
}

/// One change: `value` set, or the key removed when there is none.
#[derive(Deserialize, Debug)]
pub struct Op {
    area: Area,
    key: String,
    value: Option<String>,
}

/// What the window's browser kept for the origin the app prefers (every key of its storage, the documents of its drafts),
/// read by the app (`old_origin.rs`) for the page to merge into the state.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Old {
    pub entries: BTreeMap<String, String>,
    pub drafts: BTreeMap<String, String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    entries: BTreeMap<String, String>,
    drafts: BTreeMap<String, String>,
    imported: bool,
    /// The page is served from the port the app prefers, the one the browser's old storage belongs to (4096 unless the
    /// tests choose another): only there can the page copy that storage itself.
    preferred: bool,
    /// The address of that origin.
    old_origin: String,
    /// The file could not be read and this is the state before the last write, from the backup.
    restored: bool,
    /// The old origin's storage as the app read it, until the page has merged it and marked it copied.
    old: Option<Old>,
}

struct Loaded {
    data: Mutex<Data>,
    file: PathBuf,
    backup: PathBuf,
    blobs: PathBuf,
    /// Serializes the writes of attachments; the state itself stays free while one is written.
    blob_writes: Mutex<()>,
    /// The file on the disk is a state that was read or written whole: the next write may keep it as the backup. Changed
    /// only under `data`.
    file_is_good: AtomicBool,
    restored: bool,
    /// The page was told that it is a state from the backup: once per run, not at every page load.
    restored_told: AtomicBool,
}

struct Inner {
    dir: Result<PathBuf, String>,
    /// Set by the first read that succeeds. A read that fails is not kept: a disk that did not answer once may answer next.
    loaded: OnceLock<Loaded>,
    opening: Mutex<()>,
    old: Mutex<Option<Old>>,
    /// The page's answers wait here by token: `true` when it wrote what it held, `false` when it could not.
    flushes: Mutex<HashMap<u64, Sender<bool>>>,
    next_flush: AtomicU64,
}

#[derive(Clone)]
pub struct UiState(Arc<Inner>);

impl UiState {
    /// The state of the data folder the app runs with.
    pub fn new() -> Self {
        Self::with_dir(mango_common::data_dir().map_err(|e| format!("{e:#}")))
    }

    #[cfg(test)]
    pub(crate) fn in_dir(dir: &Path) -> Self {
        Self::with_dir(Ok(dir.to_path_buf()))
    }

    fn with_dir(dir: Result<PathBuf, String>) -> Self {
        Self(Arc::new(Inner {
            dir,
            loaded: OnceLock::new(),
            opening: Mutex::new(()),
            old: Mutex::new(None),
            flushes: Mutex::new(HashMap::new()),
            next_flush: AtomicU64::new(1),
        }))
    }

    /// Reads the file the first time and keeps it. The attachments no draft points to are removed here, once per run: at
    /// this point none can be on its way. Reads from the disk, so not for the thread of a window.
    fn loaded(&self) -> anyhow::Result<&Loaded> {
        if let Some(loaded) = self.0.loaded.get() {
            return Ok(loaded);
        }
        let _opening = self.0.opening.lock().unwrap();
        if let Some(loaded) = self.0.loaded.get() {
            return Ok(loaded);
        }
        let dir = self.0.dir.clone().map_err(|e| anyhow::anyhow!("{e}"))?;
        let loaded = open(dir)?;
        Ok(self.0.loaded.get_or_init(|| loaded))
    }

    fn snapshot(&self, preferred: bool, old_origin: String) -> anyhow::Result<Snapshot> {
        let loaded = self.loaded()?;
        let data = loaded.data.lock().unwrap();
        Ok(Snapshot {
            entries: data.entries.clone(),
            drafts: data.drafts.clone(),
            imported: data.imported,
            preferred,
            old_origin,
            restored: loaded.restored && !loaded.restored_told.swap(true, Ordering::SeqCst),
            old: self.0.old.lock().unwrap().clone(),
        })
    }

    /// The old origin's storage was not copied yet. An error when the state cannot be read: nothing is copied into it.
    pub fn needs_import(&self) -> anyhow::Result<bool> {
        Ok(!self.loaded()?.data.lock().unwrap().imported)
    }

    /// Holds what the app read of the old origin until the page merges it (`snapshot`) and marks it copied.
    pub fn keep_old(&self, old: Old) {
        *self.0.old.lock().unwrap() = Some(old);
    }

    /// `true` when a change touched the color scheme.
    fn apply(&self, ops: Vec<Op>) -> anyhow::Result<bool> {
        let mut theme = false;
        self.change(|data| {
            for op in ops {
                theme |= matches!(op.area, Area::Entries) && op.key == THEME_KEY;
                let map = match op.area {
                    Area::Entries => &mut data.entries,
                    Area::Drafts => &mut data.drafts,
                    Area::Superseded => &mut data.superseded,
                };
                match op.value {
                    Some(value) => map.insert(op.key, value),
                    None => map.remove(&op.key),
                };
            }
        })?;
        Ok(theme)
    }

    fn mark_imported(&self) -> anyhow::Result<()> {
        self.change(|data| data.imported = true)?;
        self.0.old.lock().unwrap().take();
        Ok(())
    }

    /// Changes the state in memory and writes it. When the write fails the memory keeps the change: the page sends its
    /// changes again, and the same change twice is the same state.
    fn change(&self, edit: impl FnOnce(&mut Data)) -> anyhow::Result<()> {
        let loaded = self.loaded()?;
        let mut data = loaded.data.lock().unwrap();
        edit(&mut data);
        let bytes = serde_json::to_vec(&*data)?;
        if loaded.file_is_good.load(Ordering::SeqCst) {
            if let Err(e) = keep_previous(&loaded.file, &loaded.backup) {
                eprintln!("the interface's state backup was not kept: {}: {e}", loaded.backup.display());
            }
        }
        write_durable(&loaded.file, bytes).map_err(|e| user_error(&write_failed(), format!("{}: {e}", loaded.file.display())))?;
        loaded.file_is_good.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn put_blob(&self, id: &str, bytes: &[u8]) -> anyhow::Result<()> {
        let loaded = self.loaded()?;
        let file = blob_file(loaded, id)?;
        check_blob(id, bytes)?;
        let _writing = loaded.blob_writes.lock().unwrap();
        if file.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&loaded.blobs)?;
        write_durable(&file, bytes).map_err(|e| user_error(&write_failed(), format!("{}: {e}", file.display())))
    }

    pub(crate) fn get_blob(&self, id: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let loaded = self.loaded()?;
        match std::fs::read(blob_file(loaded, id)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// The color scheme the page last saved, as a script for the page to run before its own: the page's storage of this
    /// origin may be empty (another port), and the script that paints the page cannot wait for the app's answer. Nothing
    /// when the state cannot be read yet or holds no color scheme: the page reports that itself.
    pub fn seed_script(&self) -> Option<String> {
        let data = self.loaded().ok()?.data.lock().unwrap();
        let scheme = data.entries.get(THEME_KEY).filter(|v| matches!(v.as_str(), "light" | "dark"))?;
        Some(format!("try {{ localStorage.setItem({}, {}) }} catch (_) {{}}", serde_json::to_string(THEME_KEY).ok()?, serde_json::to_string(scheme).ok()?))
    }

    /// A request to the page to write what it holds: its token, and what to wait on for the answer (`flushed`).
    fn expect_flush(&self) -> (u64, Receiver<bool>) {
        let token = self.0.next_flush.fetch_add(1, Ordering::SeqCst);
        let (sender, answer) = channel();
        self.0.flushes.lock().unwrap().insert(token, sender);
        (token, answer)
    }

    /// The page answers the request: `written` is whether everything it held is on the disk.
    fn flushed(&self, token: u64, written: bool) {
        if let Some(sender) = self.0.flushes.lock().unwrap().remove(&token) {
            let _ = sender.send(written);
        }
    }

    fn forget_flush(&self, token: u64) {
        self.0.flushes.lock().unwrap().remove(&token);
    }

    /// Waits until no write of the state or of an attachment is running, or `limit` passes; whether none is. A write that
    /// the page's answer did not wait for (its own request timed out) may still be on its way when the app is about to close.
    fn settled(&self, limit: Duration) -> bool {
        if self.0.loaded.get().is_none() {
            return true;
        }
        // The locks are taken by a thread of their own: past the limit the app goes on, and that thread ends with the write.
        let (state, (done, settled)) = (self.clone(), channel());
        std::thread::spawn(move || {
            if let Some(loaded) = state.0.loaded.get() {
                let _data = loaded.data.lock();
                let _blobs = loaded.blob_writes.lock();
            }
            let _ = done.send(());
        });
        settled.recv_timeout(limit).is_ok()
    }
}

fn write_failed() -> String {
    tr!("Mango Code non riesce a salvare lo stato dell'interfaccia.", "Mango Code cannot save the interface's state.")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The attachment's file. The id is the SHA-256 of its bytes, in hex: anything else could point outside the folder.
fn blob_file(loaded: &Loaded, id: &str) -> anyhow::Result<PathBuf> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        anyhow::bail!("{}", tr!("identificativo dell'allegato non valido", "invalid attachment id"));
    }
    Ok(loaded.blobs.join(id))
}

/// An attachment is as big as the app takes and is the bytes its id names: the page names them by their hash, and a
/// mismatch would store one thing under the name of another.
fn check_blob(id: &str, bytes: &[u8]) -> anyhow::Result<()> {
    if bytes.len() > MAX_BLOB_BYTES {
        anyhow::bail!("{}", tr!("allegato troppo grande ({} byte)", "attachment too big ({} bytes)", bytes.len()));
    }
    if sha256_hex(bytes) != id {
        anyhow::bail!("{}", tr!("l'allegato non corrisponde al suo identificativo", "the attachment does not match its id"));
    }
    Ok(())
}

/// A batch of changes is as big as the app takes, with keys of a sane length.
fn check_ops(ops: &[Op]) -> Result<(), String> {
    if ops.iter().any(|op| op.key.len() > MAX_KEY_BYTES) {
        return Err(tr!("chiave dello stato troppo lunga (oltre {MAX_KEY_BYTES} byte)", "state key too long (over {MAX_KEY_BYTES} bytes)"));
    }
    let size: usize = ops.iter().map(|op| op.key.len() + op.value.as_ref().map_or(0, String::len)).sum();
    if size > MAX_REQUEST_BYTES {
        return Err(tr!("modifiche dello stato troppo grandi ({size} byte)", "state changes too big ({size} bytes)"));
    }
    Ok(())
}

fn open(dir: PathBuf) -> anyhow::Result<Loaded> {
    let file = dir.join("ui-state.json");
    let backup = dir.join("ui-state.json.bak");
    let blobs = dir.join("ui-state").join("blobs");
    // A missing file is a state not started yet, whatever a backup holds (whoever deleted the file wanted to start over).
    // A file whose content is not a state falls back to the backup. A file the disk did not give, or one of a newer version,
    // is not a file to replace: the next write would take the user's state away.
    let (data, file_is_good, restored) = match read_state(&file) {
        Read::Good(data) => (data, true, false),
        Read::Missing => (Data { version: VERSION, ..Data::default() }, false, false),
        Read::Newer(version) => return Err(newer(&file, version)),
        Read::Unavailable(detail) => return Err(unavailable(&file, detail)),
        Read::Broken(detail) => match read_state(&backup) {
            Read::Good(data) => (data, false, true),
            _ => return Err(unreadable(&file, &backup, detail)),
        },
    };
    // The attachments only the unreadable file named are not an orphan: they stay while its state is the one that was lost.
    if !restored {
        sweep(&blobs, &data);
    }
    Ok(Loaded {
        data: Mutex::new(data),
        file,
        backup,
        blobs,
        blob_writes: Mutex::new(()),
        file_is_good: AtomicBool::new(file_is_good),
        restored,
        restored_told: AtomicBool::new(false),
    })
}

/// What reading a state file gave.
enum Read {
    Missing,
    Good(Data),
    /// The file is there and its content is not a state this version can read.
    Broken(String),
    /// A state of a version after this one.
    Newer(u32),
    /// The disk did not give the file, twice.
    Unavailable(String),
}

fn read_state(file: &Path) -> Read {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Missing,
        Err(_) => {
            // A file another program has open for a moment (a scanner, a backup) can refuse a read once.
            std::thread::sleep(Duration::from_millis(100));
            match std::fs::read(file) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Missing,
                Err(e) => return Read::Unavailable(e.to_string()),
            }
        }
    };
    #[derive(Deserialize)]
    struct Versioned {
        version: Option<u32>,
    }
    if let Ok(Versioned { version: Some(version) }) = serde_json::from_slice(&bytes) {
        if version > VERSION {
            return Read::Newer(version);
        }
    }
    match serde_json::from_slice::<Data>(&bytes) {
        Ok(data) if data.version == VERSION => Read::Good(data),
        Ok(_) => Read::Broken("not a state file this version can read".into()),
        Err(e) => Read::Broken(e.to_string()),
    }
}

/// The file as it is now becomes the backup, before it is replaced: a link to the same bytes where the disk allows it,
/// otherwise a copy. The backup itself is replaced whole.
fn keep_previous(file: &Path, backup: &Path) -> std::io::Result<()> {
    let mut staged = backup.as_os_str().to_owned();
    staged.push(".tmp");
    let staged = PathBuf::from(staged);
    let _ = std::fs::remove_file(&staged);
    if std::fs::hard_link(file, &staged).is_err() {
        std::fs::copy(file, &staged)?;
    }
    std::fs::rename(&staged, backup)
}

fn unreadable(file: &Path, backup: &Path, detail: String) -> anyhow::Error {
    user_error(
        &tr!(
            "Mango Code non riesce a leggere lo stato dell'interfaccia salvato in {} (né la sua copia {}). I file non sono stati toccati: per ripartire da zero chiudi l'app, cancella o rinomina entrambi e riaprila.",
            "Mango Code cannot read the interface's state saved in {} (nor its copy {}). The files were not touched: to start from scratch, close the app, delete or rename both and open it again.",
            file.display(),
            backup.display()
        ),
        detail,
    )
}

fn newer(file: &Path, version: u32) -> anyhow::Error {
    user_error(
        &tr!(
            "Lo stato dell'interfaccia salvato in {} è di una versione più recente di Mango Code. Il file non è stato toccato: aggiorna l'app.",
            "The interface's state saved in {} is from a newer version of Mango Code. The file was not touched: update the app.",
            file.display()
        ),
        format!("version {version}"),
    )
}

fn unavailable(file: &Path, detail: String) -> anyhow::Error {
    user_error(
        &tr!(
            "Mango Code non riesce a leggere lo stato dell'interfaccia salvato in {}: il disco non lo dà in questo momento. Il file non è stato toccato: riapri l'app tra poco.",
            "Mango Code cannot read the interface's state saved in {}: the disk does not give it right now. The file was not touched: open the app again in a moment.",
            file.display()
        ),
        detail,
    )
}

/// Removes the attachments that no draft names, among the drafts and the old ones set aside. A failure leaves the file
/// where it is.
fn sweep(blobs: &Path, data: &Data) {
    let Ok(entries) = std::fs::read_dir(blobs) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !data.drafts.values().chain(data.superseded.values()).any(|doc| doc.contains(&name)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Asks the page of the window to send the changes it holds and waits until it says it did, or a short while: the app is
/// about to close it, or to take the window to another page. Does not wait when the window shows the app's own page (there
/// is no state in it). Blocks: never call it from the thread that runs the window's events, which is the one that delivers
/// the page's answer.
pub(crate) fn flush_page(app: &AppHandle) {
    let Some(window) = crate::main_window(app) else { return };
    if !crate::on_agent_page(&window) {
        return;
    }
    let state = app.state::<UiState>().inner().clone();
    if state.loaded().is_err() {
        return;
    }
    let log = |line: &str| {
        if let Some(paths) = app.state::<crate::AppState>().paths.get() {
            crate::startup_log(paths, line);
        }
    };
    let (token, answer) = state.expect_flush();
    let event = format!("window.dispatchEvent(new CustomEvent('mango-ui-state-flush',{{detail:{token}}}))");
    match window.eval(event).ok().and_then(|()| answer.recv_timeout(FLUSH_WAIT).ok()) {
        Some(true) => {}
        Some(false) => log("the interface could not write its state; what it holds is lost"),
        None => {
            state.forget_flush(token);
            log("the interface did not confirm that its state was written");
        }
    }
    settle(app);
}

/// A write of the state that is running finishes before the app goes on to close: the page's answer does not cover one it
/// sent after its request timed out, or at the end of a Windows session, where the page cannot be asked at all. Does not
/// need the window's thread: the writes run on others.
pub(crate) fn settle(app: &AppHandle) {
    if !app.state::<UiState>().settled(SETTLE_WAIT) {
        if let Some(paths) = app.state::<crate::AppState>().paths.get() {
            crate::startup_log(paths, "a write of the interface's state was still running when the app went on");
        }
    }
}

// ---------------------------------------------------------------- commands

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> anyhow::Result<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| anyhow::anyhow!("{e}"))?
}

/// Everything the page remembers, to read once before it draws. Rejects with `unreadable` when the file cannot be read.
#[tauri::command]
pub async fn ui_state_load(app: AppHandle) -> Result<Snapshot, BridgeError> {
    let state = app.state::<UiState>().inner().clone();
    let preferred = crate::agent_port() == crate::preferred_agent_port();
    let old_origin = format!("http://127.0.0.1:{}", crate::preferred_agent_port());
    blocking(move || state.snapshot(preferred, old_origin)).await.map_err(|e| shown(&app, "unreadable", "the interface's state is unreadable", e))
}

/// The changes of the page since the last call, in order.
#[tauri::command]
pub async fn ui_state_apply(app: AppHandle, ops: Vec<Op>) -> Result<(), BridgeError> {
    check_ops(&ops).map_err(|e| err("invalid", e))?;
    let state = app.state::<UiState>().inner().clone();
    let theme = blocking(move || state.apply(ops)).await.map_err(|e| shown(&app, "io", "the interface's state was not saved", e))?;
    if theme {
        crate::seed::refresh(&app);
    }
    Ok(())
}

/// The old origin's storage is all here: the page does not copy it again.
#[tauri::command]
pub async fn ui_state_mark_imported(app: AppHandle) -> Result<(), BridgeError> {
    let state = app.state::<UiState>().inner().clone();
    blocking(move || state.mark_imported()).await.map_err(|e| shown(&app, "io", "the interface's state was not saved", e))
}

/// The page answers the request of `flush_page` with its token, once what it held is written (`written`) or could not be.
#[tauri::command]
pub fn ui_state_flushed(app: AppHandle, token: u64, written: bool) {
    app.state::<UiState>().flushed(token, written);
}

/// An attachment of a draft. The body is the id (64 characters of hex) followed by the bytes.
#[tauri::command]
pub async fn ui_blob_put(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), BridgeError> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(err("invalid", tr!("allegato non valido", "invalid attachment")));
    };
    if body.len() < 64 {
        return Err(err("invalid", tr!("allegato non valido", "invalid attachment")));
    }
    let (id, bytes) = body.split_at(64);
    let id = String::from_utf8_lossy(id).into_owned();
    let bytes = bytes.to_vec();
    let state = app.state::<UiState>().inner().clone();
    blocking(move || state.put_blob(&id, &bytes)).await.map_err(|e| shown(&app, "io", "an attachment was not saved", e))
}

/// An attachment by id: one byte, 1 if it is there and 0 if not, then its bytes.
#[tauri::command]
pub async fn ui_blob_get(app: AppHandle, id: String) -> Result<tauri::ipc::Response, BridgeError> {
    let state = app.state::<UiState>().inner().clone();
    let found = blocking(move || state.get_blob(&id)).await.map_err(|e| shown(&app, "io", "an attachment was not read", e))?;
    let mut body = vec![u8::from(found.is_some())];
    body.extend(found.unwrap_or_default());
    Ok(tauri::ipc::Response::new(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:4096";

    fn state(dir: &Path) -> UiState {
        UiState::with_dir(Ok(dir.to_path_buf()))
    }

    fn set(key: &str, value: &str) -> Op {
        Op { area: Area::Entries, key: key.into(), value: Some(value.into()) }
    }

    fn draft(key: &str, value: &str) -> Op {
        Op { area: Area::Drafts, key: key.into(), value: Some(value.into()) }
    }

    fn remove(key: &str) -> Op {
        Op { area: Area::Entries, key: key.into(), value: None }
    }

    /// Stores `bytes` as an attachment and gives its id.
    fn put(ui: &UiState, bytes: &[u8]) -> String {
        let id = sha256_hex(bytes);
        ui.put_blob(&id, bytes).unwrap();
        id
    }

    #[test]
    fn a_data_folder_without_state_is_an_empty_state_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = state(dir.path()).snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(
            snapshot,
            Snapshot { entries: BTreeMap::new(), drafts: BTreeMap::new(), imported: false, preferred: true, old_origin: ORIGIN.into(), restored: false, old: None }
        );
        assert!(!dir.path().join("ui-state.json").exists(), "a read does not write");
    }

    #[test]
    fn what_was_applied_is_there_after_the_app_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let first = state(dir.path());
        first.apply(vec![set("a", "1"), set("b", "2"), draft("p", "{\"x\":1}"), remove("b")]).unwrap();
        first.mark_imported().unwrap();
        let again = state(dir.path()).snapshot(false, ORIGIN.into()).unwrap();
        assert_eq!(again.entries, BTreeMap::from([("a".to_string(), "1".to_string())]));
        assert_eq!(again.drafts, BTreeMap::from([("p".to_string(), "{\"x\":1}".to_string())]));
        assert!(again.imported);
        assert!(!again.preferred);
    }

    #[test]
    fn the_file_is_written_whole_and_only_its_backup_is_left_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        for n in 0..20 {
            ui.apply(vec![set("key", &"x".repeat(n * 1000))]).unwrap();
            let text = std::fs::read_to_string(dir.path().join("ui-state.json")).unwrap();
            assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok(), "write {n}");
        }
        let mut names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["ui-state.json", "ui-state.json.bak"]);
    }

    #[test]
    fn a_partial_temporary_left_by_a_crash_is_not_read_and_the_next_write_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        let tmp = dir.path().join("ui-state.json.tmp");
        std::fs::write(&tmp, "{\"version\":1,\"entries\":{\"a\":\"CUT SHORT").unwrap();
        let after_crash = state(dir.path()).snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(after_crash.entries.get("a").map(String::as_str), Some("1"));
        assert!(!after_crash.restored);
        ui.apply(vec![set("b", "2")]).unwrap();
        assert!(!tmp.exists(), "the file is written aside and moved over the old one, so no temporary is left");
        let written: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json")).unwrap()).unwrap();
        assert_eq!(written.entries.len(), 2);
    }

    #[test]
    fn an_unreadable_file_without_a_backup_is_an_error_that_names_it_and_the_file_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ui-state.json");
        for broken in ["{\"version\":1,\"entries\":", "", "[]", "{\"version\":99,\"entries\":{},\"drafts\":{},\"imported\":false}"] {
            std::fs::write(&file, broken).unwrap();
            let ui = state(dir.path());
            let error = ui.snapshot(true, ORIGIN.into()).unwrap_err();
            assert!(error.to_string().contains("ui-state.json"), "{broken:?}: {error}");
            assert!(ui.apply(vec![set("a", "1")]).is_err(), "{broken:?}: a change must not replace the file it could not read");
            assert!(ui.mark_imported().is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), broken);
        }
    }

    #[test]
    fn a_state_that_cannot_be_read_falls_back_to_the_last_good_one_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        let file = dir.path().join("ui-state.json");
        assert!(dir.path().join("ui-state.json.bak").is_file());
        std::fs::write(&file, "").unwrap();
        let again = state(dir.path());
        let snapshot = again.snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(snapshot.entries.get("a").map(String::as_str), Some("1"), "the state before the last write");
        assert!(snapshot.restored);
        // the first change after the fall back does not make the unreadable file the backup
        again.apply(vec![set("b", "x")]).unwrap();
        let backup = std::fs::read_to_string(dir.path().join("ui-state.json.bak")).unwrap();
        assert!(serde_json::from_str::<Data>(&backup).is_ok(), "{backup:?}");
        let after = state(dir.path()).snapshot(true, ORIGIN.into()).unwrap();
        assert!(!after.restored);
        assert_eq!(after.entries.get("b").map(String::as_str), Some("x"));
        assert_eq!(after.entries.get("a").map(String::as_str), Some("1"));
    }

    #[test]
    fn with_both_files_unreadable_the_error_names_both_and_nothing_is_touched() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        let (file, backup) = (dir.path().join("ui-state.json"), dir.path().join("ui-state.json.bak"));
        std::fs::write(&file, "{").unwrap();
        std::fs::write(&backup, "[]").unwrap();
        let ui = state(dir.path());
        let error = ui.snapshot(true, ORIGIN.into()).unwrap_err().to_string();
        assert!(error.contains("ui-state.json") && error.contains("ui-state.json.bak"), "{error}");
        assert!(ui.apply(vec![set("a", "3")]).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "[]");
    }

    #[test]
    fn a_deleted_state_file_starts_from_scratch_even_if_a_backup_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        std::fs::remove_file(dir.path().join("ui-state.json")).unwrap();
        let snapshot = state(dir.path()).snapshot(true, ORIGIN.into()).unwrap();
        assert!(snapshot.entries.is_empty() && !snapshot.restored);
    }

    #[test]
    fn the_backup_is_the_state_before_the_last_write() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        assert!(!dir.path().join("ui-state.json.bak").exists(), "nothing before the first write");
        ui.apply(vec![set("a", "2")]).unwrap();
        ui.apply(vec![set("a", "3")]).unwrap();
        let backup: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json.bak")).unwrap()).unwrap();
        assert_eq!(backup.entries.get("a").map(String::as_str), Some("2"));
        let current: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json")).unwrap()).unwrap();
        assert_eq!(current.entries.get("a").map(String::as_str), Some("3"));
    }

    #[test]
    fn many_threads_writing_at_once_lose_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        std::thread::scope(|scope| {
            for thread in 0..8 {
                let ui = ui.clone();
                scope.spawn(move || {
                    for n in 0..25 {
                        ui.apply(vec![set(&format!("t{thread}-{n}"), "v")]).unwrap();
                        put(&ui, format!("bytes of {thread}").as_bytes());
                    }
                });
            }
        });
        assert_eq!(std::fs::read_dir(dir.path().join("ui-state").join("blobs")).unwrap().count(), 8);
        assert_eq!(state(dir.path()).snapshot(true, ORIGIN.into()).unwrap().entries.len(), 200);
    }

    #[test]
    fn an_attachment_comes_back_with_its_bytes_and_a_missing_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        let a = put(&ui, &[0, 1, 2, 255]);
        put(&ui, &[0, 1, 2, 255]);
        let b = put(&ui, &[]);
        assert_eq!(ui.get_blob(&a).unwrap(), Some(vec![0, 1, 2, 255]));
        assert_eq!(ui.get_blob(&b).unwrap(), Some(vec![]));
        assert_eq!(ui.get_blob(&"c".repeat(64)).unwrap(), None);
    }

    #[test]
    fn an_attachment_must_be_the_bytes_its_id_names() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        let wrong = "a".repeat(64);
        assert!(ui.put_blob(&wrong, b"picture").is_err());
        assert_eq!(ui.get_blob(&wrong).unwrap(), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn an_id_that_is_not_a_hash_cannot_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        for bad in ["", "..", &format!("..\\{}", "a".repeat(62)), &"A".repeat(64), &"a".repeat(63), &"a".repeat(65), &format!("{}/x", "a".repeat(62))] {
            assert!(ui.put_blob(bad, b"x").is_err(), "{bad:?}");
            assert!(ui.get_blob(bad).is_err(), "{bad:?}");
        }
        assert!(!dir.path().join("ui-state").join("x").exists());
    }

    #[test]
    fn writing_an_attachment_does_not_hold_up_the_state() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        let _writing_a_blob = ui.loaded().unwrap().blob_writes.lock().unwrap();
        let (sender, done) = channel();
        let other = ui.clone();
        std::thread::spawn(move || sender.send(other.apply(vec![set("b", "2")]).is_ok()).unwrap());
        assert_eq!(done.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn a_change_that_is_too_big_is_refused() {
        let big = "x".repeat(MAX_REQUEST_BYTES + 1);
        assert!(check_ops(&[set("a", &big)]).is_err(), "a batch over the limit");
        assert!(check_ops(&[set(&"k".repeat(MAX_KEY_BYTES + 1), "v")]).is_err(), "a key over the limit");
        assert!(check_ops(&[set("a", "1"), draft("b", "2"), remove("c")]).is_ok());
        assert!(check_ops(&[]).is_ok());
        let too_big = vec![0u8; MAX_BLOB_BYTES + 1];
        assert!(check_blob(&sha256_hex(&too_big), &too_big).is_err(), "an attachment over the limit, whose id is right");
    }

    #[test]
    fn at_the_start_the_attachments_no_draft_names_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        let kept = put(&ui, b"kept");
        let orphan = put(&ui, b"orphan");
        ui.apply(vec![draft("d", &format!("{{\"blob\":{{\"id\":\"{kept}\"}}}}"))]).unwrap();
        let again = state(dir.path());
        again.snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(again.get_blob(&kept).unwrap(), Some(b"kept".to_vec()));
        assert_eq!(again.get_blob(&orphan).unwrap(), None);
    }

    #[test]
    fn the_unreadable_file_keeps_its_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let kept = put(&state(dir.path()), b"kept");
        std::fs::write(dir.path().join("ui-state.json"), "{").unwrap();
        assert!(state(dir.path()).snapshot(true, ORIGIN.into()).is_err());
        assert!(dir.path().join("ui-state").join("blobs").join(kept).is_file());
    }

    #[test]
    fn what_the_old_origin_held_is_given_to_the_page_until_it_is_marked_imported() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        assert!(ui.needs_import().unwrap());
        ui.keep_old(Old {
            entries: BTreeMap::from([("k".to_string(), "v".to_string())]),
            drafts: BTreeMap::from([("d".to_string(), "{}".to_string())]),
        });
        let snapshot = ui.snapshot(false, ORIGIN.into()).unwrap();
        assert_eq!(snapshot.old.as_ref().map(|o| o.entries.len()), Some(1));
        assert!(snapshot.entries.is_empty(), "it is not the app's state until the page merges it");
        assert!(!dir.path().join("ui-state.json").exists());
        ui.mark_imported().unwrap();
        let after = ui.snapshot(false, ORIGIN.into()).unwrap();
        assert!(after.old.is_none() && after.imported);
        assert!(!ui.needs_import().unwrap());
    }

    #[test]
    fn a_value_the_old_origin_had_and_the_app_replaced_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![Op { area: Area::Superseded, key: "settings".into(), value: Some("old".into()) }]).unwrap();
        let written: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json")).unwrap()).unwrap();
        assert_eq!(written.superseded.get("settings").map(String::as_str), Some("old"));
        assert!(!written.entries.contains_key("settings"));
    }

    #[test]
    fn a_change_to_the_color_scheme_is_told_to_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        assert!(!ui.apply(vec![set("other", "1")]).unwrap());
        assert!(ui.apply(vec![set("other", "1"), set(THEME_KEY, "dark")]).unwrap());
        assert!(ui.apply(vec![remove(THEME_KEY)]).unwrap());
        assert!(!ui.apply(vec![draft(THEME_KEY, "dark")]).unwrap(), "only the storage key is the color scheme");
    }

    #[test]
    fn a_change_that_cannot_be_written_is_an_error_and_goes_out_with_the_next_write() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        // the temporary file cannot be created: a folder is in its place
        std::fs::create_dir(dir.path().join("ui-state.json.tmp")).unwrap();
        assert!(ui.apply(vec![set("b", "2")]).is_err());
        let on_disk: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json")).unwrap()).unwrap();
        assert_eq!(on_disk.entries.keys().collect::<Vec<_>>(), ["a"]);
        std::fs::remove_dir(dir.path().join("ui-state.json.tmp")).unwrap();
        ui.apply(vec![set("c", "3")]).unwrap();
        let on_disk: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json")).unwrap()).unwrap();
        assert_eq!(on_disk.entries.keys().collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    #[test]
    fn the_page_is_asked_to_write_and_the_wait_ends_with_its_answer_or_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        let (token, answered) = ui.expect_flush();
        assert_ne!(ui.expect_flush().0, token, "every request has its own token");
        let page = ui.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            page.flushed(token, true);
        });
        assert_eq!(answered.recv_timeout(Duration::from_secs(5)), Ok(true));
        let (token, failed) = ui.expect_flush();
        ui.flushed(token, false);
        assert_eq!(failed.recv_timeout(Duration::from_secs(5)), Ok(false), "a page that could not write says so");
        let (token, silent) = ui.expect_flush();
        assert!(silent.recv_timeout(Duration::from_millis(50)).is_err());
        ui.forget_flush(token);
        assert!(!ui.0.flushes.lock().unwrap().contains_key(&token), "a request nobody waits for is not kept");
        ui.flushed(token, true);
        ui.flushed(token + 1000, true);
    }


    /// A state file the disk does not give: a folder in its place refuses to be read as a file.
    fn unreadable_by_the_disk(dir: &Path) {
        std::fs::remove_file(dir.join("ui-state.json")).unwrap();
        std::fs::create_dir(dir.join("ui-state.json")).unwrap();
    }

    #[test]
    fn a_file_the_disk_does_not_give_is_an_error_not_a_fall_back_and_a_later_read_may_succeed() {
        let dir = tempfile::tempdir().unwrap();
        let first = state(dir.path());
        first.apply(vec![set("a", "1")]).unwrap();
        first.apply(vec![set("a", "2")]).unwrap();
        let kept = put(&first, b"only in the real file");
        first.apply(vec![draft("d", &format!("{{\"blob\":{{\"id\":\"{kept}\"}}}}"))]).unwrap();
        let backup_before = std::fs::read(dir.path().join("ui-state.json.bak")).unwrap();
        let good = std::fs::read(dir.path().join("ui-state.json")).unwrap();
        unreadable_by_the_disk(dir.path());
        let ui = state(dir.path());
        assert!(ui.snapshot(true, ORIGIN.into()).is_err(), "the backup does not stand in for a file that is there");
        assert!(ui.apply(vec![set("b", "3")]).is_err());
        assert_eq!(std::fs::read(dir.path().join("ui-state.json.bak")).unwrap(), backup_before);
        assert!(dir.path().join("ui-state").join("blobs").join(&kept).is_file(), "nothing is swept");
        std::fs::remove_dir(dir.path().join("ui-state.json")).unwrap();
        std::fs::write(dir.path().join("ui-state.json"), &good).unwrap();
        let snapshot = ui.snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(snapshot.entries.get("a").map(String::as_str), Some("2"), "the error was not kept");
        assert!(!snapshot.restored);
    }

    #[test]
    fn a_file_of_a_newer_version_is_never_replaced_not_even_by_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        let file = dir.path().join("ui-state.json");
        for newer in [
            "{\"version\":2,\"entries\":{\"a\":\"future\"},\"drafts\":{},\"imported\":true}",
            "{\"version\":2,\"entries\":[\"a shape this version does not know\"]}",
        ] {
            std::fs::write(&file, newer).unwrap();
            let again = state(dir.path());
            let error = again.snapshot(true, ORIGIN.into()).unwrap_err().to_string();
            assert!(error.contains("ui-state.json"), "{error}");
            assert!(again.apply(vec![set("b", "x")]).is_err());
            assert!(again.mark_imported().is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);
        }
    }

    #[test]
    fn a_state_restored_from_the_backup_keeps_the_attachments_only_the_lost_file_named() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        let kept = put(&ui, b"named by a draft the backup does not have");
        ui.apply(vec![draft("d", &format!("{{\"blob\":{{\"id\":\"{kept}\"}}}}"))]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        std::fs::write(dir.path().join("ui-state.json"), "").unwrap();
        // the backup is the state before the last write: it has the draft; take the draft out of it to make the point
        let mut backup: Data = serde_json::from_slice(&std::fs::read(dir.path().join("ui-state.json.bak")).unwrap()).unwrap();
        backup.drafts.clear();
        std::fs::write(dir.path().join("ui-state.json.bak"), serde_json::to_vec(&backup).unwrap()).unwrap();
        let restored = state(dir.path());
        assert!(restored.snapshot(true, ORIGIN.into()).unwrap().restored);
        assert_eq!(restored.get_blob(&kept).unwrap(), Some(b"named by a draft the backup does not have".to_vec()));
    }

    #[test]
    fn the_page_is_told_of_a_restored_state_once_per_run() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("a", "1")]).unwrap();
        ui.apply(vec![set("a", "2")]).unwrap();
        std::fs::write(dir.path().join("ui-state.json"), "").unwrap();
        let again = state(dir.path());
        assert!(again.snapshot(true, ORIGIN.into()).unwrap().restored);
        assert!(!again.snapshot(true, ORIGIN.into()).unwrap().restored, "a page load later in the same run");
    }

    #[test]
    fn an_attachment_only_an_old_draft_set_aside_names_survives_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        let aside = put(&ui, b"in a superseded draft");
        let orphan = put(&ui, b"in nothing");
        ui.apply(vec![Op { area: Area::Superseded, key: "drafts/d".into(), value: Some(format!("{{\"blob\":{{\"id\":\"{aside}\"}}}}")) }]).unwrap();
        let again = state(dir.path());
        again.snapshot(true, ORIGIN.into()).unwrap();
        assert_eq!(again.get_blob(&aside).unwrap(), Some(b"in a superseded draft".to_vec()));
        assert_eq!(again.get_blob(&orphan).unwrap(), None);
    }

    #[test]
    fn a_backup_older_than_the_end_of_the_copy_has_no_user_change_that_a_second_copy_could_undo() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        ui.apply(vec![set("copied", "from the old origin")]).unwrap();
        ui.mark_imported().unwrap();
        // the first change after the copy makes the backup the state that says the copy is done
        ui.apply(vec![remove("copied")]).unwrap();
        std::fs::write(dir.path().join("ui-state.json"), "").unwrap();
        let restored = state(dir.path()).snapshot(true, ORIGIN.into()).unwrap();
        assert!(restored.restored && restored.imported, "no second copy, which would bring back what the user removed");
    }

    #[test]
    fn the_wait_for_the_writes_ends_when_none_is_running_or_after_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let ui = state(dir.path());
        assert!(ui.settled(Duration::from_millis(10)), "nothing read yet");
        ui.apply(vec![set("a", "1")]).unwrap();
        assert!(ui.settled(Duration::from_millis(10)));
        let writing = ui.loaded().unwrap().data.lock().unwrap();
        assert!(!ui.settled(Duration::from_millis(60)), "a write holds the state");
        drop(writing);
        let blob = ui.loaded().unwrap().blob_writes.lock().unwrap();
        assert!(!ui.settled(Duration::from_millis(60)), "an attachment is being written");
        drop(blob);
        assert!(ui.settled(Duration::from_millis(10)));
    }
    #[test]
    fn the_page_is_given_its_color_scheme_before_it_loads_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(state(dir.path()).seed_script(), None);
        state(dir.path()).apply(vec![set(THEME_KEY, "dark"), set("other", "1")]).unwrap();
        let script = state(dir.path()).seed_script().unwrap();
        assert!(script.contains("\"opencode-color-scheme\"") && script.contains("\"dark\"") && !script.contains("other"), "{script}");
        state(dir.path()).apply(vec![set(THEME_KEY, "\"); alert(1); (\"")]).unwrap();
        assert_eq!(state(dir.path()).seed_script(), None);
    }
}
