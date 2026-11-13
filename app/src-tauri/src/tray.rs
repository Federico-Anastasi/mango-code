// The Mango Code icon in the Windows tray (bottom right).
//
// The window's X only hides it: closing the app would stop the engine, and reopening it
// costs the model load. A click on the icon brings the window back, and the icon has a menu
// with "Open Mango Code", "Settings…" (the settings of the interface, on the Models section)
// and "Quit": only "Quit" really stops everything.
use mango_common::tr;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItemBuilder::with_id("open", tr!("Apri Mango Code", "Open Mango Code")).build(app)?;
    let settings_item = MenuItemBuilder::with_id("settings", tr!("Impostazioni…", "Settings…")).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", tr!("Esci", "Quit")).build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open_item, &settings_item, &quit_item]).build()?;
    let items = [open_item, settings_item, quit_item];

    TrayIconBuilder::with_id("mango")
        .icon(app.default_window_icon().expect("the app icon").clone())
        .tooltip("Mango Code")
        .menu(&menu)
        // With the menu on the right button, the left one stays "open": it is what people expect.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "settings" => open_settings(app, "models"),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| match event {
            // The language can change while the app runs: the labels follow it when the pointer reaches the icon,
            // before the menu can be opened.
            TrayIconEvent::Enter { .. } => relabel(&items),
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                show(tray.app_handle())
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn relabel(items: &[MenuItem<Wry>; 3]) {
    let labels = [tr!("Apri Mango Code", "Open Mango Code"), tr!("Impostazioni…", "Settings…"), tr!("Esci", "Quit")];
    for (item, label) in items.iter().zip(labels) {
        if item.text().is_ok_and(|current| current != label) {
            let _ = item.set_text(label);
        }
    }
}

/// The settings of the interface, open on `section`: the window comes to the front and the interface gets the event
/// `mango-settings` on window, with `{ section }`. The request also stays in the bridge (`pendingSettings()`) until the
/// interface reads it: an interface that was not listening yet (still loading, or the app still starting) finds it there.
pub(crate) fn open_settings(app: &AppHandle, section: &str) {
    show(app);
    let st = app.state::<crate::AppState>();
    let ready = st.agent.lock().unwrap().is_some();
    if let (Some(event), Some(window)) = (ask_settings(&st.settings, ready, section), crate::main_window(app)) {
        let _ = window.eval(event);
    }
}

/// Keeps the request and gives the event to send, only once the interface is in the window (the agent is ready): before
/// that the window shows the app's own page, which has no settings.
fn ask_settings(pending: &Mutex<Option<String>>, ready: bool, section: &str) -> Option<String> {
    *pending.lock().unwrap() = Some(section.to_string());
    ready.then(|| format!("window.dispatchEvent(new CustomEvent('mango-settings',{{detail:{{section:{}}}}}))", serde_json::Value::from(section)))
}

/// The bridge's `pendingSettings()`: the last request of the settings not read yet, `{ section }`, and it is read.
#[tauri::command]
pub async fn settings_pending(app: AppHandle) -> Option<serde_json::Value> {
    let section = app.state::<crate::AppState>().settings.lock().unwrap().take();
    section.map(|section| serde_json::json!({ "section": section }))
}

pub fn show(app: &AppHandle) {
    if let Some(window) = crate::main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn quit(app: &AppHandle) {
    if let Some(supervisor) = app.state::<crate::AppState>().sup.get() {
        supervisor.shutdown();
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Settings…" while the app starts only keeps the request; once the interface is there it also sends the event.
    /// Either way the request waits in the bridge until it is read, once.
    #[test]
    fn the_settings_are_asked_with_the_event_only_once_the_interface_is_there() {
        let pending = Mutex::new(None);
        assert_eq!(ask_settings(&pending, false, "models"), None, "the app's own page: no event");
        assert_eq!(pending.lock().unwrap().as_deref(), Some("models"));
        assert_eq!(
            ask_settings(&pending, true, "models").as_deref(),
            Some(r#"window.dispatchEvent(new CustomEvent('mango-settings',{detail:{section:"models"}}))"#)
        );
        assert_eq!(pending.lock().unwrap().take().as_deref(), Some("models"));
        assert_eq!(pending.lock().unwrap().take(), None, "read once");
    }
}
