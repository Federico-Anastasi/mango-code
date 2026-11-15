//! A fake `sd-server` for the manager tests: the routes the manager uses, with jobs that advance by themselves.
//!
//! `fake-sd --listen-port <n> [anything else]`. The picture of a finished job is not a PNG: it is a JSON with the
//! request it got, its own arguments and the cards it was given, so that a test can read what reached the engine.
//! - `FAKE_SD_STEP_MS`: how long a step takes (default 30);
//! - `FAKE_SD_MODE`: `fail` (the job fails), `exit` (the process ends at the second step, as when memory runs out),
//!   `refuse` (the request is refused), `loading` (it never says it is ready), `absent` (it ends as soon as it starts),
//!   `exit-when-idle` (it ends a moment after its first picture);
//! - `FAKE_SD_PNG=1`: the pictures and the previews are real PNGs a page can show (a gradient, and a flat colour that
//!   changes with the step), the picture a fraction of the size asked, and it carries the request the engine got in an
//!   `iTXt` chunk with the keyword `fake-request`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port: u16 = args.windows(2).find(|w| w[0] == "--listen-port").and_then(|w| w[1].parse().ok()).expect("--listen-port <n>");
    let mode = std::env::var("FAKE_SD_MODE").unwrap_or_default();
    let step = Duration::from_millis(std::env::var("FAKE_SD_STEP_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(30));
    if mode == "absent" {
        println!("fake-sd: a library is missing");
        std::process::exit(5);
    }
    let server = Server::http(("127.0.0.1", port)).expect("port");
    let jobs: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
    for mut request in server.incoming_requests() {
        let path = request.url().to_string();
        let (status, body) = match (request.method(), path.as_str()) {
            (Method::Get, "/sdcpp/v1/models/status") => (200, json!({ "state": if mode == "loading" { "loading" } else { "ready" } })),
            (Method::Post, "/sdcpp/v1/img_gen") if mode == "refuse" => (400, json!({ "error": "invalid generation parameters" })),
            (Method::Post, "/sdcpp/v1/img_gen") => {
                let mut text = String::new();
                let _ = request.as_reader().read_to_string(&mut text);
                let asked: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let id = format!("job_{}", jobs.lock().unwrap().len() + 1);
                jobs.lock().unwrap().insert(id.clone(), json!({ "id": id, "status": "queued", "progress": { "stage": "queued" }, "preview": null }));
                let (jobs, id2, mode, args) = (jobs.clone(), id.clone(), mode.clone(), args.clone());
                std::thread::spawn(move || run(&jobs, &id2, &asked, &mode, step, &args));
                (202, json!({ "id": id, "kind": "img_gen", "status": "queued" }))
            }
            (Method::Get, p) if p.starts_with("/sdcpp/v1/jobs/") => match jobs.lock().unwrap().get(&p["/sdcpp/v1/jobs/".len()..]) {
                Some(job) => (200, job.clone()),
                None => (404, json!({ "error": "no such job" })),
            },
            _ => (404, json!({ "error": "not found" })),
        };
        let header = Header::from_bytes("Content-Type", "application/json").unwrap();
        let _ = request.respond(Response::from_string(body.to_string()).with_status_code(status).with_header(header));
    }
}

/// A job from start to end: reading the request, the steps (each with its preview), the decoding, the result.
fn run(jobs: &Mutex<HashMap<String, Value>>, id: &str, asked: &Value, mode: &str, step: Duration, args: &[String]) {
    use base64::Engine;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let set = |change: &dyn Fn(&mut Value)| change(jobs.lock().unwrap().get_mut(id).unwrap());
    let steps = asked["sample_params"]["sample_steps"].as_u64().unwrap_or(4);
    set(&|j| {
        j["status"] = "generating".into();
        j["progress"] = json!({ "stage": "conditioning", "completed": null, "total": null });
    });
    std::thread::sleep(step);
    for done in 0..steps {
        set(&|j| {
            j["progress"] = json!({ "stage": "sampling", "completed": done, "total": steps });
            if done > 0 {
                let preview = if png_mode() { png(24, 24, &|_, _| [40 + (done * 200 / steps.max(1)) as u8, 120, 220 - (done * 150 / steps.max(1)) as u8], None) } else { format!("preview {done}").into_bytes() };
                j["preview"] = json!({ "step": done, "total_steps": steps, "b64_json": b64(&preview) });
            }
        });
        if mode == "exit" && done == 1 {
            println!("fake-sd: CUDA error: out of memory");
            std::process::exit(3);
        }
        std::thread::sleep(step);
    }
    if mode == "fail" {
        return set(&|j| {
            j["status"] = "failed".into();
            j["error"] = json!({ "code": "generation_failed", "message": "generate_image returned empty results" });
        });
    }
    set(&|j| j["progress"] = json!({ "stage": "vae_decode", "completed": null, "total": null }));
    std::thread::sleep(step);
    let picture = json!({ "asked": asked, "args": args, "cards": std::env::var("CUDA_VISIBLE_DEVICES").ok() });
    set(&|j| {
        j["status"] = "completed".into();
        j["progress"] = json!({ "stage": "encoding", "completed": 1, "total": 1 });
        let bytes = if png_mode() { drawn(asked, &picture) } else { picture.to_string().into_bytes() };
        j["result"] = json!({ "output_format": "png", "images": [{ "index": 0, "b64_json": b64(&bytes) }] });
    });
    if mode == "exit-when-idle" {
        std::thread::sleep(Duration::from_millis(600));
        std::process::exit(0);
    }
}

fn png_mode() -> bool {
    std::env::var("FAKE_SD_PNG").is_ok_and(|v| v == "1")
}

/// The picture of `FAKE_SD_PNG`: the proportions asked, an eighth of the size, a gradient that follows the seed.
fn drawn(asked: &Value, request: &Value) -> Vec<u8> {
    let side = |key: &str| (asked[key].as_u64().unwrap_or(512) / 8).clamp(8, 160) as u32;
    let (w, h) = (side("width"), side("height"));
    let seed = asked["seed"].as_u64().unwrap_or(0) as u32;
    png(w, h, &|x, y| [(40 + x * 180 / w) as u8, (60 + y * 150 / h) as u8, (90 + seed.wrapping_mul(37) % 120) as u8], Some(("fake-request", &request.to_string())))
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend((data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend(data);
    out.extend(&body);
    out.extend(crc32(&body).to_be_bytes());
}

/// A PNG without compression (stored deflate blocks), with a text chunk if there is one.
fn png(w: u32, h: u32, pixel: &dyn Fn(u32, u32) -> [u8; 3], text: Option<(&str, &str)>) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..h {
        raw.push(0);
        for x in 0..w {
            raw.extend(pixel(x, y));
        }
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        zlib.extend((block.len() as u16).to_le_bytes());
        zlib.extend((!(block.len() as u16)).to_le_bytes());
        zlib.extend(*block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());

    let mut out = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a].to_vec();
    let mut header = Vec::new();
    header.extend(w.to_be_bytes());
    header.extend(h.to_be_bytes());
    header.extend([8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    if let Some((keyword, value)) = text {
        let mut itxt = keyword.as_bytes().to_vec();
        itxt.extend([0, 0, 0, 0, 0]);
        itxt.extend(value.as_bytes());
        chunk(&mut out, b"iTXt", &itxt);
    }
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}
