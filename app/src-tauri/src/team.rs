//! The Team in the settings and in the chat: the OpenRouter key (in the Windows Credential Manager, never in a
//! file), how many agents and which models. Config generation is in `agent-cfg::team`; here the commands of the
//! web UI. The choices apply from the agent's start: saving them restarts the app, like changing the downloaded models.

use crate::bridge::{err, shown, BridgeError};
use crate::AppState;
use agent_cfg::team::{self, Choices};
use mango_common::{credentials, tr, Paths};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Debug, PartialEq)]
pub struct TeamModel {
    pub key: String,
    pub label: String,
}

/// The state the page shows. The key is not there: the page only knows whether it exists.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub key: bool,
    pub agents: u8,
    pub max: u8,
    pub manager: String,
    pub agent: String,
    /// The cloud models to choose from.
    pub models: Vec<TeamModel>,
}

pub fn info(paths: &Paths, key: bool) -> anyhow::Result<TeamInfo> {
    let choices = team::read_choices(paths)?;
    let catalog = mango_common::catalog::read(paths)?.root;
    Ok(TeamInfo {
        key,
        agents: choices.agents,
        max: team::AGENTS_MAX,
        manager: choices.manager,
        agent: choices.agent,
        models: team::cloud_models(&catalog).into_iter().map(|m| TeamModel { key: m.key, label: m.label }).collect(),
    })
}

/// The key as the user types it: without spaces at the edges, not empty and without spaces inside.
fn clean_key(text: &str) -> Option<&str> {
    let c = text.trim();
    (!c.is_empty() && !c.contains(char::is_whitespace)).then_some(c)
}

fn paths(app: &AppHandle) -> Result<Paths, BridgeError> {
    app.state::<AppState>().paths.get().cloned().ok_or_else(|| err("io", tr!("percorsi non ancora noti", "paths not known yet")))
}

fn io(app: &AppHandle, e: anyhow::Error) -> BridgeError {
    shown(app, "io", "team", e)
}

#[tauri::command]
pub fn team_info(app: AppHandle) -> Result<TeamInfo, BridgeError> {
    let key = credentials::read(team::CREDENTIAL).map_err(|e| io(&app, e))?.is_some();
    info(&paths(&app)?, key).map_err(|e| io(&app, e))
}

/// Saves the key in the Credential Manager and restarts the agent, which receives it in the environment.
#[tauri::command]
pub async fn team_set_key(app: AppHandle, key: String) -> Result<(), BridgeError> {
    let key = clean_key(&key)
        .ok_or_else(|| err("invalid_key", tr!("la chiave è vuota o contiene spazi", "the key is empty or contains spaces")))?;
    credentials::save(team::CREDENTIAL, key).map_err(|e| io(&app, e))?;
    crate::restart(&app);
    Ok(())
}

#[tauri::command]
pub async fn team_remove_key(app: AppHandle) -> Result<(), BridgeError> {
    credentials::remove(team::CREDENTIAL).map_err(|e| io(&app, e))?;
    crate::restart(&app);
    Ok(())
}

/// Saves how many agents and which models; if the Team is on (there is a key) it restarts the agent to apply them.
#[tauri::command]
pub async fn team_save(app: AppHandle, agents: u8, manager: String, agent: String) -> Result<(), BridgeError> {
    team::write_choices(&paths(&app)?, &Choices { agents, manager, agent }).map_err(|e| shown(&app, "invalid_choices", "team: choices not saved", e))?;
    if credentials::read(team::CREDENTIAL).map_err(|e| io(&app, e))?.is_some() {
        crate::restart(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_cleaned_and_rejected_if_empty_or_with_spaces() {
        assert_eq!(clean_key("  sk-or-v1-abc\r\n"), Some("sk-or-v1-abc"));
        for no in ["", "   ", "sk-or v1", "sk-or-v1\nabc"] {
            assert_eq!(clean_key(no), None, "{no:?}");
        }
    }

    #[test]
    fn the_page_receives_the_choices_and_the_cloud_models_but_not_the_key() {
        let dir = std::env::temp_dir().join(format!("mango-team-info-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().join("launcher");
        let paths = Paths {
            dist,
            engines: dir.join("e"),
            models: dir.join("m"),
            opencode: dir.join("o"),
            data: dir.join("d"),
        };
        std::fs::create_dir_all(&paths.data).unwrap();
        let without = info(&paths, false).unwrap();
        assert!(!without.key);
        assert_eq!((without.agents, without.max), (4, 4));
        assert_eq!((without.manager.as_str(), without.agent.as_str()), ("deepseek", "deepseek"));
        assert_eq!(without.models.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), ["deepseek", "qwen"]);
        assert_eq!(without.models[0].label, "DeepSeek V4.1 Flash");
        assert!(info(&paths, true).unwrap().key);
        assert!(!serde_json::to_string(&without).unwrap().contains("sk-"), "the key never goes through the page");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
