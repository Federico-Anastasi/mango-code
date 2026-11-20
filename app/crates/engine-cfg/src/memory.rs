//! The engines' on-disk memory, with one budget for all of it.
//!
//! - `<memory>\<model>`: the profiles' engines' own memory (`--cache-disk`): a running engine saves there the state of
//!   conversations and of the system prompt, and on restart rereads only the new tokens. A model's files are of no use
//!   to the others, and an engine removes by itself those it doesn't recognize.
//! - `<slots>`: the official engine's slot files, kept by the manager (`engine::prefix`): `<model>.bin` is the last
//!   conversation, `<model>.prefix-<key>.bin` a system prompt read once and kept for the new conversations.
//!
//! The space ceiling and the maximum age apply to all models together and to both folders: before starting a model the
//! expired files of all are removed, and the other models' files are kept as long as they fit in half the ceiling (the
//! longest unused go first); the running model gets the rest. The slot files are cut to the ceiling when one is written
//! (`trim_slots`).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Space ceiling of the whole memory. A 100 thousand token conversation weighs ~1.1 GB with the 3.6 and ~3.8 GB with
/// TOQ's 27B; the base (system prompt and tools) a few hundred MB.
pub const MEMORY_MIB: u64 = 6144;
/// Maximum age of an unused state.
pub const MEMORY_HOURS: u64 = 24;

const PREFIX_MARK: &str = ".prefix-";

/// The slot file of model `key`'s last conversation.
pub fn last_file(key: &str) -> String {
    format!("{key}.bin")
}

/// The file the last conversation is saved in first: it replaces `last_file` only once the engine says it saved something.
pub fn pending_file(key: &str) -> String {
    format!("{key}.next.bin")
}

/// The slot file of model `key`'s system prompt with this `hash`.
pub fn prefix_file(key: &str, hash: &str) -> String {
    format!("{key}{PREFIX_MARK}{hash}.bin")
}

fn age() -> Duration {
    Duration::from_secs(MEMORY_HOURS * 3600)
}

/// Folder and ceiling (MiB) of model `key`'s memory, after making room as described above.
pub fn prepare(root: &Path, slots: &Path, key: &str) -> Result<(PathBuf, u64)> {
    let dir = root.join(key);
    std::fs::create_dir_all(&dir).with_context(|| format!("memory folder {}", dir.display()))?;
    let mut files = list_files(root).with_context(|| format!("reading the memory {}", root.display()))?;
    files.extend(list_flat(slots).with_context(|| format!("reading the slots {}", slots.display()))?);
    let (remove, ceiling) = choose(&files, &dir, SystemTime::now(), MEMORY_MIB << 20, age());
    remove_all(&remove);
    Ok((dir, ceiling >> 20))
}

/// Removes from `slots` the files unused for longer than the maximum age and then the longest unused until the whole
/// memory (the profiles' folders count) fits the ceiling. `keep` is the file just written: it goes only if it alone is
/// above the ceiling. Returns what it removed.
pub fn trim_slots(root: &Path, slots: &Path, keep: Option<&Path>) -> Result<Vec<PathBuf>> {
    let own = list_flat(slots).with_context(|| format!("reading the slots {}", slots.display()))?;
    let others: u64 = match std::fs::metadata(root) {
        Ok(_) => list_files(root).with_context(|| format!("reading the memory {}", root.display()))?.iter().map(|f| f.bytes).sum(),
        Err(_) => 0,
    };
    let remove = choose_slots(&own, others, keep, SystemTime::now(), MEMORY_MIB << 20, age());
    remove_all(&remove);
    Ok(remove)
}

/// The memory of a model that is gone: its slot files and its folder.
pub fn forget(data: &Path, key: &str) -> Result<()> {
    let slots = data.join("slots");
    let prefix = format!("{key}{PREFIX_MARK}");
    for f in list_flat(&slots).with_context(|| format!("reading the slots {}", slots.display()))? {
        let name = f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name == last_file(key) || name == pending_file(key) || (name.starts_with(&prefix) && name.ends_with(".bin")) {
            std::fs::remove_file(&f.path).with_context(|| format!("removing {}", f.path.display()))?;
        }
    }
    let dir = data.join("memory").join(key);
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e).with_context(|| format!("removing {}", dir.display())),
        _ => Ok(()),
    }
}

fn remove_all(paths: &[PathBuf]) {
    for p in paths {
        if let Err(e) = std::fs::remove_file(p) {
            eprintln!("memory: cannot remove {}: {e}", p.display());
        }
    }
}

struct MemoryFile {
    path: PathBuf,
    bytes: u64,
    used: SystemTime,
}

/// The memory's files, in the root and in the models' folders.
fn list_files(root: &Path) -> std::io::Result<Vec<MemoryFile>> {
    let mut v = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(d) = folders.pop() {
        for e in std::fs::read_dir(&d)? {
            let e = e?;
            let m = e.metadata()?;
            if m.is_dir() {
                if d == root {
                    folders.push(e.path());
                }
            } else {
                v.push(MemoryFile { path: e.path(), bytes: m.len(), used: m.modified()? });
            }
        }
    }
    Ok(v)
}

/// The files of a folder without subfolders; a folder that isn't there has none.
fn list_flat(dir: &Path) -> std::io::Result<Vec<MemoryFile>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut v = Vec::new();
    for e in entries {
        let e = e?;
        let m = e.metadata()?;
        if m.is_file() {
            v.push(MemoryFile { path: e.path(), bytes: m.len(), used: m.modified()? });
        }
    }
    Ok(v)
}

/// The files to remove and the ceiling (bytes) of the model with folder `dir`.
fn choose(files: &[MemoryFile], dir: &Path, now: SystemTime, ceiling: u64, age: Duration) -> (Vec<PathBuf>, u64) {
    let expired = |f: &MemoryFile| now.duration_since(f.used).is_ok_and(|d| d > age);
    let mut remove: Vec<PathBuf> = files.iter().filter(|f| expired(f)).map(|f| f.path.clone()).collect();
    let mut other_models: Vec<&MemoryFile> = files.iter().filter(|f| !expired(f) && !f.path.starts_with(dir)).collect();
    other_models.sort_by_key(|f| f.used);
    let mut occupied: u64 = other_models.iter().map(|f| f.bytes).sum();
    for f in other_models {
        if occupied <= ceiling / 2 {
            break;
        }
        occupied -= f.bytes;
        remove.push(f.path.clone());
    }
    (remove, ceiling - occupied)
}

/// The slot files to remove: the expired ones, then the longest unused until `own` and the profiles' `others` bytes fit
/// `ceiling`. `keep` is removed only if it alone is above the ceiling.
fn choose_slots(own: &[MemoryFile], others: u64, keep: Option<&Path>, now: SystemTime, ceiling: u64, age: Duration) -> Vec<PathBuf> {
    let expired = |f: &MemoryFile| now.duration_since(f.used).is_ok_and(|d| d > age);
    let mut remove: Vec<PathBuf> = own.iter().filter(|f| expired(f)).map(|f| f.path.clone()).collect();
    let mut live: Vec<&MemoryFile> = own.iter().filter(|f| !expired(f)).collect();
    live.sort_by_key(|f| f.used);
    let mut total = others + live.iter().map(|f| f.bytes).sum::<u64>();
    for f in &live {
        if total <= ceiling {
            break;
        }
        if keep == Some(f.path.as_path()) {
            continue;
        }
        total -= f.bytes;
        remove.push(f.path.clone());
    }
    if let Some(f) = live.iter().find(|f| keep == Some(f.path.as_path())).filter(|f| f.bytes > ceiling) {
        remove.push(f.path.clone());
    }
    remove
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    fn f(path: &str, gib: u64, hours_ago: u64) -> MemoryFile {
        MemoryFile { path: PathBuf::from(path), bytes: gib * GIB, used: SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 3600 - hours_ago * 3600) }
    }

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 3600)
    }

    fn day() -> Duration {
        Duration::from_secs(24 * 3600)
    }

    #[test]
    fn the_expired_files_of_all_models_go() {
        let files = [f(r"m\toq\a.slot", 1, 30), f(r"m\3.6\b.slot", 1, 25), f(r"m\3.6\c.slot", 1, 2), f(r"m\old.slot", 1, 48)];
        let (remove, ceiling) = choose(&files, Path::new(r"m\3.6"), now(), 6 * GIB, day());
        assert_eq!(remove, [PathBuf::from(r"m\toq\a.slot"), PathBuf::from(r"m\3.6\b.slot"), PathBuf::from(r"m\old.slot")]);
        assert_eq!(ceiling, 6 * GIB, "the running model's files are managed by its engine, within the ceiling");
    }

    #[test]
    fn the_other_models_keep_at_most_half_the_ceiling() {
        let files = [f(r"m\toq\a.slot", 2, 10), f(r"m\toq\b.slot", 2, 1), f(r"m\lfm\c.slot", 1, 5), f(r"m\3.6\d.slot", 3, 1)];
        let (remove, ceiling) = choose(&files, Path::new(r"m\3.6"), now(), 6 * GIB, day());
        // 5 GiB of the others: the oldest goes (toq\a, 2 GiB), 3 GiB remain = half the ceiling
        assert_eq!(remove, [PathBuf::from(r"m\toq\a.slot")]);
        assert_eq!(ceiling, 3 * GIB);
    }

    #[test]
    fn without_others_the_running_model_has_the_whole_ceiling() {
        let (remove, ceiling) = choose(&[f(r"m\toq\a.slot", 4, 1)], Path::new(r"m\toq"), now(), 6 * GIB, day());
        assert!(remove.is_empty());
        assert_eq!(ceiling, 6 * GIB);
    }

    #[test]
    fn the_slot_files_count_among_the_others_of_a_profile() {
        let files = [f(r"s\qwen.bin", 2, 10), f(r"s\qwen.prefix-a.bin", 2, 1), f(r"m\3.6\d.slot", 3, 1)];
        let (remove, ceiling) = choose(&files, Path::new(r"m\3.6"), now(), 6 * GIB, day());
        assert_eq!(remove, [PathBuf::from(r"s\qwen.bin")]);
        assert_eq!(ceiling, 4 * GIB);
    }

    #[test]
    fn the_slot_files_expire_and_the_longest_unused_go_to_fit_the_ceiling() {
        let own = [f(r"s\a.bin", 2, 30), f(r"s\b.bin", 2, 10), f(r"s\c.bin", 2, 5), f(r"s\d.bin", 2, 1)];
        let remove = choose_slots(&own, 0, None, now(), 6 * GIB, day());
        // a is expired; b, c, d are 6 GiB: they fit
        assert_eq!(remove, [PathBuf::from(r"s\a.bin")]);
        let remove = choose_slots(&own, GIB, None, now(), 6 * GIB, day());
        // with 1 GiB of the profiles' memory one more must go: the longest unused of the rest
        assert_eq!(remove, [PathBuf::from(r"s\a.bin"), PathBuf::from(r"s\b.bin")]);
    }

    #[test]
    fn the_file_just_written_stays_unless_it_alone_is_above_the_ceiling() {
        let own = [f(r"s\old.bin", 3, 10), f(r"s\new.bin", 4, 0)];
        let remove = choose_slots(&own, 0, Some(Path::new(r"s\new.bin")), now(), 6 * GIB, day());
        assert_eq!(remove, [PathBuf::from(r"s\old.bin")]);
        let remove = choose_slots(&own[1..], 0, Some(Path::new(r"s\new.bin")), now(), 3 * GIB, day());
        assert_eq!(remove, [PathBuf::from(r"s\new.bin")]);
        let remove = choose_slots(&own[1..], 3 * GIB, Some(Path::new(r"s\new.bin")), now(), 6 * GIB, day());
        assert!(remove.is_empty(), "the profiles' memory is not the slot file's fault");
    }

    #[test]
    fn prepares_on_disk() {
        let d = tempfile::tempdir().unwrap();
        let old = d.path().join("memory").join("toq").join("a.slot");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"x").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(25 * 3600)).unwrap();
        drop(f);
        let (dir, mib) = prepare(&d.path().join("memory"), &d.path().join("slots"), "3.6").unwrap();
        assert_eq!(dir, d.path().join("memory").join("3.6"));
        assert!(dir.is_dir());
        assert!(!old.exists(), "the expired file of another model is still there");
        assert_eq!(mib, MEMORY_MIB);
    }

    fn old_file(path: &Path, hours: u64) {
        std::fs::write(path, b"x").unwrap();
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(hours * 3600)).unwrap();
    }

    #[test]
    fn trimming_the_slots_removes_the_expired_and_keeps_the_rest() {
        let d = tempfile::tempdir().unwrap();
        let slots = d.path().join("slots");
        std::fs::create_dir_all(&slots).unwrap();
        old_file(&slots.join("a.bin"), 30);
        old_file(&slots.join("b.bin"), 2);
        let removed = trim_slots(&d.path().join("memory"), &slots, Some(&slots.join("b.bin"))).unwrap();
        assert_eq!(removed, [slots.join("a.bin")]);
        assert!(!slots.join("a.bin").exists() && slots.join("b.bin").exists());
        assert!(trim_slots(&d.path().join("memory"), &d.path().join("none"), None).unwrap().is_empty(), "no folder, no files");
    }

    #[test]
    fn a_model_taken_off_loses_its_slot_files_and_its_folder_and_no_other() {
        let d = tempfile::tempdir().unwrap();
        let (slots, memory) = (d.path().join("slots"), d.path().join("memory"));
        std::fs::create_dir_all(&slots).unwrap();
        std::fs::create_dir_all(memory.join("qwen")).unwrap();
        std::fs::create_dir_all(memory.join("qwen2")).unwrap();
        for name in [last_file("qwen"), pending_file("qwen"), prefix_file("qwen", "1a2b"), prefix_file("qwen", "3c4d"), last_file("qwen2"), prefix_file("qwen2", "1a2b"), "orphan.bin".to_string()] {
            std::fs::write(slots.join(name), b"x").unwrap();
        }
        std::fs::write(memory.join("qwen").join("a.slot"), b"x").unwrap();
        forget(d.path(), "qwen").unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&slots).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["orphan.bin", "qwen2.bin", "qwen2.prefix-1a2b.bin"]);
        assert!(!memory.join("qwen").exists() && memory.join("qwen2").is_dir());
        forget(d.path(), "never-there").unwrap();
    }
}
