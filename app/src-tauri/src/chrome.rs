//! "Use my Chrome": the agent drives the user's Chrome (their profile, their sign-ins) instead of the
//! Preview panel. It is an explicit choice, off by default, and shown only if Chrome is installed.
//!
//! The link is the remote debugging that Chrome offers from `chrome://inspect/#remote-debugging`: at every
//! connection Chrome shows a prompt ("Allow remote debugging?") that the user confirms.
//! Chrome refuses remote debugging on a fixed port with the default profile, so it cannot be
//! turned on from here: the user enables it by hand, once per Chrome start.
//!
//! The choice is in `browser.json` in the app data. `mango-chrome-mcp.mjs` also reads it at every
//! start of the browser server: so changing it does not require restarting the agent.

use crate::bridge::{err, BridgeError};
use mango_common::tr;
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Choice {
    pub my_chrome: bool,
}

pub fn choice_file() -> anyhow::Result<PathBuf> {
    Ok(mango_common::data_dir()?.join("browser.json"))
}

pub fn read_choice() -> Choice {
    choice_file()
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

pub fn write_choice(s: &Choice) -> anyhow::Result<()> {
    let f = choice_file()?;
    std::fs::write(&f, serde_json::to_string(s)?).map_err(|e| anyhow::anyhow!("{}: {e}", f.display()))
}

/// Where Windows installs Chrome (for everyone, for the user, 32-bit).
fn executables() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|v| std::env::var_os(v))
        .map(|base| PathBuf::from(base).join("Google").join("Chrome").join("Application").join("chrome.exe"))
        .collect()
}

pub fn installed() -> bool {
    executables().iter().any(|p| p.is_file())
}

/// `DevToolsActivePort` of the default profile: two lines, the port and the WebSocket path.
fn debug_port() -> Option<u16> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let f = PathBuf::from(base).join("Google").join("Chrome").join("User Data").join("DevToolsActivePort");
    port_from_file(&std::fs::read_to_string(f).ok()?)
}

fn port_from_file(text: &str) -> Option<u16> {
    text.lines().next()?.trim().parse::<u16>().ok().filter(|p| *p > 0)
}

/// Is Chrome's remote debugging on now? The file can remain after an abrupt close:
/// we check that someone is really listening.
pub fn debug_active() -> bool {
    debug_port().is_some_and(|p| {
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], p)), Duration::from_millis(500)).is_ok()
    })
}

#[derive(Serialize)]
pub struct ChromeInfo {
    /// Chrome is installed (the item in the settings is shown only in this case).
    installed: bool,
    /// Chrome's remote debugging is on now.
    debugging: bool,
    /// The user chose "Use my Chrome".
    enabled: bool,
}

#[tauri::command]
pub fn chrome_info() -> ChromeInfo {
    ChromeInfo { installed: installed(), debugging: debug_active(), enabled: read_choice().my_chrome }
}

/// Turns "Use my Chrome" on or off. Turning on is refused if Chrome is missing (`chrome_missing`) or has
/// remote debugging off (`chrome_debug_off`): the browser server would have nothing to connect to and the
/// agent would be left without a browser. Turning off goes back to the panel.
#[tauri::command]
pub fn chrome_set_enabled(enabled: bool) -> Result<(), BridgeError> {
    if enabled {
        if !installed() {
            return Err(err("chrome_missing", tr!("Chrome non è installato", "Chrome is not installed")));
        }
        if !debug_active() {
            return Err(err("chrome_debug_off", tr!("il debug remoto di Chrome è spento", "Chrome's remote debugging is off")));
        }
    }
    write_choice(&Choice { my_chrome: enabled }).map_err(|e| err("io", format!("{e:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_from_chromes_file() {
        assert_eq!(port_from_file("9222\n/devtools/browser/abc-def\n"), Some(9222));
        assert_eq!(port_from_file("9222"), Some(9222));
        assert_eq!(port_from_file("0\n/x"), None);
        assert_eq!(port_from_file("not a number\n/x"), None);
        assert_eq!(port_from_file(""), None);
    }

    #[test]
    fn the_choice_reads_as_the_code_writes_it_and_as_the_wrapper_reads_it() {
        let json = serde_json::to_string(&Choice { my_chrome: true }).unwrap();
        assert_eq!(json, r#"{"myChrome":true}"#);
        assert_eq!(serde_json::from_str::<Choice>(&json).unwrap(), Choice { my_chrome: true });
        // empty or damaged file: off
        assert_eq!(serde_json::from_str::<Choice>("{}").unwrap_or_default(), Choice::default());
    }
}
