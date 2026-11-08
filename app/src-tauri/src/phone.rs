//! "From your phone" in the web UI settings: turns the phone service on and off (crate `phone`), gives
//! its links with the QR and renews the key. The commands go through the bridge: only the app window
//! sees them, the phone does not.

use crate::bridge::{err, BridgeError};
use tauri::{AppHandle, Manager};
use phone::{State, Phone};

/// The service, or why there is none (a `phone.json` that cannot be read): the settings page says it.
struct Service(Result<Phone, String>);

/// The service, with the state saved in the app data. If it was on, the port reopens right away: the agent arrives
/// later, and until then the phone gets `502`.
pub fn install(app: &AppHandle) {
    let service = mango_common::data_dir()
        .and_then(|data| Phone::new(&data, &data.join("logs"), listen_on(), crate::phone_port(), crate::agent_port()))
        .map_err(|e| format!("{e:#}"));
    app.manage(Service(service));
}

/// All networks. In development builds `MANGO_PHONE_PC_ONLY` keeps it on 127.0.0.1: the tests drive the
/// phone page from the PC without Windows asking to open the port.
fn listen_on() -> std::net::Ipv4Addr {
    #[cfg(debug_assertions)]
    if std::env::var_os("MANGO_PHONE_PC_ONLY").is_some() {
        return std::net::Ipv4Addr::LOCALHOST;
    }
    std::net::Ipv4Addr::UNSPECIFIED
}

fn service(app: &AppHandle) -> Result<&Phone, BridgeError> {
    app.state::<Service>().inner().0.as_ref().map_err(|e| err("unavailable", e.clone()))
}

#[tauri::command]
pub fn phone_state(app: AppHandle) -> Result<State, BridgeError> {
    Ok(service(&app)?.state())
}

#[tauri::command]
pub fn phone_set_enabled(app: AppHandle, enabled: bool) -> Result<State, BridgeError> {
    service(&app)?.set_enabled(enabled).map_err(|e| err("io", format!("{e:#}")))
}

#[tauri::command]
pub fn phone_new_key(app: AppHandle) -> Result<State, BridgeError> {
    service(&app)?.new_key().map_err(|e| err("io", format!("{e:#}")))
}
