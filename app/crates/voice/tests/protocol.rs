//! The HTTP protocol of mango-voice.py --serve, without the real model: the model files are placeholders, so loading
//! fails and the service stays in the "error" state.
//! With the real model see `e2e.rs`.
//! Messages are asserted in the language the service is using, whatever it is on this PC.

use mango_common::tr;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;

struct Fixture {
    dir: PathBuf,
    server: Option<voice::VoiceServer>,
    port: u16,
}

fn fixture(tag: &str) -> Fixture {
    let dir = std::env::temp_dir().join(format!("mango-voice-test-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for f in voice::FILES {
        std::fs::write(dir.join(f.name), b"placeholder").unwrap();
    }
    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let server = voice::start(&dir.join(voice::FILES[0].name), port).unwrap();
    Fixture { dir, server: Some(server), port }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Sends raw bytes and returns (code, JSON body).
fn raw(port: u16, head: &str, body: &[u8]) -> (u16, serde_json::Value) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).unwrap();
    let text = String::from_utf8(resp).unwrap();
    let code = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let json = text.split("\r\n\r\n").nth(1).unwrap();
    (code, serde_json::from_str(json).unwrap_or_else(|e| panic!("body is not JSON ({e}): {json}")))
}

fn post(port: u16, extra_headers: &str, body: &[u8]) -> (u16, serde_json::Value) {
    let head = format!(
        "POST /transcribe HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: {}\r\n{extra_headers}\r\n",
        body.len()
    );
    raw(port, &head, body)
}

fn wav_silence() -> Vec<u8> {
    let data = vec![0u8; 16_000 * 2];
    let mut w = Vec::new();
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    for v in [16u32, 0x0001_0001, 16_000, 32_000] {
        w.extend_from_slice(&v.to_le_bytes());
    }
    w.extend_from_slice(&0x0010_0002u32.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(data.len() as u32).to_le_bytes());
    w.extend_from_slice(&data);
    w
}

#[test]
fn health_says_error_if_the_model_does_not_load() {
    let f = fixture("health");
    // loading is in a thread: we wait for it to fail
    let mut last = None;
    for _ in 0..100 {
        let r = raw(f.port, "GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", b"");
        if r.1["state"] != "loading" {
            last = Some(r);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let (code, body) = last.expect("loading never finished");
    assert_eq!(code, 200);
    assert_eq!(body["state"], "error");
    assert_eq!(body["model"], voice::FILES[0].name);
    assert!(body["error"].as_str().unwrap().contains(&tr!("non caricato", "not loaded")));
    assert_eq!(f.server.as_ref().unwrap().url, format!("http://127.0.0.1:{}", f.port));
}

#[test]
fn paths_and_methods() {
    let f = fixture("paths");
    assert_eq!(raw(f.port, "GET /other HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", b"").0, 404);
    assert_eq!(post_to(f.port, "/other").0, 404);
    assert_eq!(raw(f.port, "GET /transcribe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", b"").0, 404);
}

fn post_to(port: u16, path: &str) -> (u16, serde_json::Value) {
    raw(port, &format!("POST {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 1\r\n\r\n"), b"x")
}

#[test]
fn a_web_page_cannot_use_the_service() {
    let f = fixture("origin");
    let (code, body) = post(f.port, "Origin: http://evil.example\r\n", &wav_silence());
    assert_eq!(code, 403);
    assert!(body["error"].as_str().unwrap().contains(&tr!("server di Mango Code", "Mango Code server")));
    let (code, _) = raw(f.port, "GET /health HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n", b"");
    assert_eq!(code, 403);
}

#[test]
fn malformed_requests() {
    let f = fixture("malformed");
    assert_eq!(post(f.port, "", b"").0, 400, "empty body");
    assert_eq!(post(f.port, "", b"this is not audio").0, 422, "unreadable audio");
    // declares 26 MB and doesn't send them: the refusal must come before reading them
    let (code, body) = raw(
        f.port,
        "POST /transcribe HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 27262976\r\n\r\n",
        b"",
    );
    assert_eq!(code, 413);
    assert!(body["error"].as_str().unwrap().contains("25 MB"));
    // without Content-Length (chunked body)
    let (code, _) = raw(
        f.port,
        "POST /transcribe HTTP/1.1\r\nHost: x\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n",
        b"",
    );
    assert_eq!(code, 411);
}

#[test]
fn valid_audio_with_a_broken_model_gives_503() {
    let f = fixture("503");
    let (code, body) = post(f.port, "Content-Type: audio/wav\r\n", &wav_silence());
    assert_eq!(code, 503);
    assert!(body["error"].as_str().unwrap().contains(&tr!("non caricato", "not loaded")));
}

#[test]
fn start_without_the_files_and_without_a_port_gives_an_error() {
    let dir = std::env::temp_dir().join(format!("mango-voice-test-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let err = voice::start(&dir.join(voice::FILES[0].name), 0).err().unwrap();
    assert!(err.to_string().contains(&tr!("manca il file", "is missing")));
    let _ = std::fs::remove_dir_all(&dir);

    let f = fixture("port");
    let err = voice::start(&f.dir.join(voice::FILES[0].name), f.port).err().unwrap();
    assert!(err.to_string().contains(&tr!("non disponibile", "not available")));
}

#[test]
fn drop_frees_the_port() {
    let mut f = fixture("drop");
    drop(f.server.take());
    // tiny_http closes the listener with its accept thread: it takes a few milliseconds
    let free = (0..40).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::net::TcpListener::bind(("127.0.0.1", f.port)).is_ok()
    });
    assert!(free, "port still in use after 2 s");
}

#[test]
fn compiled_with_avx2() {
    // whisper-rs doesn't expose the build configuration; whisper.cpp prints it in the system info
    let info = whisper_rs::print_system_info();
    assert!(info.contains("AVX2 = 1"), "whisper.cpp compiled without AVX2 (GGML_AVX2=ON missing): {info}");
}
