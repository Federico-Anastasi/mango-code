use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

fn main() {
    // The executable icon is icons/icon.ico: without this line, changing it does not relink.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // Permissions of the bridge plugin (src/bridge.rs): without them, the web UI (a remote page) cannot call its commands.
    let bridge = InlinedPlugin::new()
        .commands(&["pick_folders", "projects_folder", "create_project", "read_clipboard_image", "open_external", "file_info", "open_path", "reveal_path", "set_titlebar_color", "remember_page", "remember_zoom", "open_models", "preview_place", "preview_go", "preview_nav", "preview_state", "preview_external", "chrome_info", "chrome_set_enabled", "team_info", "team_set_key", "team_remove_key", "team_save", "phone_state", "phone_set_enabled", "phone_new_key", "ui_log", "report_problem", "report_info", "open_logs_folder", "update_state", "update_check", "update_install"])
        .default_permission(DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(Attributes::new().plugin("mango-bridge", bridge)).expect("tauri-build");
}
