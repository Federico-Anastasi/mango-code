//! The "Preview" panel: a browser (WebView2) inside the window, next to the chat.
//!
//! HOW IT IS BUILT. A second webview, child of the main window (`unstable` feature of
//! Tauri 2, `Window::add_child`). The bar (address, back/forward, formats) is HTML in the web UI,
//! which also knows where the panel is: it sends `preview_place` the rectangle of a placeholder and this
//! native webview overlaps it. A separate window is not needed and would have lost the
//! resizing next to the chat. The web UI draws the panel as a card with rounded corners, like the chat's; the
//! page reaches the card's two bottom corners, so its window is cut round there (`round_corners`); on the screen of a
//! phone or a tablet, all four.
//!
//! HOW THE AGENT CONNECTS. `chrome-devtools-mcp` talks to the panel via CDP. WebView2 turns on
//! remote debugging with a browser argument, and the argument applies to all webviews that share
//! the environment: this is why the panel has a data folder of its own (WebView2 creates an environment, and so
//! a browser process, for each folder). The web UI, with its bridge calls, lives in another
//! environment and is not reachable from the port.
//!
//! THE PORT. Chosen at random at every start of the app, on 127.0.0.1 only, passed to the agent (and so to the
//! browser server) in the process environment. Whoever knows it can drive the panel and nothing else; the
//! panel has no access to the native bridge (see `capabilities/default.json`).

use crate::bridge::{err, BridgeError};
use mango_common::tr;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl, Window,
};

const LABEL: &str = "preview";
const BLANK: &str = "about:blank";

/// How long a page may take to arrive (its address to be the one the panel shows) before the panel says it cannot open it.
/// Chrome waits for a server that accepts and never answers for minutes; a panel that stays empty that long looks broken.
/// Debug builds read the limit in milliseconds from `MANGO_PREVIEW_LIMIT_MS`, so the tests do not wait half a minute.
fn load_limit() -> Duration {
    let ms = if cfg!(debug_assertions) { std::env::var("MANGO_PREVIEW_LIMIT_MS").ok().and_then(|v| v.parse().ok()) } else { None };
    Duration::from_millis(ms.unwrap_or(30_000))
}

/// State of the panel and port of the remote debugging.
pub struct Panel {
    pub cdp_port: u16,
    state: Mutex<State>,
}

#[derive(Clone, Serialize, Default)]
struct State {
    url: String,
    title: String,
    loading: bool,
    /// The address that did not arrive within `load_limit`: the web UI says so and offers to try again.
    failed: Option<String>,
    /// Counts the navigations, so the timer of one that was replaced does nothing.
    #[serde(skip)]
    navigation: u64,
    /// The panel is shown (the web UI has a visible placeholder).
    #[serde(skip)]
    visible: bool,
    /// The zoom the format asks for: a tablet in a narrow panel is shown shrunk (see `preview_place`).
    #[serde(skip)]
    fit: f64,
    /// The zoom the user chose on top of it (Ctrl+wheel, Ctrl+ / Ctrl-). The panel shows the page at `fit` × `user`.
    #[serde(skip)]
    user: f64,
    /// The shape the panel's window was last cut to.
    #[serde(skip)]
    shape: Shape,
}

/// The user's own zoom, once WebView2 says the panel's page is at `actual` while the format asks for `fit`.
/// 100% is what Ctrl+0 gives: it means "no zoom of mine", also in a shrunk format, where `actual / fit` would
/// read it as a zoom in and carry it over to the next format.
fn user_zoom(actual: f64, fit: f64) -> f64 {
    if (actual - 1.0).abs() < 1e-3 {
        return 1.0;
    }
    actual / fit
}

/// What the panel is set to for a format's zoom and the user's, within what the browser accepts.
fn shown_zoom(fit: f64, user: f64) -> f64 {
    (fit * user).clamp(crate::zoom::MIN, crate::zoom::MAX)
}

/// The pages the panel can show. The rest (mailto, app schemes) goes to the system.
fn scheme_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "file" | "about" | "data" | "blob")
}

fn is_blank(url: &str) -> bool {
    url.is_empty() || url == BLANK
}

/// `localhost`, loopback and the local network's addresses (10/8, 172.16/12, 192.168/16): a site under construction.
fn is_local_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback() || ip.is_private())
        || host.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// What the user typed in the bar → an address. The local machine and the local network go
/// to http (sites under construction), the rest to https.
pub fn normalize(written: &str) -> Result<Url, String> {
    let t = written.trim();
    if t.is_empty() {
        return Err(tr!("indirizzo vuoto", "empty address"));
    }
    let has_scheme = match t.split_once(':') {
        // "example.it:8080" is a host with a port; "mailto:x", "data:..." and "https://..." have a scheme
        Some((before, after)) => {
            !before.is_empty()
                && before.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
                && !after.chars().next().is_some_and(|c| c.is_ascii_digit())
        }
        None => false,
    };
    let candidate = if has_scheme {
        t.to_string()
    } else if Url::parse(&format!("https://{t}")).is_ok_and(|u| is_local_host(&u)) {
        format!("http://{t}")
    } else {
        format!("https://{t}")
    };
    let url = Url::parse(&candidate).map_err(|e| format!("{t}: {e}"))?;
    if !scheme_allowed(&url) {
        return Err(tr!("schema non ammesso: {}", "scheme not allowed: {}", url.scheme()));
    }
    Ok(url)
}

fn notify(app: &AppHandle, event: serde_json::Value) {
    if let Some(w) = crate::main_window(app) {
        let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('mango-preview',{{detail:{event}}}))"));
    }
}

/// After `load_limit`, if this navigation is still the last one and its page has not arrived (the panel still shows another address),
/// the panel is emptied and `failed` says which address. A page that arrived but is still loading (a slow image) is left alone.
fn give_up_later(app: &AppHandle, navigation: u64, target: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(load_limit());
        let Some(wv) = app.get_webview(LABEL) else { return };
        let arrived = wv.url().is_ok_and(|u| u.as_str() == target);
        {
            let p = app.state::<Panel>();
            let mut s = p.state.lock().unwrap();
            if s.navigation != navigation || !s.loading {
                return;
            }
            s.loading = false;
            if arrived {
                return;
            }
            s.failed = Some(target);
        }
        let _ = wv.navigate(Url::parse(BLANK).expect("a constant address"));
    });
}

/// Creates the panel (hidden) in the main window and keeps its state. To be called after the
/// window is created, before the agent starts: the browser server connects to the port.
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let port = mango_common::random_port()?;
    let data = mango_common::data_dir()?.join("preview");
    std::fs::create_dir_all(&data)?;
    app.manage(Panel { cdp_port: port, state: Mutex::new(State { fit: 1.0, user: 1.0, ..Default::default() }) });

    let main = crate::main_window(app).ok_or_else(|| anyhow::anyhow!("main window missing"))?;
    let (for_nav, for_windows, for_title, for_load, for_zoom) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(BLANK.parse()?))
        .data_directory(data)
        // Ctrl+wheel, Ctrl+ / Ctrl- / Ctrl+0 over the page zoom it, like in a browser
        .zoom_hotkeys_enabled(true)
        // Tauri's arguments for WebView2 + remote debugging (loopback only, random port). Without
        // --remote-allow-origins: a web page cannot open the debug WebSocket, only whoever sends no Origin can.
        .additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ))
        .on_navigation(move |url| {
            if !scheme_allowed(url) {
                // mailto and the like: to the Windows program that handles them, never inside the panel
                if matches!(url.scheme(), "mailto") {
                    let _ = crate::supervisor::open_outside_job(url.as_str());
                }
                return false;
            }
            let (open, navigation) = {
                let p = for_nav.state::<Panel>();
                let mut s = p.state.lock().unwrap();
                s.url = url.as_str().to_string();
                s.navigation += 1;
                // Going blank is how a page that does not arrive is given up: nothing is loading, and the reason stays.
                s.loading = !is_blank(url.as_str());
                if s.loading {
                    s.failed = None;
                }
                (!s.visible && !is_blank(url.as_str()), s.navigation)
            };
            if !is_blank(url.as_str()) {
                give_up_later(&for_nav, navigation, url.as_str().to_string());
            }
            // A navigation with the panel closed is made by the agent: the web UI opens it.
            notify(&for_nav, serde_json::json!({ "kind": if open { "open" } else { "navigate" }, "url": url.as_str() }));
            true
        })
        // target=_blank and window.open: in the same panel (there is no second panel)
        .on_new_window(move |url, _| {
            if let Some(w) = for_windows.get_webview(LABEL) {
                if scheme_allowed(&url) {
                    let _ = w.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| {
            for_title.state::<Panel>().state.lock().unwrap().title = title;
        })
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                for_load.state::<Panel>().state.lock().unwrap().loading = false;
            }
        });

    let webview = main
        .as_ref()
        .window()
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))?;
    // A zoom that is not the one `preview_place` set is the user's: it stays on top of the next formats.
    let watched = crate::zoom::watch(&webview, move |actual| {
        let p = for_zoom.state::<Panel>();
        let mut s = p.state.lock().unwrap();
        if (actual - shown_zoom(s.fit, s.user)).abs() > 1e-6 {
            s.user = user_zoom(actual, s.fit);
        }
    });
    if let Err(e) = watched {
        eprintln!("Zoom of the Preview panel not watched: {e}");
    }
    webview.hide()?;
    Ok(())
}

fn panel(app: &AppHandle) -> Result<tauri::Webview, BridgeError> {
    app.get_webview(LABEL).ok_or_else(|| err("unavailable", tr!("il pannello non c'è", "the panel does not exist")))
}

fn io<E: std::fmt::Display>(e: E) -> BridgeError {
    err("io", e.to_string())
}

/// The shape the panel's window is cut to, in physical pixels: its size, the radius of its rounded corners, and whether the two
/// top ones are rounded too.
type Shape = (i32, i32, i32, bool);

/// Cuts the panel's window to a rectangle with rounded corners: the web UI draws the page inside a card or on the screen of a
/// device, both with rounded corners, and the page is a native window on top of them, a rectangle that would cover them. The
/// two bottom corners are always rounded (the card's, which the page reaches), the top ones only on a device. A window's shape
/// does not follow its size: it is cut again whenever the size or the corners change.
fn round_corners(wv: &tauri::Webview, (width, height, radius, top): Shape) -> tauri::Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
    wv.with_webview(move |webview| unsafe {
        let mut parent = Default::default();
        if webview.controller().ParentWindow(&mut parent).is_err() {
            return;
        }
        // A rectangle rounded all around, joined to the part that stays square: the top down to where the bottom corners begin.
        // The rounded one starts its curve a pixel before the radius: the square part goes two pixels further, or a notch shows.
        let shape = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
        if !top {
            let square = CreateRectRgn(0, 0, width, (height - radius + 2).clamp(0, height));
            CombineRgn(shape, shape, square, RGN_OR);
            let _ = DeleteObject(square);
        }
        // the window owns the shape it is given
        if SetWindowRgn(HWND(parent.0), shape, true) == 0 {
            let _ = DeleteObject(shape);
        }
    })
}

/// Where the placeholder is in the web UI (CSS pixels, `dpr` = devicePixelRatio of the page), with what zoom to show the page
/// and how round its corners are (`radius`, CSS pixels: the two bottom ones, and with `round_top` the top ones too).
/// If `visible` is false the panel hides.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // they are what the page sends: one named argument each
pub fn preview_place(
    app: AppHandle,
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
    zoom: f64,
    radius: f64,
    round_top: bool,
    visible: bool,
) -> Result<(), BridgeError> {
    let wv = panel(&app)?;
    app.state::<Panel>().state.lock().unwrap().visible = visible;
    if !visible || width < 1.0 || height < 1.0 {
        return wv.hide().map_err(io);
    }
    // CSS pixels → logical pixels of the window: the page can have its own zoom (dpr = scale × zoom).
    let k = dpr / window.scale_factor().map_err(io)?;
    wv.set_bounds(Rect {
        position: LogicalPosition::new(x * k, y * k).into(),
        size: LogicalSize::new(width * k, height * k).into(),
    })
    .map_err(io)?;
    // The lock is released before `set_zoom`: WebView2 reports the change to `install`'s watcher, which takes it.
    let shape = ((width * dpr).round() as i32, (height * dpr).round() as i32, (radius * dpr).round() as i32, round_top);
    let (zoomed, reshaped) = {
        let p = app.state::<Panel>();
        let mut s = p.state.lock().unwrap();
        let zoomed = (s.fit - zoom).abs() > 1e-6;
        s.fit = zoom;
        let reshaped = s.shape != shape;
        s.shape = shape;
        (zoomed.then(|| shown_zoom(s.fit, s.user)), reshaped)
    };
    if let Some(zoom) = zoomed {
        wv.set_zoom(zoom).map_err(io)?;
    }
    if reshaped {
        round_corners(&wv, shape).map_err(io)?;
    }
    wv.show().map_err(io)
}

/// Hides the panel. The window's page is changing (the model choice, a reload): the web UI that placed the panel is going away
/// and cannot hide it, and a native panel left on its own is a blank rectangle over the next page.
pub(crate) fn hide(app: &AppHandle) {
    if let Some(p) = app.try_state::<Panel>() {
        p.state.lock().unwrap().visible = false;
    }
    if let Some(w) = app.get_webview(LABEL) {
        let _ = w.hide();
    }
}

/// Opens an address typed by the user in the bar.
#[tauri::command]
pub fn preview_go(app: AppHandle, url: String) -> Result<(), BridgeError> {
    let url = normalize(&url).map_err(|m| err("invalid", m))?;
    panel(&app)?.navigate(url).map_err(io)
}

/// The page the panel shows now, for the phone: its address and title; `None` while it is blank.
pub(crate) fn shown(app: &AppHandle) -> Option<(String, String)> {
    let s = app.try_state::<Panel>()?.state.lock().unwrap().clone();
    (!is_blank(&s.url)).then_some((s.url, s.title))
}

/// Opens `url` in the panel because the phone asked: the panel is the computer's, the phone only looks at what it shows.
/// The address is noted at once, so the phone that asked sees this page and not the one before while it loads.
pub(crate) fn open_for_phone(app: &AppHandle, url: Url) -> Result<(), BridgeError> {
    let wv = panel(app)?;
    {
        let p = app.state::<Panel>();
        let mut s = p.state.lock().unwrap();
        s.url = url.as_str().to_string();
        s.title.clear();
    }
    wv.navigate(url).map_err(io)
}

/// Back, forward, reload, stop.
#[tauri::command]
pub fn preview_nav(app: AppHandle, action: String) -> Result<(), BridgeError> {
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        other => return Err(err("invalid", tr!("azione sconosciuta: {other}", "unknown action: {other}"))),
    };
    panel(&app)?.eval(js).map_err(io)
}

#[derive(Serialize)]
pub struct PanelState {
    url: String,
    title: String,
    loading: bool,
    /// The address that did not arrive in time (see `load_limit`).
    failed: Option<String>,
    /// The panel is shown (the web UI has placed it and nothing covers it).
    visible: bool,
}

/// The current address and title. `Webview::url` queries WebView2: it also sees address changes
/// without a reload (pushState), which the navigation does not report.
#[tauri::command]
pub fn preview_state(app: AppHandle) -> Result<PanelState, BridgeError> {
    let wv = panel(&app)?;
    let s = app.state::<Panel>().state.lock().unwrap().clone();
    let url = wv.url().map(|u| u.to_string()).unwrap_or(s.url);
    Ok(PanelState { url: if is_blank(&url) { String::new() } else { url }, title: s.title, loading: s.loading, failed: s.failed, visible: s.visible })
}

/// The panel's page in the default Windows browser.
#[tauri::command]
pub fn preview_external(app: AppHandle) -> Result<(), BridgeError> {
    let url = panel(&app)?.url().map_err(io)?;
    if !matches!(url.scheme(), "http" | "https" | "file") {
        return Err(err("invalid", tr!("niente da aprire: {url}", "nothing to open: {url}")));
    }
    crate::supervisor::open_outside_job(url.as_str()).map_err(io)
}

/// What the panel is asked to show of a project file besides web pages: a PDF or a picture.
const FILE_TYPES: &[&str] = &["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];

/// The biggest file shown: above it the web UI says so, instead of a window that loads hundreds of MB of picture.
const MAX_FILE: u64 = 50 * 1024 * 1024;

/// The page that draws an SVG as a picture: as a page of its own, an SVG runs its scripts. The page allows no script and
/// loads nothing but that one local file.
fn svg_page_html(src: &str, name: &str) -> String {
    let esc = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;");
    format!(
        "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src file:; style-src 'unsafe-inline'\"><title>{}</title><style>html,body{{margin:0;height:100%}}body{{display:grid;place-items:center;background:#ddd;background-image:conic-gradient(#fff 25%,#ccc 0 50%,#fff 0 75%,#ccc 0);background-size:20px 20px}}img{{max-width:100%;max-height:100%}}</style><img src=\"{}\" alt=\"\">",
        esc(name),
        esc(src)
    )
}

/// The address the panel opens for `real` (a real file, without the `\?\` prefix), or why it is refused: not a PDF or a picture,
/// over `MAX_FILE`, or not readable.
fn file_address(real: &Path) -> Result<Url, BridgeError> {
    let ext = real.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !real.is_file() || !FILE_TYPES.contains(&ext.as_str()) {
        return Err(err("blocked_type", real.display().to_string()));
    }
    let unreadable = |e: std::io::Error| err("unreadable", format!("{}: {e}", real.display()));
    let size = std::fs::metadata(real).map_err(unreadable)?.len();
    if size > MAX_FILE {
        return Err(err("too_large", tr!("{}: {size} byte, il massimo è {MAX_FILE}", "{}: {size} bytes, the most is {MAX_FILE}", real.display())));
    }
    std::fs::File::open(real).map_err(unreadable)?;
    let to_url = |p: &Path| Url::from_file_path(p).map_err(|()| err("invalid", p.display().to_string()));
    if ext != "svg" {
        return to_url(real);
    }
    let name = real.file_name().and_then(|n| n.to_str()).unwrap_or("image.svg");
    let folder = mango_common::data_dir().map_err(io)?.join("preview-view");
    std::fs::create_dir_all(&folder).map_err(io)?;
    let page = folder.join("image.html");
    std::fs::write(&page, svg_page_html(to_url(real)?.as_str(), name)).map_err(io)?;
    to_url(&page)
}

/// Opens a PDF or a picture of a project (or of `Documents\Mango Code`) in the panel: the card of the file in the chat.
#[tauri::command]
pub async fn preview_file(app: AppHandle, path: String) -> Result<(), BridgeError> {
    let real = crate::bridge::allowed_path(&app, path).await?;
    let url = tauri::async_runtime::spawn_blocking(move || file_address(&crate::bridge::plain(&real))).await.map_err(io)??;
    panel(&app)?.navigate(url).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_typed_by_hand() {
        let ok = |s: &str| normalize(s).unwrap().to_string();
        assert_eq!(ok("example.com"), "https://example.com/");
        assert_eq!(ok("  localhost:5173/app "), "http://localhost:5173/app");
        assert_eq!(ok("127.0.0.1:3000"), "http://127.0.0.1:3000/");
        // the host decides, not the start of the text: names that begin like a local one are sites; the local network is http
        assert_eq!(ok("localhostile.com"), "https://localhostile.com/");
        assert_eq!(ok("127.example.com"), "https://127.example.com/");
        assert_eq!(ok("192.168.1.5:3000/app"), "http://192.168.1.5:3000/app");
        assert_eq!(ok("10.0.0.7"), "http://10.0.0.7/");
        assert_eq!(ok("172.20.1.1:8080"), "http://172.20.1.1:8080/");
        assert_eq!(ok("8.8.8.8"), "https://8.8.8.8/");
        assert_eq!(ok("172.32.0.1"), "https://172.32.0.1/");
        assert_eq!(ok("[::1]:3000"), "http://[::1]:3000/");
        assert_eq!(ok("http://a.it/x?y=1"), "http://a.it/x?y=1");
        assert_eq!(ok("file:///C:/Users/x/index.html"), "file:///C:/Users/x/index.html");
        for bad in ["", "   ", "javascript:alert(1)", "mailto:a@b.it", "ms-settings:privacy", "ftp://x.it/"] {
            assert!(normalize(bad).is_err(), "{bad:?} should have been rejected");
        }
    }

    #[test]
    fn the_users_zoom_stays_on_top_of_the_formats() {
        // desktop format: what the browser reports is the user's zoom
        assert_eq!(user_zoom(1.25, 1.0), 1.25);
        assert_eq!(user_zoom(0.75, 1.0), 0.75);
        // a tablet shrunk to 60%: one step in is 125% of that, and the next format shows it at 125% too
        assert!((user_zoom(0.75, 0.6) - 1.25).abs() < 1e-9);
        assert!((shown_zoom(0.8, user_zoom(0.75, 0.6)) - 1.0).abs() < 1e-9);
        // Ctrl+0 is no zoom of the user's, in any format
        assert_eq!(user_zoom(1.0, 1.0), 1.0);
        assert_eq!(user_zoom(1.0, 0.6), 1.0);
        // never outside what the browser accepts
        assert_eq!(shown_zoom(0.5, 0.25), crate::zoom::MIN);
        assert_eq!(shown_zoom(1.0, 9.0), crate::zoom::MAX);
    }

    #[test]
    fn the_port_is_one_that_is_free_to_listen_on() {
        let (a, b) = (mango_common::random_port().unwrap(), mango_common::random_port().unwrap());
        assert!(a > 1024 && b > 1024);
    }

    #[test]
    fn only_a_pdf_or_a_picture_within_the_limit_is_opened() {
        let dir = std::env::temp_dir().join(format!("mc-preview-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let make = |name: &str, bytes: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        let code = |p: &Path| file_address(p).unwrap_err().code;
        assert!(file_address(&make("a b.pdf", b"%PDF")).unwrap().as_str().ends_with("/a%20b.pdf"));
        assert!(file_address(&make("Photo.JPG", b"x")).unwrap().as_str().starts_with("file:///"));
        // the other documents, pages and programs are not shown here; neither is a folder named like a picture
        for name in ["a.docx", "a.html", "a.exe", "a.txt", "noext"] {
            assert_eq!(code(&make(name, b"x")), "blocked_type", "{name}");
        }
        std::fs::create_dir_all(dir.join("folder.png")).unwrap();
        assert_eq!(code(&dir.join("folder.png")), "blocked_type");
        // a file that is not there is not opened (the bridge checks it before; this is the last guard)
        assert_eq!(code(&dir.join("gone.png")), "blocked_type");
        // over the limit: the reason is the size
        let big = std::fs::File::create(dir.join("big.png")).unwrap();
        big.set_len(MAX_FILE + 1).unwrap();
        assert_eq!(code(&dir.join("big.png")), "too_large");
        big.set_len(MAX_FILE).unwrap();
        assert!(file_address(&dir.join("big.png")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_svg_is_drawn_by_a_page_that_cannot_run_it() {
        let page = svg_page_html("file:///C:/p/a%20&b.svg", "<x>\"'.svg");
        assert!(page.contains("<img src=\"file:///C:/p/a%20&amp;b.svg\""), "{page}");
        assert!(page.contains("<title>&lt;x&gt;&quot;&#39;.svg</title>"), "{page}");
        assert!(page.contains("default-src 'none'; img-src file:"), "{page}");
        assert!(!page.contains("<script"), "{page}");
    }
}
