// The Mango Code icon in the Windows tray (bottom right).
//
// The window's X only hides it: closing the app would stop the engine, and reopening it
// costs the model load. A click on the icon brings the window back, and the icon has a menu
// with "Open Mango Code", "Models and engine…" (the choice of models to download, see `choice.rs`)
// and "Quit": only "Quit" really stops everything.
use mango_common::tr;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItemBuilder::with_id("open", tr!("Apri Mango Code", "Open Mango Code")).build(app)?;
    let models_item = MenuItemBuilder::with_id("models", tr!("Modelli e motore…", "Models and engine…")).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", tr!("Esci", "Quit")).build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open_item, &models_item, &quit_item]).build()?;
    let items = [open_item, models_item, quit_item];

    TrayIconBuilder::with_id("mango")
        .icon(app.default_window_icon().expect("the app icon").clone())
        .tooltip("Mango Code")
        .menu(&menu)
        // With the menu on the right button, the left one stays "open": it is what people expect.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "models" => crate::choice::change(app),
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
    let labels = [tr!("Apri Mango Code", "Open Mango Code"), tr!("Modelli e motore…", "Models and engine…"), tr!("Esci", "Quit")];
    for (item, label) in items.iter().zip(labels) {
        if item.text().is_ok_and(|current| current != label) {
            let _ = item.set_text(label);
        }
    }
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
