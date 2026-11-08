//! The "Preview" panel: a browser (WebView2) inside the window, next to the chat.
//!
//! HOW IT IS BUILT. A second webview, child of the main window (`unstable` feature of
//! Tauri 2, `Window::add_child`). The bar (address, back/forward, formats) is HTML in the web UI,
//! which also knows where the panel is: it sends `preview_place` the rectangle of a placeholder and this
//! native webview overlaps it. A separate window is not needed and would have lost the
//! resizing next to the chat.
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
use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl, Window,
};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "preview";
const BLANK: &str = "about:blank";

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
    /// The panel is shown (the web UI has a visible placeholder).
    #[serde(skip)]
    visible: bool,
    #[serde(skip)]
    zoom: f64,
}

/// A free port chosen by the system (at random in the ephemeral range).
fn random_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// The pages the panel can show. The rest (mailto, app schemes) goes to the system.
fn scheme_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "file" | "about" | "data" | "blob")
}

fn is_blank(url: &str) -> bool {
    url.is_empty() || url == BLANK
}

/// What the user typed in the bar → an address. `localhost` and numeric addresses go
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
    } else if t.starts_with("localhost") || t.starts_with("127.") || t.starts_with("[::1]") {
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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('mango-preview',{{detail:{event}}}))"));
    }
}

/// Creates the panel (hidden) in the main window and keeps its state. To be called after the
/// window is created, before the agent starts: the browser server connects to the port.
pub fn install(app: &AppHandle) -> anyhow::Result<()> {
    let port = random_port()?;
    let data = mango_common::data_dir()?.join("preview");
    std::fs::create_dir_all(&data)?;
    app.manage(Panel { cdp_port: port, state: Mutex::new(State { zoom: 1.0, ..Default::default() }) });

    let main = app.get_webview_window("main").ok_or_else(|| anyhow::anyhow!("main window missing"))?;
    let (for_nav, for_windows, for_title, for_load) = (app.clone(), app.clone(), app.clone(), app.clone());
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(BLANK.parse()?))
        .data_directory(data)
        // Tauri's arguments for WebView2 + remote debugging (loopback only, random port). Without
        // --remote-allow-origins: a web page cannot open the debug WebSocket, only whoever sends no Origin can.
        .additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ))
        .on_navigation(move |url| {
            if !scheme_allowed(url) {
                // mailto and the like: to the Windows program that handles them, never inside the panel
                if matches!(url.scheme(), "mailto") {
                    let _ = for_nav.opener().open_url(url.as_str(), None::<&str>);
                }
                return false;
            }
            let open = {
                let p = for_nav.state::<Panel>();
                let mut s = p.state.lock().unwrap();
                s.url = url.as_str().to_string();
                s.loading = true;
                !s.visible && !is_blank(url.as_str())
            };
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
    webview.hide()?;
    Ok(())
}

fn panel(app: &AppHandle) -> Result<tauri::Webview, BridgeError> {
    app.get_webview(LABEL).ok_or_else(|| err("unavailable", tr!("il pannello non c'è", "the panel does not exist")))
}

fn io<E: std::fmt::Display>(e: E) -> BridgeError {
    err("io", e.to_string())
}

/// Where the placeholder is in the web UI (CSS pixels, `dpr` = devicePixelRatio of the page) and with what
/// zoom to show the page. If `visible` is false the panel hides.
#[tauri::command]
pub fn preview_place(
    app: AppHandle,
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
    zoom: f64,
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
    let changed = {
        let p = app.state::<Panel>();
        let mut s = p.state.lock().unwrap();
        let c = (s.zoom - zoom).abs() > 1e-6;
        s.zoom = zoom;
        c
    };
    if changed {
        wv.set_zoom(zoom).map_err(io)?;
    }
    wv.show().map_err(io)
}

/// Opens an address typed by the user in the bar.
#[tauri::command]
pub fn preview_go(app: AppHandle, url: String) -> Result<(), BridgeError> {
    let url = normalize(&url).map_err(|m| err("invalid", m))?;
    panel(&app)?.navigate(url).map_err(io)
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
}

/// The current address and title. `Webview::url` queries WebView2: it also sees address changes
/// without a reload (pushState), which the navigation does not report.
#[tauri::command]
pub fn preview_state(app: AppHandle) -> Result<PanelState, BridgeError> {
    let wv = panel(&app)?;
    let s = app.state::<Panel>().state.lock().unwrap().clone();
    let url = wv.url().map(|u| u.to_string()).unwrap_or(s.url);
    Ok(PanelState { url: if is_blank(&url) { String::new() } else { url }, title: s.title, loading: s.loading })
}

/// The panel's page in the default Windows browser.
#[tauri::command]
pub fn preview_external(app: AppHandle) -> Result<(), BridgeError> {
    let url = panel(&app)?.url().map_err(io)?;
    if !matches!(url.scheme(), "http" | "https" | "file") {
        return Err(err("invalid", tr!("niente da aprire: {url}", "nothing to open: {url}")));
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(io)
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
        assert_eq!(ok("http://a.it/x?y=1"), "http://a.it/x?y=1");
        assert_eq!(ok("file:///C:/Users/x/index.html"), "file:///C:/Users/x/index.html");
        for bad in ["", "   ", "javascript:alert(1)", "mailto:a@b.it", "ms-settings:privacy", "ftp://x.it/"] {
            assert!(normalize(bad).is_err(), "{bad:?} should have been rejected");
        }
    }

    #[test]
    fn the_port_is_one_that_is_free_to_listen_on() {
        let (a, b) = (random_port().unwrap(), random_port().unwrap());
        assert!(a > 1024 && b > 1024);
    }
}
