//! The zoom of the app's window and of the Preview panel (Ctrl+ / Ctrl- / Ctrl+0, Ctrl+wheel).
//!
//! The keys are the browser's own: both webviews are built with `zoom_hotkeys_enabled`, and each zooms by itself, the
//! one the pointer or the keyboard is in. WebView2 says when a zoom changes (`watch`). The window's is kept in
//! `<data>\zoom.txt` and applied at the next start (`install`); the panel's lasts until the app closes (`preview.rs`).
//!
//! The zoom is the one WebView2 reports, never one worked out from the page: `devicePixelRatio` is the zoom times the
//! screen's scale times Windows' text size (Settings, Accessibility), and a zoom saved with the text size inside it
//! came back multiplied by it at every start.

use std::path::{Path, PathBuf};
use tauri::{Webview, WebviewWindow};

/// The limits of the browser's zoom (WebView2: 25% to 500%).
pub(crate) const MIN: f64 = 0.25;
pub(crate) const MAX: f64 = 5.0;

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

/// Calls `changed` with the new zoom every time the webview's zoom changes, whoever changed it: the user or `set_zoom`.
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
        let _ = window.set_zoom(zoom);
    }
    let watched = watch(window.as_ref(), move |zoom| {
        if let Err(e) = write(&file, zoom) {
            eprintln!("Zoom not saved in {}: {e}", file.display());
        }
    });
    if let Err(e) = watched {
        eprintln!("Zoom not watched: {e}");
    }
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
