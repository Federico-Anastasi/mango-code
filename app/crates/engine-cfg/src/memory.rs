//! The engines' on-disk memory (`--cache-disk`): a running engine saves there the state of conversations and of the
//! system prompt, and on restart rereads only the new tokens. Each model has its own folder (`<memory>\<model>`):
//! a model's files are of no use to the others, and an engine removes by itself those it doesn't recognize. The
//! space ceiling and the maximum age apply to all models together: before starting a model the expired files of all
//! are removed, and the other models' files are kept as long as they fit in half the ceiling (the longest unused go
//! first); the running model gets the rest.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Space ceiling of the whole memory. A 100 thousand token conversation weighs ~1.1 GB with the 3.6 and ~3.8 GB with
/// TOQ's 27B; the base (system prompt and tools) a few hundred MB.
pub const MEMORY_MIB: u64 = 6144;
/// Maximum age of an unused state.
pub const MEMORY_HOURS: u64 = 24;

/// Folder and ceiling (MiB) of model `key`'s memory, after making room as described above.
pub fn prepare(root: &Path, key: &str) -> Result<(PathBuf, u64)> {
    let dir = root.join(key);
    std::fs::create_dir_all(&dir).with_context(|| format!("memory folder {}", dir.display()))?;
    let files = list_files(root).with_context(|| format!("reading the memory {}", root.display()))?;
    let (remove, ceiling) = choose(&files, &dir, SystemTime::now(), MEMORY_MIB << 20, Duration::from_secs(MEMORY_HOURS * 3600));
    for p in remove {
        if let Err(e) = std::fs::remove_file(&p) {
            eprintln!("memory: cannot remove {}: {e}", p.display());
        }
    }
    Ok((dir, ceiling >> 20))
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

    #[test]
    fn the_expired_files_of_all_models_go() {
        let files = [f(r"m\toq\a.slot", 1, 30), f(r"m\3.6\b.slot", 1, 25), f(r"m\3.6\c.slot", 1, 2), f(r"m\old.slot", 1, 48)];
        let (remove, ceiling) = choose(&files, Path::new(r"m\3.6"), now(), 6 * GIB, Duration::from_secs(24 * 3600));
        assert_eq!(remove, [PathBuf::from(r"m\toq\a.slot"), PathBuf::from(r"m\3.6\b.slot"), PathBuf::from(r"m\old.slot")]);
        assert_eq!(ceiling, 6 * GIB, "the running model's files are managed by its engine, within the ceiling");
    }

    #[test]
    fn the_other_models_keep_at_most_half_the_ceiling() {
        let files = [f(r"m\toq\a.slot", 2, 10), f(r"m\toq\b.slot", 2, 1), f(r"m\lfm\c.slot", 1, 5), f(r"m\3.6\d.slot", 3, 1)];
        let (remove, ceiling) = choose(&files, Path::new(r"m\3.6"), now(), 6 * GIB, Duration::from_secs(24 * 3600));
        // 5 GiB of the others: the oldest goes (toq\a, 2 GiB), 3 GiB remain = half the ceiling
        assert_eq!(remove, [PathBuf::from(r"m\toq\a.slot")]);
        assert_eq!(ceiling, 3 * GIB);
    }

    #[test]
    fn without_others_the_running_model_has_the_whole_ceiling() {
        let (remove, ceiling) = choose(&[f(r"m\toq\a.slot", 4, 1)], Path::new(r"m\toq"), now(), 6 * GIB, Duration::from_secs(24 * 3600));
        assert!(remove.is_empty());
        assert_eq!(ceiling, 6 * GIB);
    }

    #[test]
    fn prepares_on_disk() {
        let d = tempfile::tempdir().unwrap();
        let old = d.path().join("toq").join("a.slot");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"x").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(25 * 3600)).unwrap();
        drop(f);
        let (dir, mib) = prepare(d.path(), "3.6").unwrap();
        assert_eq!(dir, d.path().join("3.6"));
        assert!(dir.is_dir());
        assert!(!old.exists(), "the expired file of another model is still there");
        assert_eq!(mib, MEMORY_MIB);
    }
}
