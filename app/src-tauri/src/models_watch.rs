//! The models folder, watched: a file put there or taken away by hand, which nothing in the app announces, makes the
//! interface read the catalog and the computer again (the space the models use, the models on the computer).
//!
//! Windows tells that something under the folder changed; a burst of changes (a copy, a download writing its file) ends
//! with one call, `quiet` after the last change. The nearest existing parent is watched too (names of folders only), so
//! that a folder deleted, renamed away or put back is noticed and watched again: the watch never ends because of the
//! folder, only when it is stopped. A folder is told changed also when it disappears or comes back. When no folder above it
//! is left either (a disk that was unplugged) the thread waits for Windows to announce a volume arriving, and looks again
//! one quiet interval after it: a disk that comes back is noticed without anyone asking. A network share that comes back
//! is no volume arrival and is not noticed until the watch is started again (the next start of the app).

use anyhow::{Context, Result};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;
use windows::core::HSTRING;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Register_Notification, CM_Unregister_Notification, CM_NOTIFY_ACTION, CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL, CM_NOTIFY_EVENT_DATA, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_0_2,
    CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE, CR_SUCCESS, HCMNOTIFICATION,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_SIZE,
};
use windows::Win32::System::Ioctl::GUID_DEVINTERFACE_VOLUME;
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE};

pub const QUIET: Duration = Duration::from_secs(2);

/// What the watching thread is told: the event that wakes it to stop, and the one Windows signals when a volume arrives.
struct Shared {
    stop: AtomicBool,
    wake: HANDLE,
    arrival: HANDLE,
}

// The event handle is only signaled and closed; both are safe from any thread.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Drop for Shared {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.wake) };
        let _ = unsafe { CloseHandle(self.arrival) };
    }
}

/// A watch on a folder, running in its own thread until `stop` or until it is dropped.
pub struct Watch {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Watch {
    /// Windows tells that a volume arrived, as the test cannot make one arrive.
    #[cfg(test)]
    fn volume_arrived(&self) {
        let _ = unsafe { SetEvent(self.shared.arrival) };
    }

    /// Ends the watch and waits for its thread: no call is made after this returns.
    pub fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.shared.stop.store(true, Ordering::SeqCst);
            let _ = unsafe { SetEvent(self.shared.wake) };
            let _ = thread.join();
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The app's watch of the models folder. A move of the folder takes the watch away and keeps it away (`suspend`) until it gives
/// everything back (`resume`): a start of the app in between does not watch the folder that is being moved.
#[derive(Default)]
pub struct Slot {
    watch: Option<Watch>,
    suspended: bool,
}

impl Slot {
    /// Starts the watch with `start`, unless there is one already or a move has taken it away.
    pub fn fill(&mut self, start: impl FnOnce() -> Result<Watch>) -> Result<()> {
        if self.watch.is_none() && !self.suspended {
            self.watch = Some(start()?);
        }
        Ok(())
    }

    pub fn suspend(&mut self) {
        self.watch = None;
        self.suspended = true;
    }

    pub fn resume(&mut self) {
        self.suspended = false;
    }
}

/// Windows tells that a volume arrived: the event is signaled. The call runs in a thread of the system and does nothing else.
unsafe extern "system" fn volume_arrived(_: HCMNOTIFICATION, event: *const core::ffi::c_void, action: CM_NOTIFY_ACTION, _: *const CM_NOTIFY_EVENT_DATA, _: u32) -> u32 {
    if action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL {
        let _ = unsafe { SetEvent(HANDLE(event as *mut core::ffi::c_void)) };
    }
    0
}

/// The registration for the arrival of volumes, ended when it goes: the system waits for a call in progress, so the event it
/// signals may be closed right after.
struct VolumeArrivals(HCMNOTIFICATION);

impl VolumeArrivals {
    fn register(event: HANDLE) -> std::result::Result<VolumeArrivals, u32> {
        let mut filter = CM_NOTIFY_FILTER { cbSize: std::mem::size_of::<CM_NOTIFY_FILTER>() as u32, FilterType: CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE, ..Default::default() };
        filter.u.DeviceInterface = CM_NOTIFY_FILTER_0_2 { ClassGuid: GUID_DEVINTERFACE_VOLUME };
        let mut registration = HCMNOTIFICATION(std::ptr::null_mut());
        let answer = unsafe { CM_Register_Notification(&filter, Some(event.0 as *const core::ffi::c_void), Some(volume_arrived), &mut registration) };
        match answer == CR_SUCCESS {
            true => Ok(VolumeArrivals(registration)),
            false => Err(answer.0),
        }
    }
}

impl Drop for VolumeArrivals {
    fn drop(&mut self) {
        let _ = unsafe { CM_Unregister_Notification(self.0) };
    }
}

/// A change notification, closed when it goes.
struct Notification(HANDLE);

impl Notification {
    fn open(path: &Path, subtree: bool, filter: windows::Win32::Storage::FileSystem::FILE_NOTIFY_CHANGE) -> windows::core::Result<Notification> {
        unsafe { FindFirstChangeNotificationW(&HSTRING::from(path.as_os_str()), subtree, filter) }.map(Notification)
    }

    fn rearm(&self) -> windows::core::Result<()> {
        unsafe { FindNextChangeNotification(self.0) }
    }
}

impl Drop for Notification {
    fn drop(&mut self) {
        let _ = unsafe { FindCloseChangeNotification(self.0) };
    }
}

/// Which folder the path names right now: the volume and the file index, which a folder deleted and made again under the
/// same name does not keep (its creation time would: Windows gives a name that came back its old one). `None` when it
/// is not a folder.
fn identity(dir: &Path) -> Option<(u32, u64)> {
    if !dir.is_dir() {
        return None;
    }
    let opened = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0).open(dir).ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&opened)), &mut info) }.ok()?;
    Some((info.dwVolumeSerialNumber, u64::from(info.nFileIndexHigh) << 32 | u64::from(info.nFileIndexLow)))
}

/// The two notifications of a watch: the folder (when it exists) and its nearest existing parent.
struct Armed {
    dir: PathBuf,
    folder: Option<Notification>,
    parent: Option<(PathBuf, Notification)>,
    id: Option<(u32, u64)>,
}

impl Armed {
    /// Looks at the disk: the folder is watched if it is there, as the very folder that is there now, and the parent
    /// is the nearest existing one. Says what could not be armed.
    fn arm(dir: PathBuf, trouble: &impl Fn(String)) -> Armed {
        let mut armed = Armed { dir, folder: None, parent: None, id: None };
        armed.reconcile(trouble);
        armed
    }

    /// Nothing is left to watch: the folder and every folder above it are gone.
    fn lost(&self) -> bool {
        self.folder.is_none() && self.parent.is_none()
    }

    /// Makes the notifications match the disk: the folder is watched, as the very folder that is there now, if there is one,
    /// and the parent is the nearest one that exists. The disk can change while this is done, so it looks again until it
    /// did not.
    fn reconcile(&mut self, trouble: &impl Fn(String)) {
        for _ in 0..5 {
            let (id, parent) = (identity(&self.dir), nearest_parent(&self.dir));
            if id != self.id || (id.is_some() && self.folder.is_none()) {
                self.folder = None;
                if id.is_some() {
                    match Notification::open(&self.dir, true, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE) {
                        Ok(n) => self.folder = Some(n),
                        Err(e) => trouble(format!("{} is not watched: {e}", self.dir.display())),
                    }
                }
                self.id = id;
            }
            if self.parent.as_ref().map(|(p, _)| p) != parent.as_ref() {
                self.parent = parent.clone().and_then(|p| match Notification::open(&p, false, FILE_NOTIFY_CHANGE_DIR_NAME) {
                    Ok(n) => Some((p, n)),
                    Err(e) => {
                        trouble(format!("{} is not watched: {e}", p.display()));
                        None
                    }
                });
            }
            if identity(&self.dir) == self.id && nearest_parent(&self.dir) == parent {
                return;
            }
        }
    }
}

/// The nearest folder above `dir` that exists.
fn nearest_parent(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().skip(1).find(|p| p.is_dir()).map(Path::to_path_buf)
}

/// What a wait on the handles ended with.
#[derive(Debug, PartialEq, Eq)]
enum Waited {
    Timeout,
    /// The handle at this place was signaled.
    Signaled(usize),
    /// The call failed, or a handle was abandoned or is not in the list: the code it answered.
    Failed(u32),
}

fn waited(answer: WAIT_EVENT, handles: usize) -> Waited {
    if answer == WAIT_TIMEOUT {
        return Waited::Timeout;
    }
    match (answer.0 as usize).checked_sub(WAIT_OBJECT_0.0 as usize).filter(|at| *at < handles) {
        Some(at) => Waited::Signaled(at),
        None => Waited::Failed(answer.0),
    }
}

/// Calls `changed` when what is under `dir` changed and stopped changing, `quiet` after the last change, until the watch is
/// stopped. Returns once the watch is armed, so a change made after it is seen; a folder that is not there is watched through
/// its nearest parent (`dir` is not made here). A folder that goes away is watched through its parent and again when it
/// comes back; `trouble` hears what could not be armed. When the folder and every folder above it are gone (a disk that was
/// unplugged) or waiting fails twice in a row, `changed` is called and the thread waits, besides the stop, for a volume to
/// arrive; one quiet interval after it, it looks at the disk again and calls `changed` if something is there to watch.
pub fn watch(dir: &Path, quiet: Duration, changed: impl Fn() + Send + 'static, trouble: impl Fn(String) + Send + 'static) -> Result<Watch> {
    let wake = unsafe { CreateEventW(None, false, false, None) }.context("the watch did not start")?;
    let arrival = unsafe { CreateEventW(None, false, false, None) }.inspect_err(|_| drop(unsafe { CloseHandle(wake) })).context("the watch did not start")?;
    let shared = Arc::new(Shared { stop: AtomicBool::new(false), wake, arrival });
    let (armed, armed_rx) = mpsc::channel();
    let (dir, thread_shared) = (dir.to_path_buf(), shared.clone());
    let thread = std::thread::spawn(move || {
        // The notifications are born in the thread that waits on them.
        let mut now = Armed::arm(dir, &trouble);
        let arrivals = VolumeArrivals::register(thread_shared.arrival);
        if let Err(code) = &arrivals {
            trouble(format!("the arrival of a disk is not watched ({code:#x}): a disk that comes back is not noticed"));
        }
        let _ = armed.send(());
        let quiet_ms = quiet.as_millis() as u32;
        let (mut pending, mut failed_before, mut broken) = (false, false, false);
        loop {
            // Nothing is left to watch, or the waiting itself fails: only a disk arriving can change that.
            let degraded = broken || now.lost();
            let mut waits = vec![thread_shared.wake];
            let arrival_at = (degraded && arrivals.is_ok()).then(|| {
                waits.push(thread_shared.arrival);
                waits.len() - 1
            });
            let folder_at = now.folder.as_ref().filter(|_| !broken).map(|n| {
                waits.push(n.0);
                waits.len() - 1
            });
            let parent_at = now.parent.as_ref().filter(|_| !broken).map(|(_, n)| {
                waits.push(n.0);
                waits.len() - 1
            });
            let answer = unsafe { WaitForMultipleObjects(&waits, false, if pending { quiet_ms } else { INFINITE }) };
            let at = match waited(answer, waits.len()) {
                Waited::Timeout => {
                    pending = false;
                    changed();
                    continue;
                }
                Waited::Failed(code) => {
                    trouble(format!("waiting for a change failed ({code})"));
                    if degraded {
                        trouble("the watch cannot wait any more and ends".to_string());
                        return;
                    }
                    if failed_before {
                        trouble("the watch waits for a disk to arrive, then arms itself again".to_string());
                        broken = true;
                        continue;
                    }
                    failed_before = true;
                    let dir = now.dir.clone();
                    now = Armed::arm(dir, &trouble);
                    pending = true;
                    continue;
                }
                Waited::Signaled(at) => at,
            };
            failed_before = false;
            if at == 0 {
                if thread_shared.stop.load(Ordering::SeqCst) {
                    return;
                }
                continue;
            }
            if Some(at) == arrival_at {
                // The volume is there; its letter or its folder may take a moment more.
                if unsafe { WaitForSingleObject(thread_shared.wake, quiet_ms) } == WAIT_OBJECT_0 {
                    return;
                }
                let dir = now.dir.clone();
                now = Armed::arm(dir, &trouble);
                if !now.lost() {
                    (broken, pending) = (false, false);
                    changed();
                }
                continue;
            }
            // Something under the folder changed, or a folder next to it. If the folder itself is another one (or none)
            // it is armed again and that is told; otherwise a change under it is told, and one next to it is not. The
            // notification that fired asks for the next change, unless it is going to be replaced.
            let another = identity(&now.dir) != now.id;
            let fired = match Some(at) == folder_at {
                true => now.folder.as_ref().filter(|_| !another),
                false => now.parent.as_ref().filter(|(path, _)| path.is_dir()).map(|(_, n)| n),
            };
            if let Some(Err(e)) = fired.map(Notification::rearm) {
                trouble(format!("the watch cannot be armed again: {e}"));
            }
            if another || Some(at) == parent_at {
                now.reconcile(&trouble);
            }
            if now.lost() {
                trouble("the folder and every folder above it are gone: the watch waits for a disk to arrive".to_string());
                pending = false;
                changed();
                continue;
            }
            pending |= another || Some(at) == folder_at;
        }
    });
    armed_rx.recv().context("the watch did not start")?;
    Ok(Watch { shared, thread: Some(thread) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::sync::mpsc::Receiver;

    const QUIET_TEST: Duration = Duration::from_millis(500);
    const LONG: Duration = Duration::from_secs(10);

    /// A watched `models` folder in a temporary one: what the watch announces as changes, and what it could not arm.
    fn watched() -> (tempfile::TempDir, PathBuf, Watch, Receiver<()>, Receiver<String>) {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("models");
        std::fs::create_dir(&models).unwrap();
        let (changed, changes) = mpsc::channel();
        let (trouble, troubles) = mpsc::channel();
        let watch = watch(&models, QUIET_TEST, move || { let _ = changed.send(()); }, move |why| { let _ = trouble.send(why); }).unwrap();
        (dir, models, watch, changes, troubles)
    }

    /// Waits for a call, then for the folder to be quiet again, and says how many more calls came meanwhile.
    fn call_then_calm(changes: &Receiver<()>) -> usize {
        changes.recv_timeout(LONG).expect("a call within 10 s");
        std::iter::from_fn(|| changes.recv_timeout(QUIET_TEST * 3).ok()).count()
    }

    fn silence(changes: &Receiver<()>) {
        assert!(changes.recv_timeout(QUIET_TEST * 4).is_err(), "a call that should not have come");
    }

    /// A file put by hand under the folder, at any depth, and one taken away are each told once the folder is quiet;
    /// a burst of writes is one call.
    #[test]
    fn a_file_put_in_the_folder_by_hand_or_taken_away_is_told() {
        let (_dir, models, _watch, changes, troubles) = watched();

        std::fs::write(models.join("mine.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
        std::fs::create_dir(models.join("owner")).unwrap();
        std::fs::write(models.join("owner").join("nested.gguf"), b"weights").unwrap();
        call_then_calm(&changes);

        for i in 0..20 {
            std::fs::write(models.join("owner").join("growing.part"), vec![0u8; 1000 * (i + 1)]).unwrap();
        }
        assert_eq!(call_then_calm(&changes), 0, "the burst of writes made one call");

        std::fs::remove_file(models.join("mine.gguf")).unwrap();
        call_then_calm(&changes);
        assert!(troubles.try_recv().is_err());
    }

    /// The folder deleted while the app runs and made again: both are told, and a file put in the new one is seen.
    #[test]
    fn a_folder_deleted_and_made_again_is_watched_again() {
        let (_dir, models, _watch, changes, troubles) = watched();

        std::fs::remove_dir_all(&models).unwrap();
        call_then_calm(&changes);
        std::fs::create_dir(&models).unwrap();
        call_then_calm(&changes);

        std::fs::write(models.join("back.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
        assert!(troubles.try_recv().is_err());
    }

    /// The folder renamed away (its files go with it, and a change inside the moved folder is not the models') and a new
    /// one made under the old name: the new one is the folder that is watched.
    #[test]
    fn a_folder_renamed_away_and_made_again_is_watched_again() {
        let (dir, models, _watch, changes, _troubles) = watched();

        let moved = dir.path().join("elsewhere");
        std::fs::rename(&models, &moved).unwrap();
        call_then_calm(&changes);
        std::fs::write(moved.join("late.gguf"), b"weights").unwrap();
        silence(&changes);

        std::fs::create_dir(&models).unwrap();
        call_then_calm(&changes);
        std::fs::write(models.join("new.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
    }

    /// A folder renamed away and a new one in its place before the watch looks: it is not the one that was armed.
    #[test]
    fn a_folder_replaced_at_once_is_watched_again() {
        let (dir, models, _watch, changes, _troubles) = watched();

        std::fs::rename(&models, dir.path().join("elsewhere")).unwrap();
        std::fs::create_dir(&models).unwrap();
        call_then_calm(&changes);
        std::fs::write(models.join("new.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
    }

    /// A folder whose parents go away too is watched through the nearest one that is left, and found again when the path
    /// is made again.
    #[test]
    fn a_folder_whose_parents_are_gone_is_found_when_the_path_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("a").join("b").join("models");
        std::fs::create_dir_all(&models).unwrap();
        let (changed, changes) = mpsc::channel();
        let _watch = watch(&models, QUIET_TEST, move || { let _ = changed.send(()); }, |_| {}).unwrap();

        std::fs::remove_dir_all(dir.path().join("a")).unwrap();
        call_then_calm(&changes);
        std::fs::create_dir(dir.path().join("a")).unwrap();
        std::fs::create_dir(dir.path().join("a").join("b")).unwrap();
        silence(&changes);
        std::fs::create_dir(&models).unwrap();
        call_then_calm(&changes);
        std::fs::write(models.join("back.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
    }

    /// Another folder next to the watched one, made or removed, is not news.
    #[test]
    fn folders_next_to_the_watched_one_are_not_news() {
        let (dir, _models, _watch, changes, _troubles) = watched();

        std::fs::create_dir(dir.path().join("neighbour")).unwrap();
        std::fs::remove_dir(dir.path().join("neighbour")).unwrap();
        silence(&changes);
    }

    /// One virtual drive at a time: two tests would pick the same free letter.
    static DRIVES: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A virtual drive for a test: the letter of a drive nobody uses, mapped to a folder, and unmapped when it is dropped.
    struct Drive {
        letter: String,
        folder: PathBuf,
        _turn: std::sync::MutexGuard<'static, ()>,
    }

    impl Drive {
        fn map(to: &Path) -> Drive {
            let turn = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
            let free = ('H'..='Z').rev().map(|c| format!("{c}:")).find(|d| !Path::new(&format!("{d}\\")).exists()).expect("a free drive letter");
            let drive = Drive { letter: free, folder: to.to_path_buf(), _turn: turn };
            drive.remap();
            drive
        }

        /// The disk is plugged in again, under the same letter.
        fn remap(&self) {
            let made = std::process::Command::new("subst").arg(&self.letter).arg(&self.folder).creation_flags(mango_common::CREATE_NO_WINDOW).status().unwrap();
            assert!(made.success());
        }

        fn unmap(&self) {
            let _ = std::process::Command::new("subst").arg(&self.letter).arg("/D").creation_flags(mango_common::CREATE_NO_WINDOW).output();
        }
    }

    impl Drop for Drive {
        fn drop(&mut self) {
            self.unmap();
        }
    }

    /// A disk that goes away takes the folder and every folder above it: nothing is left to watch (`lost`). A watch started
    /// then does not end and does not look again by itself: it waits for a volume to arrive, and one quiet interval after it
    /// the folder is watched and told; a file put there afterwards is seen. (Windows tells the arrival of a real disk; the
    /// test makes one arrive, as it cannot plug a disk.)
    #[test]
    fn a_watch_whose_disk_is_gone_waits_for_a_volume_and_finds_the_folder_when_it_arrives() {
        let disk = tempfile::tempdir().unwrap();
        let drive = Drive::map(disk.path());
        let models = PathBuf::from(format!(r"{}\models", drive.letter));
        std::fs::create_dir(&models).unwrap();
        assert!(!Armed::arm(models.clone(), &|_| {}).lost());
        drive.unmap();
        assert!(Armed::arm(models.clone(), &|_| {}).lost());

        let (changed, changes) = mpsc::channel();
        let (trouble, troubles) = mpsc::channel();
        let watch = watch(&models, QUIET_TEST, move || { let _ = changed.send(()); }, move |why| { let _ = trouble.send(why); }).expect("a watch starts even when the disk is not there");
        assert!(troubles.try_recv().is_err(), "the arrival of volumes is watched");

        drive.remap();
        silence(&changes);
        watch.volume_arrived();
        assert_eq!(call_then_calm(&changes), 0, "told once, one quiet interval after the arrival");
        std::fs::write(models.join("back.gguf"), b"weights").unwrap();
        call_then_calm(&changes);
        assert!(troubles.try_recv().is_err());
    }

    /// A volume that arrives but does not bring the folder (another disk) is not news, and the watch goes on waiting.
    #[test]
    fn a_volume_that_does_not_bring_the_folder_back_is_not_news() {
        let disk = tempfile::tempdir().unwrap();
        let drive = Drive::map(disk.path());
        let models = PathBuf::from(format!(r"{}\models", drive.letter));
        std::fs::create_dir(&models).unwrap();
        drive.unmap();
        let (changed, changes) = mpsc::channel();
        let watch = watch(&models, QUIET_TEST, move || { let _ = changed.send(()); }, |_| {}).unwrap();

        watch.volume_arrived();
        silence(&changes);

        drive.remap();
        watch.volume_arrived();
        call_then_calm(&changes);
    }

    /// A volume that arrives while the folder is there is ignored, and does not cause a call later.
    #[test]
    fn a_volume_that_arrives_while_the_folder_is_there_is_ignored() {
        let (_dir, models, watch, changes, _troubles) = watched();

        watch.volume_arrived();
        silence(&changes);
        std::fs::write(models.join("one.gguf"), b"weights").unwrap();
        assert_eq!(call_then_calm(&changes), 0);
    }
    #[test]
    fn a_wait_that_fails_is_told_apart_from_a_change() {
        use windows::Win32::Foundation::{WAIT_ABANDONED_0, WAIT_FAILED};
        assert_eq!(waited(WAIT_TIMEOUT, 3), Waited::Timeout);
        assert_eq!(waited(WAIT_OBJECT_0, 3), Waited::Signaled(0));
        assert_eq!(waited(WAIT_EVENT(WAIT_OBJECT_0.0 + 2), 3), Waited::Signaled(2));
        assert_eq!(waited(WAIT_EVENT(WAIT_OBJECT_0.0 + 3), 3), Waited::Failed(3));
        assert_eq!(waited(WAIT_FAILED, 3), Waited::Failed(WAIT_FAILED.0));
        assert_eq!(waited(WAIT_ABANDONED_0, 3), Waited::Failed(WAIT_ABANDONED_0.0));
    }

    /// A move takes the watch away and nothing starts another until it gives everything back.
    #[test]
    fn a_suspended_slot_starts_nothing_until_it_is_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let starts = std::cell::Cell::new(0);
        let start = || {
            starts.set(starts.get() + 1);
            watch(dir.path(), QUIET_TEST, || {}, |_| {})
        };
        let mut slot = Slot::default();

        slot.fill(start).unwrap();
        slot.fill(start).unwrap();
        assert_eq!(starts.get(), 1, "a watch that is there stays");

        slot.suspend();
        slot.fill(start).unwrap();
        assert_eq!(starts.get(), 1, "a move has the folder");

        slot.resume();
        slot.fill(start).unwrap();
        assert_eq!(starts.get(), 2);
    }
    /// `stop` ends the thread: it returns only when the thread is gone (the closure of the watch is dropped, which the
    /// channel shows), and nothing is told after.
    #[test]
    fn a_stopped_watch_is_gone() {
        let (_dir, models, mut watch, changes, _troubles) = watched();

        watch.stop();
        assert!(matches!(changes.try_recv(), Err(mpsc::TryRecvError::Disconnected)), "the thread still holds the closure");
        std::fs::write(models.join("late.gguf"), b"weights").unwrap();
        watch.stop();
    }
}
