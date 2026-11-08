//! What goes wrong on someone else's PC has to reach us, readable by whoever fixes it (a person or an agent) and
//! without the user's personal data.
//!
//! - `ui_log`: the web UI writes here (see `INIT_SCRIPT` in `bridge.rs`) its uncaught errors, its `console.error`
//!   and the calls to the app that take more than a second. They end up in `logs\ui.log`, next to the logs of the
//!   agent and the engine.
//! - `report_problem` ("Report a problem"): one click. With a Sentry address in the build (`MANGO_SENTRY_DSN`) the
//!   report is sent there: an event with what the user wrote, the error and the computer as separate fields, and two
//!   attachments, `report.txt` (summary and the end of every log) and `screenshot.png` (only if the user leaves the box
//!   ticked). Without it (a build of your own), the same text goes to a file on the Desktop and a GitHub issue opens
//!   already filled in. In both cases the text is anonymized first (`anonymize`).

use crate::bridge::{err, BridgeError};
use mango_common::tr;
use regex::Regex;
use serde::Serialize;
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// Where the reports go: the Sentry project `mango-code` of the `mango-o6` organization (data in the EU). A DSN only
/// lets one send events, it does not read them: it can stay in the source, as in every app that uses Sentry. A build
/// can send elsewhere with `MANGO_SENTRY_DSN`, or nowhere with `MANGO_SENTRY_DSN=off` (then: file and GitHub issue).
const SENTRY_DSN: Option<&str> = match option_env!("MANGO_SENTRY_DSN") {
    Some(d) if d.is_empty() || d.eq_ignore_ascii_case("off") => None,
    Some(d) => Some(d),
    None => Some("https://55ae6f1d9f48b7c1d18c1ff540c0e46a@o4510993915314176.ingest.de.sentry.io/4512397165068368"),
};
const NEW_ISSUE: &str = "https://github.com/Federico-Anastasi/mango-code/issues/new";
/// Above this, `ui.log` becomes `ui.1.log` (the previous one is dropped).
const UI_LOG_MAX: u64 = 2 * 1024 * 1024;
/// How much of the end of each log goes into the report.
const TAIL: u64 = 256 * 1024;
/// The error in the issue address: the whole of it is in the file, and an address that is too long is cut by the browser.
const ERROR_IN_ISSUE: usize = 1500;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One line (or one indented block) in `logs\ui.log`.
#[tauri::command]
pub fn ui_log(level: String, text: String, page: Option<String>) -> Result<(), BridgeError> {
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
    let page = page.map(|p| format!(" {p}")).unwrap_or_default();
    let text = text.trim_end().replace('\n', "\n    ");
    writeln!(out, "{time} [{level}]{page} {text}").map_err(|e| err("io", format!("{}: {e}", file.display())))
}

/// The logs folder in File Explorer.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), BridgeError> {
    let logs = mango_common::data_dir().map_err(|e| err("io", e.to_string()))?.join("logs");
    app.opener().open_path(logs.display().to_string(), None::<&str>).map_err(|e| err("io", format!("{}: {e}", logs.display())))
}

#[derive(Serialize)]
pub struct Sent {
    /// Sent to Mango Code (Sentry). If false, the file is on the Desktop and the GitHub issue is open in the browser.
    sent: bool,
    file: Option<String>,
}

/// "Report a problem". `error`: what the page knows of the problem (the error pages pass theirs); `note`: what the
/// user wrote; `screenshot`: whether to attach the window.
#[tauri::command]
pub async fn report_problem(
    app: AppHandle,
    error: Option<String>,
    note: Option<String>,
    page: Option<String>,
    screenshot: Option<bool>,
) -> Result<Sent, BridgeError> {
    let version = app.package_info().version.to_string();
    // The window is captured first: while the report is being prepared the page does not change.
    let png = match (SENTRY_DSN, screenshot.unwrap_or(false), crate::main_window(&app)) {
        (Some(_), true, Some(w)) => window_png(&w).map_err(|e| ui_note(&format!("screenshot: {e:#}"))).ok(),
        _ => None,
    };
    let desktop = app.path().desktop_dir().ok();
    let done = tauri::async_runtime::spawn_blocking(move || {
        let who = Who::current();
        let report = Report::collect(&version, error, note, page, &who)?;
        match SENTRY_DSN {
            Some(dsn) => report.send(dsn, &version, png).map(|_| Sent { sent: true, file: None }),
            None => {
                let desktop = desktop.ok_or_else(|| err("io", tr!("cartella Desktop non trovata", "Desktop folder not found")))?;
                let file = report.write(&desktop)?;
                Ok(Sent { sent: false, file: Some(file.display().to_string()) })
            }
        }
    })
    .await
    .map_err(|e| err("io", e.to_string()))??;
    if let Some(file) = &done.file {
        let file = PathBuf::from(file);
        let _ = app.opener().reveal_item_in_dir(&file);
        let issue = issue_url(&Report::computer_of(&file), &file);
        app.opener().open_url(issue.as_str(), None::<&str>).map_err(|e| err("io", format!("{issue}: {e}")))?;
    }
    Ok(done)
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

    /// One Sentry envelope: the event and its attachments.
    fn send(&self, dsn: &str, version: &str, png: Option<Vec<u8>>) -> Result<(), BridgeError> {
        let dsn = Url::parse(dsn).map_err(|e| err("invalid", format!("Sentry DSN: {e}")))?;
        let project = dsn.path().trim_matches('/').to_string();
        let host = dsn.host_str().unwrap_or_default();
        let port = dsn.port().map(|p| format!(":{p}")).unwrap_or_default();
        let endpoint = format!("{}://{host}{port}/api/{project}/envelope/", dsn.scheme());
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
        if let Some(png) = &png {
            item(&mut body, json!({ "type": "attachment", "length": png.len(), "filename": "screenshot.png", "content_type": "image/png" }), png);
        }

        let key = dsn.username();
        ureq::post(&endpoint)
            .timeout(std::time::Duration::from_secs(30))
            .set("Content-Type", "application/x-sentry-envelope")
            .set("X-Sentry-Auth", &format!("Sentry sentry_version=7, sentry_client=mango-code/{version}, sentry_key={key}"))
            .send_bytes(&body)
            .map_err(|e| err("unavailable", tr!("invio della segnalazione non riuscito: {e}", "the report could not be sent: {e}")))?;
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
    let body: String = body.chars().take(ERROR_IN_ISSUE * 4).collect();
    let mut url = Url::parse(NEW_ISSUE).expect("valid address");
    url.query_pairs_mut().append_pair("title", &tr!("Problema: ", "Problem: ")).append_pair("body", &body);
    url
}

/// Windows, processor, memory, cards and the model in use.
fn computer(data: &Path) -> Computer {
    let windows = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
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
    computer: String,
}

impl Who {
    fn current() -> Who {
        let folder = std::env::var("USERPROFILE").ok().and_then(|p| Some(std::path::Path::new(&p).file_name()?.to_string_lossy().into_owned()));
        let users = std::env::var("USERNAME").ok().into_iter().chain(folder).collect();
        Who { users, computer: std::env::var("COMPUTERNAME").unwrap_or_default() }
    }
}

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

/// Takes the user's personal data out of a text: the account name in paths (`C:\Users\<user>`), the PC's name,
/// emails, network addresses, keys and tokens. What a report is for (errors, versions, timings) stays.
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
    if who.computer.len() >= 4 {
        let pc = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(&who.computer))).unwrap();
        s = pc.replace_all(&s, "<pc>").into_owned();
    }
    s = EMAIL.replace_all(&s, "<email>").into_owned();
    s = SECRET.replace_all(&s, "<secret>").into_owned();
    s = BEARER.replace_all(&s, "$1 <secret>").into_owned();
    s = KEY_FIELD.replace_all(&s, "${1}<secret>").into_owned();
    s = URL_KEY.replace_all(&s, "${1}<secret>").into_owned();
    IPV4.replace_all(&s, |c: &regex::Captures| {
        let all = &c[0];
        if c[1].parse::<u16>().map_or(true, |n| n > 255) || all.starts_with("127.") || all == "0.0.0.0" {
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
    for px in bgra.chunks_exact_mut(4) {
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
        Who { users: vec!["alice.smith".into(), "Alice".into()], computer: "DESKTOP-7Q2K".into() }
    }

    #[test]
    fn personal_data_leaves_the_text_and_what_explains_the_problem_stays() {
        let text = r#"loading path="C:\\Users\\Alice\\AppData\\Local\\MangoCode\\opencode.json" from C:/Users/alice/x and C:\Users\Alice\Desktop
host DESKTOP-7Q2K, mail alice@example.com, phone http://192.168.1.50:4097/?k=abc123def&x=1
key sk-or-v1-0123456789abcdef0123 hf_abcdefghijklmnopqrstu Authorization: Bearer eyJabc.def
gh ghp_0123456789abcdefABCDEF0123 github_pat_11ABCDEFG0123456789_xyz token=tok987zyx password: hunter2 {"api_key":"zz11yy22"}
profile C:\Users\alice.smith\x
engine on http://127.0.0.1:8080, listening 0.0.0.0, Mango Code 0.1.0, version 10.0.26200.9711"#;
        let s = anonymize(text, &who());
        for gone in ["Alice\\", "alice/", "DESKTOP-7Q2K", "alice@", "192.168.1.50", "abc123def", "sk-or-v1", "hf_abc", "eyJabc", "ghp_01", "github_pat_11", "tok987zyx", "hunter2", "zz11yy22", "alice.smith"] {
            assert!(!s.contains(gone), "{gone} still in:\n{s}");
        }
        for kept in ["Users\\\\<user>\\\\AppData", "C:/Users/<user>/x", "<pc>", "<email>", "<ip>", "127.0.0.1:8080", "0.0.0.0", "Mango Code 0.1.0", "10.0.26200.9711"] {
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
