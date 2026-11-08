//! The voice models (for the guided first run): which they are, where they are on Hugging Face and how they are
//! downloaded (with `mango_common::download`).

use anyhow::Result;
use mango_common::download::RemoteFile;
use std::fs;
use std::path::{Path, PathBuf};

/// A file to download. `size` and `sha256` are the repository's (`lfs.oid` from the Hugging Face API); the URLs point
/// to a fixed revision, so they don't change under our feet.
#[derive(Debug)]
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// Multilingual whisper `small` in f16. Repo `ggerganov/whisper.cpp`, revision 5359861c.
/// The q5_1 (181 MiB) isn't faster and is less accurate: see the choice in `lib.rs`.
pub const WHISPER: ModelFile = ModelFile {
    name: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
    size: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
};

/// Silero VAD in ggml format: removes silences before whisper.
/// Repo `ggml-org/whisper-vad`, revision 9ffd54a1.
pub const VAD: ModelFile = ModelFile {
    name: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin",
    size: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

/// Everything dictation needs on disk, to put in the same folder.
pub const FILES: [&ModelFile; 2] = [&WHISPER, &VAD];

/// The `FILES` that aren't in `dir` or have the wrong size.
pub fn missing_files(dir: &Path) -> Vec<&'static ModelFile> {
    FILES.into_iter().filter(|f| fs::metadata(dir.join(f.name)).map_or(true, |m| m.len() != f.size)).collect()
}

/// Downloads `file` into `dir` and returns its path: resume from a `.part`, hash verification and atomic rename are
/// `mango_common::download`'s.
/// `progress(downloaded, total)` is called at intervals and when the file is done.
pub fn download(file: &ModelFile, dir: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf> {
    let dest = dir.join(file.name);
    let remote = RemoteFile { url: file.url.to_string(), size: file.size, sha256: file.sha256.to_string() };
    mango_common::download::download(&remote, &dest, progress)?;
    Ok(dest)
}
