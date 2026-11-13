//! The models the agent knows, kept up to date while it runs. The agent is told every model of
//! the catalog at its launch, with the context of each and the model of new conversations. When that changes (a choice
//! changes a model's context or cards, a model of the user is added or removed, a model arrives or goes, the default
//! changes) the app writes `opencode.json` again (`agent_cfg::set_models`) and asks the agent to read it
//! (`POST /mango/reload`): the agent does it as soon as no conversation is answering. Only with this PC's engine: another
//! PC's models are that PC's, and they are read at the start.

use crate::AppState;
use agent_cfg::AgentModel;
use mango_common::Paths;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// What the agent was told: the models and the default.
#[derive(Default)]
pub struct Declared(Mutex<Option<(Vec<AgentModel>, Option<String>)>>);

impl Declared {
    /// What the launch of the agent declared.
    pub fn launched(&self, models: &[AgentModel], default: Option<&str>) {
        *self.0.lock().unwrap() = Some((models.to_vec(), default.map(str::to_string)));
    }

    /// The agent no longer knows these models: another PC's engine is in use, or the agent is starting again.
    pub fn forget(&self) {
        *self.0.lock().unwrap() = None;
    }

    /// Whether the models now differ from what the agent knows; if they do, they are taken as told. Nothing is known
    /// before the launch, and then nothing is to be told.
    fn changed(&self, models: &[AgentModel], default: Option<&str>) -> bool {
        let mut known = self.0.lock().unwrap();
        match known.as_ref() {
            Some((m, d)) if m.as_slice() == models && d.as_deref() == default => false,
            Some(_) => {
                *known = Some((models.to_vec(), default.map(str::to_string)));
                true
            }
            None => false,
        }
    }
}

/// The catalog's local models as the agent declares them.
pub fn of(catalog: &[engine_cfg::ModelEntry]) -> Vec<AgentModel> {
    catalog.iter().map(|v| AgentModel { key: v.key.clone(), label: v.label.clone(), ctx: v.ctx, images: v.images }).collect()
}

/// The catalog was read again: if the agent of this PC's engine knows other models or another default, `opencode.json`
/// is written again and the agent is asked, in a thread, to read it.
pub fn tell(app: &AppHandle, paths: &Paths, catalog: &[engine_cfg::ModelEntry], default: Option<&str>) {
    let st = app.state::<AppState>();
    let Some(agent) = st.agent.lock().unwrap().clone() else { return };
    if st.remote.lock().unwrap().is_some() {
        return;
    }
    let models = of(catalog);
    if !st.declared.changed(&models, default) {
        return;
    }
    if let Err(e) = agent_cfg::set_models(paths, &models, default) {
        crate::startup_log(paths, &format!("the agent's models not written again: {e:#}"));
        // Written again the next time something changes.
        st.declared.forget();
        return;
    }
    let paths = paths.clone();
    std::thread::spawn(move || {
        if let Err(e) = reload(&agent) {
            crate::startup_log(&paths, &format!("the agent was not asked to read its configuration again: {e:#}"));
        }
    });
}

/// `POST /mango/reload`: the agent answers at once (200 read now, 202 when no conversation answers any more). Its `/mango/*`
/// routes take only JSON (415 otherwise): an empty object.
fn reload(agent: &str) -> anyhow::Result<()> {
    let url = format!("{agent}/mango/reload");
    mango_common::internet::agent(&url, Duration::from_secs(10)).post(&url).header("Content-Type", "application/json").send("{}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(key: &str, ctx: u32) -> AgentModel {
        AgentModel { key: key.into(), label: key.to_uppercase(), ctx, images: false }
    }

    /// Only a change the agent would see is told: a context, a model, the default. Before the launch nothing is.
    #[test]
    fn the_agent_is_told_only_what_changed_since_it_was_told() {
        let d = Declared::default();
        assert!(!d.changed(&[model("a", 65_536)], None), "no agent launched yet");
        d.launched(&[model("a", 65_536), model("b", 32_768)], None);
        assert!(!d.changed(&[model("a", 65_536), model("b", 32_768)], None));
        assert!(d.changed(&[model("a", 32_768), model("b", 32_768)], None), "a context chosen");
        assert!(!d.changed(&[model("a", 32_768), model("b", 32_768)], None), "already told");
        assert!(d.changed(&[model("a", 32_768), model("b", 32_768)], Some("a")), "the first model arrived");
        assert!(d.changed(&[model("a", 32_768), model("b", 32_768), model("mine", 8_192)], Some("a")), "a model of the user");
        d.forget();
        assert!(!d.changed(&[model("a", 65_536)], None), "another PC's engine: nothing to tell");
    }

    /// The request the agent gets: a POST to its reload route, with a JSON body (the agent refuses any other with 415).
    #[test]
    fn the_reload_is_a_json_post_to_the_agent() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            // the head and the body may come in two reads
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n{}") {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "the request ended without its body: {}", String::from_utf8_lossy(&request));
                request.extend_from_slice(&chunk[..n]);
            }
            stream.write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 18\r\n\r\n{\"reloaded\":false}").unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        reload(&address).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /mango/reload HTTP/1.1\r\n"), "{request}");
        assert!(request.lines().any(|l| l.eq_ignore_ascii_case("content-type: application/json")), "{request}");
    }
}
