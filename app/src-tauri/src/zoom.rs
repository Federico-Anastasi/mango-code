//! The zoom of the app's window (Ctrl+ / Ctrl- / Ctrl+0).
//!
//! The keys are the browser's own: the window is built with `zoom_hotkeys_enabled`. The web UI tells the
//! app the page scale after a change (`remember_zoom`); the app keeps it in `<data>\zoom.txt` and applies it to the
//! window at the next start. The Preview panel is a webview of its own and keeps its zoom: `preview_place` already
//! converts the placeholder's rectangle with the page scale (`preview.rs`).

use crate::bridge::{err, BridgeError};
use std::path::Path;
use tauri::Window;

/// The limits of the browser's zoom (WebView2: 25% to 500%).
const MIN: f64 = 0.25;
const MAX: f64 = 5.0;

/// The zoom of the page: its scale (`devicePixelRatio`) over the screen's own scale, to two decimals.
fn zoom_of(page_scale: f64, screen_scale: f64) -> f64 {
    ((page_scale / screen_scale).clamp(MIN, MAX) * 100.0).round() / 100.0
}

/// The saved zoom, if there is one and it is a number the browser accepts.
pub fn read(file: &Path) -> Option<f64> {
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

/// The web UI saw its scale change: it remembers the zoom for the next start.
#[tauri::command]
pub fn remember_zoom(window: Window, page_scale: f64) -> Result<(), BridgeError> {
    if !page_scale.is_finite() || page_scale <= 0.0 {
        return Err(err("invalid", format!("page scale: {page_scale}")));
    }
    let screen = window.scale_factor().map_err(|e| err("io", e.to_string()))?;
    let file = mango_common::zoom_file().map_err(|e| err("io", e.to_string()))?;
    write(&file, zoom_of(page_scale, screen)).map_err(|e| err("io", format!("{}: {e}", file.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_zoom_is_the_page_scale_over_the_screen_scale() {
        assert_eq!(zoom_of(1.75, 1.75), 1.0);
        assert_eq!(zoom_of(1.75 * 1.25, 1.75), 1.25);
        assert_eq!(zoom_of(1.5 * 0.9, 1.5), 0.9);
        assert_eq!(zoom_of(1.0, 1.75), 0.57);
        assert_eq!(zoom_of(100.0, 1.0), MAX);
        assert_eq!(zoom_of(0.01, 1.0), MIN);
    }

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
