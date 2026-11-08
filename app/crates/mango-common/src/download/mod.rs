//! Downloading engines and models: one file at a time with resume from a partial one, hash (sha256) check and
//! atomic rename; on top, `install_engine` and `install_model`, which know what to download from the catalog
//! (`mango-engines.json`, `mango-models.json`).

pub mod hugging_face;
mod model;
mod engine;
#[cfg(test)]
mod fake_server;

pub use model::install_model;
pub use engine::{engine_size, install_engine, installed_engine};

use crate::tr;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A file to download. `size` and `sha256` come from the catalog and are valid for that version of the file
/// only: the URL must point to a fixed tag or revision.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RemoteFile {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// How often `download` calls the progress callback: one block every so often, not every read.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// How long to wait for a block of data before considering the network stalled.
const MAX_WAIT: Duration = Duration::from_secs(60);

/// How much stays free beyond the file, so the disk isn't left full when the download ends.
const MARGIN: u64 = 1 << 30;

/// A clear error, before starting, if the disk of `dir` can't hold `needed` bytes (plus the margin).
fn enough_space(needed: u64, free: u64, dir: &Path) -> Result<()> {
    let gb = |b: u64| b as f64 / (1u64 << 30) as f64;
    if free < needed + MARGIN {
        bail!(
            "{}",
            tr!(
                "sul disco di {} non c'è spazio: servono {:.1} GB (più 1 GB di margine), liberi {:.1} GB. Libera spazio e riprova.",
                "not enough space on the disk of {}: {:.1} GB needed (plus 1 GB of margin), {:.1} GB free. Free some space and try again.",
                dir.display(),
                gb(needed),
                gb(free)
            )
        );
    }
    Ok(())
}

/// The free bytes on the disk of `dir` for this user.
fn free_space(dir: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let w: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        bail!(
            "{}",
            tr!(
                "non riesco a sapere quanto spazio c'è sul disco di {}: {}",
                "can't tell how much space there is on the disk of {}: {}",
                dir.display(),
                std::io::Error::last_os_error()
            )
        );
    }
    Ok(free)
}

/// Downloads `f` to `dest`. A `<dest>.part` left by an interrupted attempt resumes from where it was; once the
/// file is whole the hash must match, and only then does the `.part` take the name `dest` (atomic rename: either
/// the right file is there, or it isn't). A file that is wrong in size or hash is discarded; one interrupted by
/// the network stays, to be resumed.
/// `progress(downloaded, total)` starts from the point already reached and ends with `(size, size)`.
pub fn download(f: &RemoteFile, dest: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    download_with_timeout(f, dest, MAX_WAIT, progress)
}

fn download_with_timeout(f: &RemoteFile, dest: &Path, max_wait: Duration, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let expected = f.sha256.to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!(
            "{}",
            tr!(
                "{name}: nel catalogo manca l'impronta sha256 di {} (valore «{}»)",
                "{name}: the catalog has no sha256 hash for {} (value «{}»)",
                f.url,
                f.sha256
            )
        );
    }
    if f.size == 0 {
        bail!("{}", tr!("{name}: nel catalogo manca la dimensione di {}", "{name}: the catalog has no size for {}", f.url));
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).with_context(|| tr!("non riesco a creare {}", "can't create {}", dir.display()))?;
    }
    let part = part_path(dest);
    let mut hasher = Sha256::new();
    let mut done = fs::metadata(&part).map_or(0, |m| m.len());
    if done > f.size {
        fs::remove_file(&part)?;
        done = 0;
    }
    if done > 0 {
        hash_first_bytes(&part, done, &mut hasher)?;
    }
    progress(done, f.size);

    if done < f.size {
        if let Some(dir) = dest.parent() {
            enough_space(f.size - done, free_space(dir)?, dir)?;
        }
        let resp = request(f, done, max_wait)
            .with_context(|| tr!("{name}: scaricamento da {} fallito", "{name}: download from {} failed", f.url))?;
        // 206 = the server resumes from `done`; 200 = it ignores the range and sends everything again
        let resumes = done > 0 && resp.status().as_u16() == 206;
        let mut out = if resumes {
            OpenOptions::new().append(true).open(&part)?
        } else {
            hasher = Sha256::new();
            done = 0;
            File::create(&part)?
        };
        let mut body = resp.into_body().into_reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut last = Instant::now();
        loop {
            let n = match body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    out.flush()?;
                    let silent = matches!(
                        e.get_ref().and_then(|i| i.downcast_ref::<ureq::Error>()),
                        Some(ureq::Error::Timeout(ureq::Timeout::PerRead))
                    );
                    if silent {
                        bail!(
                            "{}",
                            tr!(
                                "{name}: nessun dato dalla rete da {} s, dopo {done} byte su {}; controlla la connessione, riprovando riparte da lì",
                                "{name}: no data from the network for {} s, after {done} bytes of {}; check the connection, trying again resumes from there",
                                max_wait.as_secs_f64(),
                                f.size
                            )
                        );
                    }
                    bail!(
                        "{}",
                        tr!(
                            "{name}: connessione interrotta dopo {done} byte su {} ({e}); riprovando riparte da lì",
                            "{name}: connection interrupted after {done} bytes of {} ({e}); trying again resumes from there",
                            f.size
                        )
                    );
                }
            };
            out.write_all(&buf[..n])?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if done > f.size {
                drop(out);
                fs::remove_file(&part)?;
                bail!(
                    "{}",
                    tr!(
                        "{name}: il server manda più byte dei {} che dice il catalogo; file scartato",
                        "{name}: the server sends more bytes than the {} the catalog says; file discarded",
                        f.size
                    )
                );
            }
            if last.elapsed() >= PROGRESS_INTERVAL {
                progress(done, f.size);
                last = Instant::now();
            }
        }
        out.sync_all()?;
        if done < f.size {
            bail!(
                "{}",
                tr!(
                    "{name}: il server ha chiuso dopo {done} byte su {}; riprovando riparte da lì",
                    "{name}: the server closed after {done} bytes of {}; trying again resumes from there",
                    f.size
                )
            );
        }
    }
    progress(f.size, f.size);

    let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        // a wrong partial is not resumed: it's thrown away, the next attempt starts clean
        fs::remove_file(&part)?;
        bail!(
            "{}",
            tr!(
                "{name}: impronta sha256 {actual} diversa da quella del catalogo {expected}; file scartato",
                "{name}: sha256 hash {actual} differs from the catalog's {expected}; file discarded"
            )
        );
    }
    fs::rename(&part, dest).with_context(|| tr!("non riesco a rinominare {} in {}", "can't rename {} to {}", part.display(), dest.display()))
}

/// Hex sha256 of a file, read in blocks.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path).with_context(|| tr!("non riesco ad aprire {}", "can't open {}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn part_path(dest: &Path) -> PathBuf {
    with_suffix(dest, ".part")
}

/// The path with `suffix` attached to the whole name (`with_extension` would cut a name with a dot, like a
/// `v0.9.0` version).
fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s: OsString = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn hash_first_bytes(path: &Path, count: u64, hasher: &mut Sha256) -> Result<()> {
    let mut f = File::open(path)?.take(count);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        hasher.update(&buf[..n]);
    }
}

/// The HTTP request, with the range if resuming; status errors made readable.
fn request(f: &RemoteFile, from: u64, max_wait: Duration) -> Result<ureq::http::Response<ureq::Body>> {
    let mut req = http_agent(Some(max_wait)).get(&f.url);
    if from > 0 {
        req = req.header("Range", format!("bytes={from}-"));
    }
    if let Some(token) = hugging_face_token(&f.url) {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    match req.call() {
        Ok(r) => Ok(r),
        Err(ureq::Error::StatusCode(c @ (401 | 403))) if f.url.starts_with(HF) => bail!(
            "{}",
            tr!(
                "il server risponde {c}: il repo è protetto; accetta i termini sulla sua pagina su Hugging Face \
                 e salva il tuo token in «Altri modelli» (o mettilo in HF_TOKEN, o in %USERPROFILE%\\.cache\\huggingface\\token)",
                "the server answers {c}: the repo is gated; accept its terms on its Hugging Face page \
                 and save your token in «Other models» (or put it in HF_TOKEN, or in %USERPROFILE%\\.cache\\huggingface\\token)"
            )
        ),
        Err(ureq::Error::StatusCode(c)) => bail!("{}", tr!("il server risponde {c}", "the server answers {c}")),
        Err(e) => bail!("{}", tr!("rete: {e}", "network: {e}")),
    }
}

/// The HTTP client for downloads and Hugging Face calls. `max_wait`: how long the server may stay silent between
/// one block and the next (an 18 GB file has no sensible total time).
fn http_agent(max_wait: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_per_read(max_wait)
        .build()
        .into()
}

const HF: &str = "https://huggingface.co/";

/// Where the Hugging Face token is saved in the Credential Manager.
pub const HF_CREDENTIAL: &str = "HF_TOKEN";

/// The Hugging Face token, only for Hugging Face URLs (gated repos ask for it): `HF_TOKEN`, the one the app saved
/// in the Credential Manager, or the file `hf auth login` writes.
fn hugging_face_token(url: &str) -> Option<String> {
    if !url.starts_with(HF) {
        return None;
    }
    let t = std::env::var("HF_TOKEN").ok().or_else(|| crate::credentials::read(HF_CREDENTIAL).ok().flatten()).or_else(|| {
        let home = std::env::var_os("USERPROFILE")?;
        fs::read_to_string(PathBuf::from(home).join(".cache").join("huggingface").join("token")).ok()
    })?;
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::fake_server::{FakeServer, Route};
    use super::*;

    #[test]
    fn without_disk_space_the_error_says_so_before_starting() {
        let d = Path::new(r"C:\models");
        assert!(enough_space(10 << 30, 12 << 30, d).is_ok());
        let e = enough_space(10 << 30, (10 << 30) + 100, d).unwrap_err().to_string();
        assert!(e.contains(&tr!("non c'è spazio", "not enough space")) && e.contains("10.0 GB") && e.contains(r"C:\models"), "{e}");
        assert!(free_space(&std::env::temp_dir()).unwrap() > 0);
    }

    fn data(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn sha(d: &[u8]) -> String {
        Sha256::digest(d).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn remote(s: &FakeServer, path: &str, d: &[u8]) -> RemoteFile {
        RemoteFile { url: format!("{}{path}", s.url), size: d.len() as u64, sha256: sha(d) }
    }

    /// The "N bytes of M" fragment of the messages, in the current language.
    fn bytes_of(n: u64, total: u64) -> String {
        tr!("{n} byte su {total}", "{n} bytes of {total}")
    }

    #[test]
    fn downloads_a_whole_file_with_progress() {
        let d = data(3_000_000);
        let s = FakeServer::start([("/f.bin", Route::file(d.clone()))]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("sub").join("f.bin");

        let mut seen = Vec::new();
        download(&f, &dest, &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), d);
        assert!(!part_path(&dest).exists());
        assert_eq!(seen.first(), Some(&(0, 3_000_000)));
        assert_eq!(seen.last(), Some(&(3_000_000, 3_000_000)));
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
    }

    #[test]
    fn resumes_after_an_interruption() {
        let d = data(2_000_000);
        let mut v = Route::file(d.clone());
        v.interrupt_at = Some(700_000);
        let s = FakeServer::start([("/f.bin", v)]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");

        let err = download(&f, &dest, &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains(&bytes_of(700_000, 2_000_000)), "{err}");
        assert!(!dest.exists());
        assert_eq!(fs::metadata(part_path(&dest)).unwrap().len(), 700_000);

        s.set("/f.bin", Route::file(d.clone()));
        let mut first = None;
        download(&f, &dest, &mut |a, _| {
            first.get_or_insert(a);
        })
        .unwrap();

        assert_eq!(first, Some(700_000), "progress must start from the point reached");
        assert_eq!(fs::read(&dest).unwrap(), d);
        assert!(!part_path(&dest).exists());
        let r = s.requests();
        assert_eq!(r.last().unwrap().range.as_deref(), Some("bytes=700000-"));
    }

    #[test]
    fn a_stalled_network_does_not_block_and_the_resume_restarts_from_the_point_reached() {
        let d = data(2_000_000);
        let mut v = Route::file(d.clone());
        v.stall_at = Some(700_000);
        let s = FakeServer::start([("/f.bin", v)]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");

        // the server neither closes nor sends more: only the maximum wait can end the call
        let err = download_with_timeout(&f, &dest, Duration::from_secs(1), &mut |_, _| {}).unwrap_err().to_string();

        // the server holds back the last piece until it closes: the partial is at most 700000
        let partial = fs::metadata(part_path(&dest)).unwrap().len();
        assert!(partial <= 700_000, "{partial}");
        assert!(err.contains(&tr!("nessun dato", "no data")) && err.contains(&bytes_of(partial, 2_000_000)), "{err}");

        s.release();
        s.set("/f.bin", Route::file(d.clone()));
        download(&f, &dest, &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), d);
        assert_eq!(s.requests().last().unwrap().range, Some(format!("bytes={partial}-")));
    }

    #[test]
    fn if_the_server_ignores_the_range_it_restarts_from_scratch() {
        let d = data(1_000_000);
        let mut v = Route::file(d.clone());
        v.ignore_range = true;
        let s = FakeServer::start([("/f.bin", v)]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");
        fs::write(part_path(&dest), &d[..400_000]).unwrap();

        download(&f, &dest, &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), d);
    }

    #[test]
    fn an_already_whole_partial_is_verified_without_the_network() {
        let d = data(500_000);
        let s = FakeServer::start([]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");
        fs::write(part_path(&dest), &d).unwrap();

        download(&f, &dest, &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), d);
        assert!(s.requests().is_empty());
    }

    #[test]
    fn a_different_hash_discards_the_file() {
        let d = data(800_000);
        let mut bad = d.clone();
        bad[1234] ^= 0xff;
        let s = FakeServer::start([("/f.bin", Route::file(bad))]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");

        let err = download(&f, &dest, &mut |_, _| {}).unwrap_err().to_string();

        assert!(err.contains(&tr!("impronta", "hash")), "{err}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists(), "the wrong partial must be removed");
    }

    #[test]
    fn a_corrupt_partial_is_discarded_after_the_resume() {
        let d = data(900_000);
        let s = FakeServer::start([("/f.bin", Route::file(d.clone()))]);
        let f = remote(&s, "/f.bin", &d);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("f.bin");
        let mut p = d[..300_000].to_vec();
        p[10] ^= 1;
        fs::write(part_path(&dest), &p).unwrap();

        let err = download(&f, &dest, &mut |_, _| {}).unwrap_err().to_string();

        assert!(err.contains(&tr!("impronta", "hash")), "{err}");
        assert!(!part_path(&dest).exists());
        // the next attempt starts clean and succeeds
        download(&f, &dest, &mut |_, _| {}).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), d);
    }

    #[test]
    fn size_different_from_the_catalog() {
        let d = data(600_000);
        let s = FakeServer::start([("/f.bin", Route::file(d.clone()))]);
        let tmp = tempfile::tempdir().unwrap();

        // the server has fewer bytes: the error says so and the partial stays to resume
        let mut f = remote(&s, "/f.bin", &d);
        f.size += 1000;
        let dest = tmp.path().join("less.bin");
        let err = download(&f, &dest, &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains(&tr!("chiuso dopo 600000 byte su 601000", "closed after 600000 bytes of 601000")), "{err}");

        // the server has more bytes: file discarded
        let mut f = remote(&s, "/f.bin", &d);
        f.size -= 1000;
        let dest = tmp.path().join("more.bin");
        let err = download(&f, &dest, &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains(&tr!("più byte", "more bytes")), "{err}");
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[test]
    fn network_and_status_errors_are_clear() {
        let d = data(1000);
        let s = FakeServer::start([]);
        let tmp = tempfile::tempdir().unwrap();

        let dest = tmp.path().join("x.bin");
        let err = format!("{:#}", download(&remote(&s, "/missing.bin", &d), &dest, &mut |_, _| {}).unwrap_err());
        assert!(err.contains("404") && err.contains("/missing.bin"), "{err}");
        assert!(!dest.exists() && !part_path(&dest).exists());

        // nobody is listening: a network error, not an 'empty file'
        let closed_port = RemoteFile { url: "http://127.0.0.1:1/x.bin".into(), size: 1000, sha256: sha(&d) };
        let err = format!("{:#}", download(&closed_port, &dest, &mut |_, _| {}).unwrap_err());
        assert!(err.contains(&tr!("rete", "network")), "{err}");
    }

    #[test]
    fn without_hash_or_size_in_the_catalog_it_does_not_download() {
        let s = FakeServer::start([]);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("x.bin");
        let no_sha = RemoteFile { url: format!("{}/x", s.url), size: 10, sha256: String::new() };
        let err = download(&no_sha, &dest, &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains(&tr!("impronta", "hash")), "{err}");
        let no_size = RemoteFile { url: format!("{}/x", s.url), size: 0, sha256: sha(b"") };
        let err = download(&no_size, &dest, &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains(&tr!("dimensione", "size")), "{err}");
        assert!(s.requests().is_empty());
    }
}
