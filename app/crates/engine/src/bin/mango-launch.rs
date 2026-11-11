//! `mango-launch -p "request"`: Mango Code from a script, the way `claude -p` is used. It finds the running app or
//! starts it without a window, then runs the agent against the app's own agent server (`run --attach`) in the
//! given folder, with the app's models and engine. The answer goes to stdout, what the agent does (the tools it calls)
//! to stderr. The app's configuration asks for no permission; if a project's own rules do, the agent refuses it, as
//! there is nobody to answer.
//!
//! ```text
//! mango-launch -p <request> [--model <key>] [--dir <folder>]
//! ```
//!
//! Exit code: the agent's (0 when the request was answered); 2 for a wrong command line; 3 when Mango Code cannot be
//! used (not installed next to this program, not ready, or it does not start). See docs/INTEGRATION.md.

use anyhow::{bail, Context, Result};
use engine::loan::Process;
use mango_common::{tr, Paths, CREATE_NO_WINDOW};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const START_WAIT: Duration = Duration::from_secs(300);
const DETACHED_PROCESS: u32 = 0x0000_0008;

struct Request {
    text: String,
    model: Option<String>,
    dir: PathBuf,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(request) = parse(&args) else {
        eprintln!("{}", tr!(
            "uso: mango-launch -p <richiesta> [--model <chiave>] [--dir <cartella>]",
            "usage: mango-launch -p <request> [--model <key>] [--dir <folder>]"
        ));
        std::process::exit(2);
    };
    match run(&request) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(3);
        }
    }
}

fn parse(args: &[String]) -> Option<Request> {
    let value = |names: &[&str]| args.windows(2).find(|w| names.contains(&w[0].as_str())).map(|w| w[1].clone());
    Some(Request {
        text: value(&["-p", "--print"])?,
        model: value(&["--model"]),
        dir: value(&["--dir"]).map(PathBuf::from).or_else(|| std::env::current_dir().ok())?,
    })
}

fn run(request: &Request) -> Result<i32> {
    let paths = Paths::discover()?;
    let agent = ready(&paths.data)?;
    let exe = paths.opencode.join("web").join("mango-code.exe");
    let mut command = Command::new(&exe);
    command.args(["run", "--attach", &agent, "--dir"]).arg(&request.dir);
    if let Some(model) = &request.model {
        command.args(["--model", &format!("mango/{model}")]);
    }
    command.arg("--").arg(&request.text);
    // The agent keeps its state in the app's data, not in the user's home (as the app starts it).
    for (variable, folder) in [("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")] {
        command.env(variable, paths.data.join("agent").join(folder));
    }
    let status = command.status().with_context(|| tr!("non riesco ad avviare {}", "cannot start {}", exe.display()))?;
    Ok(status.code().unwrap_or(1))
}

enum State {
    Ready(String),
    /// The app is running and says why it cannot serve.
    Stuck(String),
    Absent,
}

/// What `service.json` says about the app, if its process is still there and, when ready, its agent answers.
fn state(data: &Path) -> State {
    let Ok(text) = std::fs::read_to_string(data.join("service.json")) else { return State::Absent };
    let Ok(service) = serde_json::from_str::<serde_json::Value>(&text) else { return State::Absent };
    let alive = service["pid"].as_u64().and_then(|pid| Process::open(pid as u32)).is_some_and(|p| p.alive());
    if !alive {
        return State::Absent;
    }
    if let Some(reason) = service["reason"].as_str() {
        return State::Stuck(reason.to_string());
    }
    match service["agent"].as_str() {
        Some(agent) if {
            let url = format!("{agent}/global/health");
            mango_common::internet::agent(&url, Duration::from_secs(3)).get(&url).call().is_ok()
        } =>
        {
            State::Ready(agent.to_string())
        }
        _ => State::Absent,
    }
}

/// The app this program belongs to: `mango-code.exe` in its folder (a build: both are in `targetdebug`) or in the one above it (installed:
/// this program is in `resources`, the app one level up).
fn app_beside(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().skip(1).take(2).map(|a| a.join("mango-code.exe")).find(|f| f.is_file())
}

/// The address of the agent server: of the app that is already running, or of one started here without a window,
/// which is left running (it is the same app, in the tray) for the next request.
fn ready(data: &Path) -> Result<String> {
    let settled = |state: State| match state {
        State::Ready(agent) => Ok(Some(agent)),
        State::Stuck(reason) => bail!("{}", tr!("Mango Code è aperto ma non è pronto: {reason}", "Mango Code is open but not ready: {reason}")),
        State::Absent => Ok(None),
    };
    if let Some(agent) = settled(state(data))? {
        return Ok(agent);
    }
    let exe = std::env::current_exe()?;
    let Some(app) = app_beside(&exe) else {
        bail!("{}", tr!(
            "Mango Code non è installato: non trovo mango-code.exe accanto a {}",
            "Mango Code is not installed: mango-code.exe is not next to {}",
            exe.display()
        ));
    };
    Command::new(&app)
        .arg("--service")
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| tr!("non riesco ad avviare {}", "cannot start {}", app.display()))?;
    let started = Instant::now();
    while started.elapsed() < START_WAIT {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(agent) = settled(state(data))? {
            return Ok(agent);
        }
    }
    bail!("{}", tr!(
        "Mango Code non è pronto dopo {} s (log in {})",
        "Mango Code is not ready after {} s (log in {})",
        START_WAIT.as_secs(),
        data.join("logs").display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_is_found_in_the_installed_layout_and_in_a_build() {
        let dir = tempfile::tempdir().unwrap();
        let touch = |p: &Path| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        };
        // installed: <install>mango-code.exe and <install>esourcesmango-launch.exe
        let installed = dir.path().join("installed");
        touch(&installed.join("mango-code.exe"));
        touch(&installed.join("resources").join("mango-launch.exe"));
        assert_eq!(app_beside(&installed.join("resources").join("mango-launch.exe")), Some(installed.join("mango-code.exe")));
        // a build: both in the same folder
        let build = dir.path().join("target").join("debug");
        touch(&build.join("mango-code.exe"));
        touch(&build.join("mango-launch.exe"));
        assert_eq!(app_beside(&build.join("mango-launch.exe")), Some(build.join("mango-code.exe")));
        // no app, however far up one looks: nothing (and an app three folders up is too far)
        let lonely = dir.path().join("lonely");
        touch(&lonely.join("a").join("b").join("c").join("mango-launch.exe"));
        touch(&lonely.join("mango-code.exe"));
        assert_eq!(app_beside(&lonely.join("a").join("b").join("c").join("mango-launch.exe")), None);
    }
}
