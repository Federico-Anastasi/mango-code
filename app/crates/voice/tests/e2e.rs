//! Test with the real model, to run by hand after the download:
//!
//! ```text
//! set VOICE_TEST_MODEL=C:\...\whisper\ggml-small.bin
//! set VOICE_TEST_AUDIO=C:\...\hello.webm      (webm/opus, ogg/opus or wav, in Italian)
//! set VOICE_TEST_WORDS=funzione,ordina,numeri (words the text must contain)
//! cargo test -p voice --release --test e2e -- --ignored --nocapture
//! ```
//! The VAD (`ggml-silero-v5.1.2.bin`) must be next to the model.

use std::io::Read;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("the variable {name} is missing"))
}

#[test]
#[ignore = "requires the downloaded model and an audio file (see the file's documentation)"]
fn transcribes_a_clip_like_the_agents_server_does() {
    let model = env("VOICE_TEST_MODEL");
    let audio = std::fs::read(env("VOICE_TEST_AUDIO")).unwrap();
    let words: Vec<String> = env("VOICE_TEST_WORDS").split(',').map(|w| w.trim().to_lowercase()).collect();

    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let server = voice::start(std::path::Path::new(&model), port).unwrap();
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();

    // the first request waits for the model to load, as in production
    for round in 1..=2 {
        let mut resp = agent
            .post(&format!("{}/transcribe", server.url))
            .header("Content-Type", "audio/webm;codecs=opus")
            .send(&audio[..])
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "round {round}");
        let mut body = String::new();
        resp.body_mut().as_reader().read_to_string(&mut body).unwrap();
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let text = json["text"].as_str().unwrap().to_lowercase();
        println!("round {round}: {body}");
        for w in &words {
            assert!(text.contains(w.as_str()), "'{w}' is missing in: {text}");
        }
    }
    let health: serde_json::Value =
        serde_json::from_reader(agent.get(&format!("{}/health", server.url)).call().unwrap().body_mut().as_reader()).unwrap();
    assert_eq!(health["state"], "ready");
}
