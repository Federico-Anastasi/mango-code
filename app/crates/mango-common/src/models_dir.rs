//! Where the models are kept: `<data>\models`, or the folder the user chose, written in `<data>\models-dir.txt` (the whole
//! path, on one line). A development PC's `mango-paths.json` that names the models folder wins over both
//! (`Paths::from_dirs`). Moving the models to another folder is `relocate`.

pub mod journal;
pub mod owned;
pub mod place;
pub mod relocate;

use crate::{tr, user_text};
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

pub const CHOICE_FILE: &str = "models-dir.txt";

/// The models folder when nothing else is chosen.
pub fn default_dir(data: &Path) -> PathBuf {
    data.join("models")
}

/// The folder the user chose; none when they have not (or went back to the default one). A choice that is not a whole
/// path is an error that says so: the file is written by the app, and a start on another folder than the user's would
/// not find their models.
pub fn chosen(data: &Path) -> Result<Option<PathBuf>> {
    let file = data.join(CHOICE_FILE);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(anyhow::Error::new(e).context(user_text(&tr!("Non riesco a leggere la cartella dei modelli scelta.", "I can't read the chosen models folder."), file.display()))),
    };
    let dir = PathBuf::from(text.trim_start_matches('\u{feff}').trim());
    match dir.as_os_str().is_empty() {
        true => Ok(None),
        false if dir.is_absolute() => Ok(Some(dir)),
        false => Err(crate::user_error(
            &tr!("La cartella dei modelli scelta non è un percorso completo. Scegline un'altra dalle impostazioni, o togli il file.", "The chosen models folder is not a whole path. Choose another one in the settings, or remove the file."),
            file.display(),
        )),
    }
}

/// Saves `dir` as the models folder, whole or not at all; the default folder is saved as no choice.
pub fn save(data: &Path, dir: &Path) -> std::io::Result<()> {
    let file = data.join(CHOICE_FILE);
    if same(dir, &default_dir(data)) {
        return match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(data)?;
    crate::write_durable(&file, dir.display().to_string())
}

/// The models folder now: the chosen one, or the default.
pub fn current(data: &Path) -> Result<PathBuf> {
    Ok(chosen(data)?.unwrap_or_else(|| default_dir(data)))
}

/// A development PC's `mango-paths.json` names the models folder: the user's choice does not apply there.
pub fn pinned(dist: &Path) -> Result<bool> {
    Ok(crate::paths_file(dist)?.models.is_some())
}

/// Whether a directory entry's own metadata (`DirEntry::metadata`, which does not follow links) is a link: a symbolic
/// link, a junction, or any other folder that is a reparse point. These are reported and left alone, never walked.
pub fn is_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    meta.file_type().is_symlink() || (meta.is_dir() && meta.file_attributes() & REPARSE_POINT != 0)
}

/// Whether two paths name the same place as far as the text goes: Windows ignores capitals, and a slash is a backslash.
pub fn same(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| p.display().to_string().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    key(a) == key(b)
}

/// What is left of `path` below `base`, whatever the capitals and the slashes; none when `path` is not below `base`.
pub fn below(path: &Path, base: &Path) -> Option<PathBuf> {
    let lower = |c: std::path::Component| c.as_os_str().to_string_lossy().to_lowercase();
    let (mut have, mut under) = (path.components(), base.components());
    loop {
        match (under.next(), have.next()) {
            (Some(a), Some(b)) if lower(a) == lower(b) => {}
            (None, Some(rest)) => return Some(std::iter::once(rest).chain(have).collect()),
            _ => return None,
        }
    }
}

/// The text a relative path is compared by: lower case, with backslashes.
pub(crate) fn key(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>().join("\\")
}

/// Removes the folders that the files `rels` (below `root`) have left empty, from the deepest up; it stops at the first one that
/// still holds something, and never takes a link away: a junction is removed by `remove_dir` like an empty folder.
pub(crate) fn prune_empty(root: &Path, rels: impl IntoIterator<Item = PathBuf>) {
    for rel in rels {
        for folder in rel.ancestors().skip(1).take_while(|f| !f.as_os_str().is_empty()) {
            let at = root.join(folder);
            if std::fs::symlink_metadata(&at).map_or(true, |m| is_link(&m)) || std::fs::remove_dir(&at).is_err() {
                break;
            }
        }
    }
}

/// The wish to stop a move or a model's files being put elsewhere, and the moment after which it is too late: the choice is
/// being written. The two cannot both happen: either the stop is asked before `commit` (which then fails, and the old
/// folder goes on) or `commit` comes first (and `request` says it is too late).
#[derive(Default)]
pub struct Cancel(AtomicU8);

impl Cancel {
    const RUNNING: u8 = 0;
    const ASKED: u8 = 1;
    const COMMITTED: u8 = 2;

    pub fn new() -> Cancel {
        Cancel::default()
    }

    /// For the next move.
    pub fn reset(&self) {
        self.0.store(Self::RUNNING, Ordering::SeqCst);
    }

    /// Asks to stop. True if the move will stop (it is asked now or was asked already); false if it is past the point where it can.
    pub fn request(&self) -> bool {
        self.0.compare_exchange(Self::RUNNING, Self::ASKED, Ordering::SeqCst, Ordering::SeqCst).is_ok() || self.requested()
    }

    pub fn requested(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::ASKED
    }

    /// The choice is written: what a move does from here on cannot be stopped.
    pub fn committed(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::COMMITTED
    }

    /// The move writes its choice: true if it may, false if it was asked to stop first.
    pub fn commit(&self) -> bool {
        self.0.compare_exchange(Self::RUNNING, Self::COMMITTED, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Paths;

    #[test]
    fn a_stop_and_the_commit_exclude_each_other() {
        let asked_first = Cancel::new();
        assert!(asked_first.request() && asked_first.request());
        assert!(asked_first.requested() && !asked_first.commit());
        asked_first.reset();
        assert!(asked_first.commit(), "a new move");

        let committed_first = Cancel::new();
        assert!(!committed_first.committed());
        assert!(committed_first.commit());
        assert!(!committed_first.request() && !committed_first.requested(), "too late to stop");
        assert!(committed_first.committed());
        committed_first.reset();
        assert!(!committed_first.committed());
    }

    #[test]
    fn a_path_is_below_a_folder_by_its_parts_not_its_letters() {
        let base = Path::new(r"D:\Models");
        assert_eq!(below(Path::new(r"d:/models/Org/a.gguf"), base), Some(PathBuf::from(r"Org\a.gguf")));
        assert_eq!(below(Path::new(r"D:\Models2\a.gguf"), base), None);
        assert_eq!(below(Path::new(r"D:\Models"), base), None);
        assert_eq!(below(Path::new(r"E:\Models\a.gguf"), base), None);
        assert_eq!(key(Path::new(r"Org/A.GGUF")), r"org\a.gguf");
    }

    fn dist_with(models: Option<&Path>) -> tempfile::TempDir {
        let dist = tempfile::tempdir().unwrap();
        std::fs::write(dist.path().join("mango-models.json"), "{}").unwrap();
        if let Some(models) = models {
            std::fs::write(dist.path().join("mango-paths.json"), serde_json::json!({ "models": models }).to_string()).unwrap();
        }
        dist
    }

    /// Without any choice the models are in `<data>\models`; the user's choice replaces that; a development PC's
    /// `mango-paths.json` wins over both.
    #[test]
    fn the_distribution_wins_over_the_users_choice_which_wins_over_the_default() {
        let data = tempfile::tempdir().unwrap();
        let (chosen_dir, pinned_dir) = (data.path().join("chosen"), data.path().join("pinned"));
        let dist = dist_with(None);
        let of = |dist: &Path| Paths::from_dirs(dist.to_path_buf(), data.path().to_path_buf()).unwrap().models;

        assert_eq!(of(dist.path()), data.path().join("models"));
        save(data.path(), &chosen_dir).unwrap();
        assert_eq!(of(dist.path()), chosen_dir);
        assert!(!pinned(dist.path()).unwrap());

        let dev = dist_with(Some(&pinned_dir));
        assert_eq!(of(dev.path()), pinned_dir, "mango-paths.json first");
        assert!(pinned(dev.path()).unwrap());
    }

    #[test]
    fn choosing_the_default_folder_again_removes_the_choice() {
        let data = tempfile::tempdir().unwrap();
        save(data.path(), &data.path().join("elsewhere")).unwrap();
        assert!(data.path().join(CHOICE_FILE).is_file());

        save(data.path(), &PathBuf::from(data.path().join("MODELS").display().to_string() + "\\")).unwrap();
        assert!(!data.path().join(CHOICE_FILE).exists());
        assert_eq!(chosen(data.path()).unwrap(), None);
        save(data.path(), &default_dir(data.path())).unwrap();
    }

    /// An empty file is no choice; a path that is not whole is refused with a sentence, not guessed.
    #[test]
    fn the_choice_file_is_read_as_a_whole_path_or_refused() {
        let data = tempfile::tempdir().unwrap();
        let file = data.path().join(CHOICE_FILE);
        for (text, expected) in [("", None), ("\n", None), ("\u{feff}D:\\Modelli\n", Some("D:\\Modelli"))] {
            std::fs::write(&file, text).unwrap();
            assert_eq!(chosen(data.path()).unwrap(), expected.map(PathBuf::from), "{text:?}");
        }
        std::fs::write(&file, "models\\here").unwrap();
        assert!(chosen(data.path()).is_err());
        let dist = dist_with(None);
        assert!(Paths::from_dirs(dist.path().to_path_buf(), data.path().to_path_buf()).is_err());
    }
}
