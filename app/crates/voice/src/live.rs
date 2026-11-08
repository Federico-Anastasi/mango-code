//! Live dictation: the browser sends audio in pieces while you speak, the service says when a sentence starts,
//! transcribes a partial of it now and then, and the final sentence as soon as the speaker stops.
//!
//! Each session has its own voice detector (`Engine::new_vad`), which runs inside the chunk's request (a few ms), and
//! a thread that transcribes: the finals first, in order, and only one partial at a time, always the last one asked
//! for. There is one processor: a partial never delays a final, and if the transcription is slower than the speech the
//! partials are skipped instead of piling up.

use crate::engine::{Engine, Failure, Kind};
use crate::segmenter::{Action, Config, Segmenter, WINDOW};
use mango_common::tr;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use whisper_rs::WhisperVadContext;

/// Before the new windows the detector revisits 16 windows (0.5 s): whisper.cpp resets its state at every call, and with
/// this lead-in the new windows' probabilities are those of a continuous pass.
const LEAD_IN_WINDOWS: usize = 16;
/// A session that receives nothing for a long time is abandoned (page closed, network down).
const SESSION_ABANDONED: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 8;
/// How long `end` waits for the transcriptions still in progress.
const END_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
pub struct LiveConfig {
    pub segmenter: Config,
    /// How much new audio is needed, in a sentence in progress, to ask for another partial.
    pub partial_ms: f32,
}

impl Default for LiveConfig {
    fn default() -> Self {
        LiveConfig { segmenter: Config::default(), partial_ms: 800.0 }
    }
}

pub struct Live {
    engine: Arc<Engine>,
    cfg: LiveConfig,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    counter: AtomicU64,
}

impl Live {
    pub fn new(engine: Arc<Engine>, cfg: LiveConfig) -> Arc<Live> {
        Arc::new(Live { engine, cfg, sessions: Mutex::new(HashMap::new()), counter: AtomicU64::new(1) })
    }

    /// Opens a session; waits, if needed, for the models to finish loading.
    pub fn open(&self) -> Result<String, Failure> {
        self.engine.wait_ready()?;
        let vad = self.engine.new_vad()?;
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, s| {
            let alive = s.last_use.lock().unwrap().elapsed() < SESSION_ABANDONED;
            if !alive {
                s.close();
            }
            alive
        });
        if sessions.len() >= MAX_SESSIONS {
            return Err(Failure::Unavailable(tr!("troppe dettature aperte insieme", "too many dictations open at once")));
        }
        let id = format!("d{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let session = Session::new(self.engine.clone(), vad, self.cfg.clone());
        sessions.insert(id.clone(), session);
        Ok(id)
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// A piece of audio; returns the events that came out meanwhile. `None`: the session is no longer there.
    pub fn chunk(&self, id: &str, pcm: &[f32]) -> Option<Vec<Value>> {
        let s = self.session(id)?;
        Some(s.chunk(pcm))
    }

    /// End of the dictation: closes the sentence in progress, waits for the finals and frees the session.
    pub fn end(&self, id: &str) -> Option<Vec<Value>> {
        let s = self.sessions.lock().unwrap().remove(id)?;
        Some(s.end())
    }
}

enum Slot {
    Waiting(Vec<f32>),
    Running,
    /// The text and the milliseconds the transcription took.
    Done(String, u64),
}

/// A sentence to transcribe definitively. `id` tells it apart from a preparation discarded because the speaker
/// resumed.
struct Final {
    id: u64,
    sentence: u64,
    slot: Slot,
}

struct Inner {
    seg: Segmenter,
    rest: Vec<f32>,
    lead_in: Vec<f32>,
    events: Vec<Value>,
    sentence: u64,
    next_id: u64,
    /// The prepared sentence, not yet closed.
    prepared: Option<Final>,
    /// The closed sentences, in order, waiting for the text to come out.
    closed: VecDeque<Final>,
    partial: Option<Vec<f32>>,
    partial_running: bool,
    /// Duration of the sentence when the last partial was asked for.
    partial_at_ms: f32,
    last_partial: String,
    finished: bool,
}

struct Session {
    engine: Arc<Engine>,
    cfg: LiveConfig,
    vad: Mutex<WhisperVadContext>,
    inner: Mutex<Inner>,
    wake: Condvar,
    last_use: Mutex<Instant>,
}

enum Work {
    Final(u64, Vec<f32>),
    Partial(u64, Vec<f32>),
}

impl Session {
    fn new(engine: Arc<Engine>, vad: WhisperVadContext, cfg: LiveConfig) -> Arc<Session> {
        let inner = Inner {
            seg: Segmenter::new(cfg.segmenter.clone()),
            rest: Vec::new(),
            lead_in: Vec::new(),
            events: Vec::new(),
            sentence: 1,
            next_id: 1,
            prepared: None,
            closed: VecDeque::new(),
            partial: None,
            partial_running: false,
            partial_at_ms: 0.0,
            last_partial: String::new(),
            finished: false,
        };
        let s = Arc::new(Session {
            engine,
            cfg,
            vad: Mutex::new(vad),
            inner: Mutex::new(inner),
            wake: Condvar::new(),
            last_use: Mutex::new(Instant::now()),
        });
        let w = s.clone();
        std::thread::Builder::new().name("voice-live".into()).spawn(move || w.work()).expect("dictation thread");
        s
    }

    fn close(&self) {
        self.inner.lock().unwrap().finished = true;
        self.wake.notify_all();
    }

    fn chunk(&self, pcm: &[f32]) -> Vec<Value> {
        *self.last_use.lock().unwrap() = Instant::now();
        let mut i = self.inner.lock().unwrap();
        let mut data = std::mem::take(&mut i.rest);
        data.extend_from_slice(pcm);
        let n = data.len() / WINDOW;
        if n > 0 {
            match self.probabilities(&i.lead_in, &data[..n * WINDOW]) {
                Ok(probs) => {
                    let mut actions = Vec::new();
                    for (k, p) in probs.into_iter().enumerate() {
                        i.seg.window(&data[k * WINDOW..(k + 1) * WINDOW], p, &mut actions);
                        for a in actions.drain(..) {
                            i.apply(a);
                        }
                    }
                }
                Err(e) => i.events.push(error_event(&e)),
            }
            let seen = [i.lead_in.as_slice(), &data[..n * WINDOW]].concat();
            i.lead_in = seen[seen.len().saturating_sub(LEAD_IN_WINDOWS * WINDOW)..].to_vec();
        }
        i.rest = data[n * WINDOW..].to_vec();
        i.ask_partial(self.cfg.partial_ms);
        let events = std::mem::take(&mut i.events);
        drop(i);
        self.wake.notify_all();
        events
    }

    /// The voice probabilities of the windows of `new`, with the lead-in in front to warm up the detector.
    fn probabilities(&self, lead_in: &[f32], new: &[f32]) -> Result<Vec<f32>, Failure> {
        let input = [lead_in, new].concat();
        let mut vad = self.vad.lock().unwrap();
        vad.detect_speech(&input).map_err(|e| Failure::Internal(tr!("VAD fallito: {e}", "VAD failed: {e}")))?;
        let probs = vad.probabilities();
        let from = lead_in.len() / WINDOW;
        Ok(probs[from..from + new.len() / WINDOW].to_vec())
    }

    fn end(&self) -> Vec<Value> {
        let mut i = self.inner.lock().unwrap();
        let prepared = i.prepared.take();
        match (i.seg.close_now(), prepared) {
            // already prepared: the text is there or on its way, and covers the whole sentence
            (_, Some(f)) => i.closed.push_back(f),
            (Some(audio), None) => {
                let f = i.new_final(audio);
                i.closed.push_back(f);
            }
            (None, None) => {}
        }
        i.sentence += 1;
        i.partial = None;
        i.emit_ready();
        self.wake.notify_all();
        let deadline = Instant::now() + END_WAIT;
        while !i.closed.is_empty() && !i.finished {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                i.events.push(json!({ "type": "error", "message": tr!("la trascrizione non finisce", "the transcription doesn't end") }));
                break;
            }
            i = self.wake.wait_timeout(i, left).unwrap().0;
        }
        i.finished = true;
        let events = std::mem::take(&mut i.events);
        drop(i);
        self.wake.notify_all();
        events
    }

    /// The transcribing thread: the finals first, then the most recent partial.
    fn work(&self) {
        loop {
            let work = {
                let mut i = self.inner.lock().unwrap();
                loop {
                    if i.finished {
                        return;
                    }
                    if let Some(w) = i.next_work() {
                        break w;
                    }
                    i = self.wake.wait(i).unwrap();
                }
            };
            let (kind, audio) = match &work {
                Work::Final(_, a) => (Kind::Final, a),
                Work::Partial(_, a) => (Kind::Partial, a),
            };
            let start = Instant::now();
            let result = self.engine.transcribe(audio, kind);
            let ms = start.elapsed().as_millis() as u64;
            let mut i = self.inner.lock().unwrap();
            match (work, result) {
                (Work::Final(id, _), Ok((text, _))) => i.finished_final(id, text, ms),
                (Work::Partial(sentence, _), Ok((text, _))) => i.partial_ready(sentence, text, ms),
                (Work::Final(id, _), Err(e)) => {
                    i.events.push(error_event(&e));
                    i.finished_final(id, String::new(), ms);
                }
                (Work::Partial(..), Err(e)) => {
                    i.partial_running = false;
                    i.events.push(error_event(&e));
                }
            }
            drop(i);
            self.wake.notify_all();
        }
    }
}

fn error_event(e: &Failure) -> Value {
    let (Failure::Unavailable(m) | Failure::Internal(m)) = e;
    json!({ "type": "error", "message": m })
}

impl Inner {
    fn new_final(&mut self, audio: Vec<f32>) -> Final {
        let id = self.next_id;
        self.next_id += 1;
        Final { id, sentence: self.sentence, slot: Slot::Waiting(audio) }
    }

    fn apply(&mut self, action: Action) {
        match action {
            Action::Speaking => self.events.push(json!({ "type": "speaking" })),
            Action::Empty => self.events.push(json!({ "type": "empty", "sentence": self.sentence })),
            Action::Prepare(audio) => self.prepared = Some(self.new_final(audio)),
            Action::Resume => self.prepared = None,
            Action::Close => {
                if let Some(f) = self.prepared.take() {
                    self.closed.push_back(f);
                }
                self.sentence += 1;
                self.partial = None;
                self.partial_at_ms = 0.0;
                self.last_partial.clear();
                self.emit_ready();
            }
        }
    }

    /// Asks for a partial if the sentence in progress has enough new audio and the previous one has finished.
    fn ask_partial(&mut self, every_ms: f32) {
        let duration = self.seg.duration_ms();
        if !self.seg.speaking() || self.seg.prepared() || self.partial_running || self.partial.is_some() {
            return;
        }
        if duration - self.partial_at_ms < every_ms {
            return;
        }
        self.partial_at_ms = duration;
        self.partial = Some(self.seg.sentence_audio());
    }

    fn next_work(&mut self) -> Option<Work> {
        for f in self.closed.iter_mut().chain(self.prepared.as_mut()) {
            if let Slot::Waiting(_) = f.slot {
                let Slot::Waiting(audio) = std::mem::replace(&mut f.slot, Slot::Running) else { unreachable!() };
                return Some(Work::Final(f.id, audio));
            }
        }
        let audio = self.partial.take()?;
        self.partial_running = true;
        Some(Work::Partial(self.sentence, audio))
    }

    fn finished_final(&mut self, id: u64, text: String, ms: u64) {
        // if the speaker resumed, the preparation is gone and the text is thrown away
        for f in self.closed.iter_mut().chain(self.prepared.as_mut()) {
            if f.id == id {
                f.slot = Slot::Done(text, ms);
                break;
            }
        }
        self.emit_ready();
    }

    fn emit_ready(&mut self) {
        while let Some(Final { slot: Slot::Done(..), .. }) = self.closed.front() {
            let Some(Final { sentence, slot: Slot::Done(text, ms), .. }) = self.closed.pop_front() else { unreachable!() };
            let event = if text.is_empty() {
                json!({ "type": "empty", "sentence": sentence })
            } else {
                json!({ "type": "final", "sentence": sentence, "text": text, "ms": ms })
            };
            self.events.push(event);
        }
    }

    fn partial_ready(&mut self, sentence: u64, text: String, ms: u64) {
        self.partial_running = false;
        // a sentence already closed or prepared has its final on the way
        if sentence != self.sentence || self.seg.prepared() || text.is_empty() || text == self.last_partial {
            return;
        }
        self.last_partial = text.clone();
        self.events.push(json!({ "type": "partial", "sentence": sentence, "text": text, "ms": ms }));
    }
}
