//! Pictures asked as jobs: each has a number, is made in its turn on a thread of its own, and can be followed and
//! stopped by whoever asked, or by anyone who has its number.

use crate::{Cancelled, ImageManager, Place, Progress, Request, Stage};
use base64::Engine;
use mango_common::{tr, user_phrase};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

/// How many jobs that have ended are remembered, with their pictures: the oldest go first.
const REMEMBERED: usize = 8;

/// The values on the wire are in English: they are what the interface and the other apps read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Another picture is being made: this one waits for its turn.
    Waiting,
    Preparing,
    Drawing,
    Finishing,
    Done,
    Failed,
    Cancelled,
}

impl Status {
    fn ended(self) -> bool {
        matches!(self, Status::Done | Status::Failed | Status::Cancelled)
    }
}

/// A job as it is told to whoever follows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobView {
    pub id: String,
    pub status: Status,
    pub model: String,
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    /// The seed of the request, or the one the manager drew: known once the picture is made.
    pub seed: Option<u32>,
    pub step: u32,
    pub steps: u32,
    /// Since the job was asked, until it ended.
    pub seconds: u64,
    /// Why it failed: the sentence for the user, and the technical detail.
    pub error: Option<String>,
    pub detail: Option<String>,
    /// Where the picture was written, when the request named a file: the name asked for, or the next free one if that
    /// was taken. Known once the job is done.
    pub file: Option<String>,
    /// The picture as it is at this step, small: a PNG in base64. Only while it is drawn, and only when asked for.
    pub preview: Option<String>,
}

struct Job {
    view: JobView,
    asked: Instant,
    stop: Arc<AtomicBool>,
    preview: Option<Vec<u8>>,
    picture: Option<Vec<u8>>,
}

struct Shared {
    manager: ImageManager,
    /// In the order they were asked. The numbers go on from `made`.
    jobs: Mutex<Vec<Job>>,
    made: Mutex<u64>,
}

#[derive(Clone)]
pub struct Jobs(Arc<Shared>);

impl Jobs {
    pub fn new(manager: ImageManager) -> Jobs {
        Jobs(Arc::new(Shared { manager, jobs: Mutex::new(Vec::new()), made: Mutex::new(0) }))
    }

    pub fn manager(&self) -> &ImageManager {
        &self.0.manager
    }

    /// Asks for a picture and returns its job at once. With `file` the picture is also written there (the folders
    /// that are missing are made) without replacing a file that is there: if the name is taken when the picture is
    /// ready it goes to the next free one, and the job's `file` says where. A picture that cannot be written is a job
    /// that failed.
    pub fn submit(&self, request: Request, file: Option<PathBuf>) -> JobView {
        let id = {
            let mut made = self.0.made.lock().unwrap_or_else(|e| e.into_inner());
            *made += 1;
            format!("image-{made}")
        };
        let view = JobView {
            id: id.clone(),
            status: Status::Waiting,
            model: request.model.clone(),
            prompt: request.prompt.clone(),
            width: request.width,
            height: request.height,
            seed: request.seed,
            step: 0,
            steps: 0,
            seconds: 0,
            error: None,
            detail: None,
            file: None,
            preview: None,
        };
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs();
            let ended: Vec<usize> = jobs.iter().enumerate().filter(|(_, j)| j.view.status.ended()).map(|(i, _)| i).collect();
            if ended.len() >= REMEMBERED {
                jobs.remove(ended[0]);
            }
            jobs.push(Job { view: view.clone(), asked: Instant::now(), stop: stop.clone(), preview: None, picture: None });
        }
        // Its place in the line is taken here and not on its thread: two pictures asked one after the other are made in
        // that order, whichever thread starts first.
        let (me, place) = (self.clone(), self.0.manager.place());
        let spawned = std::thread::Builder::new().name("image-job".into()).spawn(move || me.run(&id, place, &request, file, &stop));
        if let Err(e) = spawned {
            self.change(&view.id, |j| {
                j.view.status = Status::Failed;
                j.view.error = Some(tr!("Mango Code non riesce a cominciare l'immagine. Riprova.", "Mango Code cannot begin the picture. Try again."));
                j.view.detail = Some(format!("thread: {e}"));
            });
        }
        self.view(&view.id, false).unwrap_or(view)
    }

    fn run(&self, id: &str, place: Place, request: &Request, file: Option<PathBuf>, stop: &AtomicBool) {
        let made = self.0.manager.generate_in(place, request, stop, &mut |p: &Progress| {
            self.change(id, |j| {
                j.view.status = match p.stage {
                    Stage::Preparing => Status::Preparing,
                    Stage::Drawing => Status::Drawing,
                    Stage::Finishing => Status::Finishing,
                };
                (j.view.step, j.view.steps) = (p.step, p.steps);
                if p.preview.is_some() {
                    j.preview.clone_from(&p.preview);
                }
            });
        });
        let written = made.and_then(|picture| {
            let wrote = match &file {
                Some(file) => Some(write_new(file, &picture.png)?),
                None => None,
            };
            Ok((picture, wrote))
        });
        self.change(id, |j| {
            j.view.seconds = j.asked.elapsed().as_secs();
            j.preview = None;
            match written {
                Ok((picture, wrote)) => {
                    j.view.status = Status::Done;
                    j.view.seed = Some(picture.seed);
                    (j.view.step, j.view.steps) = (picture.steps, picture.steps);
                    j.view.file = wrote.map(|f| f.display().to_string());
                    j.picture = Some(picture.png);
                }
                Err(e) if e.is::<Cancelled>() => j.view.status = Status::Cancelled,
                Err(e) => {
                    j.view.status = Status::Failed;
                    j.view.error = Some(user_phrase(&e));
                    j.view.detail = Some(format!("{e:#}"));
                }
            }
        });
    }

    /// The job as it is now; with `preview`, also the picture as it is at this step.
    pub fn view(&self, id: &str, preview: bool) -> Option<JobView> {
        let jobs = self.jobs();
        let job = jobs.iter().find(|j| j.view.id == id)?;
        let mut view = job.view.clone();
        if !view.status.ended() {
            view.seconds = job.asked.elapsed().as_secs();
        }
        if preview {
            view.preview = job.preview.as_ref().map(|p| base64::engine::general_purpose::STANDARD.encode(p));
        }
        Some(view)
    }

    /// Stops the jobs that have not ended and use `model`: the one being made ends within a moment, the ones that wait
    /// never begin.
    pub fn stop_model(&self, model: &str) {
        for job in self.jobs().iter().filter(|j| !j.view.status.ended() && j.view.model == model) {
            job.stop.store(true, Ordering::SeqCst);
        }
    }

    /// The jobs that are remembered, in the order they were asked, without previews.
    pub fn views(&self) -> Vec<JobView> {
        let ids: Vec<String> = self.jobs().iter().map(|j| j.view.id.clone()).collect();
        ids.iter().filter_map(|id| self.view(id, false)).collect()
    }

    /// The picture of a job that is done, as a PNG.
    pub fn picture(&self, id: &str) -> Option<Vec<u8>> {
        self.jobs().iter().find(|j| j.view.id == id)?.picture.clone()
    }

    /// Stops a job: one being made ends within a moment, one that waits never begins. The answer is the job as it is
    /// now; whoever follows it sees `cancelled` soon after. A job that has ended stays as it ended.
    pub fn cancel(&self, id: &str) -> Option<JobView> {
        self.jobs().iter().find(|j| j.view.id == id)?.stop.store(true, Ordering::SeqCst);
        self.view(id, false)
    }

    fn change(&self, id: &str, change: impl FnOnce(&mut Job)) {
        if let Some(job) = self.jobs().iter_mut().find(|j| j.view.id == id) {
            change(job);
        }
    }

    fn jobs(&self) -> MutexGuard<'_, Vec<Job>> {
        self.0.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Writes the picture to `file` without ever replacing a file: if the name is taken at this moment (two jobs asked
/// for it, or a file appeared since) the picture goes to `name-2.ext`, `name-3.ext`, … and the path really written is
/// returned. The folders that are missing are made.
fn write_new(file: &std::path::Path, png: &[u8]) -> Result<PathBuf, anyhow::Error> {
    use std::io::{ErrorKind, Write};
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(|e| cannot_write(file, &e))?;
    }
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut n = 1u32;
    loop {
        let candidate = if n == 1 { file.to_path_buf() } else { file.with_file_name(format!("{stem}-{n}{ext}")) };
        // A folder with that name is in the way of the file asked for, not a picture to step over: on some systems
        // opening it reports "already exists", on others "access denied", so it is told apart first.
        if candidate.is_dir() {
            return Err(cannot_write(&candidate, &std::io::Error::new(ErrorKind::AlreadyExists, "a folder has this name")));
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut open) => {
                if let Err(e) = open.write_all(png) {
                    drop(open);
                    // A half-written picture is worse than none.
                    let _ = std::fs::remove_file(&candidate);
                    return Err(cannot_write(&candidate, &e));
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(cannot_write(&candidate, &e)),
        }
    }
}

fn cannot_write(file: &std::path::Path, e: &std::io::Error) -> anyhow::Error {
    mango_common::user_error(&tr!("L'immagine è fatta, ma non riesco a scriverla nel file chiesto.", "The picture is made, but I cannot write it to the file asked for."), format!("{}: {e}", file.display()))
}
