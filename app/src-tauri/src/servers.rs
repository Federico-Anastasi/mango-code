//! «Use a server», in Settings › Connections: OpenAI-compatible servers whose models the agent uses beside the local ones
//! (`agent_cfg::servers`). Adding one asks it for its models and makes one real request; nothing is saved if that does
//! not work. Adding or removing a server starts the agent again (its key reaches the agent only in the environment);
//! reading a server's list again, or choosing a default on it, has the agent read its configuration again.

use crate::bridge::BridgeError;
use crate::downloads::blocking;
use crate::AppState;
use agent_cfg::servers::{self, ModelRef, Server, ServerModel, Servers};
use anyhow::{bail, Context, Result};
use mango_common::{credentials, tr, Paths};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Held while `servers.json` is read, changed and written: a probe takes up to a minute, and a removal or a default
/// chosen meanwhile would otherwise be written over. Probes run outside it.
static WRITING: Mutex<()> = Mutex::new(());

/// The keys whose absence the log has told: `for_the_agent` runs at each start and at each change of the models, and tells
/// each key once, until it is read again.
static REPORTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn paths(app: &AppHandle) -> Result<Paths> {
    app.state::<AppState>().paths.get().cloned().with_context(|| tr!("Mango Code si sta ancora avviando.", "Mango Code is still starting."))
}

/// The list to add to or remove from: a damaged file is put aside and a new list begins (the log says so).
fn read_to_change(paths: &Paths) -> Result<Servers> {
    let (list, put_aside) = servers::read_to_change(paths)?;
    if put_aside {
        crate::startup_log(paths, "the damaged list of external servers was put aside as servers.json.bad");
    }
    Ok(list)
}

fn first_report(name: &str) -> bool {
    let mut reported = REPORTED.lock().unwrap();
    let new = !reported.iter().any(|n| n == name);
    if new {
        reported.push(name.to_string());
    }
    new
}

enum KeyAction {
    Save,
    Read,
    Remove,
}

/// What the user reads when the key of the server `host` cannot be saved, read or removed: the app's words, not the name
/// the key has in the Credential Manager.
fn keychain(host: &str, action: KeyAction) -> String {
    match action {
        KeyAction::Save => tr!("Non riesco a salvare la chiave del server {host} nel Gestore credenziali di Windows.", "I can't save the key of the server {host} in the Windows Credential Manager."),
        KeyAction::Read => tr!("Non riesco a leggere la chiave del server {host} dal Gestore credenziali di Windows.", "I can't read the key of the server {host} from the Windows Credential Manager."),
        KeyAction::Remove => tr!("Non riesco a togliere la chiave del server {host} dal Gestore credenziali di Windows.", "I can't remove the key of the server {host} from the Windows Credential Manager."),
    }
}

/// What the agent needs: the servers, and the keys of those that have one. Nothing here stops the app: a list that
/// cannot be read leaves the agent without servers (Settings › Connections shows why), a key that is not in the
/// Credential Manager (removed by hand) or cannot be read leaves its server without one (its requests are refused), and
/// a default that is no longer among the models goes back to the local one. The log says each.
pub fn for_the_agent(paths: &Paths) -> (Servers, Vec<(String, String)>) {
    let mut list = match servers::read(paths) {
        Ok(list) => list,
        Err(e) => {
            crate::startup_log(paths, &format!("the agent starts without external servers: {e:#}"));
            return (Servers::default(), Vec::new());
        }
    };
    let mut keys = Vec::new();
    for s in list.list.iter_mut().filter(|s| s.key) {
        let name = s.credential();
        match credentials::read(&name) {
            Ok(Some(key)) => {
                REPORTED.lock().unwrap().retain(|n| *n != name);
                keys.push((name, key));
            }
            Ok(None) => {
                if first_report(&name) {
                    crate::startup_log(paths, &format!("the key of the server {} is not in the Credential Manager", s.label()));
                }
                s.key = false;
            }
            Err(e) => {
                if first_report(&name) {
                    crate::startup_log(paths, &format!("the key of the server {} cannot be read: {e:#}", s.label()));
                }
                s.key = false;
            }
        }
    }
    if list.default.is_some() && list.checked_default().is_none() {
        crate::startup_log(paths, "the default on an external server is not among its models: the local one is used");
        list.default = None;
    }
    (list, keys)
}

/// A change the agent reads from its configuration (`agent_models::tell`); with another PC's engine the agent reads it
/// only at its start, so the app starts again. A default that is no longer on a server loads the local one, as a start
/// does.
fn tell_the_agent(app: &AppHandle) {
    if app.state::<AppState>().remote.lock().unwrap().is_some() {
        crate::engine_remote::restart_after_the_answer(app.clone());
    } else if let Some((catalog, default)) = crate::choices_changed(app) {
        crate::load_default(app, &catalog, default.as_deref());
    }
}

/// The servers as the page shows them: no key, only whether there is one.
#[derive(Serialize)]
pub struct ServersView {
    list: Vec<ServerView>,
    default: Option<ModelRef>,
}

#[derive(Serialize)]
struct ServerView {
    id: String,
    label: String,
    url: String,
    key: bool,
    models: Vec<ModelView>,
}

/// A model of a server with the name the user reads for it.
#[derive(Serialize)]
struct ModelView {
    label: String,
    #[serde(flatten)]
    model: ServerModel,
}

fn view(s: Servers) -> ServersView {
    let models = |models: Vec<ServerModel>| models.into_iter().map(|model| ModelView { label: model.label(), model }).collect();
    ServersView {
        list: s.list.into_iter().map(|s| ServerView { label: s.label(), id: s.id, url: s.url, key: s.key, models: models(s.models) }).collect(),
        default: s.default,
    }
}

#[tauri::command]
pub async fn servers_state(app: AppHandle) -> Result<ServersView, BridgeError> {
    blocking(app, |app| Ok(view(servers::read(&paths(app)?)?))).await
}

/// How adding went: `context` when the server does not say the context of its models: nothing was saved, and the page
/// asks the user, proposing this number.
#[derive(Serialize)]
pub struct Added {
    context: Option<u32>,
}

/// The models of a probe with their context: the server's, or the one the user gave; `None` if one is missing.
fn with_context(found: Vec<servers::Found>, context: Option<u32>) -> Option<Vec<ServerModel>> {
    found.into_iter().map(|m| Some(ServerModel { ctx: m.ctx.or(context)?, id: m.id, images: m.images, price: m.price, name: m.name })).collect()
}

/// Adds the server at `address`, with its key if any: checked first (`servers::probe`); with a server that does not say
/// the context, saved once the user gives one (`context`). `as_default`: a server of one model makes it the model of new
/// conversations (the first start, where nothing local is downloaded); with more, the Home asks which.
#[tauri::command]
pub async fn servers_add(app: AppHandle, address: String, key: Option<String>, context: Option<u32>, as_default: Option<bool>) -> Result<Added, BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        let url = servers::normalize(&address)?;
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if let Some(key) = &key {
            servers::check_key(key)?;
        }
        let in_use = |list: &Servers| -> Result<()> {
            if list.list.iter().any(|s| s.url == url) {
                bail!("{}", tr!("Il server {url} è già fra quelli in uso.", "The server {url} is already among those in use."));
            }
            Ok(())
        };
        match servers::read(&paths) {
            Err(e) if servers::is_damaged(&e) => {}
            list => in_use(&list?)?,
        }
        let probed = servers::probe(&url, key.as_deref())?;
        let Some(models) = with_context(probed.models, context) else { return Ok(Added { context: Some(servers::PROPOSED_CONTEXT) }) };
        let _writing = WRITING.lock().unwrap();
        let mut list = read_to_change(&paths)?;
        in_use(&list)?;
        let server = Server { id: list.next_id(), url: url.clone(), key: key.is_some(), models, context };
        if let Some(key) = &key {
            credentials::save(&server.credential(), key).with_context(|| keychain(&server.label(), KeyAction::Save))?;
        }
        // with more than one model the user chooses (the Home lists them): none is chosen behind their back
        if as_default == Some(true) && server.models.len() == 1 {
            list.default = Some(ModelRef { server: server.id.clone(), model: probed.answered });
        }
        let credential = server.credential();
        list.list.push(server);
        if let Err(e) = servers::write(&paths, &list) {
            if key.is_some() {
                let _ = credentials::remove(&credential);
            }
            return Err(e.into());
        }
        crate::engine_remote::restart_after_the_answer(app.clone());
        Ok(Added { context: None })
    })
    .await
}

/// What «Refresh the list» changed that the user chose or relies on: the model of new conversations when it was on this
/// server and is gone (its name; they use the local default again), and the context of the models when it changed.
#[derive(Serialize)]
pub struct Refreshed {
    gone: Option<String>,
    context: Option<ContextChange>,
}

/// The smallest context of the server's models, before and after.
#[derive(Serialize)]
struct ContextChange {
    from: u32,
    to: u32,
}

/// The server `id` of `list` with the models of a probe: what the user chose or relies on and changed (`Refreshed`) is
/// answered. A model the server gives no context for, when the user gave none, is an error: nothing changes.
fn apply_refresh(list: &mut Servers, id: &str, found: Vec<servers::Found>) -> Result<Refreshed> {
    let s = list.list.iter_mut().find(|s| s.id == id).with_context(|| tr!("Il server non è più fra quelli in uso.", "The server is no longer among those in use."))?;
    let smallest = |models: &[ServerModel]| models.iter().map(|m| m.ctx).min();
    let before = (smallest(&s.models), list.default.as_ref().filter(|d| d.server == id).and_then(|d| s.models.iter().find(|m| m.id == d.model)).map(ServerModel::label));
    let Some(models) = with_context(found, s.context) else {
        let host = s.label();
        bail!(
            "{}",
            tr!(
                "Il server {host} non dice il contesto di alcuni modelli e non ne hai indicato uno: toglilo e aggiungilo di nuovo, scrivendo il contesto.",
                "The server {host} does not say the context of some models and you have not given one: remove it and add it again, writing the context."
            )
        );
    };
    s.models = models;
    let after = smallest(&s.models);
    let mut refreshed = Refreshed { gone: None, context: before.0.zip(after).filter(|(from, to)| from != to).map(|(from, to)| ContextChange { from, to }) };
    if list.default.is_some() && list.checked_default().is_none() {
        refreshed.gone = before.1;
        list.default = None;
    }
    Ok(refreshed)
}

/// «Refresh the list»: the server's models asked again, with the context given when it was added for those the server
/// does not say; a default on a model that is gone goes back to the local one. It answers what changed.
#[tauri::command]
pub async fn servers_refresh(app: AppHandle, id: String) -> Result<Refreshed, BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        let gone_server = || tr!("Il server non è più fra quelli in uso.", "The server is no longer among those in use.");
        let s = servers::read(&paths)?.list.into_iter().find(|s| s.id == id).with_context(gone_server)?;
        let key = if s.key { credentials::read(&s.credential()).with_context(|| keychain(&s.label(), KeyAction::Read))? } else { None };
        let probed = servers::probe(&s.url, key.as_deref())?;
        let _writing = WRITING.lock().unwrap();
        let mut list = servers::read(&paths)?;
        let refreshed = apply_refresh(&mut list, &id, probed.models)?;
        servers::write(&paths, &list)?;
        drop(_writing);
        tell_the_agent(app);
        Ok(refreshed)
    })
    .await
}

/// «Remove»: the server, its key and its models; a default on it goes back to the local one. The key goes first: a server
/// left in the list without it is one the user can remove again, a key left without its server would stay for good.
#[tauri::command]
pub async fn servers_remove(app: AppHandle, id: String) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        let _writing = WRITING.lock().unwrap();
        let mut list = read_to_change(&paths)?;
        let Some(at) = list.list.iter().position(|s| s.id == id) else { return Ok(()) };
        let gone = list.list.remove(at);
        if gone.key {
            credentials::remove(&gone.credential()).with_context(|| keychain(&gone.label(), KeyAction::Remove))?;
        }
        if list.default.as_ref().is_some_and(|d| d.server == id) {
            list.default = None;
        }
        servers::write(&paths, &list)?;
        crate::engine_remote::restart_after_the_answer(app.clone());
        Ok(())
    })
    .await
}

/// The model of new conversations on a server (`model` of server `server`), or back to the local default (`None`).
#[tauri::command]
pub async fn servers_set_default(app: AppHandle, server: Option<String>, model: Option<String>) -> Result<(), BridgeError> {
    blocking(app, move |app| {
        let paths = paths(app)?;
        set_default(&paths, server.zip(model).map(|(server, model)| ModelRef { server, model }))?;
        tell_the_agent(app);
        Ok(())
    })
    .await
}

/// The default on a server, or none: one that is not among a server's models is refused.
pub fn set_default(paths: &Paths, default: Option<ModelRef>) -> Result<()> {
    let _writing = WRITING.lock().unwrap();
    let mut list = servers::read(paths)?;
    if let Some(r) = &default {
        if !list.list.iter().any(|s| s.id == r.server && s.models.iter().any(|m| m.id == r.model)) {
            bail!("{}", tr!("Il modello «{}» non è fra quelli del server.", "The model «{}» is not among the server's.", r.model));
        }
    }
    if list.default == default {
        return Ok(());
    }
    list.default = default;
    servers::write(paths, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(id: &str, ctx: Option<u32>) -> servers::Found {
        servers::Found { id: id.into(), ctx, images: false, price: None, name: None }
    }

    fn server(context: Option<u32>) -> Servers {
        let model = ServerModel { id: "a".into(), ctx: 8192, images: false, price: None, name: None };
        Servers { list: vec![Server { id: "server-1".into(), url: "http://192.168.1.20:8080/v1".into(), key: false, models: vec![model], context }], default: None, last: 1 }
    }

    /// A refresh that finds a model with no context, when the user gave none, says so and changes nothing: no model
    /// goes on with a context nobody chose.
    #[test]
    fn a_refresh_does_not_invent_the_context_of_a_model() {
        let mut list = server(None);
        let said = apply_refresh(&mut list, "server-1", vec![found("a", Some(8192)), found("b", None)]).err().expect("refused").to_string();
        assert!(said.contains("192.168.1.20:8080") && said.contains(&tr!("non dice il contesto", "does not say the context")), "{said}");
        assert_eq!(list, server(None));
    }

    /// The context the user gave fills the models the server does not say, and a change of the smallest is told.
    #[test]
    fn a_refresh_gives_the_context_the_user_chose_to_the_models_that_lack_it() {
        let mut list = server(Some(16_384));
        let refreshed = apply_refresh(&mut list, "server-1", vec![found("a", Some(32_768)), found("b", None)]).unwrap();
        assert_eq!(list.list[0].models.iter().map(|m| (m.id.as_str(), m.ctx)).collect::<Vec<_>>(), [("a", 32_768), ("b", 16_384)]);
        let change = refreshed.context.expect("the smallest context changed");
        assert_eq!((change.from, change.to), (8192, 16_384));
    }
}
