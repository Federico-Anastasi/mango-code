//! The protocol of `mango-voice.py --serve`, reproduced: the agent server's /mango/voice/transcribe route forwards the
//! clip here (POST /transcribe) and returns its reply.
//!
//! * `GET /health` -> 200 `{"state":"loading"|"ready"|"error","model":...}` (+ `"error"`)
//! * `POST /transcribe`, body = raw audio -> 200 `{"text","audio_s","elapsed_s"}`
//! * Live dictation (see `live.rs`), with sequential requests:
//!   * `POST /live/start` -> 200 `{"id"}` (waits for the models to load)
//!   * `POST /live/pcm?id=…`, body = 16-bit little-endian PCM, mono, 16 kHz -> 200 `{"events":[…]}`
//!   * `POST /live/end?id=…` -> 200 `{"events":[…]}`: closes the sentence in progress and waits for the finals
//!   * an event is `{"type":"speaking"|"empty"|"partial"|"final"|"error", …}`; 404 if the session is gone
//! * errors `{"error": "..."}`: 400 empty · 403 request from a web page (there's an `Origin`) · 404 path · 411 without
//!   Content-Length · 413 over 25 MB · 422 unreadable audio · 503 model not available · 500 transcription failed

use crate::audio::{self, SAMPLE_RATE};
use crate::engine::{Engine, Failure, Kind, Status};
use crate::live::Live;
use mango_common::tr;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response};

/// Like MAX_AUDIO_BYTES in the Python.
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
/// A piece of live dictation lasts a few hundred milliseconds: 1 MiB is 32 s.
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

pub fn handle(mut req: Request, engine: &Arc<Engine>, live: &Arc<Live>, model_name: &str) {
    let (status, body) = route(&mut req, engine, live, model_name);
    let json_header = Header::from_bytes("Content-Type", "application/json; charset=utf-8").expect("static header");
    // if the client closed the connection there's nobody to tell
    let _ = req.respond(Response::from_string(body.to_string()).with_status_code(status).with_header(json_header));
}

fn error(status: u16, msg: impl Into<String>) -> (u16, Value) {
    (status, json!({ "error": msg.into() }))
}

fn content_length_missing() -> (u16, Value) {
    error(411, tr!("manca Content-Length", "Content-Length is missing"))
}

fn route(req: &mut Request, engine: &Arc<Engine>, live: &Arc<Live>, model_name: &str) -> (u16, Value) {
    // The page only talks to the agent's server: a request with Origin comes from a browser that calls us bypassing it,
    // and mustn't be able to use the service or read its replies.
    if req.headers().iter().any(|h| h.field.equiv("Origin")) {
        return error(
            403,
            tr!(
                "il servizio di trascrizione si usa tramite il server di Mango Code",
                "the transcription service is used through the Mango Code server"
            ),
        );
    }
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    match (req.method(), path) {
        (Method::Get, "/health") => (200, health(&engine.status(), model_name)),
        (Method::Post, "/transcribe") => transcribe(req, engine),
        (Method::Post, "/live/start") => match live.open() {
            Ok(id) => (200, json!({ "id": id })),
            Err(f) => failure(f),
        },
        (Method::Post, "/live/pcm") => live_pcm(req, live, query),
        (Method::Post, "/live/end") => match query_id(query).and_then(|id| live.end(id)) {
            Some(events) => (200, json!({ "events": events })),
            None => error(404, tr!("dettatura conclusa", "dictation ended")),
        },
        (Method::Get | Method::Post, _) => error(404, tr!("percorso sconosciuto", "unknown path")),
        _ => error(405, tr!("metodo non supportato", "method not supported")),
    }
}

fn query_id(query: &str) -> Option<&str> {
    query.split('&').find_map(|kv| kv.strip_prefix("id="))
}

fn failure(f: Failure) -> (u16, Value) {
    match f {
        Failure::Unavailable(m) => error(503, m),
        Failure::Internal(m) => error(500, m),
    }
}

fn live_pcm(req: &mut Request, live: &Arc<Live>, query: &str) -> (u16, Value) {
    let Some(id) = query_id(query) else {
        return error(400, tr!("manca l'id della dettatura", "the dictation id is missing"));
    };
    let Some(len) = req.body_length() else {
        return content_length_missing();
    };
    if len > MAX_CHUNK_BYTES || len % 2 != 0 {
        return error(400, tr!("pezzo di audio non valido", "invalid audio chunk"));
    }
    let mut data = Vec::with_capacity(len);
    if let Err(e) = req.as_reader().take(len as u64).read_to_end(&mut data) {
        return error(400, tr!("corpo della richiesta illeggibile: {e}", "request body unreadable: {e}"));
    }
    let pcm: Vec<f32> = data.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
    match live.chunk(id, &pcm) {
        Some(events) => (200, json!({ "events": events })),
        None => error(404, tr!("dettatura conclusa", "dictation ended")),
    }
}

fn health(status: &Status, model: &str) -> Value {
    match status {
        Status::Failed(e) => json!({ "state": "error", "error": e, "model": model }),
        Status::Ready => json!({ "state": "ready", "model": model }),
        Status::Loading => json!({ "state": "loading", "model": model }),
    }
}

fn transcribe(req: &mut Request, engine: &Arc<Engine>) -> (u16, Value) {
    let Some(len) = req.body_length() else {
        return content_length_missing();
    };
    if len == 0 {
        return error(400, tr!("audio vuoto", "empty audio"));
    }
    if len > MAX_AUDIO_BYTES {
        let mb = MAX_AUDIO_BYTES / (1024 * 1024);
        return error(413, tr!("audio troppo lungo (oltre {mb} MB)", "audio too long (over {mb} MB)"));
    }
    let mut data = Vec::with_capacity(len);
    if let Err(e) = req.as_reader().take(len as u64).read_to_end(&mut data) {
        return error(400, tr!("corpo della richiesta illeggibile: {e}", "request body unreadable: {e}"));
    }
    // first the audio, then the wait for the model: a broken clip is refused at once
    let pcm = match audio::decode(data) {
        Ok(p) => p,
        Err(e) => return error(422, tr!("audio non decodificabile: {e}", "audio cannot be decoded: {e}")),
    };
    match engine.transcribe(&pcm, Kind::Final) {
        Ok((text, elapsed)) => (
            200,
            json!({
                "text": text,
                "audio_s": round2(pcm.len() as f64 / SAMPLE_RATE as f64),
                "elapsed_s": round2(elapsed),
            }),
        ),
        Err(f) => failure(f),
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
