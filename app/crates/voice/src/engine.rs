//! Whisper (whisper.cpp) on the processor: models load in a thread, transcriptions are serialized (there is one
//! processor, and whisper's state is single per model).

use mango_common::tr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

/// The audio whisper expects: mono f32 PCM at 16 kHz.
pub const SAMPLE_RATE: u32 = 16_000;
/// Like faster-whisper (beam_size=5 in its `transcribe`).
const BEAM_SIZE: i32 = 5;
/// Under a second whisper.cpp transcribes nothing: it is padded with silence.
const MIN_SAMPLES: usize = SAMPLE_RATE as usize;
/// How long a request that arrives while the model loads waits (ATTESA_MODELLO_S in the Python).
const LOAD_WAIT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Loading,
    Ready,
    Failed(String),
}

/// Why a transcription didn't succeed; the HTTP route derives the code from it.
#[derive(Debug)]
pub enum Failure {
    /// The model isn't there (yet or ever): 503.
    Unavailable(String),
    /// Whisper failed on valid audio: 500.
    Internal(String),
}

/// Which transcription is asked for: the final one of a finished sentence, or the partial of a sentence in progress
/// (faster and less accurate, and thrown away as soon as a more recent one arrives).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Final,
    Partial,
}

/// The models and threads to use. The partial's model, if missing, is the final's.
#[derive(Clone, Debug)]
pub struct Settings {
    pub model: PathBuf,
    pub vad: PathBuf,
    pub partial_model: Option<PathBuf>,
    /// Whisper threads; normally half the logical processors (`threads()`).
    pub threads: Option<i32>,
    /// The partial shortens the encoder context to the audio's duration (see `audio_ctx`).
    pub partial_short_ctx: bool,
}

impl Settings {
    pub fn new(model: &Path, vad: &Path, partial_model: Option<&Path>) -> Self {
        Settings {
            model: model.to_path_buf(),
            vad: vad.to_path_buf(),
            partial_model: partial_model.map(Path::to_path_buf),
            threads: None,
            partial_short_ctx: true,
        }
    }
}

struct Whisper {
    // whisper's state doesn't live without its context: we keep them together
    _ctx: WhisperContext,
    state: WhisperState,
}

struct Loaded {
    final_model: Whisper,
    partial_model: Option<Whisper>,
    vad: WhisperVadContext,
}

pub struct Engine {
    status: Mutex<Status>,
    changed: Condvar,
    loaded: OnceLock<Mutex<Loaded>>,
    threads: i32,
    partial_short_ctx: bool,
    vad_model: PathBuf,
}

impl Engine {
    /// Starts the loading in a thread and returns at once.
    pub fn spawn(settings: &Settings) -> Arc<Engine> {
        let engine = Arc::new(Engine {
            status: Mutex::new(Status::Loading),
            changed: Condvar::new(),
            loaded: OnceLock::new(),
            threads: settings.threads.unwrap_or_else(threads),
            partial_short_ctx: settings.partial_short_ctx,
            vad_model: settings.vad.clone(),
        });
        let (e, settings) = (engine.clone(), settings.clone());
        std::thread::spawn(move || {
            let result = load(&settings);
            let mut st = e.status.lock().unwrap();
            *st = match result {
                Ok(loaded) => {
                    let _ = e.loaded.set(Mutex::new(loaded));
                    Status::Ready
                }
                Err(msg) => Status::Failed(msg),
            };
            e.changed.notify_all();
        });
        engine
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    /// A voice detector all for a live session: its state flows with the audio.
    pub fn new_vad(&self) -> Result<WhisperVadContext, Failure> {
        let mut params = WhisperVadContextParams::new();
        params.set_n_threads(1);
        WhisperVadContext::new(&self.vad_model.to_string_lossy(), params).map_err(|e| {
            Failure::Unavailable(tr!("VAD '{}' non caricato: {e}", "VAD '{}' not loaded: {e}", self.vad_model.display()))
        })
    }

    /// Waits for the loading to end (`LOAD_WAIT` at most).
    fn wait_loaded(&self) -> Result<&Mutex<Loaded>, Failure> {
        let st = self.status.lock().unwrap();
        let (st, _) = self.changed.wait_timeout_while(st, LOAD_WAIT, |s| *s == Status::Loading).unwrap();
        match &*st {
            Status::Ready => Ok(self.loaded.get().expect("Ready without a model")),
            Status::Failed(m) => Err(Failure::Unavailable(m.clone())),
            Status::Loading => Err(Failure::Unavailable(tr!(
                "il modello è ancora in caricamento, riprova fra poco",
                "the model is still loading, try again in a moment"
            ))),
        }
    }

    /// Waits for the models to be loaded.
    pub fn wait_ready(&self) -> Result<(), Failure> {
        self.wait_loaded().map(|_| ())
    }

    /// Transcribes a 16 kHz mono clip: text (empty = no speech) and seconds of compute, model wait excluded.
    pub fn transcribe(&self, pcm: &[f32], kind: Kind) -> Result<(String, f64), Failure> {
        let loaded = self.wait_loaded()?;
        let mut guard = loaded.lock().unwrap();
        let t0 = Instant::now();

        // In a button's clip there is always silence at the edges, and on silence whisper invents sentences: Silero
        // (the same VAD as faster-whisper) removes it first. It is applied here and not with
        // `FullParams::enable_vad`, which whisper.cpp only honors in `whisper_full`, while whisper-rs calls
        // `whisper_full_with_state`: the flag would be ignored.
        let mut speech = keep_speech(&mut guard.vad, pcm)?;
        if speech.is_empty() {
            return Ok((String::new(), t0.elapsed().as_secs_f64()));
        }
        // under a second whisper.cpp transcribes nothing ("input is too short")
        if speech.len() < MIN_SAMPLES {
            speech.resize(MIN_SAMPLES, 0.0);
        }

        let mut p = match kind {
            Kind::Final => FullParams::new(SamplingStrategy::BeamSearch { beam_size: BEAM_SIZE, patience: -1.0 }),
            Kind::Partial => FullParams::new(SamplingStrategy::Greedy { best_of: 1 }),
        };
        // Dictation follows the app's language.
        p.set_language(Some(mango_common::i18n::lang().code()));
        p.set_n_threads(self.threads);
        p.set_translate(false);
        p.set_suppress_nst(true);
        // whisper's state is single and lives between requests: with the context on, one dictation's text would
        // condition the next
        p.set_no_context(true);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_special(false);
        p.set_print_timestamps(false);
        if kind == Kind::Partial {
            p.set_single_segment(true);
            p.set_no_timestamps(true);
            // no new attempts at a higher temperature: a partial that doesn't convince is redone with the next one
            p.set_temperature_inc(0.0);
            if self.partial_short_ctx {
                p.set_audio_ctx(audio_ctx(speech.len()));
            }
        }

        let w = match (kind, guard.partial_model.as_mut()) {
            (Kind::Partial, Some(par)) => par,
            _ => &mut guard.final_model,
        };
        w.state.full(p, &speech).map_err(|e| Failure::Internal(tr!("trascrizione fallita: {e}", "transcription failed: {e}")))?;
        let text: String = w
            .state
            .as_iter()
            .map(|s| s.to_str_lossy().map(|t| t.into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| Failure::Internal(tr!("testo non leggibile: {e}", "unreadable text: {e}")))?
            .concat();
        Ok((text.trim().to_string(), t0.elapsed().as_secs_f64()))
    }
}

/// The encoder context is 1500 positions for 30 s (50 per second) and costs as much as its length: for a partial of a
/// few seconds it is shortened to the duration, with a margin.
fn audio_ctx(samples: usize) -> i32 {
    let positions = (samples as f32 / SAMPLE_RATE as f32 * 50.0).ceil() as usize + 64;
    (positions.div_ceil(32) * 32).clamp(256, 1500) as i32
}

/// Only the stretches with speech, separated by 0.1 s of silence (as whisper.cpp does with its VAD).
fn keep_speech(vad: &mut WhisperVadContext, pcm: &[f32]) -> Result<Vec<f32>, Failure> {
    let mut params = WhisperVadParams::new();
    params.set_min_silence_duration(500);
    // like faster-whisper: a margin around the speech, so the consonants at the edges aren't lost
    params.set_speech_pad(400);
    let segments = vad
        .segments_from_samples(params, pcm)
        .map_err(|e| Failure::Internal(tr!("VAD fallito: {e}", "VAD failed: {e}")))?;
    let cs = |t: f32| ((t as f64 / 100.0 * SAMPLE_RATE as f64) as usize).min(pcm.len());
    let mut out = Vec::new();
    for seg in segments {
        if !out.is_empty() {
            out.resize(out.len() + SAMPLE_RATE as usize / 10, 0.0);
        }
        out.extend_from_slice(&pcm[cs(seg.start)..cs(seg.end)]);
    }
    Ok(out)
}

fn load_whisper(model: &Path) -> Result<Whisper, String> {
    let name = model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut params = WhisperContextParameters::new();
    // the GPUs belong to the language model
    params.use_gpu(false);
    let ctx = WhisperContext::new_with_params(model, params).map_err(|e| tr!("modello '{name}' non caricato: {e}", "model '{name}' not loaded: {e}"))?;
    let state = ctx.create_state().map_err(|e| tr!("modello '{name}' non caricato: {e}", "model '{name}' not loaded: {e}"))?;
    Ok(Whisper { _ctx: ctx, state })
}

fn load(settings: &Settings) -> Result<Loaded, String> {
    let final_model = load_whisper(&settings.model)?;
    let partial_model = settings.partial_model.as_deref().map(load_whisper).transpose()?;
    let vad_name = settings.vad.display();
    let vad = WhisperVadContext::new(&settings.vad.to_string_lossy(), WhisperVadContextParams::new())
        .map_err(|e| tr!("VAD '{vad_name}' non caricato: {e}", "VAD '{vad_name}' not loaded: {e}"))?;
    Ok(Loaded { final_model, partial_model, vad })
}

/// Half the logical processors (≈ the physical cores), between 2 and 8: beyond that, whisper doesn't gain.
fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map_or(4, |n| n.get());
    (logical / 2).clamp(2, 8) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_partials_context_follows_the_duration() {
        // 3 s -> 150 positions + margin, rounded to 32
        assert_eq!(audio_ctx(3 * 16_000), 256);
        assert_eq!(audio_ctx(10 * 16_000), 576);
        assert_eq!(audio_ctx(60 * 16_000), 1500);
    }
}
