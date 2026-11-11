//! Test with the real model, to run by hand after the download:
//!
//! ```text
//! set VOICE_TEST_MODEL=C:\...\whisper\ggml-small.bin
//! set VOICE_TEST_AUDIO=C:\...\hello.pcm       (raw 16-bit little-endian mono PCM at 16 kHz, in Italian)
//! set VOICE_TEST_WORDS=funzione,ordina,numeri (words the text must contain)
//! cargo test -p voice --release --test e2e -- --ignored --nocapture
//! ```
//! The VAD (`ggml-silero-v5.1.2.bin`) must be next to the model.

use std::io::Read;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("the variable {name} is missing"))
}

fn post(agent: &ureq::Agent, url: &str, body: &[u8]) -> serde_json::Value {
    let mut resp = agent.post(url).header("Content-Type", "application/octet-stream").send(body).unwrap();
    assert_eq!(resp.status().as_u16(), 200, "{url}");
    let mut text = String::new();
    resp.body_mut().as_reader().read_to_string(&mut text).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
#[ignore = "requires the downloaded model and an audio file (see the file's documentation)"]
fn dictates_a_clip_like_the_agents_server_does() {
    let model = env("VOICE_TEST_MODEL");
    let audio = std::fs::read(env("VOICE_TEST_AUDIO")).unwrap();
    let words: Vec<String> = env("VOICE_TEST_WORDS").split(',').map(|w| w.trim().to_lowercase()).collect();

    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let server = voice::start(std::path::Path::new(&model), port).unwrap();
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();

    // the first dictation waits for the model to load, as in production
    for round in 1..=2 {
        let id = post(&agent, &format!("{}/live/start", server.url), b"")["id"].as_str().unwrap().to_string();
        let mut events = Vec::new();
        // a second of audio at a time (32,000 bytes), then a second of silence for the VAD to close the sentence
        for chunk in audio.chunks(32_000).chain(std::iter::once(&[0u8; 32_000][..])) {
            events.extend(post(&agent, &format!("{}/live/pcm?id={id}", server.url), chunk)["events"].as_array().unwrap().clone());
        }
        events.extend(post(&agent, &format!("{}/live/end?id={id}", server.url), b"")["events"].as_array().unwrap().clone());
        let text: String =
            events.iter().filter(|e| e["type"] == "final").filter_map(|e| e["text"].as_str()).collect::<Vec<_>>().join(" ").to_lowercase();
        println!("round {round}: {text}");
        for w in &words {
            assert!(text.contains(w.as_str()), "'{w}' is missing in: {text}");
        }
    }
    let health: serde_json::Value =
        serde_json::from_reader(agent.get(&format!("{}/health", server.url)).call().unwrap().body_mut().as_reader()).unwrap();
    assert_eq!(health["state"], "ready");
}
