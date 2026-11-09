//! Bridge between the web UI and Windows: native folder picker, new project,
//! images from the clipboard, external links, opening project files.
//!
//! `INIT_SCRIPT` runs in every page of the window before the page scripts and
//! defines `window.__MANGO_DESKTOP__`, which the agent's web UI uses if it is there.
//!
//! The commands live in a plugin (`mango-bridge`) and not among the app commands: the web UI is a
//! remote page (127.0.0.1) and Tauri lets it call only commands with explicit permissions. For the
//! app commands the permissions exist only with a manifest that lists ALL the commands, including
//! those of `lib.rs`; for a plugin the manifest concerns only the plugin (see `build.rs`).

use mango_common::tr;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{
    ipc::Response,
    plugin::Builder,
    webview::{NewWindowResponse, WebviewWindowBuilder},
    App, AppHandle, Manager, Url, Window, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const INIT_SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke("plugin:mango-bridge|" + cmd, args);

  // What goes wrong in the page ends up in logs\ui.log (report.rs): uncaught errors, console.error, and the calls
  // to the app that take more than a second or never answer. At most 100 lines a minute.
  let budget = 100;
  setInterval(() => (budget = 100), 60000);
  const log = (level, text) => {
    if (budget <= 0) return;
    budget--;
    invoke("ui_log", { level, text: String(text).slice(0, 4000), page: location.pathname }).catch(() => {});
  };
  const describe = (v) => {
    if (v instanceof Error) return v.stack || String(v);
    if (typeof v !== "object" || v === null) return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  addEventListener("error", (e) => {
    // the browser's warning about a ResizeObserver that resizes what it observes: harmless, and it would fill the log
    if (!e.error && String(e.message).startsWith("ResizeObserver loop")) return;
    log("error", e.error ? describe(e.error) : `${e.message} (${e.filename}:${e.lineno})`);
  });
  addEventListener("unhandledrejection", (e) => log("error", "unhandled rejection: " + describe(e.reason)));
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    consoleError(...args);
    log("console", args.map(describe).join(" "));
  };
  // These wait for the user (a dialog) or do slow work on purpose: their time says nothing.
  const waits = new Set(["pick_folders", "report_problem", "update_check"]);
  const call = (cmd, args) => {
    if (waits.has(cmd)) return invoke(cmd, args);
    const t0 = performance.now();
    let settled = false;
    const late = setTimeout(() => settled || log("slow", `${cmd}: no answer after 5 s`), 5000);
    const p = invoke(cmd, args);
    p.finally(() => {
      settled = true;
      clearTimeout(late);
      const ms = Math.round(performance.now() - t0);
      if (ms > 1000) log("slow", `${cmd}: ${ms} ms`);
    }).catch(() => {});
    return p;
  };

  window.__MANGO_DESKTOP__ = Object.freeze({
    // "Report a problem" ({ error?, note?, screenshot?, files? }; files are File objects the user chose, they go as they
    // are): logs, computer and (if asked) the window go to Mango Code, anonymized; resolves with { sent: true }. A build
    // without the Sentry address writes a file on the Desktop and opens a GitHub issue instead: { sent: false, file }.
    // The body is the one report.rs reads: the length of a JSON header (4 bytes), the header, the files one after the other.
    reportProblem: async (o) => {
      const files = Array.from(o?.files ?? []);
      const header = new TextEncoder().encode(JSON.stringify({
        error: o?.error ?? null, note: o?.note ?? null, page: location.href, screenshot: !!o?.screenshot,
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      }));
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, header.length);
      return call("report_problem", await new Blob([length, header, ...files]).arrayBuffer());
    },
    // What a report may carry: { maxBytes (the user's files together), attachments, screenshot }
    reportInfo: () => call("report_info"),
    // the app's logs folder in File Explorer
    openLogs: () => call("open_logs_folder"),
    // Automatic updates: state() and check() give { status, version?, percent?, message? } (the web UI's UpdaterState);
    // install() stops agent and engine, runs the installer and closes the app. Changes arrive as "mango-update" on window.
    updates: Object.freeze({
      state: () => call("update_state"),
      check: () => call("update_check"),
      install: () => call("update_install"),
    }),
    // folders chosen in the Windows picker (array), or null if the user cancels
    pickDirectories: (opts) => call("pick_folders", { title: opts?.title ?? null, multiple: !!opts?.multiple }),
    // the folder where "New project" creates projects if another one is not chosen (Documents\Mango Code)
    projectsFolder: () => call("projects_folder"),
    // creates <folder>\<name> (without a folder: the default one) and returns its path; rejects with { code, message }
    createProject: (name, parent) => call("create_project", { name, parent: parent ?? null }),
    // PNG (ArrayBuffer) from the native clipboard, or null if there is no image
    readClipboardImage: async () => {
      const png = await call("read_clipboard_image");
      return png && png.byteLength ? png : null;
    },
    openExternal: (url) => call("open_external", { url }),
    // the choice of models to download ("Models and engine"): the window moves to the app page
    openModels: () => call("open_models"),
    // project files (absolute path): { size, isDir }, opening with the default program, selecting in File Explorer;
    // they reject with { code, message } (not_found, forbidden, blocked_type, ...)
    fileInfo: (path) => call("file_info", { path }),
    openPath: (path) => call("open_path", { path }),
    revealPath: (path) => call("reveal_path", { path }),
    // Preview panel (native browser next to the chat). place: rectangle of the placeholder in CSS pixels,
    // devicePixelRatio and zoom of the page in the panel; changes arrive as a "mango-preview" event on window
    preview: Object.freeze({
      place: (r) => call("preview_place", r),
      go: (url) => call("preview_go", { url }),
      nav: (action) => call("preview_nav", { action }),
      state: () => call("preview_state"),
      openExternal: () => call("preview_external"),
    }),
    // "Use my Chrome": { installed, debugging, enabled }; setEnabled rejects with chrome_missing / chrome_debug_off
    chrome: Object.freeze({
      info: () => call("chrome_info"),
      setEnabled: (enabled) => call("chrome_set_enabled", { enabled }),
    }),
    // The Team: info() = { key, agents, max, manager, agent, models: [{ key, label }] } (never the key);
    // setKey/removeKey/save restart the agent; they reject with { code, message } (invalid_key, invalid_choices, io)
    team: Object.freeze({
      info: () => call("team_info"),
      setKey: (key) => call("team_set_key", { key }),
      removeKey: () => call("team_remove_key"),
      save: (agents, manager, agent) => call("team_save", { agents, manager, agent }),
    }),
    // "From your phone": { enabled, listening, port, error, home, away } (home and away: { address, link, qr } or null)
    phone: Object.freeze({
      state: () => call("phone_state"),
      setEnabled: (enabled) => call("phone_set_enabled", { enabled }),
      newKey: () => call("phone_new_key"),
    }),
  });

  // Windows title bar of the same color as the top of the page: it recolors itself
  // when the theme changes (of the web UI or of the system).
  let last = "";
  const bg = (el) => {
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || +m[4] > 0.5)) return [+m[1], +m[2], +m[3]].map(Math.round);
    }
    return null;
  };
  const sync = () => {
    if (!document.body) return;
    const rgb = bg(document.elementFromPoint(innerWidth / 2, 2)) || bg(document.body);
    if (!rgb || rgb.join() === last) return;
    last = rgb.join();
    call("set_titlebar_color", { r: rgb[0], g: rgb[1], b: rgb[2] }).catch(() => {});
  };
  addEventListener("DOMContentLoaded", sync);
  addEventListener("load", sync);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(sync, 50));
  setInterval(sync, 1000);

  // The zoom (Ctrl+ / Ctrl- / Ctrl+0 are the browser's): after a change of the page scale the app
  // remembers it for the next start.
  let zooming;
  addEventListener("resize", () => {
    clearTimeout(zooming);
    zooming = setTimeout(() => call("remember_zoom", { pageScale: devicePixelRatio }).catch(() => {}), 800);
  });

  // Last page of the web UI (project or conversation): the app reopens it at the next start.
  let page = "";
  setInterval(() => {
    if (location.protocol !== "http:" || location.href === page) return;
    page = location.href;
    call("remember_page", { url: page }).catch(() => {});
  }, 1000);
})();
"#;

/// Registers the bridge commands together with the ones passed (those of lib.rs).
macro_rules! handlers {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![$($extra),*]
    };
}
pub(crate) use handlers;

/// Error of the commands: the web UI reads `code` to choose the text (in Italian or English),
/// `message` is the technical detail.
#[derive(Serialize, Debug)]
pub struct BridgeError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

pub(crate) fn err(code: &'static str, message: impl Into<String>) -> BridgeError {
    BridgeError { code, message: message.into() }
}

// ---------------------------------------------------------------- folders

/// Windows folder picker (it already has "New folder"). `None` if the user cancels.
#[tauri::command]
async fn pick_folders(
    app: AppHandle,
    window: Window,
    title: Option<String>,
    multiple: bool,
) -> Result<Option<Vec<String>>, BridgeError> {
    let mut dialog = app.dialog().file().set_parent(&window).set_can_create_directories(true);
    if let Some(t) = title {
        dialog = dialog.set_title(t);
    }
    let picked = if multiple {
        dialog.blocking_pick_folders()
    } else {
        dialog.blocking_pick_folder().map(|p| vec![p])
    };
    let Some(picked) = picked else { return Ok(None) };
    picked
        .into_iter()
        .map(|p| {
            p.into_path()
                .map(|p| p.display().to_string())
                .map_err(|e| err("io", tr!("percorso non valido: {e}", "invalid path: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Valid Windows folder name, already trimmed of spaces at the edges.
fn valid_folder_name(raw: &str) -> Result<&str, BridgeError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(err("invalid", tr!("il nome è vuoto", "the name is empty")));
    }
    if name.chars().count() > 100 {
        return Err(err("invalid", tr!("il nome supera i 100 caratteri", "the name is longer than 100 characters")));
    }
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err(err("invalid", tr!("il nome contiene caratteri non ammessi da Windows", "the name contains characters Windows does not allow")));
    }
    if name.ends_with('.') {
        return Err(err("invalid", tr!("il nome non può finire con un punto", "the name cannot end with a dot")));
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(err("invalid", tr!("nome riservato da Windows", "name reserved by Windows")));
    }
    Ok(name)
}

pub(crate) fn projects_root(app: &AppHandle) -> Result<PathBuf, BridgeError> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| err("io", tr!("cartella Documenti non trovata: {e}", "Documents folder not found: {e}")))?;
    Ok(docs.join("Mango Code"))
}

fn create_in(root: &Path, raw: &str) -> Result<PathBuf, BridgeError> {
    let name = valid_folder_name(raw)?;
    std::fs::create_dir_all(root).map_err(|e| err("io", format!("{}: {e}", root.display())))?;
    let dir = root.join(name);
    match std::fs::create_dir(&dir) {
        Ok(()) => Ok(dir),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(err("exists", dir.display().to_string())),
        Err(e) => Err(err("io", format!("{}: {e}", dir.display()))),
    }
}

#[tauri::command]
fn projects_folder(app: AppHandle) -> Result<String, BridgeError> {
    projects_root(&app).map(|p| p.display().to_string())
}

/// Creates `<parent>\<name>` (without `parent`, `Documents\Mango Code\<name>`) and returns the path.
#[tauri::command]
async fn create_project(app: AppHandle, name: String, parent: Option<String>) -> Result<String, BridgeError> {
    let root = match parent {
        Some(p) => PathBuf::from(p),
        None => projects_root(&app)?,
    };
    create_in(&root, &name).map(|p| p.display().to_string())
}

// ---------------------------------------------------------------- clipboard

/// Above this threshold (bytes) an image file copied from File Explorer is not brought into the prompt.
const MAX_CLIPBOARD_FILE: u64 = 25 * 1024 * 1024;

fn encode_png(img: &image::DynamicImage) -> Result<Vec<u8>, BridgeError> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| err("io", format!("PNG encoding: {e}")))?;
    Ok(out.into_inner())
}

/// First image among the copied files (File Explorer), as PNG.
fn clipboard_file_image(files: &[PathBuf]) -> Result<Option<Vec<u8>>, BridgeError> {
    const EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    let Some(path) = files.iter().find(|f| {
        f.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| EXT.iter().any(|x| x.eq_ignore_ascii_case(e)))
    }) else {
        return Ok(None);
    };
    let size = std::fs::metadata(path).map_err(|e| err("io", format!("{}: {e}", path.display())))?.len();
    if size > MAX_CLIPBOARD_FILE {
        return Err(err("too_large", format!("{}: {size} bytes", path.display())));
    }
    let bytes = std::fs::read(path).map_err(|e| err("io", format!("{}: {e}", path.display())))?;
    let img = image::load_from_memory(&bytes).map_err(|e| err("io", format!("{}: {e}", path.display())))?;
    encode_png(&img).map(Some)
}

/// Image in the native clipboard (bitmap, or first image file copied from File Explorer) as PNG.
/// Empty response if there is nothing to paste.
#[tauri::command]
async fn read_clipboard_image() -> Result<Response, BridgeError> {
    use arboard::Error;
    let clipboard_error = |e: Error| err("io", tr!("appunti: {e}", "clipboard: {e}"));
    let mut clip = arboard::Clipboard::new().map_err(clipboard_error)?;
    match clip.get_image() {
        Ok(data) => {
            let rgba = image::RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
                .ok_or_else(|| err("io", tr!("immagine degli appunti incoerente", "inconsistent clipboard image")))?;
            return Ok(Response::new(encode_png(&image::DynamicImage::ImageRgba8(rgba))?));
        }
        Err(Error::ContentNotAvailable) => {}
        Err(e) => return Err(clipboard_error(e)),
    }
    match clip.get().file_list() {
        Ok(files) => Ok(Response::new(clipboard_file_image(&files)?.unwrap_or_default())),
        Err(Error::ContentNotAvailable) => Ok(Response::new(Vec::new())),
        Err(e) => Err(clipboard_error(e)),
    }
}

// ---------------------------------------------------------------- external links

/// Opens in the default browser only http, https and mailto: no local files or other schemes.
fn open_in_browser(url: &str) -> Result<(), BridgeError> {
    let parsed = Url::parse(url).map_err(|e| err("invalid", format!("{url}: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(err("invalid", tr!("schema non ammesso: {}", "scheme not allowed: {}", parsed.scheme())));
    }
    crate::supervisor::open_outside_job(parsed.as_str()).map_err(|e| err("io", format!("{url}: {e}")))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), BridgeError> {
    open_in_browser(&url)
}

/// A page of the app itself: local loading page or web UI on the agent server. Nothing else may take the window's
/// place: a local file (file://) the agent made, opened there by mistake, replaced the whole app.
fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost")),
        "tauri" | "about" => true,
        _ => false,
    }
}

// ---------------------------------------------------------------- project files

/// Extensions that Windows runs instead of opening them with a program: they are never launched from here.
const EXECUTABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "mst", "hta", "cpl", "msc", "lnk", "url", "reg", "inf",
    "scf", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "jar", "py", "pyw", "application", "gadget", "dll",
    "sys",
];

fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXECUTABLE.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Project folders the agent server knows (main folder and any working copies).
pub(crate) fn agent_projects() -> Result<Vec<PathBuf>, BridgeError> {
    let url = format!("http://127.0.0.1:{}/project", crate::agent_port());
    let body = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .map_err(|e| err("unavailable", format!("{url}: {e}")))?
        .into_string()
        .map_err(|e| err("unavailable", format!("{url}: {e}")))?;
    let list: Vec<serde_json::Value> = serde_json::from_str(&body)
        .map_err(|e| err("unavailable", tr!("{url}: risposta non valida: {e}", "{url}: invalid response: {e}")))?;
    Ok(project_dirs(&list))
}

/// The folders of the agent's projects and their sandboxes. The agent also lists a "global" project whose folder is `/`: the
/// root of a disk is every folder, not a project, so roots are left out (otherwise every file on C: would count as "in a project").
fn project_dirs(list: &[serde_json::Value]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for p in list {
        dirs.extend(p.get("worktree").and_then(|w| w.as_str()).map(PathBuf::from));
        let sandboxes = p.get("sandboxes").and_then(|s| s.as_array());
        dirs.extend(sandboxes.into_iter().flatten().filter_map(|s| s.as_str()).map(PathBuf::from));
    }
    dirs.retain(|d| d.parent().is_some());
    dirs
}

#[cfg(test)]
mod project_dirs_tests {
    use super::*;

    #[test]
    fn the_global_project_and_disk_roots_are_not_projects() {
        let list = serde_json::json!([
            { "worktree": "/" },
            { "worktree": "C:\\", "sandboxes": ["D:\\"] },
            { "worktree": "C:\\Users\\Alice\\Documents\\Mango Code\\ricette", "sandboxes": ["C:\\Users\\Alice\\sandbox-1"] }
        ]);
        let dirs = project_dirs(list.as_array().unwrap());
        assert_eq!(
            dirs,
            vec![PathBuf::from("C:\\Users\\Alice\\Documents\\Mango Code\\ricette"), PathBuf::from("C:\\Users\\Alice\\sandbox-1")]
        );
    }
}

/// Is `real` (already resolved, without `..` or links) inside one of the allowed folders?
fn inside_any(real: &Path, areas: &[PathBuf]) -> bool {
    areas.iter().filter_map(|a| std::fs::canonicalize(a).ok()).any(|a| real.starts_with(a))
}

/// Windows path without the `\\?\` prefix that `canonicalize` adds: Windows programs do not like it.
pub(crate) fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// An existing file or folder inside a project or in `Documents\Mango Code`; nothing else.
/// The web UI passes paths that come from the agent: here we decide what it is lawful to touch.
async fn allowed_path(app: &AppHandle, raw: String) -> Result<PathBuf, BridgeError> {
    let path = PathBuf::from(&raw);
    if !path.is_absolute() {
        return Err(err("invalid", tr!("percorso non assoluto: {raw}", "path is not absolute: {raw}")));
    }
    let docs = projects_root(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let real = std::fs::canonicalize(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => err("not_found", path.display().to_string()),
            _ => err("io", format!("{}: {e}", path.display())),
        })?;
        let mut areas = vec![docs];
        areas.extend(agent_projects()?);
        if inside_any(&real, &areas) {
            Ok(real)
        } else {
            Err(err("forbidden", tr!("{} non è in un progetto", "{} is not in a project", real.display())))
        }
    })
    .await
    .map_err(|e| err("io", e.to_string()))?
}

#[derive(Serialize)]
struct FileInfo {
    size: u64,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

/// Size of a project file (for the card in the chat). `not_found` if it was deleted.
#[tauri::command]
async fn file_info(app: AppHandle, path: String) -> Result<FileInfo, BridgeError> {
    let real = allowed_path(&app, path).await?;
    let meta = std::fs::metadata(&real).map_err(|e| err("io", format!("{}: {e}", real.display())))?;
    Ok(FileInfo { size: if meta.is_dir() { 0 } else { meta.len() }, is_dir: meta.is_dir() })
}

/// Opens the file with the default Windows program (folders in File Explorer).
#[tauri::command]
async fn open_path(app: AppHandle, path: String) -> Result<(), BridgeError> {
    let real = allowed_path(&app, path).await?;
    if real.is_file() && is_executable(&real) {
        return Err(err("blocked_type", real.display().to_string()));
    }
    crate::supervisor::open_outside_job(&plain(&real).to_string_lossy()).map_err(|e| err("io", format!("{}: {e}", real.display())))
}

/// Shows the file in File Explorer, already selected.
#[tauri::command]
async fn reveal_path(app: AppHandle, path: String) -> Result<(), BridgeError> {
    let real = allowed_path(&app, path).await?;
    app.opener()
        .reveal_item_in_dir(plain(&real))
        .map_err(|e| err("io", format!("{}: {e}", real.display())))
}

// ---------------------------------------------------------------- last page

/// Saves the last page of the web UI; `lib.rs` reopens it at startup.
#[tauri::command]
fn remember_page(url: String) -> Result<(), BridgeError> {
    let parsed = Url::parse(&url).map_err(|e| err("invalid", format!("{url}: {e}")))?;
    // Only web UI pages (agent server): the loading page is also http
    // (http://tauri.localhost) and, saved at startup, it erased the conversation to reopen.
    if parsed.scheme() != "http" || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err(err("invalid", tr!("pagina non della web UI: {url}", "not a web UI page: {url}")));
    }
    let f = mango_common::last_page_file().map_err(|e| err("io", e.to_string()))?;
    std::fs::write(&f, parsed.as_str()).map_err(|e| err("io", format!("{}: {e}", f.display())))
}

// ---------------------------------------------------------------- models

/// "Models and engine": the window moves to the choice of models to download, like the tray item.
/// Async, so it runs off the window's thread: a synchronous command runs on it, and showing the window from there
/// waits for that same thread (the app froze).
#[tauri::command]
async fn open_models(app: AppHandle) {
    crate::choice::change(&app);
}

// ---------------------------------------------------------------- title bar

/// Colors the Windows title bar (Windows 11; on Windows 10 it stays the system one).
/// Text and buttons become light on a dark background and dark on a light one.
#[tauri::command]
fn set_titlebar_color(window: Window, r: u8, g: u8, b: u8) -> Result<(), BridgeError> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
    };
    let hwnd = HWND(window.hwnd().map_err(|e| err("io", tr!("finestra: {e}", "window: {e}")))?.0);
    // perceived luminance: above half scale the background is light
    let dark = (299 * r as u32 + 587 * g as u32 + 114 * b as u32) / 1000 < 128;
    let caption: u32 = r as u32 | (g as u32) << 8 | (b as u32) << 16; // COLORREF = 0x00BBGGRR
    let text: u32 = if dark { 0x00F0F0F0 } else { 0x00101010 };
    let dark_mode = BOOL::from(dark);
    unsafe {
        let set = |attr, ptr: *const std::ffi::c_void, size: usize| {
            DwmSetWindowAttribute(hwnd, attr, ptr, size as u32)
        };
        set(DWMWA_USE_IMMERSIVE_DARK_MODE, &dark_mode as *const _ as _, std::mem::size_of::<BOOL>())
            .map_err(|e| err("io", tr!("tema scuro della barra: {e}", "title bar dark theme: {e}")))?;
        set(DWMWA_CAPTION_COLOR, &caption as *const _ as _, 4)
            .map_err(|e| err("io", tr!("colore della barra: {e}", "title bar color: {e}")))?;
        set(DWMWA_TEXT_COLOR, &text as *const _ as _, 4)
            .map_err(|e| err("io", tr!("colore del titolo: {e}", "title text color: {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- window

/// Registers the bridge plugin.
pub fn install(app: &App) -> tauri::Result<()> {
    app.handle().plugin(
        Builder::<Wry>::new("mango-bridge")
            .invoke_handler(tauri::generate_handler![
                pick_folders,
                projects_folder,
                create_project,
                read_clipboard_image,
                open_external,
                file_info,
                open_path,
                reveal_path,
                set_titlebar_color,
                remember_page,
                crate::zoom::remember_zoom,
                open_models,
                crate::preview::preview_place,
                crate::preview::preview_go,
                crate::preview::preview_nav,
                crate::preview::preview_state,
                crate::preview::preview_external,
                crate::chrome::chrome_info,
                crate::chrome::chrome_set_enabled,
                crate::team::team_info,
                crate::team::team_set_key,
                crate::team::team_remove_key,
                crate::team::team_save,
                crate::phone::phone_state,
                crate::phone::phone_set_enabled,
                crate::phone::phone_new_key,
                crate::report::ui_log,
                crate::report::report_problem,
                crate::report::report_info,
                crate::report::open_logs_folder,
                crate::updater::update_state,
                crate::updater::update_check,
                crate::updater::update_install
            ])
            .build(),
    )
}

/// Main window options that the bridge needs: script, file drag and drop, and external links.
pub fn window<'a>(
    builder: WebviewWindowBuilder<'a, Wry, App>,
    app: &AppHandle,
) -> WebviewWindowBuilder<'a, Wry, App> {
    let for_nav = app.clone();
    builder
        .initialization_script(INIT_SCRIPT)
        // Tauri intercepts drag&drop by default and the page would not receive the HTML5 events
        .disable_drag_drop_handler()
        // target=_blank and window.open: never a second app window, always the default browser
        .on_new_window(move |url, _| {
            if let Err(e) = open_in_browser(url.as_str()) {
                eprintln!("external link not opened: {}", e.message);
            }
            NewWindowResponse::Deny
        })
        // a link without a target that would take the window out of the app goes to the browser
        .on_navigation(move |url| {
            // The app's first page is the loading one: we come back to it for the model choice.
            if url.host_str() == Some("tauri.localhost") {
                let _ = for_nav.state::<crate::AppState>().app_page.set(url.clone());
            }
            if is_internal(url) {
                return true;
            }
            if let Err(e) = open_in_browser(url.as_str()) {
                eprintln!("external link not opened: {}", e.message);
            }
            false
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_and_invalid_names() {
        assert_eq!(valid_folder_name("  My site ").unwrap(), "My site");
        assert_eq!(valid_folder_name("v1.2").unwrap(), "v1.2");
        for bad in ["", "   ", "a/b", "a\\b", "a:b", "a*", "a?", "a\"b", "a<b", "a|b", "end.", "con", "NUL.txt", "lpt3"] {
            assert!(valid_folder_name(bad).is_err(), "{bad:?} should have been rejected");
        }
        assert!(valid_folder_name(&"x".repeat(101)).is_err());
        assert!(valid_folder_name("console").is_ok());
    }

    #[test]
    fn creates_and_rejects_a_duplicate() {
        let root = std::env::temp_dir().join(format!("mango-bridge-test-{}", std::process::id()));
        let dir = create_in(&root, "Test").unwrap();
        assert!(dir.is_dir());
        let e = create_in(&root, "Test").unwrap_err();
        assert_eq!(e.code, "exists");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn internal_and_external_links() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_internal(&u("http://127.0.0.1:4096/abc")));
        assert!(is_internal(&u("http://tauri.localhost/index.html")));
        assert!(is_internal(&u("tauri://localhost/index.html")));
        assert!(!is_internal(&u("https://example.com/")));
        assert!(!is_internal(&u("mailto:a@b.it")));
        assert!(!is_internal(&u("file:///C:/Users/a/site/index.html")));
        assert!(!is_internal(&u("data:text/html,hello")));
    }

    #[test]
    fn project_files() {
        let base = std::env::temp_dir().join(format!("mango-bridge-files-{}", std::process::id()));
        let project = base.join("project");
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(project.join("sub")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(project.join("sub").join("a.docx"), b"x").unwrap();
        std::fs::write(elsewhere.join("b.docx"), b"x").unwrap();
        let areas = vec![project.clone()];

        let inside = std::fs::canonicalize(project.join("sub").join("a.docx")).unwrap();
        assert!(inside_any(&inside, &areas));
        let outside = std::fs::canonicalize(elsewhere.join("b.docx")).unwrap();
        assert!(!inside_any(&outside, &areas));
        // with `..` the resolved path leaves the project
        let escaped = std::fs::canonicalize(project.join("sub").join("..").join("..").join("elsewhere").join("b.docx")).unwrap();
        assert!(!inside_any(&escaped, &areas));
        // a folder with the same prefix in the name is not the same folder
        std::fs::create_dir_all(base.join("project-bis")).unwrap();
        let neighbor = std::fs::canonicalize(base.join("project-bis")).unwrap();
        assert!(!inside_any(&neighbor, &areas));
        // an area that does not exist admits nothing
        assert!(!inside_any(&inside, &[base.join("does-not-exist")]));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn executable_types_and_windows_prefix() {
        for bad in ["a.exe", "a.BAT", "x/y.ps1", "a.lnk", "b.Js", "c.py"] {
            assert!(is_executable(Path::new(bad)), "{bad}");
        }
        for ok in ["a.docx", "a.html", "a.pdf", "a", "a.txt", "exe"] {
            assert!(!is_executable(Path::new(ok)), "{ok}");
        }
        assert_eq!(plain(Path::new(r"\\?\C:\Users\x\a.docx")), PathBuf::from(r"C:\Users\x\a.docx"));
        assert_eq!(plain(Path::new(r"\\?\UNC\server\s\a.docx")), PathBuf::from(r"\\?\UNC\server\s\a.docx"));
        assert_eq!(plain(Path::new(r"C:\a.docx")), PathBuf::from(r"C:\a.docx"));
    }
}
