//! Where a sentence starts and where it ends, from Silero's voice probabilities (one per 32 ms window). It is the
//! logic of the base `ascolto_conversazione.py`, without the transcription: here it only decides, and whoever uses it
//! takes care of transcribing.
//!
//! A sentence starts after `start_ms` of voice and ends after `end_of_sentence_ms` of silence. At that point the audio
//! goes off for transcription (`Prepare`), but the sentence closes (`Close`) only if for another `continue_ms`
//! nobody resumes: whoever resumes continues the same sentence (`Resume`) and the transcription already done is
//! thrown away. A sentence without at least `SURE_VOICE_MS` of sure voice is noise (a breath, a click): `Empty`, and
//! it isn't transcribed, because on a piece without voice whisper invents a sentence.

use std::collections::VecDeque;

/// Samples at 16 kHz in a Silero window.
pub const WINDOW: usize = 512;
pub const WINDOW_MS: f32 = WINDOW as f32 * 1000.0 / 16_000.0;
/// A shorter gap doesn't interrupt the start of a sentence.
const GAP_MS: f32 = 100.0;
/// A sentence is transcribed only if it contains sure voice: at least `SURE_VOICE_MS` with probability from
/// `SURE_VOICE_P`. A spoken «yes» gets there, real voice exceeds 0.9.
const SURE_VOICE_P: f32 = 0.85;
const SURE_VOICE_MS: f32 = 150.0;
/// Before the start 300 ms are kept, so the first consonant isn't lost.
const BEFORE_MS: f32 = 300.0;
/// Little silence is left at the tail of the sentence: whisper hallucinates on it.
const TAIL_MS: f32 = 150.0;
/// The cut of a sentence that's too long falls on the lowest point of this last stretch.
const CUT_SEARCH_MS: f32 = 3000.0;

#[derive(Clone, Debug)]
pub struct Config {
    pub threshold: f32,
    pub end_of_sentence_ms: f32,
    pub continue_ms: f32,
    pub start_ms: f32,
    /// A longer sentence cuts itself at the nearest breath: the partial costs as much as the sentence.
    pub max_sentence_ms: f32,
}

impl Default for Config {
    fn default() -> Self {
        Config { threshold: 0.5, end_of_sentence_ms: 600.0, continue_ms: 500.0, start_ms: 240.0, max_sentence_ms: 12_000.0 }
    }
}

#[derive(Debug, PartialEq)]
pub enum Action {
    /// The speaker has started.
    Speaking,
    /// It was noise: no text.
    Empty,
    /// The silence is as long as `end_of_sentence_ms`: this is the audio to transcribe.
    Prepare(Vec<f32>),
    /// The speaker has resumed: the sentence continues and the prepared transcription is no longer valid.
    Resume,
    /// Nobody resumed: the sentence is closed.
    Close,
}

pub struct Segmenter {
    cfg: Config,
    end_threshold: f32,
    speaking: bool,
    /// The sentence's audio and the probability of each of its windows.
    sentence: Vec<f32>,
    probs: Vec<f32>,
    candidate: Vec<f32>,
    before: VecDeque<Vec<f32>>,
    run_ms: f32,
    sure_ms: f32,
    gap_ms: f32,
    silence_ms: f32,
    resume_ms: f32,
    prepared: bool,
}

impl Segmenter {
    pub fn new(cfg: Config) -> Self {
        let end_threshold = (cfg.threshold - 0.15).max(0.1);
        Segmenter {
            cfg,
            end_threshold,
            speaking: false,
            sentence: Vec::new(),
            probs: Vec::new(),
            candidate: Vec::new(),
            before: VecDeque::new(),
            run_ms: 0.0,
            sure_ms: 0.0,
            gap_ms: 0.0,
            silence_ms: 0.0,
            resume_ms: 0.0,
            prepared: false,
        }
    }

    /// There is a sentence in progress (started and not yet closed).
    pub fn speaking(&self) -> bool {
        self.speaking
    }

    /// The sentence has already been prepared and is waiting for `continue_ms`.
    pub fn prepared(&self) -> bool {
        self.prepared
    }

    pub fn duration_ms(&self) -> f32 {
        self.sentence.len() as f32 * 1000.0 / 16_000.0
    }

    /// The audio of the sentence in progress without the tail silence (minus `TAIL_MS`).
    pub fn sentence_audio(&self) -> Vec<f32> {
        let cut = ((self.silence_ms - TAIL_MS).max(0.0) * 16.0) as usize;
        let end = if cut > 0 && cut < self.sentence.len() { self.sentence.len() - cut } else { self.sentence.len() };
        self.sentence[..end].to_vec()
    }

    /// Closes the sentence in progress now (end of dictation) and gives its audio, if it contains voice.
    pub fn close_now(&mut self) -> Option<Vec<f32>> {
        if !self.speaking || self.sure_ms < SURE_VOICE_MS {
            self.reset();
            return None;
        }
        let audio = self.sentence_audio();
        self.reset();
        Some(audio)
    }

    fn reset(&mut self) {
        self.speaking = false;
        self.sentence.clear();
        self.probs.clear();
        self.candidate.clear();
        self.before.clear();
        self.run_ms = 0.0;
        self.sure_ms = 0.0;
        self.gap_ms = 0.0;
        self.silence_ms = 0.0;
        self.resume_ms = 0.0;
        self.prepared = false;
    }

    /// A window of `WINDOW` samples with its voice probability.
    pub fn window(&mut self, w: &[f32], p: f32, out: &mut Vec<Action>) {
        if !self.speaking {
            return self.waiting(w, p, out);
        }
        self.sentence.extend_from_slice(w);
        self.probs.push(p);
        if p >= SURE_VOICE_P {
            self.sure_ms += WINDOW_MS;
        }
        self.silence_ms = if p >= self.end_threshold { 0.0 } else { self.silence_ms + WINDOW_MS };

        if self.prepared {
            self.resume_ms = if p >= self.cfg.threshold { self.resume_ms + WINDOW_MS } else { 0.0 };
            if self.resume_ms >= self.cfg.start_ms {
                self.prepared = false;
                out.push(Action::Resume);
            } else if self.silence_ms >= self.cfg.end_of_sentence_ms + self.cfg.continue_ms {
                self.close(out);
            }
            return;
        }
        if self.silence_ms >= self.cfg.end_of_sentence_ms {
            return self.prepare(out);
        }
        if self.duration_ms() >= self.cfg.max_sentence_ms {
            self.cut(out);
        }
    }

    fn waiting(&mut self, w: &[f32], p: f32, out: &mut Vec<Action>) {
        if p >= self.cfg.threshold {
            self.candidate.extend_from_slice(w);
            self.run_ms += WINDOW_MS;
            if p >= SURE_VOICE_P {
                self.sure_ms += WINDOW_MS;
            }
            self.gap_ms = 0.0;
            if self.run_ms >= self.cfg.start_ms {
                self.speaking = true;
                let before = (BEFORE_MS / WINDOW_MS) as usize;
                let from = self.before.len().saturating_sub(before);
                self.sentence = self.before.iter().skip(from).flatten().copied().collect();
                self.probs = vec![0.0; self.before.len() - from];
                self.sentence.append(&mut self.candidate);
                self.probs.resize(self.sentence.len() / WINDOW, p);
                self.before.clear();
                self.silence_ms = 0.0;
                out.push(Action::Speaking);
            }
        } else if !self.candidate.is_empty() && self.gap_ms + WINDOW_MS <= GAP_MS {
            self.candidate.extend_from_slice(w);
            self.gap_ms += WINDOW_MS;
        } else {
            // Real silence: the candidate wasn't the start of a sentence.
            if !self.candidate.is_empty() {
                for piece in self.candidate.chunks(WINDOW) {
                    self.before.push_back(piece.to_vec());
                }
            }
            self.before.push_back(w.to_vec());
            let max = (1000.0 / WINDOW_MS) as usize + 1;
            while self.before.len() > max {
                self.before.pop_front();
            }
            self.candidate.clear();
            self.run_ms = 0.0;
            self.sure_ms = 0.0;
            self.gap_ms = 0.0;
        }
    }

    fn prepare(&mut self, out: &mut Vec<Action>) {
        if self.sure_ms < SURE_VOICE_MS {
            self.reset();
            out.push(Action::Empty);
            return;
        }
        self.prepared = true;
        self.resume_ms = 0.0;
        out.push(Action::Prepare(self.sentence_audio()));
        if self.cfg.continue_ms <= 0.0 {
            self.close(out);
        }
    }

    fn close(&mut self, out: &mut Vec<Action>) {
        self.reset();
        out.push(Action::Close);
    }

    /// The sentence exceeded `max_sentence_ms` without a pause: it is cut at the nearest breath (the window with the
    /// least voice of the last stretch) and the rest is already the next sentence.
    fn cut(&mut self, out: &mut Vec<Action>) {
        let n = self.probs.len();
        let search = ((CUT_SEARCH_MS / WINDOW_MS) as usize).min(n);
        let point = (n - search..n).min_by(|&a, &b| self.probs[a].total_cmp(&self.probs[b])).unwrap_or(n);
        let rest_audio = self.sentence.split_off(point * WINDOW);
        let rest_probs = self.probs.split_off(point);
        out.push(Action::Prepare(std::mem::take(&mut self.sentence)));
        out.push(Action::Close);
        self.sentence = rest_audio;
        self.sure_ms = rest_probs.iter().filter(|&&q| q >= SURE_VOICE_P).count() as f32 * WINDOW_MS;
        self.probs = rest_probs;
        self.silence_ms = 0.0;
        self.prepared = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds the segmenter a sequence of (probability, windows) and collects the actions with the window in which
    /// they came out.
    fn run(cfg: Config, stretches: &[(f32, usize)]) -> Vec<(usize, Action)> {
        let mut s = Segmenter::new(cfg);
        let mut seen = Vec::new();
        let mut i = 0;
        for &(p, n) in stretches {
            for _ in 0..n {
                let mut out = Vec::new();
                s.window(&[0.1; WINDOW], p, &mut out);
                seen.extend(out.into_iter().map(|a| (i, a)));
                i += 1;
            }
        }
        seen
    }

    fn names(v: &[(usize, Action)]) -> Vec<&'static str> {
        v.iter()
            .map(|(_, a)| match a {
                Action::Speaking => "speaking",
                Action::Empty => "empty",
                Action::Prepare(_) => "prepare",
                Action::Resume => "resume",
                Action::Close => "close",
            })
            .collect()
    }

    // 1 window = 32 ms: 20 windows = 640 ms.
    const VOICE: f32 = 0.95;
    const SILENCE: f32 = 0.02;

    #[test]
    fn a_sentence_starts_closes_and_is_transcribed_once() {
        let v = run(Config::default(), &[(SILENCE, 10), (VOICE, 30), (SILENCE, 40)]);
        assert_eq!(names(&v), ["speaking", "prepare", "close"]);
        // speaking after 240 ms of voice (8 windows); prepare after 600 ms of silence (19 windows);
        // close after another 500 ms (16 windows)
        assert_eq!(v[0].0, 10 + 7);
        assert_eq!(v[1].0, 40 + 18);
        assert_eq!(v[2].0, 40 + 18 + 16);
    }

    #[test]
    fn little_tail_silence_is_kept() {
        let v = run(Config::default(), &[(VOICE, 30), (SILENCE, 25)]);
        let Action::Prepare(audio) = &v[1].1 else { panic!("prepare is missing") };
        // 30 windows of voice + 19 of silence (608 ms) minus the 150 ms tail (not beyond the silence samples)
        let silence = 19 * WINDOW;
        let cut = ((19.0 * WINDOW_MS - 150.0) * 16.0) as usize;
        assert_eq!(audio.len(), 30 * WINDOW + silence - cut);
    }

    #[test]
    fn whoever_resumes_within_continue_ms_continues_the_same_sentence() {
        let v = run(Config::default(), &[(VOICE, 30), (SILENCE, 22), (VOICE, 20), (SILENCE, 40)]);
        assert_eq!(names(&v), ["speaking", "prepare", "resume", "prepare", "close"]);
    }

    #[test]
    fn a_short_noise_is_not_transcribed() {
        // 8 windows above the threshold but below sure voice (0.85): it passes the start, not the sure voice
        let v = run(Config::default(), &[(0.6, 8), (SILENCE, 40)]);
        assert_eq!(names(&v), ["speaking", "empty"]);
    }

    #[test]
    fn a_click_below_the_start_does_not_even_make_it_begin() {
        let v = run(Config::default(), &[(VOICE, 3), (SILENCE, 60)]);
        assert!(v.is_empty());
    }

    #[test]
    fn silence_does_nothing() {
        assert!(run(Config::default(), &[(SILENCE, 500)]).is_empty());
    }

    #[test]
    fn a_short_gap_does_not_break_the_start() {
        // voice, a gap of 3 windows (96 ms, under 100 ms), voice: the start counts 4+4 windows
        let v = run(Config::default(), &[(VOICE, 4), (SILENCE, 3), (VOICE, 4), (SILENCE, 40)]);
        assert_eq!(names(&v), ["speaking", "prepare", "close"]);
    }

    #[test]
    fn a_too_long_sentence_is_cut_at_the_breath() {
        let mut cfg = Config::default();
        cfg.max_sentence_ms = 4000.0;
        // 100 windows of voice (3.2 s), a breath (p 0.6) of one window, 40 of voice: the cut falls on the breath
        let v = run(cfg, &[(VOICE, 100), (0.6, 1), (VOICE, 40), (SILENCE, 40)]);
        assert_eq!(names(&v), ["speaking", "prepare", "close", "prepare", "close"]);
        let Action::Prepare(first) = &v[1].1 else { panic!() };
        // the cut is at the lowest point: the breath is window 100
        assert_eq!(first.len(), 100 * WINDOW);
    }

    #[test]
    fn close_now_gives_the_audio_if_there_is_voice_and_nothing_if_it_is_noise() {
        let mut s = Segmenter::new(Config::default());
        let mut out = Vec::new();
        for _ in 0..20 {
            s.window(&[0.1; WINDOW], VOICE, &mut out);
        }
        assert!(s.speaking());
        assert_eq!(s.close_now().unwrap().len(), 20 * WINDOW);
        assert!(!s.speaking());

        let mut s = Segmenter::new(Config::default());
        for _ in 0..8 {
            s.window(&[0.1; WINDOW], 0.6, &mut out);
        }
        assert!(s.speaking());
        assert!(s.close_now().is_none());
    }
}
