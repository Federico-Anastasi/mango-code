//! What goes wrong on someone else's PC has to reach us, readable by whoever fixes it (a person or an agent) and
//! without the user's personal data.
//!
//! - `ui_log`: the web UI writes here (see `INIT_SCRIPT` in `bridge.rs`) its uncaught errors, its `console.error`
//!   and the calls to the app that take more than a second. They end up in `logs\ui.log`, next to the logs of the
//!   agent and the engine.
//! - `report_problem` ("Report a problem"): one click. With a Sentry address in the build (`MANGO_CODE_SENTRY_DSN`) the
//!   report is sent there: an event with what the user wrote, the error and the computer as separate fields, and
//!   attachments: `report.txt` (summary and the end of every log), `screenshot.png` (only if the user leaves the box
//!   ticked) and the files the user chose or pasted, which go as they are, untouched. Without the address (a build of
//!   your own), the text goes to a file on the Desktop and a GitHub issue opens already filled in, and there are no
//!   attachments. The text is anonymized first (`anonymize`), the user's files are not.
//! - What the page sends is one body (`Submission::parse`): 4 bytes with the length of a JSON header (`error`, `note`,
//!   `page`, `screenshot`, `files` with name, type and size), the header, then the bytes of the files one after the
//!   other. The same body comes from the window (the bridge) and from the phone (`PhoneReports`, `/phone/report`).
//! - The limits: Sentry takes at most 40 MB for a request and 200 MB of attachments per event (its documentation on
//!   attachments). The request goes out uncompressed, so it must stay under 40 MB with the report
//!   text and the screenshot in it: the user's files may add up to `FILES_MAX`, and the whole envelope is measured
//!   before sending (`ENVELOPE_MAX`). A file that is too large is refused with a sentence, never dropped.

use crate::bridge::{err, BridgeError};
use mango_common::tr;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// Where the reports go: the Sentry project `mango-code` of the `mango-o6` organization (data in the EU). A DSN only
/// lets one send events, it does not read them: it can stay in the source, as in every app that uses Sentry. A build
/// can send elsewhere with `MANGO_CODE_SENTRY_DSN`, or nowhere with `MANGO_CODE_SENTRY_DSN=off` (then: file and GitHub issue).
const SENTRY_DSN: Option<&str> = match option_env!("MANGO_CODE_SENTRY_DSN") {
    Some(d) if d.is_empty() || d.eq_ignore_ascii_case("off") => None,
    Some(d) => Some(d),
    None => Some("https://55ae6f1d9f48b7c1d18c1ff540c0e46a@o4510993915314176.ingest.de.sentry.io/4512397165068368"),
};
const NEW_ISSUE: &str = "https://github.com/Federico-Anastasi/mango-code/issues/new";
/// Above this, `ui.log` becomes `ui.1.log` (the previous one is dropped).
const UI_LOG_MAX: u64 = 2 * 1024 * 1024;
/// The most lines `ui.log` takes in a minute: the page (a broken one, or the phone's) is not trusted to count.
const UI_LOG_LINES_PER_MINUTE: usize = 100;
/// How much of the end of each log goes into the report.
const TAIL: u64 = 256 * 1024;
/// The most characters of the report text that go in the issue's address: the whole of it is in the file on the Desktop,
/// and an address that is too long is cut by the browser.
const ISSUE_BODY_MAX: usize = 6000;
/// What Sentry takes for a request (bytes). The envelope goes out uncompressed.
const ENVELOPE_MAX: usize = 40_000_000;
/// What the user's files may add up to (bytes): `ENVELOPE_MAX` minus room for `report.txt` (the end of up to a dozen logs)
/// and a screenshot of a large window.
pub const FILES_MAX: usize = 30_000_000;
/// The most the JSON header of a report may weigh: the user's note and an error text.
const HEADER_MAX: usize = 256 * 1024;

fn megabytes(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// The lines `ui.log` took in the current minute, and how many it left out.
struct LineCap {
    since: Option<Instant>,
    taken: usize,
    left_out: usize,
}

impl LineCap {
    /// Whether the line at `now` goes in, and how many lines the minute before left out (to be said once).
    fn ask(&mut self, now: Instant) -> Option<usize> {
        if self.since.is_some_and(|since| now.duration_since(since) < Duration::from_secs(60)) {
            if self.taken >= UI_LOG_LINES_PER_MINUTE {
                self.left_out += 1;
                return None;
            }
            self.taken += 1;
            return Some(0);
        }
        (self.since, self.taken) = (Some(now), 1);
        Some(std::mem::take(&mut self.left_out))
    }
}

static UI_LOG_CAP: Mutex<LineCap> = Mutex::new(LineCap { since: None, taken: 0, left_out: 0 });

/// One line (or one indented block) in `logs\ui.log`, at most `UI_LOG_LINES_PER_MINUTE` a minute.
#[tauri::command]
pub fn ui_log(level: String, text: String, page: Option<String>) -> Result<(), BridgeError> {
    let Some(left_out) = UI_LOG_CAP.lock().unwrap_or_else(|e| e.into_inner()).ask(Instant::now()) else {
        return Ok(());
    };
    let logs = mango_common::data_dir().map_err(|e| err("io", e.to_string()))?.join("logs");
    let file = logs.join("ui.log");
    if std::fs::metadata(&file).map(|m| m.len() > UI_LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&file, logs.join("ui.1.log"));
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| err("io", format!("{}: {e}", file.display())))?;
    let time = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if left_out > 0 {
        writeln!(out, "{time} [ui.log] {left_out} lines left out in the minute before (cap of {UI_LOG_LINES_PER_MINUTE} a minute)").map_err(|e| err("io", format!("{}: {e}", file.display())))?;
    }
    let page = page.map(|p| format!(" {p}")).unwrap_or_default();
    let text = text.trim_end().replace('\n', "\n    ");
    writeln!(out, "{time} [{level}]{page} {text}").map_err(|e| err("io", format!("{}: {e}", file.display())))
}

/// The logs folder in File Explorer.
#[tauri::command]
pub fn open_logs_folder() -> Result<(), BridgeError> {
    let logs = mango_common::data_dir().map_err(|e| err("io", e.to_string()))?.join("logs");
    crate::supervisor::open_outside_job(&logs.display().to_string()).map_err(|e| err("io", format!("{}: {e}", logs.display())))
}

#[derive(Serialize)]
pub struct Sent {
    /// Sent to Mango Code (Sentry). If false, the file is on the Desktop and the GitHub issue is open in the browser.
    sent: bool,
    file: Option<String>,
}

/// What a report may carry, for the page that shows the form (the bridge's `report_info` and `GET /phone/report`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportInfo {
    /// What the user's files may add up to, in bytes.
    max_bytes: usize,
    /// Whether files can be attached: only when the report goes to Sentry (a build of your own writes a text file).
    attachments: bool,
    /// Whether the window can be photographed: not from the phone, where the window is the computer's.
    screenshot: bool,
}

impl ReportInfo {
    fn new(screenshot: bool) -> ReportInfo {
        ReportInfo { max_bytes: FILES_MAX, attachments: SENTRY_DSN.is_some(), screenshot: screenshot && SENTRY_DSN.is_some() }
    }
}

#[tauri::command]
pub fn report_info() -> ReportInfo {
    ReportInfo::new(true)
}

/// A file the user chose or pasted: it goes as it is.
struct Attachment {
    name: String,
    content_type: String,
    bytes: Vec<u8>,
}

/// What the page sends (see the top of the file).
struct Submission {
    error: Option<String>,
    note: Option<String>,
    page: Option<String>,
    screenshot: bool,
    files: Vec<Attachment>,
}

#[derive(Deserialize)]
struct Header {
    error: Option<String>,
    note: Option<String>,
    page: Option<String>,
    #[serde(default)]
    screenshot: bool,
    #[serde(default)]
    files: Vec<FileHeader>,
}

#[derive(Deserialize)]
struct FileHeader {
    name: String,
    #[serde(rename = "type", default)]
    content_type: String,
    size: usize,
}

/// The name of a file as Sentry will show it: no folders, no control characters, not empty.
fn file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).take(120).collect();
    let clean = clean.trim();
    if clean.is_empty() { "file".to_string() } else { clean.to_string() }
}

impl Submission {
    fn parse(body: &[u8]) -> Result<Submission, BridgeError> {
        let invalid = || err("invalid", tr!("segnalazione non valida", "invalid report"));
        let length = u32::from_be_bytes(body.get(..4).and_then(|b| b.try_into().ok()).ok_or_else(invalid)?) as usize;
        if length > HEADER_MAX {
            return Err(err("too_large", tr!("il testo della segnalazione è troppo lungo", "the text of the report is too long")));
        }
        let header: Header = serde_json::from_slice(body.get(4..4 + length).ok_or_else(invalid)?).map_err(|_| invalid())?;
        let mut rest = &body[4 + length..];
        let total = header.files.iter().try_fold(0usize, |sum, f| sum.checked_add(f.size)).ok_or_else(invalid)?;
        if let Some(big) = header.files.iter().find(|f| f.size > FILES_MAX) {
            return Err(err(
                "too_large",
                tr!(
                    "«{}» pesa {}: gli allegati possono arrivare a {} in tutto",
                    "«{}» is {}: attachments can add up to {}",
                    file_name(&big.name),
                    megabytes(big.size),
                    megabytes(FILES_MAX)
                ),
            ));
        }
        if total > FILES_MAX {
            return Err(err(
                "too_large",
                tr!(
                    "gli allegati pesano {}: possono arrivare a {} in tutto",
                    "the attachments are {}: they can add up to {}",
                    megabytes(total),
                    megabytes(FILES_MAX)
                ),
            ));
        }
        if total != rest.len() {
            return Err(err("invalid", tr!("gli allegati non sono arrivati interi", "the attachments did not arrive whole")));
        }
        let mut files = Vec::new();
        for f in header.files {
            let (bytes, tail) = rest.split_at(f.size);
            rest = tail;
            let content_type = if f.content_type.trim().is_empty() { "application/octet-stream".to_string() } else { f.content_type };
            files.push(Attachment { name: file_name(&f.name), content_type, bytes: bytes.to_vec() });
        }
        Ok(Submission { error: header.error, note: header.note, page: header.page, screenshot: header.screenshot, files })
    }
}

/// "Report a problem" from the window: the body described at the top of the file.
#[tauri::command]
pub async fn report_problem(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Sent, BridgeError> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(err("invalid", tr!("segnalazione non valida", "invalid report")));
    };
    let submission = Submission::parse(body)?;
    // The window is captured first: while the report is being prepared the page does not change.
    let png = match (SENTRY_DSN, submission.screenshot, crate::main_window(&app)) {
        (Some(_), true, Some(w)) => window_png(&w).map_err(|e| ui_note(&format!("screenshot: {e:#}"))).ok(),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || deliver(&app, submission, png)).await.map_err(|e| err("io", e.to_string()))?
}

/// Prepares the report and sends it (or, without a Sentry address, writes it on the Desktop and opens the issue).
fn deliver(app: &AppHandle, submission: Submission, png: Option<Vec<u8>>) -> Result<Sent, BridgeError> {
    let version = app.package_info().version.to_string();
    let who = Who::current();
    let Submission { error, note, page, files, .. } = submission;
    if SENTRY_DSN.is_none() && !files.is_empty() {
        return Err(err("invalid", tr!("questa versione non invia allegati", "this build does not send attachments")));
    }
    let report = Report::collect(&version, error, note, page, &who)?;
    let done = match SENTRY_DSN {
        Some(dsn) => report.send(dsn, &version, png, &files).map(|_| Sent { sent: true, file: None })?,
        None => {
            let desktop = app
                .path()
                .desktop_dir()
                .map_err(|_| err("io", tr!("cartella Desktop non trovata", "Desktop folder not found")))?;
            let file = report.write(&desktop)?;
            Sent { sent: false, file: Some(file.display().to_string()) }
        }
    };
    if let Some(file) = &done.file {
        let file = PathBuf::from(file);
        let _ = app.opener().reveal_item_in_dir(&file);
        let issue = issue_url(&Report::computer_of(&file), &file);
        crate::supervisor::open_outside_job(issue.as_str()).map_err(|e| err("io", format!("{issue}: {e}")))?;
    }
    Ok(done)
}

/// The phone's reports (`/phone/report`): the same body as the window's, without the screenshot (the window is the
/// computer's, not the phone's) and without the page (it is the phone's).
pub struct PhoneReports(pub AppHandle);

impl phone::Reports for PhoneReports {
    fn max_body(&self) -> u64 {
        (FILES_MAX + HEADER_MAX + 4) as u64
    }

    fn info(&self) -> serde_json::Value {
        serde_json::to_value(ReportInfo::new(false)).unwrap_or_default()
    }

    fn submit(&self, body: Vec<u8>) -> std::result::Result<serde_json::Value, (u16, String)> {
        let status = |e: &BridgeError| match e.code {
            "too_large" => 413,
            "invalid" => 400,
            _ => 500,
        };
        let mut submission = Submission::parse(&body).map_err(|e| (status(&e), e.message))?;
        submission.screenshot = false;
        submission.page = None;
        let sent = deliver(&self.0, submission, None).map_err(|e| (status(&e), e.message))?;
        serde_json::to_value(sent).map_err(|e| (500, e.to_string()))
    }
}

/// What a report carries, already anonymized.
struct Report {
    note: Option<String>,
    error: Option<String>,
    page: Option<String>,
    computer: Computer,
    /// The text attached (and saved on the Desktop without Sentry): summary, then the end of every log.
    text: String,
}

struct Computer {
    windows: String,
    cpu: String,
    ram_mib: u64,
    gpus: Vec<(String, u64)>,
    model: String,
}

impl Computer {
    fn summary(&self, version: &str) -> String {
        let mut s = format!("Mango Code {version}\n{}\nCPU: {}, RAM {} MiB\n", self.windows, self.cpu, self.ram_mib);
        for (i, (name, mib)) in self.gpus.iter().enumerate() {
            s += &format!("GPU {i}: {name} ({mib} MiB)\n");
        }
        s + &format!("Model: {}", self.model)
    }
}

impl Report {
    fn collect(version: &str, error: Option<String>, note: Option<String>, page: Option<String>, who: &Who) -> Result<Report, BridgeError> {
        let data = mango_common::data_dir().map_err(|e| err("io", e.to_string()))?;
        let clean = |s: Option<String>| s.map(|s| anonymize(s.trim(), who)).filter(|s| !s.is_empty());
        let (error, note, page) = (clean(error), clean(note), clean(page));
        let computer = computer(&data);
        let mut text = format!("# Mango Code problem report\n\n{}\n", computer.summary(version));
        if let Some(p) = &page {
            text += &format!("Page: {p}\n");
        }
        if let Some(n) = &note {
            text += &format!("\n## What the user says\n\n{n}\n");
        }
        if let Some(e) = &error {
            text += &format!("\n## Error\n\n{e}\n");
        }
        text += "\n## Logs (the end of each, oldest change first)\n";
        for log in logs(&data) {
            text += &format!("\n===== {} =====\n{}\n", anonymize(&log.display().to_string(), who), anonymize(&tail(&log), who));
        }
        Ok(Report { note, error, page, computer, text })
    }

    /// One Sentry envelope: the event and its attachments, if it stays within what Sentry takes.
    fn envelope(&self, dsn: &Url, version: &str, png: Option<&[u8]>, files: &[Attachment]) -> Result<Vec<u8>, BridgeError> {
        let id = uuid::Uuid::new_v4().simple().to_string();

        let title = self
            .note
            .as_deref()
            .or(self.error.as_deref())
            .and_then(|t| t.lines().find(|l| !l.trim().is_empty()))
            .unwrap_or("Report from the app")
            .chars()
            .take(200)
            .collect::<String>();
        let c = &self.computer;
        let gpu = c.gpus.first().map(|g| g.0.clone()).unwrap_or_else(|| "none".into());
        let vram: u64 = c.gpus.iter().map(|g| g.1).sum();
        let event = json!({
            "event_id": id,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "platform": "native",
            // always error: Sentry gives "error" high priority, and high priority is what its alert emails about.
            // The `kind` tag tells an error page from a user's report.
            "level": "error",
            "logger": "report-a-problem",
            "release": format!("mango-code@{version}"),
            "environment": if cfg!(debug_assertions) { "development" } else { "production" },
            "message": { "formatted": title },
            "tags": {
                "kind": if self.error.is_some() { "error-page" } else { "user-report" },
                "gpu": gpu,
                "vram_mib": vram.to_string(),
                "model": c.model,
                "ram_mib": c.ram_mib.to_string(),
            },
            "contexts": {
                "os": { "name": "Windows", "version": c.windows },
                "device": { "cpu_description": c.cpu, "memory_size": c.ram_mib * 1024 * 1024 },
                "gpu": { "name": gpu, "memory_size": vram },
            },
            "extra": {
                "note": self.note,
                "error": self.error,
                "page": self.page,
                "gpus": c.gpus.iter().map(|g| format!("{} ({} MiB)", g.0, g.1)).collect::<Vec<_>>(),
            },
        });

        let mut body = Vec::new();
        writeln!(body, "{}", json!({ "event_id": id, "dsn": dsn.as_str(), "sent_at": chrono::Utc::now().to_rfc3339() })).ok();
        let event = serde_json::to_vec(&event).map_err(|e| err("io", e.to_string()))?;
        item(&mut body, json!({ "type": "event", "length": event.len() }), &event);
        let text = self.text.as_bytes();
        item(&mut body, json!({ "type": "attachment", "length": text.len(), "filename": "report.txt", "content_type": "text/plain" }), text);
        if let Some(png) = png {
            item(&mut body, json!({ "type": "attachment", "length": png.len(), "filename": "screenshot.png", "content_type": "image/png" }), png);
        }
        for f in files {
            item(&mut body, json!({ "type": "attachment", "length": f.bytes.len(), "filename": f.name, "content_type": f.content_type }), &f.bytes);
        }
        if body.len() > ENVELOPE_MAX {
            return Err(err(
                "too_large",
                tr!(
                    "la segnalazione pesa {}, più di quanto si può inviare ({}): togli un file o la schermata",
                    "the report is {}, more than can be sent ({}): remove a file or the screenshot",
                    megabytes(body.len()),
                    megabytes(ENVELOPE_MAX)
                ),
            ));
        }
        Ok(body)
    }

    fn send(&self, dsn: &str, version: &str, png: Option<Vec<u8>>, files: &[Attachment]) -> Result<(), BridgeError> {
        let dsn = Url::parse(dsn).map_err(|e| err("invalid", format!("Sentry DSN: {e}")))?;
        let project = dsn.path().trim_matches('/').to_string();
        let host = dsn.host_str().unwrap_or_default();
        let port = dsn.port().map(|p| format!(":{p}")).unwrap_or_default();
        let endpoint = format!("{}://{host}{port}/api/{project}/envelope/", dsn.scheme());
        let body = self.envelope(&dsn, version, png.as_deref(), files)?;
        let key = dsn.username();
        // 30 s and 3 more for every MB: the files of a report can be tens of MB over a slow line
        mango_common::internet::agent(&endpoint, std::time::Duration::from_secs(30 + 3 * (body.len() / 1_000_000) as u64))
            .post(&endpoint)
            .header("Content-Type", "application/x-sentry-envelope")
            .header("X-Sentry-Auth", format!("Sentry sentry_version=7, sentry_client=mango-code/{version}, sentry_key={key}"))
            .send(&body)
            .map_err(|e| {
                let e = mango_common::internet::explain(&e, &endpoint).unwrap_or_else(|| e.to_string());
                err("unavailable", tr!("invio della segnalazione non riuscito: {e}", "the report could not be sent: {e}"))
            })?;
        Ok(())
    }

    /// Without Sentry: the text on the Desktop.
    fn write(&self, desktop: &Path) -> Result<PathBuf, BridgeError> {
        let name = format!("Mango Code - {} {}.txt", tr!("segnalazione", "report"), chrono::Local::now().format("%Y-%m-%d %H.%M.%S"));
        let file = desktop.join(name);
        std::fs::write(&file, &self.text).map_err(|e| err("io", format!("{}: {e}", file.display())))?;
        Ok(file)
    }

    /// The computer's lines at the top of a report file written by `write` (for the issue's body).
    fn computer_of(file: &Path) -> String {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        text.lines().skip_while(|l| !l.starts_with("Mango Code ")).take_while(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
    }
}

/// One item of a Sentry envelope: its header line, then its bytes.
fn item(body: &mut Vec<u8>, header: serde_json::Value, bytes: &[u8]) {
    writeln!(body, "{header}").ok();
    body.extend_from_slice(bytes);
    body.push(b'\n');
}

/// Without Sentry: the address of the new GitHub issue, with title and body already written.
fn issue_url(computer: &str, file: &Path) -> Url {
    let file_name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let body = format!(
        "**{}**\n\n{}\n\n**{}**\n\n```\n{computer}\n```\n\n{}",
        tr!("Cosa è successo", "What happened"),
        tr!("<!-- Cosa stavi facendo e cosa è andato storto. -->", "<!-- What you were doing and what went wrong. -->"),
        tr!("Computer", "Computer"),
        tr!(
            "**Log**: trascina qui il file `{file_name}`, che si è appena aperto in Esplora file (è sul Desktop).",
            "**Logs**: drag here the file `{file_name}`, just opened in File Explorer (it is on the Desktop)."
        )
    );
    let body: String = body.chars().take(ISSUE_BODY_MAX).collect();
    let mut url = Url::parse(NEW_ISSUE).expect("valid address");
    url.query_pairs_mut().append_pair("title", &tr!("Problema: ", "Problem: ")).append_pair("body", &body);
    url
}

/// Windows, processor, memory, cards and the model in use.
fn computer(data: &Path) -> Computer {
    let windows = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .creation_flags(mango_common::CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let model = std::fs::read_to_string(data.join("model.txt")).map(|m| m.trim().to_string()).unwrap_or_default();
    let model = if model.is_empty() { "-".to_string() } else { model };
    match engine_cfg::hardware::detect() {
        Ok(hw) => Computer {
            windows,
            cpu: format!("{} ({} cores)", hw.cpu.name, hw.cpu.cores),
            ram_mib: hw.ram_mib,
            gpus: hw.gpus.iter().map(|g| (g.name.clone(), g.memory_mib)).collect(),
            model,
        },
        Err(e) => Computer { windows, cpu: format!("not read: {e:#}"), ram_mib: 0, gpus: Vec::new(), model },
    }
}

/// The logs of the app, of the agent and of its tools, oldest change first.
fn logs(data: &Path) -> Vec<PathBuf> {
    let dirs = [data.join("logs"), data.join("mcp"), data.join("agent").join("data").join("opencode").join("log")];
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "log"))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
        .collect();
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// The end of a log (`TAIL` bytes). It is read even while the app keeps writing it.
fn tail(path: &Path) -> String {
    let read = || -> std::io::Result<String> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        let start = len.saturating_sub(TAIL);
        f.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Ok(if start > 0 { format!("[... {start} bytes]\n{text}") } else { text })
    };
    read().unwrap_or_else(|e| format!("(not read: {e})"))
}

// ---------------------------------------------------------------- personal data

/// Who uses this PC: what `anonymize` takes out.
struct Who {
    /// The account name and the profile folder's name: with a Microsoft account they differ (`alice.smith`, `Alice`).
    users: Vec<String>,
    /// The PC's name and the Windows domain's (the same when the PC is not in a company).
    computer: Vec<String>,
    /// The profile folder, when it is not under `Users` (there the account's name is already taken out).
    profile: Option<String>,
}

impl Who {
    fn current() -> Who {
        let folder = std::env::var("USERPROFILE").ok().and_then(|p| Some(std::path::Path::new(&p).file_name()?.to_string_lossy().into_owned()));
        let users = std::env::var("USERNAME").ok().into_iter().chain(folder).collect();
        let profile = std::env::var("USERPROFILE").ok().filter(|p| !p.to_lowercase().replace('/', "\\").contains("\\users\\"));
        let computer = ["COMPUTERNAME", "USERDOMAIN"].iter().filter_map(|v| std::env::var(v).ok()).collect();
        Who { users, computer, profile }
    }
}

/// A company's OneDrive folder carries the company's name: `OneDrive - Name`.
static ONEDRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(OneDrive - )[^\\/"'\r\n]+"#).unwrap());
/// A complete IPv6 address (eight groups) or abbreviated with `::` (at least one group before it): a time like `12:34:56` is not one.
static IPV6: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?").unwrap()
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap());
/// IPv4 addresses, except loopback and "any" (`127.x`, `0.0.0.0`), which say nothing about the user.
static IPV4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b").unwrap());
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:sk-[A-Za-z0-9_\-]{16,}|hf_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})").unwrap()
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap());
/// `password=…`, `token: …`, `"api_key":"…"` in a log line or in JSON.
static KEY_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b((?:api[_-]?key|access[_-]?token|token|password|passwd|secret)"?\s*[=:]\s*"?)[^\s"'&,;}]+"#).unwrap()
});
static URL_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([?&](?:k|key|token|access_token|api_key|apikey|password)=)[^&\s\x22']+").unwrap());

/// Takes the user's personal data out of a text: the account name in paths (`C:\Users\<user>`), a profile folder
/// elsewhere, the PC's and the domain's name, a company's OneDrive folder, emails, network addresses, keys and tokens. What a report is for (errors, versions, timings) stays.
fn anonymize(text: &str, who: &Who) -> String {
    let mut s = text.to_string();
    // In paths only: as a plain word the name could be an ordinary word ("Mango").
    // Longest first: "alice.smith" before "Alice".
    let mut names: Vec<&String> = who.users.iter().filter(|u| u.len() >= 2).collect();
    names.sort_by_key(|u| std::cmp::Reverse(u.len()));
    for name in names {
        let user = Regex::new(&format!(r"(?i)(users[\\/]+){}\b", regex::escape(name))).unwrap();
        s = user.replace_all(&s, "${1}<user>").into_owned();
    }
    if let Some(profile) = &who.profile {
        let parts: Vec<String> = profile.split(['\\', '/']).filter(|c| !c.is_empty()).map(regex::escape).collect();
        let folder = Regex::new(&format!(r"(?i){}\b", parts.join(r"[\\\/]+"))).unwrap();
        s = folder.replace_all(&s, "<profile>").into_owned();
    }
    for name in who.computer.iter().filter(|n| n.len() >= 4) {
        let pc = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(name))).unwrap();
        s = pc.replace_all(&s, "<pc>").into_owned();
    }
    s = ONEDRIVE.replace_all(&s, "${1}<org>").into_owned();
    s = EMAIL.replace_all(&s, "<email>").into_owned();
    s = IPV6.replace_all(&s, "<ip>").into_owned();
    s = SECRET.replace_all(&s, "<secret>").into_owned();
    s = BEARER.replace_all(&s, "$1 <secret>").into_owned();
    s = KEY_FIELD.replace_all(&s, "${1}<secret>").into_owned();
    s = URL_KEY.replace_all(&s, "${1}<secret>").into_owned();
    IPV4.replace_all(&s, |c: &regex::Captures| {
        let all = &c[0];
        if (1..=4).any(|i| c[i].parse::<u16>().map_or(true, |n| n > 255)) || all.starts_with("127.") || all == "0.0.0.0" {
            all.to_string()
        } else {
            "<ip>".to_string()
        }
    })
    .into_owned()
}

/// A line in `ui.log` for a step of the report that did not work (the report goes anyway).
fn ui_note(text: &str) -> String {
    let _ = ui_log("report".into(), text.into(), None);
    text.to_string()
}

// ---------------------------------------------------------------- screenshot

/// The app's window as PNG, panel included (`PrintWindow` with `PW_RENDERFULLCONTENT`: WebView2 draws with
/// DirectComposition, and a plain copy of the screen would also catch what covers the window).
fn window_png(window: &tauri::WebviewWindow) -> anyhow::Result<Vec<u8>> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    const PW_RENDERFULLCONTENT: u32 = 2;

    let hwnd = HWND(window.hwnd()?.0);
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)? };
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    anyhow::ensure!(w > 0 && h > 0, "window of size {w}x{h}");
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(HWND::default());
        let dc = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bitmap);
        let printed = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let rows = GetDIBits(dc, bitmap, 0, h as u32, Some(bgra.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(dc, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(dc);
        ReleaseDC(HWND::default(), screen);
        anyhow::ensure!(printed && rows == h, "PrintWindow {printed}, rows {rows} of {h}");
    }
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    let image = image::RgbaImage::from_raw(w as u32, h as u32, bgra).ok_or_else(|| anyhow::anyhow!("image buffer"))?;
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who() -> Who {
        Who { users: vec!["alice.smith".into(), "Alice".into()], computer: vec!["DESKTOP-7Q2K".into()], profile: None }
    }

    /// A profile folder that is not under `Users`, and a work domain.
    fn who_with_a_profile_elsewhere() -> Who {
        Who { users: vec!["anna".into()], computer: vec!["DESKTOP-7Q2K".into(), "AZIENDA".into()], profile: Some(r"D:\Profili\anna".into()) }
    }

    /// One rule per row: the text as it is in the logs and as it leaves.
    #[test]
    fn each_rule_removes_its_datum_and_leaves_the_rest() {
        let rules: [(&str, &str, &str); 9] = [
            ("profile folder outside Users", r"loading D:\Profili\anna\Desktop\x.json", r"loading <profile>\Desktop\x.json"),
            ("the same, escaped as in JSON", r#"{"dir":"D:\\Profili\\anna\\Documents"}"#, r#"{"dir":"<profile>\\Documents"}"#),
            ("the same, with forward slashes and other case", "file:///d:/profili/ANNA/x", "file:///<profile>/x"),
            ("a similar folder is not the profile", r"D:\Profili\anna2\x and D:\Profili\annabella", r"D:\Profili\anna2\x and D:\Profili\annabella"),
            ("work domain", r"AZIENDA\anna in session", r"<pc>\anna in session"),
            ("work OneDrive", r"C:\Users\anna\OneDrive - Rossi Srl\Video\a.mp4", r"C:\Users\<user>\OneDrive - <org>\Video\a.mp4"),
            ("IPv6, abbreviated and complete", "fe80::1c2d:3e4f:5a6b:7c8d and 2001:0db8:85a3:0000:0000:8a2e:0370:7334", "<ip> and <ip>"),
            ("a time and IPv6 loopback stay", "at 12:34:56 on ::1", "at 12:34:56 on ::1"),
            ("the account name outside paths stays", "anna opened Anna Studio", "anna opened Anna Studio"),
        ];
        for (name, before, after) in rules {
            assert_eq!(anonymize(before, &who_with_a_profile_elsewhere()), after, "rule: {name}");
        }
    }

    /// One rule per row, invented data: what each rule takes out and what it must leave.
    #[test]
    fn every_rule_has_its_row() {
        let rules: [(&str, &str, &str); 22] = [
            ("user in a path", r"C:\Users\alice.smith\Desktop\a.txt", r"C:\Users\<user>\Desktop\a.txt"),
            ("user in a path, JSON-escaped", r#"{"p":"C:\\Users\\Alice\\x"}"#, r#"{"p":"C:\\Users\\<user>\\x"}"#),
            ("user in a path, forward slashes", "C:/Users/alice/x", "C:/Users/<user>/x"),
            ("the user's name as a plain word stays", "Alice asked", "Alice asked"),
            ("computer name", "host DESKTOP-7Q2K ready", "host <pc> ready"),
            ("email", "write to alice@example.com now", "write to <email> now"),
            ("IPv4 of a home network", "phone at 192.168.1.50:4097", "phone at <ip>:4097"),
            ("IPv4, public", "peer 203.0.113.9", "peer <ip>"),
            ("loopback and any-address stay", "on 127.0.0.1:8080 and 0.0.0.0", "on 127.0.0.1:8080 and 0.0.0.0"),
            ("a version of four numbers is not an address", "Windows 10.0.19045.1", "Windows 10.0.19045.1"),
            ("a number over 255 anywhere in the four is not an address", "build 10.0.5.300", "build 10.0.5.300"),
            ("sk- key", "key sk-or-v1-0123456789abcdef0123 end", "key <secret> end"),
            ("hf_ token", "hf_abcdefghijklmnopqrstu", "<secret>"),
            ("GitHub token", "ghp_0123456789abcdefABCDEF0123", "<secret>"),
            ("GitHub fine-grained token", "github_pat_11ABCDEFG0123456789_xyz", "<secret>"),
            ("Bearer header", "Authorization: Bearer eyJabc.def12345", "Authorization: Bearer <secret>"),
            ("password in a log line", "password: hunter2 ok", "password: <secret> ok"),
            ("token in a log line", "token=tok987zyx&x=1", "token=<secret>&x=1"),
            ("key in JSON", r#"{"api_key":"zz11yy22"}"#, r#"{"api_key":"<secret>"}"#),
            ("key in an address", "http://x/?k=abc123def&x=1", "http://x/?k=<secret>&x=1"),
            ("an ordinary word is not a key", "task: ready, passwords are checked", "task: ready, passwords are checked"),
            ("a time is not an IPv6 address", "at 12:34:56", "at 12:34:56"),
        ];
        for (name, before, after) in rules {
            assert_eq!(anonymize(before, &who()), after, "rule: {name}");
        }
    }

    #[test]
    fn ui_log_takes_a_hundred_lines_a_minute_and_says_how_many_it_left_out() {
        let mut cap = LineCap { since: None, taken: 0, left_out: 0 };
        let start = Instant::now();
        assert_eq!((0..UI_LOG_LINES_PER_MINUTE).filter(|_| cap.ask(start) == Some(0)).count(), UI_LOG_LINES_PER_MINUTE);
        assert_eq!(cap.ask(start + Duration::from_secs(30)), None);
        assert_eq!(cap.ask(start + Duration::from_secs(59)), None);
        assert_eq!(cap.ask(start + Duration::from_secs(61)), Some(2));
        assert_eq!(cap.ask(start + Duration::from_secs(62)), Some(0));
    }

    #[test]
    fn personal_data_leaves_the_text_and_what_explains_the_problem_stays() {
        let text = r#"loading path="C:\\Users\\Alice\\AppData\\Local\\MangoCode\\opencode.json" from C:/Users/alice/x and C:\Users\Alice\Desktop
host DESKTOP-7Q2K, mail alice@example.com, phone http://192.168.1.50:4097/?k=abc123def&x=1
key sk-or-v1-0123456789abcdef0123 hf_abcdefghijklmnopqrstu Authorization: Bearer eyJabc.def
gh ghp_0123456789abcdefABCDEF0123 github_pat_11ABCDEFG0123456789_xyz token=tok987zyx password: hunter2 {"api_key":"zz11yy22"}
profile C:\Users\alice.smith\x
engine on http://127.0.0.1:8080, listening 0.0.0.0, Mango Code 0.1.0, version 10.0.19045.1"#;
        let s = anonymize(text, &who());
        for gone in ["Alice\\", "alice/", "DESKTOP-7Q2K", "alice@", "192.168.1.50", "abc123def", "sk-or-v1", "hf_abc", "eyJabc", "ghp_01", "github_pat_11", "tok987zyx", "hunter2", "zz11yy22", "alice.smith"] {
            assert!(!s.contains(gone), "{gone} still in:\n{s}");
        }
        for kept in ["Users\\\\<user>\\\\AppData", "C:/Users/<user>/x", "<pc>", "<email>", "<ip>", "127.0.0.1:8080", "0.0.0.0", "Mango Code 0.1.0", "10.0.19045.1"] {
            assert!(s.contains(kept), "{kept} missing in:\n{s}");
        }
    }

    #[test]
    fn the_tail_of_a_long_log_says_how_much_was_left_out() {
        let dir = std::env::temp_dir().join(format!("mango-report-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("big.log");
        std::fs::write(&log, "a".repeat((TAIL + 10) as usize)).unwrap();
        let t = tail(&log);
        assert!(t.starts_with("[... 10 bytes]"));
        assert_eq!(t.matches('a').count(), TAIL as usize);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A body as the page builds it: the length of the header, the header, the files.
    fn body(header: serde_json::Value, files: &[&[u8]]) -> Vec<u8> {
        let head = serde_json::to_vec(&header).unwrap();
        let mut out = (head.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&head);
        files.iter().for_each(|f| out.extend_from_slice(f));
        out
    }

    #[test]
    fn what_the_page_sends_is_read_whole_and_the_files_are_untouched() {
        let bytes = body(
            json!({ "note": "it hangs", "error": null, "page": "http://127.0.0.1:4096/", "screenshot": true,
                    "files": [{ "name": "C:\\Users\\Alice\\Desktop\\screen.png", "type": "image/png", "size": 3 }, { "name": "a.docx", "type": "", "size": 2 }] }),
            &[&[1, 2, 3], &[255, 0]],
        );
        let s = Submission::parse(&bytes).unwrap();
        assert_eq!(s.note.as_deref(), Some("it hangs"));
        assert!(s.screenshot && s.error.is_none());
        let names: Vec<_> = s.files.iter().map(|f| (f.name.as_str(), f.content_type.as_str(), f.bytes.as_slice())).collect();
        // no folders in the name (it carries the user's name), a missing type becomes the generic one, the bytes are the same
        assert_eq!(names, [("screen.png", "image/png", &[1u8, 2, 3][..]), ("a.docx", "application/octet-stream", &[255u8, 0][..])]);
        // no files is a report like before
        assert!(Submission::parse(&body(json!({ "note": "x" }), &[])).unwrap().files.is_empty());
    }

    #[test]
    fn a_file_that_is_too_large_is_refused_with_a_sentence_that_names_it() {
        // one file over the limit (the bytes are not even needed to know)
        let one = body(json!({ "files": [{ "name": "movie.mp4", "type": "video/mp4", "size": FILES_MAX + 1 }] }), &[]);
        let e = Submission::parse(&one).err().unwrap();
        assert_eq!(e.code, "too_large");
        assert!(e.message.contains("movie.mp4") && e.message.contains("30.0 MB"), "{}", e.message);
        // two that are fine alone and not together
        let two = body(json!({ "files": [{ "name": "a", "size": FILES_MAX / 2 + 1 }, { "name": "b", "size": FILES_MAX / 2 + 1 }] }), &[]);
        assert_eq!(Submission::parse(&two).err().unwrap().code, "too_large");
        // exactly the limit passes the size check (it then fails only because the bytes are not there)
        let exact = body(json!({ "files": [{ "name": "a", "size": FILES_MAX }] }), &[]);
        assert_eq!(Submission::parse(&exact).err().unwrap().code, "invalid");
    }

    #[test]
    fn a_body_that_is_cut_or_lies_is_not_read() {
        let whole = body(json!({ "files": [{ "name": "a", "size": 3 }] }), &[&[1, 2, 3]]);
        assert!(Submission::parse(&whole).is_ok());
        for cut in [0, 2, 5, whole.len() - 1] {
            assert_eq!(Submission::parse(&whole[..cut]).err().unwrap().code, "invalid", "cut at {cut}");
        }
        // the header says 2, three come
        let more = body(json!({ "files": [{ "name": "a", "size": 2 }] }), &[&[1, 2, 3]]);
        assert_eq!(Submission::parse(&more).err().unwrap().code, "invalid");
        assert_eq!(Submission::parse(&body(json!("not an object"), &[])).err().unwrap().code, "invalid");
    }

    fn a_report() -> Report {
        Report {
            note: Some("it hangs".into()),
            error: None,
            page: None,
            computer: Computer { windows: "10".into(), cpu: "cpu".into(), ram_mib: 1, gpus: Vec::new(), model: "m".into() },
            text: "the text".into(),
        }
    }

    #[test]
    fn the_envelope_carries_the_files_with_their_exact_lengths_and_stays_under_the_limit() {
        let dsn = Url::parse("https://key@o1.ingest.de.sentry.io/2").unwrap();
        let files = [Attachment { name: "screen.png".into(), content_type: "image/png".into(), bytes: vec![7; 5] }];
        let body = a_report().envelope(&dsn, "0.1.0", None, &files).unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains(r#""filename":"screen.png""#) && text.contains(r#""length":5"#), "{text}");
        assert!(text.contains(r#""filename":"report.txt""#));
        assert!(body.ends_with(&[7, 7, 7, 7, 7, b'\n']));
        // the report alone is small; with the largest allowed files and a large screenshot it can go over: then it says so
        let big = [Attachment { name: "big.bin".into(), content_type: "application/octet-stream".into(), bytes: vec![0; FILES_MAX] }];
        assert!(a_report().envelope(&dsn, "0.1.0", Some(&vec![0; 8_000_000]), &big).is_ok());
        let e = a_report().envelope(&dsn, "0.1.0", Some(&vec![0; 11_000_000]), &big).err().unwrap();
        assert_eq!(e.code, "too_large");
        assert!(e.message.contains("40.0 MB"), "{}", e.message);
    }

    #[path = "../../../../crates/mango-common/src/internet/fake_proxy.rs"]
    mod fake_proxy;

    #[test]
    fn behind_a_company_filter_with_an_unknown_certificate_the_report_says_what_to_do() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Inspect);
        // The one test of this file that touches the environment: the other tests only call this computer, which no proxy sees.
        std::env::set_var("HTTPS_PROXY", &proxy.address);
        let result = a_report().send("https://key@o1.ingest.de.sentry.io/2", "0.1.0", None, &[]);
        std::env::remove_var("HTTPS_PROXY");
        let e = result.unwrap_err();
        assert_eq!(e.code, "unavailable");
        assert!(e.message.contains(&mango_common::internet::certificate_message()), "{}", e.message);
        assert_eq!(proxy.seen(), ["CONNECT o1.ingest.de.sentry.io:443 HTTP/1.1"]);
    }

    #[test]
    fn the_issue_points_to_the_file_on_the_desktop() {
        let url = issue_url("Mango Code 0.1.0\nGPU 0: GTX 1650 (4096 MiB)", Path::new("C:\\Desktop\\report.txt"));
        let body = url.query_pairs().find(|(k, _)| k == "body").map(|(_, v)| v.into_owned()).unwrap();
        assert!(body.contains("GTX 1650") && body.contains("report.txt"));
        assert!(url.as_str().starts_with(NEW_ISSUE));
    }

    /// A Sentry envelope as their ingestion reads it: a header line, then for each item its header and its bytes.
    #[test]
    fn the_envelope_has_one_header_line_per_item_and_the_exact_lengths() {
        let mut body = Vec::new();
        item(&mut body, json!({ "type": "event", "length": 2 }), b"{}");
        item(&mut body, json!({ "type": "attachment", "length": 3, "filename": "window.png" }), &[0, 10, 255]);
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("{\"length\":2,\"type\":\"event\"}\n{}\n") || text.starts_with("{\"type\":\"event\",\"length\":2}\n{}\n"));
        assert_eq!(&body[body.len() - 4..], &[0, 10, 255, b'\n']);
    }
}
