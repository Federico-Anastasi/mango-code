//! Development tools present on this PC, and the system prompt section that describes them.
//!
//! The model is small and the user may have nothing installed: without this section it would write a Python script
//! that it cannot run. Here we detect what is there (Python, Node, Git, .NET, Java, Rust, Go, winget, Office) with
//! short commands, in parallel, hidden and with a maximum time; the result is saved in `<data>/tools.json`; the text
//! is generated.
//!
//! Two stability rules, because a different system prompt costs a reread of the base:
//! - a check that times out is "uncertain" and keeps the saved value (the text doesn't change);
//! - in the text the versions are short (Python 3.12, not 3.12.4): a minor update doesn't change it.
//!
//! The `bun` command is always available: `bun.cmd` launches `mango-code.exe` (compiled with Bun) with
//! `BUN_BE_BUN=1`, and lives in an app folder put at the head of the agent's `PATH`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Maximum time of each single detection command.
const MAX_TIME: Duration = Duration::from_secs(4);

/// What is on the PC. The `Option<String>` fields are the full version, `None` = not installed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Detection {
    pub python: Option<String>,
    pub node: Option<String>,
    pub git: Option<String>,
    /// Highest SDK version (a runtime without SDK isn't enough to build).
    pub dotnet: Option<String>,
    pub java: Option<String>,
    /// `true` if the compiler (`javac`) is there too: a JRE runs but doesn't compile.
    pub java_jdk: bool,
    pub rust: Option<String>,
    pub go: Option<String>,
    pub winget: Option<String>,
    pub word: bool,
    pub excel: bool,
    pub powerpoint: bool,
}

/// Outcome of a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// Finished: `text` = stdout followed by stderr; `succeeded` = exit code 0.
    Finished { succeeded: bool, text: String },
    /// The program doesn't exist or can't be started.
    NotFound,
    /// It didn't finish within the maximum time (killed).
    TimedOut,
}

/// Who runs a command: the real one (`run_real`) or a fake one in tests.
pub type Run<'a> = &'a (dyn Fn(&str, &[&str]) -> Output + Sync);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Outcome {
    Found(String),
    Absent,
    /// The check timed out: we don't know. The previous result holds.
    Uncertain,
}

// ---------------------------------------------------------------------------------------------
// Running the commands

/// Launches `program` without a window, with stdin closed, and waits `max` at most.
pub fn run(program: &str, args: &[&str], max: Duration) -> Output {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else { return Output::NotFound };

    // One thread per pipe: a command that writes a lot doesn't block on a full pipe. The threads aren't waited for
    // beyond a moment: a grandchild that keeps the pipe open mustn't keep us waiting.
    let (tx, rx) = mpsc::channel::<(u8, Vec<u8>)>();
    fn read<R: Read + Send + 'static>(mut r: R, order: u8, tx: mpsc::Sender<(u8, Vec<u8>)>) {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            let _ = tx.send((order, buf));
        });
    }
    if let Some(o) = child.stdout.take() {
        read(o, 0, tx.clone());
    }
    if let Some(e) = child.stderr.take() {
        read(e, 1, tx.clone());
    }
    drop(tx);

    let t0 = Instant::now();
    let succeeded = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) => {}
            Err(_) => return Output::NotFound,
        }
        if t0.elapsed() >= max {
            let _ = child.kill();
            let _ = child.wait();
            return Output::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let mut pieces: Vec<(u8, Vec<u8>)> = Vec::new();
    let end = Instant::now() + Duration::from_millis(300);
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(p) => pieces.push(p),
            Err(_) => break,
        }
    }
    pieces.sort_by_key(|p| p.0);
    let text = pieces.iter().map(|(_, b)| String::from_utf8_lossy(b).into_owned()).collect::<Vec<_>>().join("\n");
    Output::Finished { succeeded, text }
}

fn run_real(program: &str, args: &[&str]) -> Output {
    run(program, args, MAX_TIME)
}

// ---------------------------------------------------------------------------------------------
// Parsing the outputs

/// The version number («3.12.4», «24.1.0») at the start of `s`, if any.
fn number(s: &str) -> Option<String> {
    let end = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let n = s[..end].trim_end_matches('.');
    (n.starts_with(|c: char| c.is_ascii_digit())).then(|| n.to_string())
}

/// The version that follows `prefix` at the start of a line (ignoring leading spaces and a `v` or `go` attached to
/// the number). `None` if no line has that form: this is how the Microsoft Store's fake Python alias is discarded
/// («Python was not found; run without arguments...»).
fn after_prefix(text: &str, prefix: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(prefix)?;
        number(rest.trim_start_matches(['v', 'V', ' ']))
    })
}

fn python_version(t: &str) -> Option<String> {
    after_prefix(t, "Python ")
}
fn node_version(t: &str) -> Option<String> {
    after_prefix(t, "v")
}
fn git_version(t: &str) -> Option<String> {
    after_prefix(t, "git version ")
}
fn cargo_version(t: &str) -> Option<String> {
    after_prefix(t, "cargo ")
}
fn go_version(t: &str) -> Option<String> {
    after_prefix(t, "go version go")
}
fn winget_version(t: &str) -> Option<String> {
    after_prefix(t, "v")
}
fn javac_version(t: &str) -> Option<String> {
    after_prefix(t, "javac ")
}

/// `java -version` writes on stderr `openjdk version "21.0.12" 2025-07-15` (or `java version "1.8.0_391"`).
fn java_version(t: &str) -> Option<String> {
    t.lines().find_map(|line| {
        let i = line.find(" version \"")?;
        let rest = &line[i + " version \"".len()..];
        let end = rest.find('"')?;
        let v = &rest[..end];
        let n = number(v)?;
        Some(n)
    })
}

/// `dotnet --list-sdks`: lines «9.0.100 [C:\Program Files\dotnet\sdk]». The highest version counts.
fn dotnet_version(t: &str) -> Option<String> {
    let key = |v: &str| -> Vec<u32> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    t.lines()
        .filter_map(|r| number(r.split_whitespace().next()?))
        .max_by_key(|v| key(v))
}

/// The first `n` components of a version: «3.12.4» with 2 → «3.12».
fn short(v: &str, n: usize) -> String {
    v.split('.').take(n).collect::<Vec<_>>().join(".")
}

/// Java's major version: «21.0.12» → 21, «1.8.0_391» → 8.
fn java_major(v: &str) -> String {
    let mut comp = v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty());
    match (comp.next(), comp.next()) {
        (Some("1"), Some(second)) => second.to_string(),
        (Some(first), _) => first.to_string(),
        _ => v.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// Detection

/// Tries the commands in order: the first whose output contains a version wins. A command that times out makes the
/// check uncertain at once (trying the alternative would cost another maximum time).
fn attempt(run: Run, attempts: &[(&str, &[&str])], parse: fn(&str) -> Option<String>) -> Outcome {
    for (prog, args) in attempts {
        match run(prog, args) {
            Output::Finished { text, .. } => {
                if let Some(v) = parse(&text) {
                    return Outcome::Found(v);
                }
            }
            Output::NotFound => {}
            Output::TimedOut => return Outcome::Uncertain,
        }
    }
    Outcome::Absent
}

/// An Office application is there if its COM class is registered (needed to drive it from PowerShell).
fn attempt_office(run: Run, progid: &str) -> Outcome {
    let key = format!(r"HKCR\{progid}\CLSID");
    // `reg query` exits with 0 if the key is there, 1 if it's missing.
    match run("reg", &["query", &key]) {
        Output::Finished { succeeded: true, .. } => Outcome::Found("yes".into()),
        Output::Finished { .. } | Output::NotFound => Outcome::Absent,
        Output::TimedOut => Outcome::Uncertain,
    }
}

fn merge(new: Outcome, old: &Option<String>) -> Option<String> {
    match new {
        Outcome::Found(v) => Some(v),
        Outcome::Absent => None,
        Outcome::Uncertain => old.clone(),
    }
}

fn merge_bool(new: Outcome, old: bool) -> bool {
    merge(new, &old.then(|| "yes".to_string())).is_some()
}

/// Detects everything, in parallel. `previous` supplies the value of the checks that time out.
pub fn detect_with(run: Run, previous: &Detection) -> Detection {
    let p = previous;
    std::thread::scope(|s| {
        let python = s.spawn(|| {
            attempt(run, &[("python", &["--version"]), ("py", &["-3", "--version"])], python_version)
        });
        let node = s.spawn(|| attempt(run, &[("node", &["--version"])], node_version));
        let git = s.spawn(|| attempt(run, &[("git", &["--version"])], git_version));
        let dotnet = s.spawn(|| attempt(run, &[("dotnet", &["--list-sdks"])], dotnet_version));
        let java = s.spawn(|| attempt(run, &[("java", &["-version"])], java_version));
        let javac = s.spawn(|| attempt(run, &[("javac", &["-version"])], javac_version));
        let rust = s.spawn(|| attempt(run, &[("cargo", &["--version"])], cargo_version));
        let go = s.spawn(|| attempt(run, &[("go", &["version"])], go_version));
        let winget = s.spawn(|| attempt(run, &[("winget", &["--version"])], winget_version));
        let word = s.spawn(|| attempt_office(run, "Word.Application"));
        let excel = s.spawn(|| attempt_office(run, "Excel.Application"));
        let powerpoint = s.spawn(|| attempt_office(run, "PowerPoint.Application"));
        let j = |h: std::thread::ScopedJoinHandle<'_, Outcome>| h.join().unwrap_or(Outcome::Uncertain);

        Detection {
            python: merge(j(python), &p.python),
            node: merge(j(node), &p.node),
            git: merge(j(git), &p.git),
            dotnet: merge(j(dotnet), &p.dotnet),
            java: merge(j(java), &p.java),
            java_jdk: merge_bool(j(javac), p.java_jdk),
            rust: merge(j(rust), &p.rust),
            go: merge(j(go), &p.go),
            winget: merge(j(winget), &p.winget),
            word: merge_bool(j(word), p.word),
            excel: merge_bool(j(excel), p.excel),
            powerpoint: merge_bool(j(powerpoint), p.powerpoint),
        }
    })
}

/// Path of the file with the last detection.
pub fn detection_file(data: &Path) -> PathBuf {
    data.join("tools.json")
}

fn load(data: &Path) -> Option<Detection> {
    let t = std::fs::read_to_string(detection_file(data)).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

/// Detection at every app start: compares with the saved one and rewrites only if it changes.
/// It never fails: if the file can't be written, the error goes to stderr and the result is used anyway.
pub fn update_with(run: Run, data: &Path) -> Detection {
    let before = load(data);
    let now = detect_with(run, &before.clone().unwrap_or_default());
    if before.as_ref() != Some(&now) {
        let written = serde_json::to_string_pretty(&now)
            .map_err(anyhow::Error::from)
            .and_then(|t| std::fs::write(detection_file(data), t).map_err(anyhow::Error::from));
        if let Err(e) = written {
            eprintln!("PC tools: detection not saved: {e:#}");
        }
    }
    now
}

/// Like `update_with`, with the real commands. Meant for a thread parallel to the engine loading.
pub fn update(data: &Path) -> Detection {
    update_with(&run_real, data)
}

// ---------------------------------------------------------------------------------------------
// Text for the system prompt

/// A missing language: name, winget id, indicative size.
const INSTALLABLE: &[(&str, &str, &str)] = &[
    ("Python", "Python.Python.3.12", "100 MB"),
    ("Node", "OpenJS.NodeJS.LTS", "80 MB"),
    ("Git", "Git.Git", "300 MB"),
    (".NET", "Microsoft.DotNet.SDK.10", "700 MB"),
    ("Java", "EclipseAdoptium.Temurin.21.JDK", "300 MB"),
    ("Rust", "Rustlang.Rustup", "1 GB plus 5 GB of Microsoft C++ tools"),
    ("Go", "GoLang.Go", "250 MB"),
];

/// The system prompt section. It must stay the same until the PC changes (no dates, no long versions): a different
/// text makes the engine reread the base.
pub fn instructions(r: &Detection) -> String {
    let java = r.java.as_ref().map(|v| {
        let p = java_major(v);
        if r.java_jdk {
            format!("Java {p}")
        } else {
            format!("Java {p} (to run only: no compiler)")
        }
    });
    // (name, present)
    let entries: Vec<(&str, Option<String>)> = vec![
        ("Python", r.python.as_ref().map(|v| format!("Python {}", short(v, 2)))),
        ("Node", r.node.as_ref().map(|v| format!("Node {}", short(v, 1)))),
        ("Git", r.git.as_ref().map(|v| format!("Git {}", short(v, 2)))),
        (".NET", r.dotnet.as_ref().map(|v| format!(".NET {}", short(v, 1)))),
        ("Java", java),
        ("Rust", r.rust.as_ref().map(|v| format!("Rust {}", short(v, 2)))),
        ("Go", r.go.as_ref().map(|v| format!("Go {}", short(v, 2)))),
    ];

    // Without a version: opencode chooses the shell (PowerShell 7 if really installed, otherwise Windows PowerShell
    // 5.1) and the `bash` tool's description already says which.
    let mut present = vec![
        "PowerShell".to_string(),
        "JavaScript and TypeScript with `bun` (always available, already included: `bun file.ts`)".to_string(),
    ];
    present.extend(entries.iter().filter_map(|(_, v)| v.clone()));

    let missing: Vec<&str> = entries.iter().filter(|(_, v)| v.is_none()).map(|(n, _)| *n).collect();

    let mut t = String::from("## Tools on this PC\n\n");
    t += &format!("On this PC you can write and run: {}.\n", present.join("; "));
    if !missing.is_empty() {
        t += &format!("Not installed: {}.\n", missing.join(", "));
    }

    let office: Vec<&str> =
        [("Word", r.word), ("Excel", r.excel), ("PowerPoint", r.powerpoint)].iter().filter(|(_, c)| *c).map(|(n, _)| *n).collect();
    if office.is_empty() {
        t += "Microsoft Office is not installed.\n";
    } else {
        t += &format!(
            "Microsoft Office installed ({}): for a PDF identical to the original, export the file with PowerShell and COM (`New-Object -ComObject Word.Application`, then `ExportAsFixedFormat`).\n",
            office.join(", ")
        );
    }

    t += "\nIf a job needs something that is not in this list, don't assume it is there. \
Explain to the user in simple words what is needed, roughly how big it is and why, and ask whether they want to install it. \
Install only after their yes. For small scripts prefer what is already there (PowerShell or bun).\n";

    if r.winget.is_some() {
        let to_install: Vec<String> = INSTALLABLE
            .iter()
            .filter(|(n, _, _)| missing.contains(n))
            .map(|(n, id, size)| format!("{n}: `winget install -e --id {id}` (about {size})"))
            .collect();
        if !to_install.is_empty() {
            t += &format!("To install: {}.\n", to_install.join("; "));
        }
        t += "After installing, in the same PowerShell, update the PATH: \
`$env:Path += ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.\n";
    } else {
        t += "`winget` is not on this PC: if something needs to be installed, tell the user to download it from the official site and guide them step by step.\n";
    }
    t
}

/// Writes the section to `<config>/MANGO-pc.md` only if the text changed; returns its path.
pub fn write_instructions(config_dir: &Path, r: &Detection) -> Result<PathBuf> {
    let path = config_dir.join("MANGO-pc.md");
    let text = instructions(r);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(&text) {
        std::fs::write(&path, text).with_context(|| format!("cannot write {}", path.display()))?;
    }
    Ok(path)
}

// ---------------------------------------------------------------------------------------------
// The `bun` command

/// The agent's environment variable with the path of `mango-code.exe` for the shim. In the `.cmd` file there is no
/// path: batch files are read in the terminal's code page and a user name with accented letters would break it; the
/// environment, instead, is Unicode.
pub const BUN_VAR: &str = "MANGO_BUN_EXE";

const BUN_SHIM: &str = "@echo off\r\nset BUN_BE_BUN=1\r\n\"%MANGO_BUN_EXE%\" %*\r\nexit /b %ERRORLEVEL%\r\n";

/// Creates `<data>/bin/bun.cmd` (if missing or different) and returns the folder, to put at the head of the agent's
/// `PATH`.
pub fn install_bun_shim(data: &Path) -> Result<PathBuf> {
    let dir = data.join("bin");
    std::fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let shim = dir.join("bun.cmd");
    if std::fs::read_to_string(&shim).ok().as_deref() != Some(BUN_SHIM) {
        std::fs::write(&shim, BUN_SHIM).with_context(|| format!("cannot write {}", shim.display()))?;
    }
    Ok(dir)
}

/// The agent's `PATH`: the shim folder at the head, then the inherited one.
pub fn path_with_bun(bin: &Path, inherited: Option<&std::ffi::OsStr>) -> String {
    match inherited {
        Some(p) if !p.is_empty() => format!("{};{}", bin.display(), p.to_string_lossy()),
        _ => bin.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(t: &str) -> Output {
        Output::Finished { succeeded: true, text: t.to_string() }
    }

    #[test]
    fn versions_from_real_outputs() {
        assert_eq!(python_version("Python 3.12.4\r\n").as_deref(), Some("3.12.4"));
        assert_eq!(python_version("Python 3.13.0rc1").as_deref(), Some("3.13.0"));
        assert_eq!(node_version("v24.1.0\n").as_deref(), Some("24.1.0"));
        assert_eq!(git_version("git version 2.47.1.windows.1\n").as_deref(), Some("2.47.1"));
        assert_eq!(cargo_version("cargo 1.82.0 (8f40fc59f 2024-08-21)").as_deref(), Some("1.82.0"));
        assert_eq!(go_version("go version go1.23.2 windows/amd64").as_deref(), Some("1.23.2"));
        assert_eq!(winget_version("v1.9.25200").as_deref(), Some("1.9.25200"));
        assert_eq!(javac_version("javac 21.0.1").as_deref(), Some("21.0.1"));
    }

    #[test]
    fn old_and_new_java() {
        let new = "openjdk version \"21.0.12\" 2025-07-15 LTS\nOpenJDK Runtime Environment Temurin-21.0.12+7 (build 21.0.12+7-LTS)";
        let old = "java version \"1.8.0_391\"\nJava(TM) SE Runtime Environment (build 1.8.0_391-b13)";
        assert_eq!(java_version(new).as_deref(), Some("21.0.12"));
        assert_eq!(java_major("21.0.12"), "21");
        assert_eq!(java_version(old).as_deref(), Some("1.8.0"));
        assert_eq!(java_major("1.8.0"), "8");
        assert_eq!(java_version("Error: no java here"), None);
    }

    #[test]
    fn dotnet_takes_the_highest_version_not_the_last_line() {
        let t = "8.0.404 [C:\\Program Files\\dotnet\\sdk]\n10.0.100 [C:\\Program Files\\dotnet\\sdk]\n9.0.100 [C:\\Program Files\\dotnet\\sdk]\n";
        assert_eq!(dotnet_version(t).as_deref(), Some("10.0.100"));
        // runtime only, no SDK: the list is empty
        assert_eq!(dotnet_version(""), None);
        assert_eq!(dotnet_version("No .NET SDKs were found."), None);
    }

    #[test]
    fn the_stores_fake_python_alias_is_not_a_version() {
        let fake = "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.";
        assert_eq!(python_version(fake), None);
        // also with the line among other text
        assert_eq!(python_version("\nPython was not found;\n"), None);
    }

    #[test]
    fn short_versions_for_the_text() {
        assert_eq!(short("3.12.4", 2), "3.12");
        assert_eq!(short("24.1.0", 1), "24");
        assert_eq!(short("3", 2), "3");
    }

    /// Fake runner: table (program -> output).
    fn fake<'a>(table: &'a [(&'a str, Output)]) -> impl Fn(&str, &[&str]) -> Output + Sync + 'a {
        move |prog, args| {
            let key = if prog == "reg" { args.get(1).copied().unwrap_or("") } else { prog };
            table.iter().find(|(p, _)| *p == key).map(|(_, u)| u.clone()).unwrap_or(Output::NotFound)
        }
    }

    #[test]
    fn detection_with_the_stores_alias_missing_commands_and_office() {
        let table = [
            ("python", finished("Python was not found; run without arguments to install from the Microsoft Store")),
            ("node", finished("v24.1.0")),
            ("git", finished("git version 2.47.1.windows.1")),
            ("java", finished("openjdk version \"21.0.12\" 2025-07-15")),
            ("javac", Output::NotFound),
            ("winget", finished("v1.9.25200")),
            (r"HKCR\Word.Application\CLSID", finished("HKEY_CLASSES_ROOT\\Word.Application\\CLSID\n    (Default)    REG_SZ    {000209FF-0000-0000-C000-000000000046}\n")),
            (r"HKCR\Excel.Application\CLSID", Output::Finished { succeeded: false, text: "ERROR: The system was unable to find the specified registry key or value.".into() }),
        ];
        let r = detect_with(&fake(&table), &Detection::default());
        assert_eq!(r.python, None, "the Store's alias is not Python");
        assert_eq!(r.node.as_deref(), Some("24.1.0"));
        assert_eq!(r.git.as_deref(), Some("2.47.1"));
        assert_eq!(r.java.as_deref(), Some("21.0.12"));
        assert!(!r.java_jdk);
        assert_eq!(r.go, None, "command that doesn't exist");
        assert!(r.word && !r.excel && !r.powerpoint);
        assert_eq!(r.winget.as_deref(), Some("1.9.25200"));
    }

    #[test]
    fn python_is_also_found_with_the_py_launcher() {
        let table = [("python", Output::NotFound), ("py", finished("Python 3.11.9"))];
        let r = detect_with(&fake(&table), &Detection::default());
        assert_eq!(r.python.as_deref(), Some("3.11.9"));
    }

    #[test]
    fn a_command_that_hangs_keeps_the_previous_value() {
        let before = Detection { node: Some("22.0.0".into()), word: true, ..Default::default() };
        let table = [
            ("node", Output::TimedOut),
            ("git", Output::TimedOut),
            (r"HKCR\Word.Application\CLSID", Output::TimedOut),
        ];
        let r = detect_with(&fake(&table), &before);
        assert_eq!(r.node.as_deref(), Some("22.0.0"), "timed out = unknown, not «uninstalled»");
        assert!(r.word);
        assert_eq!(r.git, None, "without a previous value an uncertain check counts as «not there»");
        // a command that answers corrects the previous value, even in the negative
        let table2 = [("node", Output::NotFound)];
        assert_eq!(detect_with(&fake(&table2), &before).node, None);
    }

    #[test]
    fn a_real_command_that_hangs_is_killed_in_time() {
        let t0 = Instant::now();
        let u = run("powershell", &["-NoProfile", "-Command", "Start-Sleep -Seconds 20"], Duration::from_millis(700));
        assert_eq!(u, Output::TimedOut);
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        assert_eq!(run("this-program-does-not-exist-xyz", &[], Duration::from_secs(1)), Output::NotFound);
        match run("powershell", &["-NoProfile", "-Command", "[Console]::Error.WriteLine('err'); 'out'"], Duration::from_secs(20)) {
            Output::Finished { succeeded, text } => assert!(succeeded && text.contains("out") && text.contains("err"), "{text}"),
            other => panic!("{other:?}"),
        }
    }

    fn everything() -> Detection {
        Detection {
            python: Some("3.12.4".into()),
            node: Some("24.1.0".into()),
            git: Some("2.47.1".into()),
            dotnet: Some("9.0.100".into()),
            java: Some("21.0.12".into()),
            java_jdk: true,
            rust: Some("1.82.0".into()),
            go: Some("1.23.2".into()),
            winget: Some("1.9.25200".into()),
            word: true,
            excel: true,
            powerpoint: true,
        }
    }

    #[test]
    fn text_with_everything_installed() {
        let t = instructions(&everything());
        assert!(t.contains(
            "On this PC you can write and run: PowerShell; JavaScript and TypeScript with `bun` (always available, already included: `bun file.ts`); Python 3.12; Node 24; Git 2.47; .NET 9; Java 21; Rust 1.82; Go 1.23."
        ), "{t}");
        assert!(!t.contains("Not installed"));
        assert!(t.contains("Microsoft Office installed (Word, Excel, PowerPoint)"));
        assert!(t.contains("Install only after their yes"));
    }

    #[test]
    fn text_with_almost_nothing_installed_and_without_winget() {
        let r = Detection { node: Some("20.11.0".into()), java: Some("1.8.0".into()), ..Default::default() };
        let t = instructions(&r);
        assert!(t.contains("PowerShell; JavaScript and TypeScript with `bun`"));
        assert!(t.contains("Node 20; Java 8 (to run only: no compiler)."), "{t}");
        assert!(t.contains("Not installed: Python, Git, .NET, Rust, Go."), "{t}");
        assert!(t.contains("Microsoft Office is not installed."));
        assert!(t.contains("`winget` is not on this PC"));
        assert!(!t.contains("winget install"));
    }

    #[test]
    fn text_with_winget_proposes_only_the_missing_ones() {
        let r = Detection { python: Some("3.12.4".into()), winget: Some("1.9".into()), ..Default::default() };
        let t = instructions(&r);
        assert!(t.contains("Node: `winget install -e --id OpenJS.NodeJS.LTS` (about 80 MB)"), "{t}");
        assert!(!t.contains("Python.Python"), "Python is already there");
        assert!(t.contains("GetEnvironmentVariable('Path','Machine')"));
    }

    #[test]
    fn the_text_does_not_change_for_a_minor_update() {
        let a = everything();
        let mut b = everything();
        b.python = Some("3.12.9".into());
        b.node = Some("24.9.1".into());
        b.git = Some("2.47.3".into());
        b.dotnet = Some("9.0.300".into());
        b.java = Some("21.0.99".into());
        assert_eq!(instructions(&a), instructions(&b));
        // but a language that appears or disappears does
        b.go = None;
        assert_ne!(instructions(&a), instructions(&b));
    }

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tools-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_file_is_rewritten_only_if_it_changes() {
        let d = folder("save");
        let table = [("node", finished("v24.1.0"))];
        let r1 = update_with(&fake(&table), &d);
        let f = detection_file(&d);
        let t1 = std::fs::metadata(&f).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let r2 = update_with(&fake(&table), &d);
        assert_eq!(r1, r2);
        assert_eq!(std::fs::metadata(&f).unwrap().modified().unwrap(), t1, "same = not rewritten");
        let table2 = [("node", finished("v25.0.0"))];
        let r3 = update_with(&fake(&table2), &d);
        assert_eq!(r3.node.as_deref(), Some("25.0.0"));
        assert_eq!(load(&d), Some(r3));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn bun_shim_and_path() {
        let d = folder("shim");
        let bin = install_bun_shim(&d).unwrap();
        let cmd = std::fs::read_to_string(bin.join("bun.cmd")).unwrap();
        assert!(cmd.contains("BUN_BE_BUN=1") && cmd.contains("%MANGO_BUN_EXE%") && cmd.contains("%*"));
        assert!(cmd.is_ascii(), "no paths or accented letters in the batch file");
        // second time: same content, no error
        install_bun_shim(&d).unwrap();
        let p = path_with_bun(&bin, Some(std::ffi::OsStr::new(r"C:\Windows;C:\other")));
        assert!(p.starts_with(&bin.display().to_string()) && p.ends_with(r"C:\Windows;C:\other"));
        assert_eq!(path_with_bun(&bin, None), bin.display().to_string());
        let _ = std::fs::remove_dir_all(&d);
    }
}
