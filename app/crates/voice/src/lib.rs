//! Local dictation in Rust (whisper.cpp): the HTTP service the agent server (routes /mango/voice/live) forwards the
//! microphone's audio to. It runs inside the app's process, on a thread of its own.
//!
//! # Model
//! `ggml-small.bin` (multilingual whisper `small`, f16, 465 MiB) plus `ggml-silero-v5.1.2.bin` (VAD, 0.9 MB), in
//! `<models>/whisper/`; they are downloaded with `download`. The `small-q5_1` (181 MiB) isn't faster (the time is
//! dominated by the encoder, which always works on 30 s) and on 16 synthetic Italian clips, with and without noise, it
//! got 31 words wrong out of 296 against the f16's 18 (in one case it truncated the sentence halfway).
//!
//! # To build (Windows)
//! * MSVC (Build Tools with C++), `cmake` and `ninja`, in a prompt with `vcvars64` loaded.
//! * `libclang.dll` for bindgen: `LIBCLANG_PATH` = folder that contains it (LLVM, or the pip `libclang` wheel, which
//!   brings it along).
//! * `CMAKE_GENERATOR=Ninja`: the Visual Studio generator doesn't find cmake 4's compiler.
//! * `GGML_NATIVE=OFF GGML_AVX=ON GGML_AVX2=ON GGML_FMA=ON GGML_F16C=ON` in cargo's environment. Left to itself
//!   (`GGML_NATIVE`), ggml with MSVC picks the instruction sets of the processor that builds: SSE2 where the probe
//!   fails, a third slower, and AVX-512 on a processor that has it, which stops the app with an illegal instruction
//!   everywhere else. The test `compiled_for_avx2_and_nothing_newer` checks both. As a consequence `start` refuses
//!   processors without AVX2.
//! * A `target` folder with a short path: under the 260 characters of MAX_PATH cmake can't launch anything.

mod download;
mod engine;
mod http;
mod live;
mod segmenter;

pub use download::{download, missing_files, ModelFile, FILES};
pub use engine::Settings;
pub use live::LiveConfig;
pub use segmenter::Config as SegmenterConfig;

use anyhow::{bail, Context, Result};
use mango_common::{tr, Paths};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Where the app expects whisper's model (downloaded separately, like the GGUF).
/// The VAD model is in the same folder (`download::FILES`).
pub fn model_path(paths: &Paths) -> PathBuf {
    models_dir(paths).join(download::WHISPER.name)
}

/// The voice models folder, to pass to `missing_files` and `download`.
pub fn models_dir(paths: &Paths) -> PathBuf {
    paths.models.join("whisper")
}

/// Running service; stopped on Drop.
pub struct VoiceServer {
    pub url: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for VoiceServer {
    fn drop(&mut self) {
        // closes the port; a transcription in progress dies with the process
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Opens the port at once and loads the model in the background: until it is ready, `/health` says "loading" and
/// transcriptions wait.
pub fn start(model: &Path, port: u16) -> Result<VoiceServer> {
    let vad = model.with_file_name(download::VAD.name);
    start_with(Settings::new(model, &vad, None), LiveConfig::default(), port)
}

/// Like `start`, with the models and the live dictation parameters chosen by the caller.
pub fn start_with(settings: Settings, live: LiveConfig, port: u16) -> Result<VoiceServer> {
    let model = settings.model.as_path();
    let partial = settings.partial_model.as_deref();
    for f in [Some(model), Some(settings.vad.as_path()), partial].into_iter().flatten() {
        if !f.is_file() {
            bail!("{}", tr!("manca il file {}", "the file {} is missing", f.display()));
        }
    }
    require_cpu_features()?;
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .map_err(|e| anyhow::anyhow!("{}", tr!("porta {port} non disponibile: {e}", "port {port} is not available: {e}")))?;
    let stop = Arc::new(AtomicBool::new(false));
    let engine = engine::Engine::spawn(&settings);
    let live = live::Live::new(engine.clone(), live);
    let name = model.file_name().context("model path without a name")?.to_string_lossy().into_owned();

    let thread = {
        let stop = stop.clone();
        std::thread::Builder::new().name("voice".into()).spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(req)) => {
                        // one thread per request, like ThreadingHTTPServer: /health answers even during a
                        // transcription; the engine serializes them
                        let (engine, live, name) = (engine.clone(), live.clone(), name.clone());
                        std::thread::spawn(move || http::handle(req, &engine, &live, &name));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("[voice] the service stops: {e}");
                        break;
                    }
                }
            }
        })?
    };
    Ok(VoiceServer { url: format!("http://127.0.0.1:{port}"), stop, thread: Some(thread) })
}

/// whisper.cpp is compiled with AVX2/FMA/F16C (see above): on a processor that doesn't have them it would stop with an
/// illegal instruction, so better to say so beforehand.
pub fn require_cpu_features() -> Result<()> {
    #[cfg(target_arch = "x86_64")]
    if !(is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") && is_x86_feature_detected!("f16c")) {
        bail!("{}", tr!("il processore non ha AVX2/FMA: la dettatura locale non è disponibile", "the processor has no AVX2/FMA: local dictation is not available"));
    }
    Ok(())
}
