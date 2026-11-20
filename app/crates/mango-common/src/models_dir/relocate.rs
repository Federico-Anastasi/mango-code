//! Moving the models folder: a preview that touches nothing, and the move itself.
//!
//! Only what is Mango Code's own moves (`Owned`): the files of the models, the dictation models, what the app writes next to
//! them. Any other file in the folder stays where it is, and the preview says so. On the same volume the files are renamed
//! one by one into the new folder; if one cannot be (a file open in another program), those already moved go back. On another
//! volume the files are copied one by one into a temporary name, with their modification time, hashed on both sides, and
//! renamed into place; only when all are there the choice is written (and the places and the user's models that point into
//! the old folder are pointed at the new one), it is read back, and only then the old files are removed one by one. Until the
//! choice is written the old folder is the models folder, so a move that stops, is cancelled or fails leaves it whole; what
//! was already copied stays in the new folder, with a mark (`.mango-moving`) that lets the next try continue and skip the
//! identical files. Before the first file is touched a journal says what goes where (`journal`): a move that stops half way is
//! finished or put back from it the next time the app starts.
//!
//! Links (junctions, symbolic links) are never followed, copied or removed: they are reported and stay in the old folder, and
//! so do the models behind them. A file with another name elsewhere (a hard link) is copied as a file of its own and only its
//! name here is removed.

use super::journal::{self, Journal};
use super::owned::Owned;
use super::{prune_empty, same, save, Cancel};
use crate::download::{enough_space, recorded_hash, write_verified};
use crate::{engine_path, free_space, tr, user_error, user_text};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetFileInformationByHandle, GetVolumeInformationW, GetVolumePathNameW, BY_HANDLE_FILE_INFORMATION};

/// Left in a new folder while files are being copied into it: the old folder they come from.
pub const MARKER: &str = ".mango-moving";

/// What a file being copied is called until it is whole and checked.
const COPYING: &str = ".mango-copy";

/// How much is read and written, and checked for a cancel, at a time.
const BLOCK: usize = 4 << 20;

const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_REMOTE: u32 = 4;

/// How finely a disk keeps the modification time of a file: FAT rounds to two seconds, exFAT to ten milliseconds, and a
/// network share may be any of them.
const FAT_GRAIN: Duration = Duration::from_secs(2);
const FINE_GRAIN: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    /// Not there yet, or a folder with nothing in it.
    Empty,
    /// What an earlier try of this move left: it goes on, skipping the files that are identical.
    Continues,
    /// A folder with files of its own: the models are not merged into it, it can only be used as it is.
    HasFiles,
}

/// What moving the models to `to` would do, found without changing anything.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub from: PathBuf,
    pub to: PathBuf,
    /// The files in the old folder that would move, and their bytes. Links and files that are not ours are not among them.
    pub files: u64,
    pub bytes: u64,
    /// Free bytes on the disk of the new folder.
    pub free_bytes: u64,
    pub same_volume: bool,
    /// Junctions and symbolic links in the old folder (paths below it): they are not moved.
    pub links: Vec<String>,
    /// The links among them that hold files of the models: those models stay behind the link and are not in the new folder.
    pub model_links: Vec<String>,
    /// Files that have another name elsewhere on the disk.
    pub hard_links: Vec<String>,
    /// Downloads that were interrupted: their partial files move too, and the download goes on from there.
    pub partial_files: u64,
    /// How many files in the folder are not Mango Code's: they stay where they are.
    pub foreign_files: u64,
    /// The one line that says so.
    pub staying: Option<String>,
    pub destination: Destination,
    /// One line, for a network or a removable disk: it works, with a catch.
    pub warning: Option<String>,
    /// The sentence that says why this folder cannot be the models folder, also as it is.
    pub refusal: Option<String>,
    /// The sentence that says why the models cannot be moved there (but the folder can be used as it is): not enough
    /// room, or files of its own.
    pub move_refusal: Option<String>,
}

/// One file of the old folder.
#[derive(Debug, Clone)]
pub(crate) struct Item {
    pub(crate) rel: PathBuf,
    pub(crate) size: u64,
    pub(crate) modified: SystemTime,
    /// The hash noted when the file was verified, if the note still holds.
    pub(crate) hash: Option<String>,
}

#[derive(Debug, Default)]
struct Scan {
    /// Our files (the notes of a verified hash apart), sorted.
    files: Vec<Item>,
    /// Our notes of a verified hash: they are renamed with their files, and written again after a copy.
    notes: Vec<PathBuf>,
    links: Vec<PathBuf>,
    model_links: Vec<PathBuf>,
    hard_linked: Vec<PathBuf>,
    foreign: u64,
    bytes: u64,
    partial: u64,
}

impl Scan {
    /// Every file that goes, the notes too, as the journal names them.
    fn moving(&self) -> Vec<String> {
        self.files.iter().map(|f| f.rel.clone()).chain(self.notes.iter().cloned()).map(|p| p.display().to_string()).collect()
    }
}

/// What is under `root`, links not followed. A root that is not there holds nothing.
fn scan(root: &Path, owned: &Owned) -> std::io::Result<Scan> {
    let mut found = Scan::default();
    let mut pending = vec![PathBuf::new()];
    while let Some(folder) = pending.pop() {
        let entries = match fs::read_dir(root.join(&folder)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && folder.as_os_str().is_empty() => return Ok(found),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            let rel = folder.join(entry.file_name());
            // A file that goes away while we look (a download that ends) is not there.
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if super::is_link(&meta) {
                if owned.has(&rel) || owned.under(&rel) {
                    found.model_links.push(rel.clone());
                }
                found.links.push(rel);
            } else if meta.is_dir() {
                pending.push(rel);
            } else if !owned.has(&rel) {
                found.foreign += 1;
            } else if rel.extension().is_some_and(|e| e.eq_ignore_ascii_case("verified")) {
                found.notes.push(rel);
            } else {
                let path = root.join(&rel);
                if link_count(&path).is_some_and(|n| n > 1) {
                    found.hard_linked.push(rel.clone());
                }
                found.bytes += meta.len();
                found.partial += u64::from(rel.extension().is_some_and(|e| e.eq_ignore_ascii_case("part")));
                found.files.push(Item { size: meta.len(), modified: meta.modified()?, hash: recorded_hash(&path), rel });
            }
        }
    }
    found.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    found.notes.sort();
    found.links.sort();
    found.model_links.sort();
    found.hard_linked.sort();
    Ok(found)
}

/// How many names the file has. `None` when it cannot be asked (the number is only told to the user).
fn link_count(file: &Path) -> Option<u32> {
    // Asked with no access at all, so a file another program holds shut can still be asked.
    let handle = fs::OpenOptions::new().access_mode(0).share_mode(7).open(file).ok()?;
    // SAFETY: the handle is open for the whole call and `info` is a valid structure for it to fill.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let asked = unsafe { GetFileInformationByHandle(handle.as_raw_handle() as HANDLE, &mut info) };
    (asked != 0).then_some(info.nNumberOfLinks)
}

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain([0]).collect()
}

/// The root of the volume that holds `path` (the nearest folder that exists is asked), in lower case.
pub(crate) fn volume_root(path: &Path) -> Option<Vec<u16>> {
    let full = std::path::absolute(path).ok()?;
    let existing = full.ancestors().find(|p| p.is_dir())?;
    let mut root = vec![0u16; 1024];
    // SAFETY: `wide` ends with 0 and `root` is as long as the length passed.
    let asked = unsafe { GetVolumePathNameW(wide(existing).as_ptr(), root.as_mut_ptr(), root.len() as u32) };
    let end = root.iter().position(|c| *c == 0)?;
    (asked != 0 && end > 0).then(|| String::from_utf16_lossy(&root[..end]).to_lowercase().encode_utf16().chain([0]).collect())
}

/// A line for a network or a removable disk: the models work there, with a catch.
pub(crate) fn drive_warning(folder: &Path) -> Option<String> {
    match volume_root(folder).map(|root| unsafe { GetDriveTypeW(root.as_ptr()) }) {
        Some(DRIVE_REMOTE) => Some(tr!(
            "È un disco di rete: i modelli si leggono più lentamente, e senza la rete non partono.",
            "It is a network drive: the models load more slowly, and without the network they do not start."
        )),
        Some(DRIVE_REMOVABLE) => Some(tr!("È un disco rimovibile: se lo stacchi, i modelli non ci sono.", "It is a removable drive: if you unplug it, the models are not there.")),
        _ => None,
    }
}

/// How finely the disk that holds `path` keeps the modification time of a file.
fn grain(path: &Path) -> Duration {
    let Some(root) = volume_root(path) else { return FINE_GRAIN };
    let mut name = [0u16; 64];
    // SAFETY: `root` ends with 0, and the buffer is as long as the length passed; the other answers are not asked for.
    let asked = unsafe { GetVolumeInformationW(root.as_ptr(), std::ptr::null_mut(), 0, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), name.as_mut_ptr(), name.len() as u32) };
    let system = String::from_utf16_lossy(&name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())]).to_ascii_uppercase();
    match (asked != 0 && system.starts_with("FAT")) || unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOTE {
        true => FAT_GRAIN,
        false => FINE_GRAIN,
    }
}

/// Whether the engine can open files in `dir`: it reads its command line in the ANSI code page, so a path with other
/// letters opens only by its short name, which exists for a folder that is there and not always for one to be made.
pub(crate) fn engine_reads(dir: &Path) -> bool {
    let Ok(full) = std::path::absolute(dir) else { return false };
    let Some(existing) = full.ancestors().find(|p| p.is_dir()) else { return false };
    let to_make = full.strip_prefix(existing).map_or(true, |rest| rest.as_os_str().is_empty() || rest.display().to_string().is_ascii());
    to_make && engine_path(existing).is_ascii()
}

fn inside(path: &Path, folder: &Path) -> bool {
    let key = |p: &Path| p.display().to_string().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    key(path).starts_with(&format!("{}\\", key(folder)))
}

/// The file that says the new folder is the target of an earlier try: it holds the old folder.
fn continues(to: &Path, from: &Path) -> bool {
    fs::read_to_string(to.join(MARKER)).is_ok_and(|text| same(Path::new(text.trim()), from))
}

fn destination_of(to: &Path, from: &Path) -> std::io::Result<Destination> {
    let mut entries = match fs::read_dir(to) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Destination::Empty),
        Err(e) => return Err(e),
    };
    Ok(match entries.next() {
        None => Destination::Empty,
        Some(_) if continues(to, from) => Destination::Continues,
        Some(_) => Destination::HasFiles,
    })
}

/// A copy already in `to` that is the same file: the same size, and the same modification time as far as its disk keeps it (or
/// a note of a verified hash of its own that is the original's).
pub(crate) fn identical(copy: &Path, item: &Item) -> bool {
    identical_within(copy, item, grain(copy))
}

fn identical_within(copy: &Path, item: &Item, grain: Duration) -> bool {
    let Ok(meta) = fs::metadata(copy) else { return false };
    let near = meta.modified().is_ok_and(|t| t.duration_since(item.modified).unwrap_or_else(|e| e.duration()) <= grain);
    meta.len() == item.size && (near || item.hash.as_ref().is_some_and(|hash| recorded_hash(copy).as_ref() == Some(hash)))
}

/// What moving the models from `from` to `to` would do. Nothing on the disk changes.
pub fn preview(from: &Path, to: &Path, owned: &Owned) -> Result<Preview> {
    let to = std::path::absolute(to).with_context(|| tr!("{} non è un percorso valido", "{} is not a valid path", to.display()))?;
    let found = scan(from, owned).with_context(|| user_text(&tr!("Non riesco a leggere la cartella dei modelli.", "I can't read the models folder."), from.display()))?;
    let destination = match to.is_dir() {
        true => destination_of(&to, from).map_err(|e| anyhow::Error::new(e).context(user_text(&tr!("Non riesco a leggere la cartella scelta.", "I can't read the chosen folder."), to.display())))?,
        false => Destination::Empty,
    };
    let same_volume = matches!((volume_root(from), volume_root(&to)), (Some(a), Some(b)) if a == b);
    let remaining: u64 = match destination {
        Destination::Continues => found.files.iter().filter(|f| !identical(&to.join(&f.rel), f)).map(|f| f.size).sum(),
        _ => found.bytes,
    };
    let free_bytes = free_space(&to)?;

    let refusal = if same(from, &to) {
        Some(tr!("È già la cartella dei modelli.", "It is already the models folder."))
    } else if inside(&to, from) || inside(from, &to) {
        Some(tr!("Una cartella non può stare dentro l'altra: scegline una fuori da quella dei modelli.", "One folder cannot be inside the other: choose one outside the models folder."))
    } else if to.exists() && !to.is_dir() {
        Some(tr!("Questo percorso è un file, non una cartella.", "This path is a file, not a folder."))
    } else if !engine_reads(&to) {
        Some(tr!(
            "Il motore non riesce ad aprire i file in una cartella con lettere accentate o non latine nel nome. Scegline una con un nome semplice.",
            "The engine cannot open files in a folder whose name has accented or non-Latin letters. Choose one with a plain name."
        ))
    } else {
        None
    };
    let move_refusal = if destination == Destination::HasFiles {
        Some(tr!("La cartella non è vuota: i modelli non si uniscono ai suoi file. Puoi solo usarla com'è.", "The folder is not empty: the models are not mixed with its files. You can only use it as it is."))
    } else if !same_volume {
        enough_space(remaining, free_bytes, &to).err().map(|e| e.to_string())
    } else {
        None
    };
    let warning = drive_warning(&to);
    let staying = (found.foreign > 0).then(|| {
        tr!(
            "Nella cartella ci sono file che non sono di Mango Code ({}): restano dove sono.",
            "The folder has files that are not Mango Code's ({}): they stay where they are.",
            found.foreign
        )
    });
    let names = |paths: &[PathBuf]| paths.iter().map(|p| p.display().to_string()).collect();
    Ok(Preview {
        from: from.to_path_buf(),
        files: found.files.len() as u64,
        bytes: found.bytes,
        free_bytes,
        same_volume,
        links: names(&found.links),
        model_links: names(&found.model_links),
        hard_links: names(&found.hard_linked),
        partial_files: found.partial,
        foreign_files: found.foreign,
        staying,
        destination,
        warning,
        refusal,
        move_refusal,
        to,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// Same volume: each file is renamed.
    Rename,
    /// Another volume: the files are copied, then the old ones removed.
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Moving,
    Copying,
    Verifying,
    /// The files are all in the new folder; the choice is about to be written. Too late to cancel once this has been told and
    /// answered.
    Saving,
    Removing,
}

/// How far a move is. Bytes count the copying and the checking of the files.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: u64,
    pub total_files: u64,
    /// The file being copied or checked, below the folder.
    pub current: Option<String>,
}

/// What a move did.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub method: Method,
    pub files: u64,
    pub bytes: u64,
    /// Bytes written by this run (a file copied by an earlier try is not written again).
    pub copied_bytes: u64,
    /// What stayed in the old folder: the links that hold models, and the files that could not be removed (a program has them
    /// open). Files that are not ours stay too, and are not listed.
    pub left: Vec<String>,
}

/// The error of a move that was cancelled: the old folder is the models folder, as before.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&tr!("Spostamento annullato: la cartella dei modelli è rimasta quella di prima.", "Move cancelled: the models folder is the one it was."))
    }
}

impl std::error::Error for Cancelled {}

/// The folders of a move: the app's data (where the choice is written), the old models folder, the new one, and what in the
/// old one is ours.
#[derive(Clone, Copy)]
pub struct Job<'a> {
    pub data: &'a Path,
    pub from: &'a Path,
    pub to: &'a Path,
    pub owned: &'a Owned,
}

/// Uses `job.to` as the models folder as it is, with the files it has: it is made if it is not there, and the choice is
/// written and read back. Nothing moves, now or later: the files of the old folder that are not ours were never moved, and the
/// ones that are stay where they are.
pub fn use_folder(job: Job) -> Result<()> {
    let found = preview(job.from, job.to, job.owned)?;
    if let Some(why) = found.refusal {
        return Err(user_error(&why, found.to.display()));
    }
    fs::create_dir_all(&found.to).with_context(|| user_text(&tr!("Non riesco a creare la cartella.", "I can't create the folder."), found.to.display()))?;
    // Whatever move was left half done is settled by this choice: its journal would be finished at the next start.
    journal::clear(job.data);
    save(job.data, &found.to).with_context(|| user_text(&tr!("Non riesco a salvare la scelta.", "I can't save the choice."), job.data.display()))?;
    match same(&super::current(job.data)?, &found.to) {
        true => Ok(()),
        false => Err(user_error(&tr!("La scelta salvata non è quella attesa.", "The choice that was saved is not the one expected."), job.data.display())),
    }
}

/// Moves the models from `job.from` to `job.to`, by the way the preview says. The old folder stays whole until the
/// choice is written; `cancel` is looked at between two blocks. `progress` hears each step.
pub fn relocate(job: Job, cancel: &Cancel, progress: &mut dyn FnMut(&Progress)) -> Result<Report> {
    let found = preview(job.from, job.to, job.owned)?;
    if let Some(why) = found.refusal.or(found.move_refusal) {
        return Err(user_error(&why, found.to.display()));
    }
    let job = Job { to: &found.to, ..job };
    match found.same_volume {
        true => rename_all(job, cancel, progress),
        false => copy_all(job, found.free_bytes, cancel, progress),
    }
}

pub(crate) fn io_error(what: String, path: &Path, e: std::io::Error) -> anyhow::Error {
    // 32 and 33: another program has the file open.
    let busy = matches!(e.raw_os_error(), Some(32 | 33));
    let sentence = match busy {
        true => tr!("Un altro programma sta usando un file dei modelli. Chiudilo e riprova.", "Another program is using a model file. Close it and try again."),
        false => what,
    };
    anyhow::Error::new(e).context(user_text(&sentence, path.display()))
}

/// The links of the old folder that hold models: what the move cannot take, and the user is told.
fn left_links(found: &Scan) -> Vec<String> {
    found.model_links.iter().map(|l| l.display().to_string()).collect()
}

/// Same volume: our files are renamed one by one into the new folder. One that cannot be (open in another program) sends back
/// the ones already moved, and the choice is not written.
pub fn rename_all(job: Job, cancel: &Cancel, progress: &mut dyn FnMut(&Progress)) -> Result<Report> {
    let found = scan(job.from, job.owned).with_context(|| user_text(&tr!("Non riesco a leggere la cartella dei modelli.", "I can't read the models folder."), job.from.display()))?;
    let all = found.moving();
    let made = !job.to.exists();
    fs::create_dir_all(job.to).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), job.to, e))?;
    journal::write(job.data, &Journal { from: job.from.to_path_buf(), to: job.to.to_path_buf(), method: Method::Rename, files: all.clone(), made })?;
    let total = all.len() as u64;
    let mut moved: Vec<&String> = Vec::new();
    let mut tell = |stage: Stage, done: usize, current: Option<String>| progress(&Progress { stage, done_bytes: 0, total_bytes: 0, done_files: done as u64, total_files: total, current });
    let outcome: Result<()> = (|| {
        for rel in &all {
            if cancel.requested() {
                return Err(Cancelled.into());
            }
            tell(Stage::Moving, moved.len(), Some(rel.clone()));
            let (old, new) = (job.from.join(rel), job.to.join(rel));
            fs::create_dir_all(new.parent().unwrap_or(job.to)).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), &new, e))?;
            fs::rename(&old, &new).map_err(|e| io_error(tr!("Non riesco a spostare un file dei modelli.", "I can't move a model file."), &old, e))?;
            moved.push(rel);
        }
        tell(Stage::Saving, all.len(), None);
        if !cancel.commit() {
            return Err(Cancelled.into());
        }
        // A choice that was not written leaves the move undone: it is not committed, whatever the cancel said before.
        journal::commit(job.data, job.from, job.to, &all).inspect_err(|_| cancel.reset())
    })();
    if let Err(e) = outcome {
        let stuck: Vec<String> = moved.iter().rev().filter(|rel| fs::rename(job.to.join(rel), job.from.join(rel)).is_err()).map(|rel| rel.to_string()).collect();
        prune_empty(job.to, moved.iter().map(|rel| PathBuf::from(rel)));
        if made {
            let _ = fs::remove_dir(job.to);
        }
        if stuck.is_empty() {
            journal::clear(job.data);
            return Err(e);
        }
        return Err(stuck_error(&e, &stuck));
    }
    tell(Stage::Moving, all.len(), None);
    prune_empty(job.from, all.iter().map(PathBuf::from));
    journal::clear(job.data);
    Ok(Report { method: Method::Rename, files: found.files.len() as u64, bytes: found.bytes, copied_bytes: 0, left: left_links(&found) })
}

/// A move that stopped and could not put everything back: a failure of its own, whatever stopped it. It is built anew rather
/// than wrapped, so that a cancel that left files behind is not taken for a plain cancel.
pub(crate) fn stuck_error(cause: &anyhow::Error, stuck: &[String]) -> anyhow::Error {
    user_error(&tr!("Qualcosa non è tornato al suo posto: sta nella nuova cartella.", "Something did not go back to its place: it is in the new folder."), format!("{}; {cause:#}", stuck.join(", ")))
}

/// Another volume: copies, checks, writes the choice, removes the old files. `free` is what the new disk has free.
pub fn copy_all(job: Job, free: u64, cancel: &Cancel, progress: &mut dyn FnMut(&Progress)) -> Result<Report> {
    let found = scan(job.from, job.owned).with_context(|| user_text(&tr!("Non riesco a leggere la cartella dei modelli.", "I can't read the models folder."), job.from.display()))?;
    let resumed = continues(job.to, job.from);
    let todo: u64 = found.files.iter().filter(|f| !(resumed && identical(&job.to.join(&f.rel), f))).map(|f| f.size).sum();
    enough_space(todo, free, job.to)?;

    let made = !job.to.exists();
    fs::create_dir_all(job.to).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), job.to, e))?;
    fs::write(job.to.join(MARKER), job.from.display().to_string()).map_err(|e| io_error(tr!("Non riesco a scrivere nella cartella.", "I can't write in the folder."), job.to, e))?;
    let all = found.moving();
    journal::write(job.data, &Journal { from: job.from.to_path_buf(), to: job.to.to_path_buf(), method: Method::Copy, files: all.clone(), made })?;

    let total_files = found.files.len() as u64;
    // Every file is read twice: once to copy it (and hash it), once to hash the copy.
    let total_bytes = found.bytes * 2;
    // Until the choice is written the old folder is the models folder, and a journal left by a move that did not get there
    // would be finished by the next start: it goes on every way out. The copies stay, with their mark, for the next try.
    let copied: Result<u64> = (|| {
        let (mut done_bytes, mut copied_bytes) = (0u64, 0u64);
        for (i, item) in found.files.iter().enumerate() {
            let (src, dst) = (job.from.join(&item.rel), job.to.join(&item.rel));
            let current = Some(item.rel.display().to_string());
            let mut tell = |stage: Stage, done_bytes: u64| progress(&Progress { stage, done_bytes, total_bytes, done_files: i as u64, total_files, current: current.clone() });
            fs::create_dir_all(dst.parent().unwrap_or(job.to)).map_err(|e| io_error(tr!("Non riesco a creare la cartella.", "I can't create the folder."), &dst, e))?;
            if resumed && identical(&dst, item) {
                confirm(&src, &dst, item, cancel, &mut done_bytes, &mut tell)?;
                continue;
            }
            copied_bytes += copy_file(&src, &dst, item, cancel, &mut done_bytes, &mut tell)?;
        }
        progress(&Progress { stage: Stage::Saving, done_bytes, total_bytes, done_files: total_files, total_files, current: None });
        if !cancel.commit() {
            return Err(Cancelled.into());
        }
        journal::commit(job.data, job.from, job.to, &all).inspect_err(|_| cancel.reset())?;
        Ok(copied_bytes)
    })();
    let copied_bytes = copied.inspect_err(|_| journal::clear(job.data))?;

    // The new folder is the models folder now, and the choice and the places were read back. What cannot be removed from the
    // old one stays there and is told.
    let mut left = left_links(&found);
    for (i, rel) in all.iter().enumerate() {
        progress(&Progress { stage: Stage::Removing, done_bytes: total_bytes, total_bytes, done_files: i as u64, total_files: all.len() as u64, current: Some(rel.clone()) });
        if let Err(e) = fs::remove_file(job.from.join(rel)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                left.push(rel.clone());
            }
        }
    }
    prune_empty(job.from, all.iter().map(PathBuf::from));
    // The mark has done its work; if it stays, the next move to this folder would take it for the continuation of this one.
    if let Err(e) = fs::remove_file(job.to.join(MARKER)) {
        left.push(format!("{MARKER} ({e})"));
    }
    journal::clear(job.data);
    Ok(Report { method: Method::Copy, files: total_files, bytes: found.bytes, copied_bytes, left })
}

/// Copies `src` to `dst` through a temporary name, with its modification time, hashes it on both sides, puts it in place, and
/// writes its note of a verified hash again if it had one (with the modification time the new disk really kept). The answer is
/// the bytes written. A copy that is cut short leaves no file with the final name.
pub(crate) fn copy_file(src: &Path, dst: &Path, item: &Item, cancel: &Cancel, done: &mut u64, tell: &mut dyn FnMut(Stage, u64)) -> Result<u64> {
    let mut temporary = dst.as_os_str().to_owned();
    temporary.push(COPYING);
    let temporary = PathBuf::from(temporary);
    let copied = (|| -> Result<u64> {
        let mut input = File::open(src).map_err(|e| io_error(tr!("Non riesco a leggere un file dei modelli.", "I can't read a model file."), src, e))?;
        let mut output = File::create(&temporary).map_err(|e| io_error(tr!("Non riesco a scrivere nella nuova cartella.", "I can't write in the new folder."), &temporary, e))?;
        let mut block = vec![0u8; BLOCK];
        let (mut written, mut hash) = (0u64, Sha256::new());
        loop {
            if cancel.requested() {
                return Err(Cancelled.into());
            }
            let n = input.read(&mut block).map_err(|e| io_error(tr!("Non riesco a leggere un file dei modelli.", "I can't read a model file."), src, e))?;
            if n == 0 {
                break;
            }
            hash.update(&block[..n]);
            output.write_all(&block[..n]).map_err(|e| io_error(tr!("Non riesco a scrivere nella nuova cartella.", "I can't write in the new folder."), &temporary, e))?;
            written += n as u64;
            *done += n as u64;
            tell(Stage::Copying, *done);
        }
        output.sync_all()?;
        output.set_modified(item.modified).map_err(|e| io_error(tr!("Non riesco a scrivere nella nuova cartella.", "I can't write in the new folder."), &temporary, e))?;
        drop(output);
        if written != item.size {
            return Err(user_error(
                &tr!("Un file dei modelli è cambiato mentre lo copiavo. Riprova.", "A model file changed while it was being copied. Try again."),
                format!("{}: {written} bytes read, {} expected", src.display(), item.size),
            ));
        }
        let original = crate::hex(&hash.finalize());
        if let Some(expected) = item.hash.as_ref().filter(|expected| **expected != original) {
            return Err(user_error(
                &tr!("Un file dei modelli non è quello verificato in precedenza: è danneggiato o è cambiato.", "A model file is not the one that was verified earlier: it is damaged or has changed."),
                format!("{}: sha256 {original}, expected {expected}", src.display()),
            ));
        }
        let copy = hash_of(&temporary, cancel, |n| {
            *done += n;
            tell(Stage::Verifying, *done);
        })?;
        if copy != original {
            return Err(user_error(
                &tr!("La copia di un file dei modelli non è uguale all'originale. Riprova.", "The copy of a model file is not the same as the original. Try again."),
                format!("{}: sha256 {copy}, original {original}", dst.display()),
            ));
        }
        fs::rename(&temporary, dst).map_err(|e| io_error(tr!("Non riesco a scrivere nella nuova cartella.", "I can't write in the new folder."), dst, e))?;
        // The note is a shortcut for the next check, nothing else: a disk that rounds the time of the file would make the original's
        // note not match the copy, so it is written again from the copy as the disk kept it. Without it the file is hashed again.
        if item.hash.is_some() {
            let _ = write_verified(dst, &original);
        }
        Ok(written)
    })();
    if copied.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copied
}

/// A copy that an earlier try left, and that looks the same, is checked once more before the original can go: the same hash on
/// both sides.
fn confirm(src: &Path, dst: &Path, item: &Item, cancel: &Cancel, done: &mut u64, tell: &mut dyn FnMut(Stage, u64)) -> Result<()> {
    if item.hash.as_ref().is_some_and(|hash| recorded_hash(dst).as_ref() == Some(hash)) {
        *done += 2 * item.size;
        tell(Stage::Verifying, *done);
        return Ok(());
    }
    let original = hash_of(src, cancel, |n| *done += n)?;
    let copy = hash_of(dst, cancel, |n| *done += n)?;
    tell(Stage::Verifying, *done);
    match original == copy {
        true => Ok(()),
        false => Err(user_error(
            &tr!("La copia di un file dei modelli non è uguale all'originale. Riprova.", "The copy of a model file is not the same as the original. Try again."),
            format!("{}: sha256 {copy}, original {original}", dst.display()),
        )),
    }
}

/// The sha256 of a file, read in blocks; `read` hears each block, and a cancel ends it.
fn hash_of(file: &Path, cancel: &Cancel, mut read: impl FnMut(u64)) -> Result<String> {
    let mut input = File::open(file).map_err(|e| io_error(tr!("Non riesco a controllare la copia.", "I can't check the copy."), file, e))?;
    let (mut hash, mut block) = (Sha256::new(), vec![0u8; BLOCK]);
    loop {
        if cancel.requested() {
            return Err(Cancelled.into());
        }
        let n = input.read(&mut block)?;
        if n == 0 {
            return Ok(crate::hex(&hash.finalize()));
        }
        hash.update(&block[..n]);
        read(n as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::sha256_file;
    use crate::model_files::{self, Place};
    use crate::models_dir::chosen;
    use std::os::windows::process::CommandExt;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    /// A moment far from now, with milliseconds, which is what the note of a verified hash records.
    fn long_ago() -> SystemTime {
        SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_704_164_645_678)
    }

    fn content(len: usize, seed: usize) -> Vec<u8> {
        (0..len).map(|i| ((i + seed) * 31 % 251) as u8).collect()
    }

    fn stamp(file: &Path, at: SystemTime) {
        File::options().write(true).open(file).unwrap().set_modified(at).unwrap();
    }

    /// An old models folder with the files of two models (one with the note of a verified hash), a partial download, a file
    /// the user moved into it and a model of the user's, and beside them what is not ours (a note, a file in a model's folder,
    /// an empty folder), in a temporary folder next to the new one and the data folder.
    struct Setup {
        _root: tempfile::TempDir,
        data: PathBuf,
        from: PathBuf,
        to: PathBuf,
        owned: Owned,
    }

    impl Setup {
        fn new() -> Setup {
            let root = tempfile::tempdir().unwrap();
            let (data, from, to) = (root.path().join("data"), root.path().join("old models"), root.path().join("new models"));
            for folder in [data.clone(), from.join("owner-GGUF"), from.join("empty"), from.join("fast"), from.join("mine")] {
                fs::create_dir_all(folder).unwrap();
            }
            let big = content(9 << 20, 1);
            fs::write(from.join("owner-GGUF").join("big.gguf"), &big).unwrap();
            stamp(&from.join("owner-GGUF").join("big.gguf"), long_ago());
            fs::write(from.join("owner-GGUF").join("big.gguf.verified"), serde_json::json!({ "sha256": crate::hex(&Sha256::digest(&big)), "size": big.len(), "modified_ms": 1_704_164_645_678u64 }).to_string()).unwrap();
            fs::write(from.join("small.gguf"), content(70_000, 2)).unwrap();
            fs::write(from.join("other.gguf.part"), content(300_000, 3)).unwrap();
            fs::write(from.join("fast").join("own.gguf"), content(1000, 4)).unwrap();
            fs::write(from.join("mine").join("user.gguf"), content(2000, 5)).unwrap();
            fs::write(from.join("notes.txt"), b"my notes").unwrap();
            fs::write(from.join("owner-GGUF").join("readme.txt"), b"mine too").unwrap();
            let owned = Owned::new(&["owner-GGUF/big.gguf", "small.gguf", "other.gguf", "fast/own.gguf", "mine/user.gguf"].map(PathBuf::from));
            Setup { _root: root, data, from, to, owned }
        }

        fn job(&self) -> Job<'_> {
            Job { data: &self.data, from: &self.from, to: &self.to, owned: &self.owned }
        }

        /// The places and the user's models that point into the old folder, and some that do not.
        fn write_references(&self) {
            let at = |p: &str| self.from.join(p);
            model_files::update(&self.data, |all| {
                all.insert("Org/own.gguf".into(), Place { at: at("fast/own.gguf"), own: true });
                all.insert("Org/theirs.gguf".into(), Place { at: at("theirs.gguf"), own: false });
                all.insert("Org/far.gguf".into(), Place { at: PathBuf::from(r"E:\far\far.gguf"), own: true });
            })
            .unwrap();
            let outside = PathBuf::from(r"E:\elsewhere\other.gguf");
            let list = serde_json::json!({ "models": {
                "mine": { "label": "Mine", "gguf": at("mine/user.gguf"), "files": [ { "path": at("mine/user.gguf"), "size": 2000 } ] },
                "elsewhere": { "label": "Elsewhere", "gguf": outside, "files": [ { "path": outside, "size": 1 } ] }
            } });
            fs::write(self.data.join(crate::catalog::USER_FILE), serde_json::to_string_pretty(&list).unwrap()).unwrap();
        }

        fn names(dir: &Path) -> Vec<String> {
            let mut all = Vec::new();
            let mut pending = vec![dir.to_path_buf()];
            while let Some(folder) = pending.pop() {
                for entry in fs::read_dir(&folder).unwrap().flatten() {
                    let path = entry.path();
                    all.push(path.strip_prefix(dir).unwrap().display().to_string());
                    if entry.file_type().unwrap().is_dir() {
                        pending.push(path);
                    }
                }
            }
            all.sort();
            all
        }
    }

    fn no_progress(_: &Progress) {}

    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).creation_flags(crate::CREATE_NO_WINDOW).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
    }

    /// What the new folder holds after a move: the files that are ours, and the folders around them.
    fn moved_names() -> Vec<String> {
        ["fast", r"fast\own.gguf", "mine", r"mine\user.gguf", "other.gguf.part", "owner-GGUF", r"owner-GGUF\big.gguf", r"owner-GGUF\big.gguf.verified", "small.gguf"].map(String::from).to_vec()
    }

    /// What the old folder still holds: what is not ours.
    fn staying_names() -> Vec<String> {
        ["empty", "notes.txt", "owner-GGUF", r"owner-GGUF\readme.txt"].map(String::from).to_vec()
    }

    /// Runs a move that "crashes" when `when` says so: the panic leaves the disk as it is, with no rollback and no cleanup.
    fn crash<T>(when: impl Fn(&Progress) -> bool, run: impl FnOnce(&mut dyn FnMut(&Progress)) -> Result<T>) {
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let _ = run(&mut |p| {
                if when(p) {
                    panic!("the app is ended here");
                }
            });
        }));
        assert!(crashed.is_err(), "the move never reached the point where it was to be ended");
    }

    // ---------------------------------------------------------------- the preview

    /// The preview counts our files, finds the partial download and what is not ours, says the disks are the same, and
    /// changes nothing.
    #[test]
    fn the_preview_counts_what_would_move_and_touches_nothing() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);

        let found = preview(&setup.from, &setup.to, &setup.owned).unwrap();

        assert_eq!((found.files, found.partial_files, found.foreign_files), (5, 1, 2));
        assert_eq!(found.bytes, (9 << 20) + 70_000 + 300_000 + 1000 + 2000, "the note of a hash and the files that are not ours are not counted");
        assert!(found.same_volume && found.destination == Destination::Empty && found.free_bytes > 0);
        assert!(found.refusal.is_none() && found.move_refusal.is_none() && found.warning.is_none());
        assert!(found.staying.is_some_and(|line| line.contains('2')), "one line says that files stay");
        assert_eq!(Setup::names(&setup.from), before);
        assert!(!setup.to.exists(), "the new folder was not made");
        assert!(!setup.data.join(crate::models_dir::CHOICE_FILE).exists() && !setup.data.join(journal::FILE).exists());
    }

    /// A folder with only our files has nothing to say about what stays.
    #[test]
    fn the_preview_says_nothing_about_staying_files_when_there_are_none() {
        let setup = Setup::new();
        for foreign in ["notes.txt", r"owner-GGUF\readme.txt"] {
            fs::remove_file(setup.from.join(foreign)).unwrap();
        }
        let found = preview(&setup.from, &setup.to, &setup.owned).unwrap();
        assert_eq!((found.foreign_files, found.staying), (0, None));
    }

    /// Links are found and not followed: the size does not include what they point to, a file with two names is told, and a
    /// link that holds a model of ours is told apart from one that does not.
    #[test]
    fn the_preview_finds_junctions_and_hard_links_and_does_not_follow_them() {
        let mut setup = Setup::new();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("elsewhere.gguf"), content(1_000_000, 4)).unwrap();
        fs::create_dir_all(outside.path().join("models-behind")).unwrap();
        fs::write(outside.path().join("models-behind").join("held.gguf"), content(3000, 6)).unwrap();
        junction(&setup.from.join("linked"), outside.path());
        junction(&setup.from.join("held"), &outside.path().join("models-behind"));
        fs::hard_link(setup.from.join("small.gguf"), outside.path().join("small-twin.gguf")).unwrap();
        setup.owned = Owned::new(&["owner-GGUF/big.gguf", "small.gguf", "other.gguf", "fast/own.gguf", "mine/user.gguf", "held/held.gguf"].map(PathBuf::from));

        let found = preview(&setup.from, &setup.to, &setup.owned).unwrap();

        assert_eq!(found.links, ["held", "linked"]);
        assert_eq!(found.model_links, ["held"], "only the link that holds a file of a model");
        assert_eq!(found.hard_links, ["small.gguf"]);
        assert_eq!(found.files, 5, "nothing of the junctions' targets was counted");
        assert!(found.bytes < 1_000_000 + (9 << 20), "{}", found.bytes);
    }

    #[test]
    fn the_preview_tells_a_destination_with_files_and_one_that_continues_a_move() {
        let setup = Setup::new();
        fs::create_dir_all(&setup.to).unwrap();
        assert_eq!(preview(&setup.from, &setup.to, &setup.owned).unwrap().destination, Destination::Empty);

        fs::write(setup.to.join("mine.txt"), b"mine").unwrap();
        let busy = preview(&setup.from, &setup.to, &setup.owned).unwrap();
        assert_eq!(busy.destination, Destination::HasFiles);
        assert!(busy.move_refusal.is_some() && busy.refusal.is_none(), "it can be used as it is, not merged into");

        fs::write(setup.to.join(MARKER), setup.from.display().to_string()).unwrap();
        assert_eq!(preview(&setup.from, &setup.to, &setup.owned).unwrap().destination, Destination::Continues);
        fs::write(setup.to.join(MARKER), r"C:\some\other\folder").unwrap();
        assert_eq!(preview(&setup.from, &setup.to, &setup.owned).unwrap().destination, Destination::HasFiles, "the mark of another move is not ours");
    }

    #[test]
    fn the_preview_refuses_a_folder_the_models_cannot_live_in() {
        let setup = Setup::new();
        let refused = |to: &Path| preview(&setup.from, to, &setup.owned).unwrap().refusal;

        assert!(refused(&setup.from).is_some(), "the folder it already is");
        assert!(refused(&setup.from.join("inner")).is_some(), "inside the old folder");
        assert!(refused(setup.from.parent().unwrap()).is_some(), "around the old folder");
        assert!(refused(&setup.from.join("small.gguf")).is_some(), "a file");
        // The engine reads the command line in the ANSI code page: a new folder with letters it cannot read is refused.
        assert!(refused(&setup.to.join("Łukasz")).is_some(), "letters the engine cannot open");
        assert!(refused(&setup.to.join("plain name")).is_none());
    }

    /// An existing folder with accents is accepted exactly when it has a short ASCII name (a volume may not make them).
    #[test]
    fn a_folder_with_accents_is_accepted_when_it_has_a_short_name() {
        let setup = Setup::new();
        let accented = setup.to.with_file_name("José nuovo");
        fs::create_dir_all(&accented).unwrap();
        let reads = engine_path(&accented).is_ascii();
        assert_eq!(preview(&setup.from, &accented, &setup.owned).unwrap().refusal.is_none(), reads);
    }

    // ---------------------------------------------------------------- the move on the same volume

    #[test]
    fn on_the_same_volume_our_files_are_renamed_and_the_rest_stays() {
        let setup = Setup::new();
        let mut stages = Vec::new();

        let report = relocate(setup.job(), &Cancel::new(), &mut |p| stages.push(p.stage)).unwrap();

        assert_eq!((report.method, report.files, report.copied_bytes, report.left.len()), (Method::Rename, 5, 0, 0));
        assert!(stages.iter().all(|s| matches!(s, Stage::Moving | Stage::Saving)));
        assert_eq!(Setup::names(&setup.to), moved_names());
        assert_eq!(Setup::names(&setup.from), staying_names(), "what is not ours was not touched, and the folders the move emptied are gone");
        assert_eq!(fs::read(setup.from.join("notes.txt")).unwrap(), b"my notes");
        assert_eq!(chosen(&setup.data).unwrap(), Some(setup.to.clone()));
        assert_eq!(fs::read(setup.to.join("small.gguf")).unwrap(), content(70_000, 2));
        assert!(!setup.data.join(journal::FILE).exists(), "the journal goes with the move");
    }

    /// A file another program holds open cannot be renamed: what was moved goes back, nothing is chosen, and the old folder
    /// is as it was.
    #[test]
    fn a_locked_file_sends_the_renamed_files_back() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let _held = fs::OpenOptions::new().read(true).share_mode(1).open(setup.from.join("small.gguf")).unwrap();

        let error = relocate(setup.job(), &Cancel::new(), &mut no_progress).unwrap_err();

        assert!(!error.is::<Cancelled>());
        assert_eq!(Setup::names(&setup.from), before);
        assert!(!setup.data.join(crate::models_dir::CHOICE_FILE).exists() && !setup.data.join(journal::FILE).exists());
        assert!(!setup.to.exists() || Setup::names(&setup.to).is_empty());
        assert_eq!(fs::read(setup.from.join("small.gguf")).unwrap(), content(70_000, 2));
    }

    /// A cancel whose rollback is cut short (a moved file is held open, so it cannot go back) is not a plain cancel: files sit
    /// in the new folder, and the error says so instead of «cancelled». The journal stays, so that the next start puts them back.
    #[test]
    fn a_cancel_that_leaves_a_file_in_the_new_folder_is_a_failure_that_says_so() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let cancel = Cancel::new();
        let mut held = Vec::new();

        let error = relocate(setup.job(), &cancel, &mut |p| {
            if p.done_files == 2 && held.is_empty() {
                let moved = Setup::names(&setup.to).into_iter().map(|n| setup.to.join(n)).find(|f| f.is_file()).unwrap();
                held.push(fs::OpenOptions::new().read(true).share_mode(1).open(moved).unwrap());
                assert!(cancel.request());
            }
        })
        .unwrap_err();

        assert!(!error.is::<Cancelled>(), "{error:#}");
        assert!(crate::user_phrase(&error).contains(&tr!("non è tornato", "did not go back")), "{error:#}");
        assert!(setup.data.join(journal::FILE).exists(), "the next start puts the file back");
        assert!(chosen(&setup.data).unwrap().is_none());
        drop(held);
        assert!(journal::recover(&setup.data).unwrap().is_some_and(|said| said.contains("put back")));
        assert_eq!(Setup::names(&setup.from), before, "everything is back");
    }

    /// A move whose choice could not be written did not happen, however far it got: the cancel is not left «committed», which
    /// would tell the app that the choice is written and that nothing may be given back.
    #[test]
    fn a_choice_that_could_not_be_written_is_not_a_committed_move() {
        for by_copy in [false, true] {
            let setup = Setup::new();
            fs::create_dir(setup.data.join(crate::models_dir::CHOICE_FILE)).unwrap();
            let cancel = Cancel::new();

            let error = match by_copy {
                true => copy_all(setup.job(), PLENTY, &cancel, &mut no_progress),
                false => relocate(setup.job(), &cancel, &mut no_progress),
            }
            .unwrap_err();

            assert!(!error.is::<Cancelled>(), "{error:#}");
            assert!(!cancel.committed(), "by copy: {by_copy}");
            assert!(!setup.data.join(journal::FILE).exists());
        }
    }

    #[test]
    fn a_cancel_on_the_same_volume_leaves_the_old_folder_whole() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let cancel = Cancel::new();

        let error = relocate(setup.job(), &cancel, &mut |p| {
            if p.done_files == 2 {
                assert!(cancel.request());
            }
        })
        .unwrap_err();

        assert!(error.is::<Cancelled>());
        assert_eq!(Setup::names(&setup.from), before);
        assert!(chosen(&setup.data).unwrap().is_none() && !setup.to.exists());
    }

    /// A cancel asked when everything is moved and the choice is about to be written still stops it, and the files go back;
    /// one asked after the choice is written is too late, and says so.
    #[test]
    fn a_cancel_is_in_time_until_the_choice_is_written_and_says_when_it_is_not() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let cancel = Cancel::new();
        let error = relocate(setup.job(), &cancel, &mut |p| {
            if p.stage == Stage::Saving {
                assert!(cancel.request(), "in time");
            }
        })
        .unwrap_err();
        assert!(error.is::<Cancelled>());
        assert_eq!(Setup::names(&setup.from), before, "everything went back");
        assert!(chosen(&setup.data).unwrap().is_none());

        let late = Cancel::new();
        let mut answers = Vec::new();
        relocate(setup.job(), &late, &mut |p| {
            if p.stage == Stage::Moving && p.current.is_none() {
                answers.push(late.request());
            }
        })
        .unwrap();
        assert_eq!(answers, [false], "the choice was written: too late");
        assert!(chosen(&setup.data).unwrap().is_some());
    }

    /// A junction in the old folder is not ours to move: it stays, with what it points to.
    #[test]
    fn a_junction_stays_where_it_is_and_its_target_is_not_touched() {
        let setup = Setup::new();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("elsewhere.gguf"), content(1000, 5)).unwrap();
        junction(&setup.from.join("linked"), outside.path());

        relocate(setup.job(), &Cancel::new(), &mut no_progress).unwrap();

        assert_eq!(fs::read(setup.from.join("linked").join("elsewhere.gguf")).unwrap(), content(1000, 5));
        assert!(!setup.to.join("linked").exists());
    }

    // ---------------------------------------------------------------- the places and the models that point into the folder

    /// A place the user gave a model of ours and a model of the user's whose files are in the old folder follow them to the new
    /// one; the ones that point elsewhere, and a file of the user's that stays, keep pointing where they did. Both ways.
    #[test]
    fn the_places_and_the_users_models_inside_the_old_folder_follow_their_files() {
        for rename in [true, false] {
            let setup = Setup::new();
            setup.write_references();

            match rename {
                true => drop(relocate(setup.job(), &Cancel::new(), &mut no_progress).unwrap()),
                false => drop(copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap()),
            };

            let places = model_files::read(&setup.data).unwrap();
            assert_eq!(places["Org/own.gguf"], Place { at: setup.to.join("fast").join("own.gguf"), own: true }, "rename: {rename}");
            assert_eq!(places["Org/theirs.gguf"], Place { at: setup.from.join("theirs.gguf"), own: false }, "a file of the user's stays and so does its place");
            assert_eq!(places["Org/far.gguf"].at, PathBuf::from(r"E:\far\far.gguf"));
            let list: serde_json::Value = serde_json::from_str(&fs::read_to_string(setup.data.join(crate::catalog::USER_FILE)).unwrap()).unwrap();
            let user = setup.to.join("mine").join("user.gguf").display().to_string();
            assert_eq!(list["models"]["mine"]["gguf"], user.as_str());
            assert_eq!(list["models"]["mine"]["files"][0]["path"], user.as_str());
            assert_eq!(list["models"]["elsewhere"]["gguf"], r"E:\elsewhere\other.gguf");
            assert!(fs::metadata(&user).is_ok(), "and the file is where the list says");
        }
    }

    /// When the places cannot be written down the move does not happen: the choice is put back, the files stay (or go back),
    /// and the originals of a copy are still there.
    #[test]
    fn a_move_whose_places_cannot_be_written_does_not_happen() {
        for rename in [true, false] {
            let setup = Setup::new();
            let before = Setup::names(&setup.from);
            fs::write(setup.data.join(crate::catalog::USER_FILE), "{ not json").unwrap();

            let result = match rename {
                true => relocate(setup.job(), &Cancel::new(), &mut no_progress),
                false => copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress),
            };

            assert!(result.is_err(), "rename: {rename}");
            assert_eq!(Setup::names(&setup.from), before, "the old folder is whole");
            assert!(chosen(&setup.data).unwrap().is_none(), "the choice was put back");
            assert_eq!(fs::read_to_string(setup.data.join(crate::catalog::USER_FILE)).unwrap(), "{ not json");
        }
    }

    // ---------------------------------------------------------------- a move that stops half way

    /// The app is ended after some of the files were renamed: the next start finds the journal, puts everything back, and the
    /// old folder is the models folder, whole.
    #[test]
    fn a_rename_interrupted_after_some_files_is_put_back_at_the_next_start() {
        for renamed in 0..6 {
            let setup = Setup::new();
            let before = Setup::names(&setup.from);

            crash(|p| p.stage == Stage::Moving && p.done_files == renamed && p.current.is_some(), |progress| relocate(setup.job(), &Cancel::new(), progress));

            assert!(setup.data.join(journal::FILE).exists());
            assert_eq!(Setup::names(&setup.to).is_empty(), renamed == 0, "files had moved ({renamed})");
            let said = journal::recover(&setup.data).unwrap();

            assert!(said.is_some_and(|s| s.contains("put back")));
            assert_eq!(Setup::names(&setup.from), before, "after {renamed} files");
            assert!(!setup.to.exists(), "the folder the move made is gone");
            assert!(chosen(&setup.data).unwrap().is_none() && !setup.data.join(journal::FILE).exists());
            assert_eq!(journal::recover(&setup.data).unwrap(), None, "nothing left to do");
        }
    }

    /// The app is ended right after the choice was written: the next start finishes the move, and the places are as if it had
    /// ended well.
    #[test]
    fn a_rename_interrupted_after_the_choice_is_finished_at_the_next_start() {
        let setup = Setup::new();
        setup.write_references();

        crash(|p| p.stage == Stage::Moving && p.current.is_none(), |progress| relocate(setup.job(), &Cancel::new(), progress));
        assert!(setup.data.join(journal::FILE).exists() && chosen(&setup.data).unwrap().is_some());

        let said = journal::recover(&setup.data).unwrap();

        assert!(said.is_some_and(|s| s.contains("finished")));
        assert_eq!(Setup::names(&setup.to), moved_names());
        assert_eq!(Setup::names(&setup.from), staying_names());
        assert_eq!(model_files::read(&setup.data).unwrap()["Org/own.gguf"].at, setup.to.join("fast").join("own.gguf"));
        assert!(!setup.data.join(journal::FILE).exists());
    }

    /// A move that was ended after the choice but before the places were written down is finished the same way: the places are
    /// written by the start.
    #[test]
    fn a_choice_without_the_places_is_completed_at_the_next_start() {
        let setup = Setup::new();
        setup.write_references();
        crash(|p| p.stage == Stage::Moving && p.current.is_none(), |progress| relocate(setup.job(), &Cancel::new(), progress));
        let places = setup.from.join("fast").join("own.gguf");
        model_files::update(&setup.data, |all| all.get_mut("Org/own.gguf").unwrap().at = places.clone()).unwrap();

        journal::recover(&setup.data).unwrap();

        assert_eq!(model_files::read(&setup.data).unwrap()["Org/own.gguf"].at, setup.to.join("fast").join("own.gguf"));
    }

    /// The app is ended after the copies were made and the choice written, before the old files were removed: the next start
    /// removes the old files whose copy is in place, and nothing else.
    #[test]
    fn a_copy_interrupted_before_the_old_files_were_removed_is_finished_at_the_next_start() {
        let setup = Setup::new();

        crash(|p| p.stage == Stage::Removing, |progress| copy_all(setup.job(), PLENTY, &Cancel::new(), progress));
        assert_eq!(Setup::names(&setup.from).len(), staying_names().len() + 8, "the originals are all still there");

        let said = journal::recover(&setup.data).unwrap();

        assert!(said.is_some_and(|s| s.contains("finished")));
        assert_eq!(Setup::names(&setup.from), staying_names());
        assert_eq!(Setup::names(&setup.to), moved_names(), "and the mark of the move is gone");
        assert_eq!(recorded_hash(&setup.to.join("owner-GGUF").join("big.gguf")).is_some(), true);
    }

    /// The app is ended while the files are copied: the old folder is still the models folder; the next start only drops the
    /// journal, and the next try goes on from the copies already made.
    #[test]
    fn a_copy_interrupted_before_the_choice_leaves_the_old_folder_chosen_and_goes_on_next_time() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);

        crash(|p| p.stage == Stage::Copying && p.done_bytes > 5 << 20, |progress| copy_all(setup.job(), PLENTY, &Cancel::new(), progress));
        let said = journal::recover(&setup.data).unwrap();

        assert!(said.is_some_and(|s| s.contains("next try")));
        assert_eq!(Setup::names(&setup.from), before);
        assert!(chosen(&setup.data).unwrap().is_none() && !setup.data.join(journal::FILE).exists());
        let again = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap();
        assert_eq!(Setup::names(&setup.to), moved_names());
        assert_eq!(again.copied_bytes, (9 << 20) + 70_000, "the three files already copied were not copied again");
        assert!(chosen(&setup.data).unwrap().is_some());
    }

    // ---------------------------------------------------------------- the move to another volume (called directly)

    const PLENTY: u64 = 1 << 40;

    #[test]
    fn a_copy_keeps_the_modification_time_and_the_verified_note_stays_valid() {
        let setup = Setup::new();
        let mut progress = Vec::new();
        let old = setup.from.join("owner-GGUF").join("big.gguf");
        assert_eq!(recorded_hash(&old).is_some(), true, "the note holds before the move");

        let report = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut |p| progress.push(p.clone())).unwrap();

        let new = setup.to.join("owner-GGUF").join("big.gguf");
        assert_eq!(fs::metadata(&new).unwrap().modified().unwrap(), long_ago());
        assert_eq!(recorded_hash(&new), Some(crate::hex(&Sha256::digest(content(9 << 20, 1)))), "the note holds after the move");
        assert_eq!(fs::read(setup.to.join("small.gguf")).unwrap(), content(70_000, 2));
        assert_eq!(fs::read(setup.to.join("other.gguf.part")).unwrap(), content(300_000, 3));
        assert_eq!(Setup::names(&setup.to), moved_names());
        assert_eq!(Setup::names(&setup.from), staying_names(), "what is not ours stays");
        assert_eq!(chosen(&setup.data).unwrap(), Some(setup.to.clone()));
        assert_eq!((report.method, report.files, report.left.clone()), (Method::Copy, 5, Vec::<String>::new()), "{:?}", report.left);
        assert!(report.copied_bytes >= 9 << 20);
        let stages: Vec<Stage> = progress.iter().map(|p| p.stage).collect();
        assert!(stages.contains(&Stage::Verifying) && stages.contains(&Stage::Saving) && stages.contains(&Stage::Removing));
        let last_copy = progress.iter().filter(|p| p.stage == Stage::Saving).last().unwrap();
        assert_eq!(last_copy.done_bytes, last_copy.total_bytes, "every file was read twice, and the bar says so");
    }

    /// A file in the new folder from an earlier try that looks like the original (same size, same time) but is not is found out
    /// by the hash of both sides, whether the original has a note or not: nothing is chosen and nothing is removed.
    #[test]
    fn a_copy_from_an_earlier_try_is_checked_by_hash_before_the_original_can_go() {
        for victim in [r"owner-GGUF\big.gguf", "small.gguf"] {
            let setup = Setup::new();
            let (original, leftover) = (setup.from.join(victim), setup.to.join(victim));
            fs::create_dir_all(leftover.parent().unwrap()).unwrap();
            let mut bytes = fs::read(&original).unwrap();
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0xff;
            fs::write(&leftover, &bytes).unwrap();
            stamp(&leftover, fs::metadata(&original).unwrap().modified().unwrap());
            fs::write(setup.to.join(MARKER), setup.from.display().to_string()).unwrap();
            let before = Setup::names(&setup.from);

            let error = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap_err();

            assert!(format!("{error:#}").contains("sha256"), "{victim}: {error:#}");
            assert_eq!(Setup::names(&setup.from), before, "{victim}: the originals are all still there");
            assert!(chosen(&setup.data).unwrap().is_none());
        }
    }

    /// A disk that keeps the time of a file less finely than it was given (exFAT, FAT, a network share) still recognises its
    /// own copy: within what the disk keeps, or by the hash noted next to the copy; and a copy of another size or another time
    /// is not the same file.
    #[test]
    fn a_copy_on_a_disk_that_rounds_the_time_is_still_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("copy.gguf");
        fs::write(&copy, content(5000, 1)).unwrap();
        let original = long_ago() + Duration::from_micros(654_321);
        let item = |hash: Option<String>| Item { rel: PathBuf::new(), size: 5000, modified: original, hash };

        stamp(&copy, original - Duration::from_micros(654_321 % 10_000));
        assert!(identical_within(&copy, &item(None), FINE_GRAIN), "rounded to ten milliseconds");
        stamp(&copy, original - Duration::from_millis(1_800));
        assert!(identical_within(&copy, &item(None), FAT_GRAIN), "rounded to two seconds");
        assert!(!identical_within(&copy, &item(None), FINE_GRAIN), "but not on a disk that keeps the time to the millisecond");
        stamp(&copy, original + Duration::from_secs(60));
        assert!(!identical_within(&copy, &item(None), FAT_GRAIN), "another time");

        // The note next to the copy, written with the time the disk kept, says it is the original's file.
        let hash = crate::hex(&Sha256::digest(content(5000, 1)));
        write_verified(&copy, &hash).unwrap();
        assert!(identical_within(&copy, &item(Some(hash.clone())), FINE_GRAIN), "same size and the same hash noted");
        assert!(!identical_within(&copy, &item(Some("0".repeat(64))), FINE_GRAIN), "another hash");
        fs::write(&copy, content(4999, 1)).unwrap();
        assert!(!identical_within(&copy, &item(Some(hash)), FAT_GRAIN), "another size");
        assert_eq!(grain(dir.path()), FINE_GRAIN, "an NTFS disk keeps the time finely");
    }

    /// After a copy the note of a verified hash is the copy's: it matches the time the new disk kept, whatever that is, so the
    /// file does not have to be read again.
    #[test]
    fn the_note_of_a_copy_matches_the_time_the_disk_kept() {
        let setup = Setup::new();
        copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap();

        let new = setup.to.join("owner-GGUF").join("big.gguf");
        let note: serde_json::Value = serde_json::from_str(&fs::read_to_string(setup.to.join("owner-GGUF").join("big.gguf.verified")).unwrap()).unwrap();
        let kept = fs::metadata(&new).unwrap().modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64;
        assert_eq!(note["modified_ms"].as_u64(), Some(kept));
        assert!(recorded_hash(&new).is_some());
    }

    /// The old files go one by one only after the choice is written and read back; the old folders that are left empty go
    /// too, and the old models folder itself stays.
    #[test]
    fn the_old_files_are_removed_after_the_choice_and_the_old_folder_stays() {
        let setup = Setup::new();
        let mut at_removal = None;

        copy_all(setup.job(), PLENTY, &Cancel::new(), &mut |p| {
            if p.stage == Stage::Removing && at_removal.is_none() {
                at_removal = Some((chosen(&setup.data).unwrap(), Setup::names(&setup.from).len()));
            }
        })
        .unwrap();

        assert_eq!(at_removal, Some((Some(setup.to.clone()), staying_names().len() + 8)), "everything was still there when the choice was written");
        assert!(setup.from.is_dir() && Setup::names(&setup.from) == staying_names());
    }

    /// A file another program holds shut cannot be read: nothing is chosen, nothing is removed, no half file stays.
    #[test]
    fn a_locked_file_stops_the_copy_before_anything_is_chosen() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let _held = fs::OpenOptions::new().read(true).share_mode(0).open(setup.from.join("small.gguf")).unwrap();

        let error = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap_err();

        assert!(format!("{error:#}").contains("small.gguf"), "{error:#}");
        assert_eq!(Setup::names(&setup.from), before);
        assert!(chosen(&setup.data).unwrap().is_none());
        assert!(Setup::names(&setup.to).iter().all(|n| !n.ends_with(COPYING) && !n.ends_with("small.gguf")), "{:?}", Setup::names(&setup.to));
    }

    /// A file the old folder cannot let go (it is open, and cannot be deleted) stays, and the move is done all the same.
    #[test]
    fn a_file_that_cannot_be_removed_stays_in_the_old_folder_and_is_told() {
        let setup = Setup::new();
        let _held = fs::OpenOptions::new().read(true).share_mode(1).open(setup.from.join("small.gguf")).unwrap();

        let report = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap();

        assert_eq!(report.left, ["small.gguf"]);
        assert_eq!(chosen(&setup.data).unwrap(), Some(setup.to.clone()));
        assert_eq!(fs::read(setup.to.join("small.gguf")).unwrap(), content(70_000, 2));
        assert!(!setup.from.join("other.gguf.part").exists());
        assert!(!setup.data.join(journal::FILE).exists());
    }

    /// Not enough room is told before anything is made or copied: not even the folder.
    #[test]
    fn not_enough_room_is_refused_before_anything_is_touched() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);

        let error = copy_all(setup.job(), 1 << 20, &Cancel::new(), &mut no_progress).unwrap_err();

        assert!(error.is::<crate::download::NoSpace>(), "{error:#}");
        assert!(!setup.to.exists());
        assert_eq!(Setup::names(&setup.from), before);
        assert!(chosen(&setup.data).unwrap().is_none() && !setup.data.join(journal::FILE).exists());
    }

    /// A cancel in the middle leaves the old folder chosen and whole, no file with a final name that is half, and the
    /// next try continues: the file already copied is not copied again.
    #[test]
    fn an_interrupted_copy_is_continued_and_does_not_copy_a_file_twice() {
        let setup = Setup::new();
        let before = Setup::names(&setup.from);
        let cancel = Cancel::new();

        let error = copy_all(setup.job(), PLENTY, &cancel, &mut |p| {
            if p.stage == Stage::Copying && p.done_bytes > 5 << 20 {
                cancel.request();
            }
        })
        .unwrap_err();

        assert!(error.is::<Cancelled>());
        assert_eq!(Setup::names(&setup.from), before, "the old folder is whole");
        assert!(chosen(&setup.data).unwrap().is_none(), "and still the models folder");
        assert!(!setup.data.join(journal::FILE).exists(), "a copy that did not get to the choice leaves no journal behind: the next start would take it for a move to finish");
        let stopped_at = Setup::names(&setup.to);
        assert!(stopped_at.iter().all(|n| !n.ends_with(COPYING)), "no half file: {stopped_at:?}");
        assert_eq!(preview(&setup.from, &setup.to, &setup.owned).unwrap().destination, Destination::Continues);

        let all = preview(&setup.from, &setup.to, &setup.owned).unwrap().bytes;
        let again = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap();
        assert!(chosen(&setup.data).unwrap().is_some());
        assert_eq!(Setup::names(&setup.to), moved_names());
        assert!(again.copied_bytes < all, "the files already copied were not copied again ({} of {all})", again.copied_bytes);
    }

    /// Junctions are not followed, copied or removed; a hard link is copied as a file and only this name is removed. A link that
    /// holds a model of ours is among what is left, so the user is told.
    #[test]
    fn a_junction_and_a_hard_link_are_left_intact_by_the_copy() {
        let mut setup = Setup::new();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("elsewhere.gguf"), content(1_000_000, 4)).unwrap();
        fs::create_dir_all(outside.path().join("behind")).unwrap();
        fs::write(outside.path().join("behind").join("held.gguf"), content(3000, 6)).unwrap();
        junction(&setup.from.join("linked"), outside.path());
        junction(&setup.from.join("held"), &outside.path().join("behind"));
        fs::hard_link(setup.from.join("small.gguf"), outside.path().join("small-twin.gguf")).unwrap();
        setup.owned = Owned::new(&["owner-GGUF/big.gguf", "small.gguf", "other.gguf", "fast/own.gguf", "mine/user.gguf", "held/held.gguf"].map(PathBuf::from));

        let report = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap();

        assert_eq!(report.left, ["held"], "the link with a model behind it, and not the one with nothing of ours");
        assert!(!setup.to.join("linked").exists() && !setup.to.join("held").exists(), "a link is not copied");
        assert_eq!(fs::read(outside.path().join("elsewhere.gguf")).unwrap(), content(1_000_000, 4), "its target is intact");
        assert_eq!(fs::read(setup.from.join("linked").join("elsewhere.gguf")).unwrap(), content(1_000_000, 4), "the junction is still there");
        assert_eq!(fs::read(setup.from.join("held").join("held.gguf")).unwrap(), content(3000, 6));
        assert_eq!(fs::read(outside.path().join("small-twin.gguf")).unwrap(), content(70_000, 2), "the other name of the file is intact");
        assert_eq!(fs::read(setup.to.join("small.gguf")).unwrap(), content(70_000, 2));
        assert!(!setup.from.join("small.gguf").exists());
    }

    /// A copy that came out different from a file with a hash noted is refused and not left under its name.
    #[test]
    fn a_copy_that_differs_from_the_noted_hash_is_refused() {
        let setup = Setup::new();
        let big = setup.from.join("owner-GGUF").join("big.gguf");
        let note = fs::read_to_string(setup.from.join("owner-GGUF").join("big.gguf.verified")).unwrap();
        let wrong = note.replace(&crate::hex(&Sha256::digest(content(9 << 20, 1))), &"0".repeat(64));
        fs::write(setup.from.join("owner-GGUF").join("big.gguf.verified"), wrong).unwrap();
        assert!(recorded_hash(&big).is_some());

        let error = copy_all(setup.job(), PLENTY, &Cancel::new(), &mut no_progress).unwrap_err();

        assert!(format!("{error:#}").contains("sha256"), "{error:#}");
        assert!(!setup.to.join("owner-GGUF").join("big.gguf").exists());
        assert!(chosen(&setup.data).unwrap().is_none());
        assert!(sha256_file(&big).is_ok(), "the original is whole");
        assert!(!setup.data.join(journal::FILE).exists(), "a failed copy leaves no journal");
    }

    // ---------------------------------------------------------------- using a folder as it is

    #[test]
    fn a_folder_with_files_is_used_as_it_is_and_nothing_moves() {
        let setup = Setup::new();
        fs::create_dir_all(&setup.to).unwrap();
        fs::write(setup.to.join("mine.gguf"), b"mine").unwrap();
        let before = Setup::names(&setup.from);

        assert!(relocate(setup.job(), &Cancel::new(), &mut no_progress).is_err());
        assert!(chosen(&setup.data).unwrap().is_none());

        use_folder(setup.job()).unwrap();
        assert_eq!(chosen(&setup.data).unwrap(), Some(setup.to.clone()));
        assert_eq!(Setup::names(&setup.from), before);
        assert_eq!(fs::read(setup.to.join("mine.gguf")).unwrap(), b"mine");
    }

    /// A copy that was cancelled and then the same folder used as it is: the start that follows finds nothing to finish, so the
    /// places of files that were never copied are not pointed at the new folder.
    #[test]
    fn a_cancelled_copy_followed_by_using_its_folder_leaves_nothing_for_the_next_start_to_finish() {
        let setup = Setup::new();
        setup.write_references();
        let places = fs::read_to_string(setup.data.join(model_files::FILE)).unwrap();
        let cancel = Cancel::new();
        copy_all(setup.job(), PLENTY, &cancel, &mut |p| {
            if p.stage == Stage::Copying && p.done_bytes > 5 << 20 {
                cancel.request();
            }
        })
        .unwrap_err();

        use_folder(setup.job()).unwrap();

        assert_eq!(chosen(&setup.data).unwrap(), Some(setup.to.clone()));
        assert_eq!(journal::recover(&setup.data).unwrap(), None);
        assert_eq!(fs::read_to_string(setup.data.join(model_files::FILE)).unwrap(), places, "the places were not rewritten");
    }

    /// Using a folder as it is settles any move that was left half done: its journal would otherwise be finished at the next start.
    #[test]
    fn using_a_folder_clears_a_journal_that_was_left() {
        let setup = Setup::new();
        let journal = Journal { from: setup.from.clone(), to: setup.to.clone(), method: Method::Copy, files: vec!["small.gguf".into()], made: true };
        journal::write(&setup.data, &journal).unwrap();

        use_folder(setup.job()).unwrap();

        assert!(!setup.data.join(journal::FILE).exists());
    }

    #[test]
    fn the_default_folder_is_chosen_by_removing_the_choice() {
        let setup = Setup::new();
        relocate(setup.job(), &Cancel::new(), &mut no_progress).unwrap();
        assert!(chosen(&setup.data).unwrap().is_some());

        let back = Job { data: &setup.data, from: &setup.to, to: &crate::models_dir::default_dir(&setup.data), owned: &setup.owned };
        relocate(back, &Cancel::new(), &mut no_progress).unwrap();

        assert_eq!(chosen(&setup.data).unwrap(), None);
        assert_eq!(Setup::names(&crate::models_dir::default_dir(&setup.data)), moved_names());
        assert!(Setup::names(&setup.to).is_empty(), "the folder that was left holds nothing of ours");
    }
}
