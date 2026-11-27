use std::path::Path;
use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

/// Makes `to` equal to `from`, writing only the files that differ: a write inside `ui/` rebuilds the app.
fn mirror(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(to)? {
        let entry = entry?;
        if from.join(entry.file_name()).exists() {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let copy = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            mirror(&entry.path(), &copy)?;
        } else {
            let content = std::fs::read(entry.path())?;
            if std::fs::read(&copy).ok().as_ref() != Some(&content) {
                std::fs::write(&copy, content)?;
            }
        }
    }
    Ok(())
}

fn main() {
    // The app's page sees only `ui/`: the files shared by the Mango apps (`suite/`, at the repo root) reach it as a copy,
    // before Tauri packs it. The copy is not committed.
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let suite = app.join("..").join("suite");
    println!("cargo:rerun-if-changed={}", suite.display());
    mirror(&suite, &app.join("ui").join("suite")).expect("copying suite/ into ui/");
    // The executable icon is icons/icon.ico: without this line, changing it does not relink.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    // Permissions of the bridge plugin (src/bridge.rs): without them, the web UI (a remote page) cannot call its commands.
    let bridge = InlinedPlugin::new()
        .commands(&["pick_folders", "projects_folder", "create_project", "read_clipboard_image", "open_external", "file_info", "open_path", "reveal_path", "set_titlebar_color", "models_download", "models_pause", "models_resume", "models_cancel", "models_set_default", "models_set_image_default", "models_set_choices", "models_remove", "models_open_folder", "models_dir_state", "models_dir_preview", "models_dir_move", "models_dir_use", "models_dir_cancel", "models_dir_restart", "model_place_preview", "model_place_move", "computer_set_gpu_used", "computer_set_small_models", "computer_open_optimize", "computer_update_engine", "other_models_search", "other_models_analyze", "other_models_pick_file", "user_models_add", "user_models_remove", "token_status", "token_save", "token_remove", "settings_pending", "zoom_get", "zoom_set", "preview_place", "preview_go", "preview_nav", "preview_state", "preview_capture", "preview_external", "preview_file", "chrome_info", "chrome_set_enabled", "team_info", "team_set_key", "team_remove_key", "team_save", "phone_state", "phone_set_enabled", "phone_new_key", "dictation_state", "dictation_set_enabled", "engine_share_state", "engine_share_set_enabled", "engine_share_new_key", "engine_remote_connect", "engine_remote_disconnect", "servers_state", "servers_add", "servers_refresh", "servers_remove", "servers_set_default", "ui_log", "report_problem", "report_info", "open_logs_folder", "update_state", "update_check", "update_set_automatic", "update_install", "close_notice_answer", "close_notice_seen", "ui_state_load", "ui_state_apply", "ui_state_mark_imported", "ui_state_flushed", "ui_blob_put", "ui_blob_get"])
        .default_permission(DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(Attributes::new().plugin("mango-bridge", bridge)).expect("tauri-build");
}
