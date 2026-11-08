//! Installing engines (llama.cpp and our forks) from the `mango-engines.json` catalog:
//! `<engines>/<engine>/<version>-<build>/llama-server.exe`.

use super::{download, with_suffix, RemoteFile};
use crate::{tr, Build, Paths};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const EXE: &str = "llama-server.exe";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct Engine {
    version: String,
    /// `false` for the engine that can't list GPUs (`--list-devices`): for CUDA it's enough that it starts.
    #[serde(default = "default_true")]
    gpu_check: bool,
    build: BTreeMap<String, EngineBuild>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct EngineBuild {
    #[serde(flatten)]
    file: RemoteFile,
    /// The CUDA libraries, to add only if the PC lacks them.
    runtime: Option<RemoteFile>,
}

fn catalog(paths: &Paths) -> Result<BTreeMap<String, Engine>> {
    let f = paths.dist.join("mango-engines.json");
    let text = fs::read_to_string(&f).with_context(|| tr!("non riesco a leggere {}", "can't read {}", f.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).with_context(|| tr!("{} non è valido", "{} is not valid", f.display()))
}

fn engine_dir(paths: &Paths, engine: &str, m: &Engine, build: Build) -> PathBuf {
    paths.engines.join(engine).join(format!("{}-{build}", m.version))
}

/// The folder with `llama-server.exe` for this engine and build, if it's already there: the downloaded one of the
/// catalog's version, or (only for CUDA 12, as `setup.ps1` builds them) the old `<engines>\<engine>` of
/// development from source.
pub fn installed_engine(paths: &Paths, engine: &str, build: Build) -> Option<PathBuf> {
    if let Some(m) = catalog(paths).ok().and_then(|mut c| c.remove(engine)) {
        let d = engine_dir(paths, engine, &m, build);
        if d.join(EXE).is_file() {
            return Some(d);
        }
    }
    let old = paths.engines.join(engine);
    (build == Build::Cuda12 && old.join(EXE).is_file()).then_some(old)
}

/// Downloads the build from the catalog, extracts it into `<engines>/<engine>/<version>-<build>/` and checks that
/// `llama-server.exe --version` starts (and, for CUDA, that it sees a GPU); only then does the folder appear. For
/// CUDA it adds the runtime libraries if the PC lacks them. Already installed = no download.
/// `progress(downloaded, total)` counts the bytes of all files.
pub fn install_engine(paths: &Paths, engine: &str, build: Build, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf> {
    install_with(paths, engine, build, &std::env::var_os("PATH").unwrap_or_default(), check_engine, progress)
}

/// How many bytes are left to download to have the engine: 0 if it's already installed; for CUDA the runtime counts
/// only if the PC lacks it.
pub fn engine_size(paths: &Paths, engine: &str, build: Build) -> Result<u64> {
    size_with(paths, engine, build, &std::env::var_os("PATH").unwrap_or_default())
}

fn size_with(paths: &Paths, engine: &str, build: Build, path: &std::ffi::OsStr) -> Result<u64> {
    if installed_engine(paths, engine, build).is_some() {
        return Ok(0);
    }
    let (_, b, runtime) = to_download(paths, engine, build, path)?;
    Ok(b.file.size + runtime.map_or(0, |r| r.size))
}

/// The catalog entry for `engine` and `build`, and the CUDA runtime to add if the PC lacks it.
fn to_download(paths: &Paths, engine: &str, build: Build, path: &std::ffi::OsStr) -> Result<(Engine, EngineBuild, Option<RemoteFile>)> {
    let mut cat = catalog(paths)?;
    let mut m = cat
        .remove(engine)
        .with_context(|| tr!("il motore «{engine}» non è nel catalogo dei motori", "the engine «{engine}» is not in the engine catalog"))?;
    let b = m.build.remove(build.as_str()).with_context(|| {
        let available: Vec<&str> = m.build.keys().map(String::as_str).collect();
        let available = available.join(", ");
        tr!(
            "il motore «{engine}» non ha una build «{build}» nel catalogo (ci sono: {available})",
            "the engine «{engine}» has no «{build}» build in the catalog (available: {available})"
        )
    })?;
    let runtime = match (&b.runtime, build.cuda_major()) {
        (Some(r), Some(major)) if !cuda_runtime_present(major, path) => Some(r.clone()),
        _ => None,
    };
    Ok((m, b, runtime))
}

/// `install_engine` with the PATH and the final check chosen by the caller (tests have no real engine nor its
/// GPUs).
fn install_with(
    paths: &Paths,
    engine: &str,
    build: Build,
    path: &std::ffi::OsStr,
    check: fn(&Path, Build, bool) -> Result<()>,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf> {
    if let Some(d) = installed_engine(paths, engine, build) {
        return Ok(d);
    }
    let (m, b, runtime) = to_download(paths, engine, build, path)?;
    let runtime = runtime.as_ref();

    let dest = engine_dir(paths, engine, &m, build);
    let work = paths.engines.join(engine).join(".download");
    let temp = with_suffix(&dest, ".tmp");
    let total = b.file.size + runtime.map_or(0, |r| r.size);
    let mut zips = vec![(&b.file, 0u64)];
    zips.extend(runtime.map(|r| (r, b.file.size)));

    if temp.exists() {
        fs::remove_dir_all(&temp)?;
    }
    for (f, before) in &zips {
        download(f, &work.join(file_name(&f.url)?), &mut |done, _| progress(before + done, total))?;
    }
    let r = (|| -> Result<()> {
        for (f, _) in &zips {
            extract(&work.join(file_name(&f.url)?), &temp)?;
        }
        check(&temp, build, m.gpu_check).with_context(|| {
            tr!(
                "il motore «{engine}» ({build}) scaricato non è utilizzabile su questo PC",
                "the downloaded engine «{engine}» ({build}) is not usable on this PC"
            )
        })?;
        fs::rename(&temp, &dest).with_context(|| tr!("non riesco a creare {}", "can't create {}", dest.display()))
    })();
    // the zips have done their job, either way; the half-built folder hasn't
    for (f, _) in &zips {
        fs::remove_file(work.join(file_name(&f.url)?))?;
    }
    let _ = fs::remove_dir(&work);
    if let Err(e) = r {
        let _ = fs::remove_dir_all(&temp);
        return Err(e);
    }
    Ok(dest)
}

fn file_name(url: &str) -> Result<&str> {
    url.rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .with_context(|| tr!("l'URL {url} non finisce con un nome di file", "the URL {url} doesn't end with a file name"))
}

/// `true` if a folder in the PATH (where the Windows loader looks for DLLs) has all the CUDA runtime libraries of
/// that major version. `CUDA_PATH` doesn't count: if its `bin` isn't in the PATH, the engine wouldn't find the DLLs
/// anyway.
fn cuda_runtime_present(major: u32, path: &std::ffi::OsStr) -> bool {
    let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    [format!("cudart64_{major}.dll"), format!("cublas64_{major}.dll"), format!("cublasLt64_{major}.dll")]
        .iter()
        .all(|dll| dirs.iter().any(|d| d.join(dll).is_file()))
}

/// Extracts a zip into `dest`, refusing paths that escape the folder.
fn extract(zip: &Path, dest: &Path) -> Result<()> {
    let f = File::open(zip).with_context(|| tr!("non riesco ad aprire {}", "can't open {}", zip.display()))?;
    let mut a = zip::ZipArchive::new(BufReader::new(f)).with_context(|| tr!("{} non è uno zip valido", "{} is not a valid zip", zip.display()))?;
    for i in 0..a.len() {
        let mut e = a.by_index(i)?;
        let Some(rel) = e.enclosed_name() else {
            bail!("{}", tr!("{}: percorso non ammesso nello zip: {:?}", "{}: path not allowed in the zip: {:?}", zip.display(), e.name()))
        };
        let out = dest.join(rel);
        if e.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p)?;
        }
        io::copy(&mut e, &mut File::create(&out)?).with_context(|| tr!("estrazione di {} fallita", "extracting {} failed", out.display()))?;
    }
    Ok(())
}

/// The engine must start (`--version`); a CUDA build must also see a GPU (`--list-devices`): with a driver too old
/// for that CUDA the engine starts anyway and then runs on the CPU, silently. `gpu_check` is the engine's in the
/// catalog: ik_llama.cpp (`toq`) has no `--list-devices` and would exit with an error.
fn check_engine(dir: &Path, build: Build, gpu_check: bool) -> Result<()> {
    run(dir, "--version")?;
    if gpu_check && build.cuda_major().is_some() {
        let (gpus, messages) = run(dir, "--list-devices")?;
        if !lists_gpus(&gpus) {
            bail!(
                "{}",
                tr!(
                    "il motore parte ma non vede nessuna scheda: il driver NVIDIA di questo PC è troppo vecchio per la build {build}? ({})",
                    "the engine starts but sees no GPU: is this PC's NVIDIA driver too old for the {build} build? ({})",
                    messages.trim()
                )
            );
        }
    }
    Ok(())
}

/// `true` if the output of `--list-devices` lists at least one device (after `Available devices:`, one line per
/// device, or `(none)`).
fn lists_gpus(output: &str) -> bool {
    output
        .lines()
        .skip_while(|l| !l.starts_with("Available devices:"))
        .skip(1)
        .any(|l| !l.trim().is_empty() && l.trim() != "(none)")
}

/// Launches `llama-server.exe <arg>` in the folder and wants exit 0 within the time; returns what it wrote on
/// stdout and on stderr. If it fails, the error reports what it wrote.
fn run(dir: &Path, arg: &str) -> Result<(String, String)> {
    let exe = dir.join(EXE);
    if !exe.is_file() {
        bail!("{}", tr!("nello zip non c'è {EXE}", "{EXE} is not in the zip"));
    }
    let (f_out, f_err) = (dir.join(".stdout.txt"), dir.join(".stderr.txt"));
    let mut cmd = Command::new(&exe);
    cmd.arg(arg).current_dir(dir).stdin(Stdio::null()).stdout(File::create(&f_out)?).stderr(File::create(&f_err)?);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().with_context(|| tr!("non riesco a lanciare {}", "can't launch {}", exe.display()))?;
    drop(cmd); // closes our handles on the output files, so they can be deleted
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() > COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{}", tr!("{EXE} {arg} non risponde entro {} s", "{EXE} {arg} does not answer within {} s", COMMAND_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let read = |f: &Path| -> Result<String> {
        let t = String::from_utf8_lossy(&fs::read(f)?).into_owned();
        fs::remove_file(f)?;
        Ok(t)
    };
    let (out, err) = (read(&f_out)?, read(&f_err)?);
    if !status.success() {
        bail!("{}", tr!("{EXE} {arg} è uscito con {status}: {}{}", "{EXE} {arg} exited with {status}: {}{}", out.trim(), err.trim()));
    }
    Ok((out, err))
}

#[cfg(test)]
mod tests {
    use super::super::fake_server::{FakeServer, Route};
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::OsString;
    use std::io::Write;

    fn sha(d: &[u8]) -> String {
        Sha256::digest(d).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A zip with these files (`(name, bytes)`), uncompressed.
    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    /// A system executable that exits 0 with `--version` (curl) and one that exits 1 (hostname): they stand in for
    /// `llama-server.exe` to test the installation without a real engine.
    fn system_exe(name: &str) -> Vec<u8> {
        let root = std::env::var_os("SystemRoot").expect("SystemRoot");
        fs::read(PathBuf::from(root).join("System32").join(name)).unwrap()
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        paths: Paths,
        s: FakeServer,
    }

    /// A server with the given zips (`(path, zip)`) and a `mango-engines.json` catalog describing them:
    /// `build` = `(engine, build name, zip path, runtime zip path)`.
    fn fixture(zips: &[(&str, &[u8])], build: &[(&str, &str, &str, Option<&str>)]) -> Fixture {
        let s = FakeServer::start([]);
        for (p, z) in zips {
            s.set(p, Route::file(z.to_vec()));
        }
        let file = |p: &str| {
            let z = zips.iter().find(|(q, _)| *q == p).unwrap().1;
            serde_json::json!({ "url": format!("{}{p}", s.url), "size": z.len(), "sha256": sha(z) })
        };
        let mut cat = serde_json::Map::new();
        for (engine, name, p, rt) in build {
            let m = cat.entry(engine.to_string()).or_insert(serde_json::json!({ "version": "v1.2.3", "build": {} }));
            let mut b = file(p);
            if let Some(rt) = rt {
                b["runtime"] = file(rt);
            }
            m["build"][name] = b;
        }
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("dist")).unwrap();
        fs::write(tmp.path().join("dist/mango-engines.json"), serde_json::to_string(&cat).unwrap()).unwrap();
        let paths = Paths { dist: tmp.path().join("dist"), engines: tmp.path().join("engines"), models: tmp.path().join("m"), opencode: tmp.path().join("oc"), data: tmp.path().join("d") };
        Fixture { _tmp: tmp, paths, s }
    }

    /// In tests the check is only `--version`: the system executable standing in for the engine lists no GPUs.
    fn version_only(dir: &Path, _: Build, _: bool) -> Result<()> {
        run(dir, "--version").map(|_| ())
    }

    fn install(paths: &Paths, engine: &str, build: Build, path: &std::ffi::OsStr, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf> {
        install_with(paths, engine, build, path, version_only, progress)
    }

    fn no_cuda() -> OsString {
        OsString::new()
    }

    #[test]
    fn installs_extracts_verifies_and_cleans_up() {
        let z = zip(&[("llama-server.exe", &system_exe("curl.exe")), ("sub/folder/x.dll", b"dll")]);
        let p = fixture(&[("/cpu.zip", &z)], &[("llamacpp", "cpu", "/cpu.zip", None)]);
        assert_eq!(installed_engine(&p.paths, "llamacpp", Build::Cpu), None);

        let mut seen = Vec::new();
        let dir = install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |a, t| seen.push((a, t))).unwrap();

        assert_eq!(dir, p.paths.engines.join("llamacpp").join("v1.2.3-cpu"));
        assert!(dir.join("llama-server.exe").is_file());
        assert_eq!(fs::read(dir.join("sub/folder/x.dll")).unwrap(), b"dll");
        let sz = z.len() as u64;
        assert_eq!(seen.last(), Some(&(sz, sz)));
        let left: Vec<_> = fs::read_dir(p.paths.engines.join("llamacpp")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["v1.2.3-cpu"], "no zips or temporary folders");
        assert_eq!(installed_engine(&p.paths, "llamacpp", Build::Cpu), Some(dir.clone()));
        assert_eq!(installed_engine(&p.paths, "llamacpp", Build::Vulkan), None);

        // already installed: no requests
        assert_eq!(install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |_, _| {}).unwrap(), dir);
        assert_eq!(p.s.requests().len(), 1);
    }

    #[test]
    fn cuda_downloads_the_runtime_only_if_it_is_missing_from_the_path() {
        let server = zip(&[("llama-server.exe", &system_exe("curl.exe")), ("ggml-cuda.dll", b"cuda")]);
        let rt = zip(&[("cudart64_12.dll", b"a"), ("cublas64_12.dll", b"b"), ("cublasLt64_12.dll", b"c")]);
        let build = [("llamacpp", "cuda-12", "/c12.zip", Some("/rt12.zip"))];
        let zips: [(&str, &[u8]); 2] = [("/c12.zip", &server), ("/rt12.zip", &rt)];

        // the PATH lacks the libraries: they are downloaded and end up next to the engine
        let p = fixture(&zips, &build);
        let mut seen = Vec::new();
        let dir = install(&p.paths, "llamacpp", Build::Cuda12, &no_cuda(), &mut |a, t| seen.push((a, t))).unwrap();
        assert_eq!(p.s.requests().len(), 2);
        assert!(dir.join("cudart64_12.dll").is_file() && dir.join("cublasLt64_12.dll").is_file());
        let tot = (server.len() + rt.len()) as u64;
        assert_eq!(seen.last(), Some(&(tot, tot)));

        // the PATH already has them: only the build
        let on_pc = tempfile::tempdir().unwrap();
        for dll in ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"] {
            fs::write(on_pc.path().join(dll), b"x").unwrap();
        }
        let p = fixture(&zips, &build);
        let path = std::env::join_paths([on_pc.path()]).unwrap();
        let dir = install(&p.paths, "llamacpp", Build::Cuda12, &path, &mut |_, _| {}).unwrap();
        assert_eq!(p.s.requests().len(), 1);
        assert!(dir.join("llama-server.exe").is_file() && !dir.join("cudart64_12.dll").exists());
    }

    /// How much is left to download: the build, plus the runtime only if missing; zero when the engine is already there.
    #[test]
    fn the_size_to_download_counts_the_runtime_only_if_missing() {
        let server = zip(&[("llama-server.exe", &system_exe("curl.exe"))]);
        let rt = zip(&[("cudart64_12.dll", b"a"), ("cublas64_12.dll", b"b"), ("cublasLt64_12.dll", b"c")]);
        let p = fixture(&[("/c12.zip", &server), ("/rt12.zip", &rt)], &[("llamacpp", "cuda-12", "/c12.zip", Some("/rt12.zip"))]);
        assert_eq!(size_with(&p.paths, "llamacpp", Build::Cuda12, &no_cuda()).unwrap(), (server.len() + rt.len()) as u64);
        let on_pc = tempfile::tempdir().unwrap();
        for dll in ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"] {
            fs::write(on_pc.path().join(dll), b"x").unwrap();
        }
        let path = std::env::join_paths([on_pc.path()]).unwrap();
        assert_eq!(size_with(&p.paths, "llamacpp", Build::Cuda12, &path).unwrap(), server.len() as u64);
        install(&p.paths, "llamacpp", Build::Cuda12, &path, &mut |_, _| {}).unwrap();
        assert_eq!(size_with(&p.paths, "llamacpp", Build::Cuda12, &path).unwrap(), 0);
        assert!(size_with(&p.paths, "llamacpp", Build::Vulkan, &path).unwrap_err().to_string().contains(&tr!("non ha una build «vulkan»", "has no «vulkan» build")));
    }

    #[test]
    fn the_runtime_is_looked_up_by_major_version_and_for_all_libraries() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("cudart64_12.dll"), b"x").unwrap();
        fs::write(a.join("cublas64_12.dll"), b"x").unwrap();
        fs::write(b.join("cublasLt64_12.dll"), b"x").unwrap();
        let with_b = std::env::join_paths([&a, &b]).unwrap();
        assert!(cuda_runtime_present(12, &with_b), "the libraries can be in different PATH folders");
        assert!(!cuda_runtime_present(13, &with_b));
        assert!(!cuda_runtime_present(12, a.as_os_str()), "one is missing");
        assert!(!cuda_runtime_present(12, &no_cuda()));
    }

    #[test]
    fn lists_gpus_tells_no_gpu_from_at_least_one() {
        // real output of a CUDA 13 build on a driver that doesn't support it
        assert!(!lists_gpus("Available devices:\r\n  (none)\r\n"));
        assert!(!lists_gpus("Available devices:\n"));
        assert!(!lists_gpus(""));
        assert!(lists_gpus("Available devices:\n  CUDA0: NVIDIA GeForce RTX 3060 Ti (8191 MiB, 7000 MiB free)\n"));
        assert!(lists_gpus("noise\nAvailable devices:\n  Vulkan0: AMD Radeon (8176 MiB, 8000 MiB free)\n  CUDA0: x\n"));
    }

    #[test]
    fn if_the_engine_does_not_start_the_error_says_so_and_nothing_is_left() {
        let z = zip(&[("llama-server.exe", &system_exe("hostname.exe"))]);
        let p = fixture(&[("/cpu.zip", &z)], &[("llamacpp", "cpu", "/cpu.zip", None)]);

        let err = format!("{:#}", install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |_, _| {}).unwrap_err());

        assert!(err.contains(&tr!("non è utilizzabile", "is not usable")) && err.contains("--version"), "{err}");
        assert_eq!(fs::read_dir(p.paths.engines.join("llamacpp")).unwrap().count(), 0);
        assert_eq!(installed_engine(&p.paths, "llamacpp", Build::Cpu), None);
    }

    #[test]
    fn a_zip_without_the_server_or_with_paths_outside_the_folder_is_refused() {
        let without = zip(&[("other.exe", b"x")]);
        let p = fixture(&[("/a.zip", &without)], &[("llamacpp", "cpu", "/a.zip", None)]);
        let err = format!("{:#}", install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |_, _| {}).unwrap_err());
        assert!(err.contains(&tr!("nello zip non c'è llama-server.exe", "llama-server.exe is not in the zip")), "{err}");

        let outside = zip(&[("../evil.txt", b"x")]);
        let p = fixture(&[("/b.zip", &outside)], &[("llamacpp", "cpu", "/b.zip", None)]);
        let err = format!("{:#}", install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |_, _| {}).unwrap_err());
        assert!(err.contains(&tr!("percorso non ammesso", "path not allowed")), "{err}");
        assert!(!p.paths.engines.join("llamacpp").join("evil.txt").exists());
        assert!(!p.paths.engines.join("evil.txt").exists());
    }

    #[test]
    fn a_catalog_without_the_engine_or_the_build_says_what_there_is() {
        let z = zip(&[("llama-server.exe", b"x")]);
        let p = fixture(&[("/a.zip", &z)], &[("prism", "cuda-12", "/a.zip", None)]);

        let err = install(&p.paths, "toq", Build::Cuda12, &no_cuda(), &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("«toq»") && err.contains(&tr!("catalogo", "catalog")), "{err}");
        let err = install(&p.paths, "prism", Build::Vulkan, &no_cuda(), &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("«vulkan»") && err.contains("cuda-12"), "{err}");

        fs::remove_file(p.paths.dist.join("mango-engines.json")).unwrap();
        let err = install(&p.paths, "prism", Build::Cuda12, &no_cuda(), &mut |_, _| {}).unwrap_err().to_string();
        assert!(err.contains("mango-engines.json"), "{err}");
    }

    #[test]
    fn a_wrong_hash_in_the_catalog_does_not_install() {
        let z = zip(&[("llama-server.exe", &system_exe("curl.exe"))]);
        let p = fixture(&[("/a.zip", &z)], &[("llamacpp", "cpu", "/a.zip", None)]);
        let f = p.paths.dist.join("mango-engines.json");
        let cat = fs::read_to_string(&f).unwrap().replace(&sha(&z), &"0".repeat(64));
        fs::write(&f, cat).unwrap();

        let err = format!("{:#}", install(&p.paths, "llamacpp", Build::Cpu, &no_cuda(), &mut |_, _| {}).unwrap_err());

        assert!(err.contains(&tr!("impronta", "hash")), "{err}");
        assert_eq!(installed_engine(&p.paths, "llamacpp", Build::Cpu), None);
    }

    /// The catalog that ships with the app: the `prism` and `toq` engines are there, and each entry is either empty
    /// (zip still to be published) or complete; a half-filled one would download a file that can't be verified.
    #[test]
    fn the_real_catalog_has_empty_or_complete_entries() {
        let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../launcher");
        let paths = Paths { dist, engines: PathBuf::new(), models: PathBuf::new(), opencode: PathBuf::new(), data: PathBuf::new() };
        let cat = catalog(&paths).unwrap();
        for engine in ["llamacpp", "prism", "toq"] {
            let m = &cat[engine];
            assert!(!m.version.is_empty() && !m.build.is_empty(), "{engine}");
            assert_eq!(m.gpu_check, engine != "toq", "{engine}");
            for (name, b) in &m.build {
                for f in std::iter::once(&b.file).chain(&b.runtime) {
                    let empty = f.size == 0 && f.sha256.is_empty();
                    let complete = f.size > 0 && f.sha256.len() == 64 && f.url.starts_with("https://");
                    assert!(empty || complete, "{engine} {name}: {f:?}");
                }
            }
        }
    }

    /// `toq` (ik_llama.cpp) has no `--list-devices`: its catalog says not to ask for it, and the value reaches the
    /// final check. The other engines keep it.
    #[test]
    fn the_gpu_check_follows_the_catalog() {
        static RECEIVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
        fn record(_: &Path, _: Build, gpu_check: bool) -> Result<()> {
            RECEIVED.store(gpu_check, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        let z = zip(&[("llama-server.exe", b"x")]);
        let p = fixture(&[("/a.zip", &z)], &[("toq", "cuda-12", "/a.zip", None)]);
        let f = p.paths.dist.join("mango-engines.json");
        let cat = fs::read_to_string(&f).unwrap().replace(r#""version":"v1.2.3""#, r#""version":"v1.2.3","gpu_check":false"#);
        fs::write(&f, cat).unwrap();

        install_with(&p.paths, "toq", Build::Cuda12, &no_cuda(), record, &mut |_, _| {}).unwrap();

        assert!(!RECEIVED.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn the_old_development_folder_counts_for_cuda_12() {
        let z = zip(&[("llama-server.exe", b"x")]);
        let p = fixture(&[("/a.zip", &z)], &[("prism", "cuda-12", "/a.zip", None)]);
        let old = p.paths.engines.join("prism");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("llama-server.exe"), b"x").unwrap();

        assert_eq!(installed_engine(&p.paths, "prism", Build::Cuda12), Some(old.clone()));
        assert_eq!(installed_engine(&p.paths, "prism", Build::Cpu), None);
        assert_eq!(installed_engine(&p.paths, "toq", Build::Cuda12), None);
        assert_eq!(install(&p.paths, "prism", Build::Cuda12, &no_cuda(), &mut |_, _| {}).unwrap(), old);
        assert!(p.s.requests().is_empty());
    }
}
