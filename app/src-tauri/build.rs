use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

fn main() {
    // The executable icon is icons/icon.ico: without this line, changing it does not relink.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // Permissions of the bridge plugin (src/bridge.rs): without them, the web UI (a remote page) cannot call its commands.
    let bridge = InlinedPlugin::new()
        .commands(&["pick_folders", "projects_folder", "create_project", "read_clipboard_image", "open_external", "file_info", "open_path", "reveal_path", "set_titlebar_color", "models_download", "models_pause", "models_resume", "models_cancel", "models_set_default", "models_set_choices", "models_remove", "models_open_folder", "computer_set_gpu_used", "computer_set_small_models", "computer_open_optimize", "computer_update_engine", "other_models_search", "other_models_analyze", "other_models_pick_file", "user_models_add", "user_models_remove", "token_status", "token_save", "token_remove", "settings_pending", "zoom_get", "zoom_set", "preview_place", "preview_go", "preview_nav", "preview_state", "preview_external", "preview_file", "chrome_info", "chrome_set_enabled", "team_info", "team_set_key", "team_remove_key", "team_save", "phone_state", "phone_set_enabled", "phone_new_key", "dictation_state", "dictation_set_enabled", "engine_share_state", "engine_share_set_enabled", "engine_share_new_key", "engine_remote_connect", "engine_remote_disconnect", "ui_log", "report_problem", "report_info", "open_logs_folder", "update_state", "update_check", "update_set_automatic", "update_install", "close_notice_answer", "close_notice_seen"])
        .default_permission(DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(Attributes::new().plugin("mango-bridge", bridge)).expect("tauri-build");
}
