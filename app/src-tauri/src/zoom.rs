//! The zoom of the app's window and of the Preview panel (Ctrl+ / Ctrl- / Ctrl+0, Ctrl+wheel).
//!
//! The keys are the browser's own: both webviews are built with `zoom_hotkeys_enabled`, and each zooms by itself, the
//! one the pointer or the keyboard is in. WebView2 says when the user changes a zoom (`watch`). The window's is kept in
//! `<data>\zoom.txt` and applied at the next start (`install`); the panel's lasts until the app closes (`preview.rs`).
//! The settings' «Grandezza» reads and sets the window's (`zoom_get`, `zoom_set`) and follows the keys through the
//! event `mango-zoom` on window.
//!
//! The zoom is the one WebView2 reports, never one worked out from the page: `devicePixelRatio` is the zoom times the
//! screen's scale times Windows' text size (Settings, Accessibility), and a zoom saved with the text size inside it
//! came back multiplied by it at every start.

use crate::bridge::{err, BridgeError};
use mango_common::tr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

/// The limits of the browser's zoom (WebView2: 25% to 500%).
pub(crate) const MIN: f64 = 0.25;
pub(crate) const MAX: f64 = 5.0;

/// The window's zoom now (the bits of an f64): the last one WebView2 said, or the one given at the start.
static WINDOW: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000);

/// The saved zoom, if there is one and it is a number the browser accepts.
fn read(file: &Path) -> Option<f64> {
    let zoom: f64 = std::fs::read_to_string(file).ok()?.trim().parse().ok()?;
    (MIN..=MAX).contains(&zoom).then_some(zoom)
}

/// Saves the zoom; at 100% the file goes away (it is the default).
fn write(file: &Path, zoom: f64) -> std::io::Result<()> {
    if (zoom - 1.0).abs() < 0.005 {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    mango_common::write_atomic(file, zoom.to_string())
}

/// Calls `changed` with the new zoom every time the user changes the webview's zoom (keys, Ctrl+wheel). A zoom set from
/// the code is not told by WebView2: `zoom_set` tells it itself.
pub(crate) fn watch(webview: &Webview, changed: impl Fn(f64) + Send + 'static) -> tauri::Result<()> {
    webview.with_webview(move |webview| unsafe {
        let handler = webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
            if let Some(controller) = controller {
                let mut zoom = 1.0;
                controller.ZoomFactor(&mut zoom)?;
                changed(zoom);
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(e) = webview.controller().add_ZoomFactorChanged(&handler, &mut token) {
            eprintln!("Zoom not watched: {e}");
        }
    })
}

/// Gives the window the zoom of the last time and remembers the one the user leaves it at.
pub fn install(window: &WebviewWindow, file: PathBuf) {
    if let Some(zoom) = read(&file) {
        if window.set_zoom(zoom).is_ok() {
            WINDOW.store(zoom.to_bits(), Ordering::Relaxed);
        }
    }
    let page = window.clone();
    if let Err(e) = watch(window.as_ref(), move |zoom| window_changed(&page, &file, zoom)) {
        eprintln!("Zoom not watched: {e}");
    }
}

/// The window's zoom changed: kept for `zoom_get`, saved for the next start, and told to «Grandezza» in the settings.
fn window_changed(page: &WebviewWindow, file: &Path, zoom: f64) {
    WINDOW.store(zoom.to_bits(), Ordering::Relaxed);
    if let Err(e) = write(file, zoom) {
        eprintln!("Zoom not saved in {}: {e}", file.display());
    }
    let _ = page.eval(format!("window.dispatchEvent(new CustomEvent('mango-zoom',{{detail:{zoom}}}))"));
}

/// The window's zoom now, 1 for 100%.
#[tauri::command]
pub async fn zoom_get() -> f64 {
    f64::from_bits(WINDOW.load(Ordering::Relaxed))
}

/// Sets the window's zoom, within the browser's limits, and gives the one set. WebView2 does not tell a zoom set from
/// here (`ZoomFactorChanged` is only for the user's): it is kept and told as one made with the keys.
#[tauri::command]
pub async fn zoom_set(app: AppHandle, zoom: f64) -> Result<f64, BridgeError> {
    if !zoom.is_finite() {
        return Err(err("invalid", tr!("grandezza non valida: {zoom}", "invalid size: {zoom}")));
    }
    let zoom = zoom.clamp(MIN, MAX);
    let window = app.state::<crate::AppState>().main.get().ok_or_else(|| err("io", tr!("la finestra non c'è ancora", "the window is not there yet")))?.clone();
    window.set_zoom(zoom).map_err(|e| err("io", e.to_string()))?;
    let file = mango_common::zoom_file().map_err(|e| err("io", e.to_string()))?;
    window_changed(&window, &file, zoom);
    Ok(zoom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_zoom_is_kept_in_a_file_and_100_percent_removes_it() {
        let dir = std::env::temp_dir().join(format!("mango-zoom-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("zoom.txt");
        assert_eq!(read(&file), None);
        write(&file, 1.25).unwrap();
        assert_eq!(read(&file), Some(1.25));
        write(&file, 1.0).unwrap();
        assert_eq!(read(&file), None);
        assert!(!file.exists());
        write(&file, 1.0).unwrap();
        for bad in ["", "abc", "0", "9", "-1", "NaN"] {
            std::fs::write(&file, bad).unwrap();
            assert_eq!(read(&file), None, "{bad:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
