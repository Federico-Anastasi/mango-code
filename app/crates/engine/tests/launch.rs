//! `mango-launch -p` up to the point where it hands the request to the agent: what it does when Mango Code cannot be
//! used. The request answered by a running Mango Code is in `integration/tests/launch.test.ts`, with the real agent.
//! Data and distribution belong to a temporary folder, the language is Italian, and the program is a copy in a folder
//! with no `mango-code.exe` next to it, so no app is ever started.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Output};

const LAUNCH: &str = env!("CARGO_BIN_EXE_mango-launch");

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("data/settings.json"), r#"{ "language": "it" }"#).unwrap();
        std::fs::write(root.join("dist/mango-models.json"), "{}").unwrap();
        std::fs::copy(LAUNCH, root.join("bin/mango-launch.exe")).unwrap();
        Fixture { _dir: dir, root }
    }

    fn service(&self, json: &str) {
        std::fs::write(self.root.join("data/service.json"), json).unwrap();
    }

    fn launch(&self, args: &[&str]) -> (Option<i32>, String) {
        let o: Output = Command::new(self.root.join("bin/mango-launch.exe"))
            .args(args)
            .env("MANGO_DIST", self.root.join("dist"))
            .env("MANGO_DATA", self.root.join("data"))
            .creation_flags(mango_common::CREATE_NO_WINDOW)
            .output()
            .unwrap();
        (o.status.code(), String::from_utf8_lossy(&o.stderr).into_owned())
    }
}

#[test]
fn without_a_request_it_says_how_to_ask_for_one() {
    let (code, error) = Fixture::new().launch(&["--model", "fake"]);
    assert_eq!(code, Some(2));
    assert!(error.contains("uso: mango-launch -p"), "{error}");
}

#[test]
fn when_the_app_is_not_there_it_says_so_and_a_stale_service_file_is_not_believed() {
    let f = Fixture::new();
    // A pid that no process has, and an agent that nobody listens to: the file of an app that crashed.
    f.service(r#"{ "version": 1, "pid": 4294967290, "agent": "http://127.0.0.1:9", "engine": null, "window": false }"#);
    let (code, error) = f.launch(&["-p", "hello"]);
    assert_eq!(code, Some(3));
    assert!(error.contains("Mango Code non è installato"), "{error}");
}

#[test]
fn an_app_that_is_running_but_not_ready_gives_its_reason_and_is_not_started_again() {
    let f = Fixture::new();
    // The pid of this test process: alive for as long as the test runs.
    f.service(&format!(r#"{{ "version": 1, "pid": {}, "reason": "scegli i modelli nella finestra", "window": false }}"#, std::process::id()));
    let (code, error) = f.launch(&["-p", "hello"]);
    assert_eq!(code, Some(3));
    assert!(error.contains("non è pronto: scegli i modelli nella finestra"), "{error}");
}

#[test]
fn a_ready_app_without_its_agent_is_a_readable_error() {
    let f = Fixture::new();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let agent = format!("http://{}", server.server_addr().to_ip().unwrap());
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_string("{}"));
        }
    });
    f.service(&format!(r#"{{ "version": 1, "pid": {}, "agent": "{agent}", "engine": null, "window": false }}"#, std::process::id()));
    let (code, error) = f.launch(&["-p", "hello"]);
    assert_eq!(code, Some(3));
    assert!(error.contains("non riesco ad avviare") && error.contains("mango-code.exe"), "{error}");
}
