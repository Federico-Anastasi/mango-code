//! The external servers: OpenAI-compatible servers (llama-server, LM Studio, a cloud service) whose models the agent uses
//! beside the local ones. Each is an opencode provider of its own (`server-<n>`): the agent talks to it directly, without
//! the engine manager, so nothing of Mango Code's engine applies there (the queue, the memory on disk, the catalog's
//! sampling: the server's own hold). The list lives in `<data>/servers.json`, without secrets; the key of each, if any,
//! is in the Credential Manager and reaches the agent in its environment (`Server::credential`), like the Team's.

use anyhow::{bail, Context, Result};
use mango_common::{tr, Paths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const FILE: &str = "servers.json";
/// The context proposed when the server does not say it.
pub const PROPOSED_CONTEXT: u32 = 32_768;
/// How long a probe waits for each answer: a cloud service far away, a server on the LAN that is loading its model.
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// What `servers.json` holds.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Servers {
    pub list: Vec<Server>,
    /// The model of new conversations, when it is a server's: then the local one is not loaded at start.
    pub default: Option<ModelRef>,
    /// The number of the last id given: an id never comes back, or the conversations of a server removed would go to
    /// the next one added.
    pub last: u32,
}

/// A model of a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub server: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    /// The provider in the agent's configuration: `server-<n>`, never given again.
    pub id: String,
    /// The base of the API, followed by `/models` and `/chat/completions`.
    pub url: String,
    /// A key for it is in the Credential Manager, under `credential()`.
    pub key: bool,
    pub models: Vec<ServerModel>,
    /// The context the user gave for the models whose context the server does not say.
    #[serde(default)]
    pub context: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerModel {
    pub id: String,
    pub ctx: u32,
    pub images: bool,
    /// What it costs, when the service says it (OpenRouter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<Price>,
    /// The name the server gives it, when it gives one (OpenRouter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ServerModel {
    /// What the user reads for the model: the name the server gives, or its id; the name of a file (llama-server names
    /// its model by the path of the file) without its folder and its extension.
    pub fn label(&self) -> String {
        let said = self.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&self.id);
        let is_path = said.contains('\\') || said.starts_with('/') || said.as_bytes().get(1) == Some(&b':') || said.to_ascii_lowercase().ends_with(".gguf");
        if !is_path {
            return said.to_string();
        }
        let file = said.rsplit(['/', '\\']).next().unwrap_or(said);
        let stem = file.len().checked_sub(5).filter(|&at| file.is_char_boundary(at) && file[at..].eq_ignore_ascii_case(".gguf")).map_or(file, |at| &file[..at]);
        if stem.is_empty() { said.to_string() } else { stem.to_string() }
    }
}

/// US dollars per million tokens, read and written.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Price {
    pub input: f64,
    pub output: f64,
}

impl Server {
    /// What the user reads for the server: the host, with the port when there is one ("192.168.1.20:8080",
    /// "api.openai.com").
    pub fn label(&self) -> String {
        host_of(&self.url).to_string()
    }

    /// The name of its key in the Credential Manager, which is also the variable that brings it to the agent.
    pub fn credential(&self) -> String {
        format!("MANGO_SERVER_KEY_{}", self.id.replace('-', "_").to_uppercase())
    }
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split('/').next().unwrap_or(rest)
}

impl Servers {
    /// The default on a server, if it is still among that server's models: a list written by hand may name one that is
    /// not, and then the local default holds.
    pub fn checked_default(&self) -> Option<&ModelRef> {
        self.default.as_ref().filter(|d| self.list.iter().any(|s| s.id == d.server && s.models.iter().any(|m| m.id == d.model)))
    }

    /// The id of a server being added: one more than any given before.
    pub fn next_id(&mut self) -> String {
        let listed = self.list.iter().filter_map(|s| s.id.strip_prefix("server-")?.parse::<u32>().ok()).max().unwrap_or(0);
        self.last = self.last.max(listed) + 1;
        format!("server-{}", self.last)
    }
}

/// The saved servers; none if the file isn't there. A file that can't be read is an error that says so.
pub fn read(paths: &Paths) -> Result<Servers> {
    let f = paths.data.join(FILE);
    let text = match std::fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Servers::default()),
        Err(e) => return Err(e).with_context(|| mango_common::user_text(&tr!("Non riesco a leggere i server esterni.", "I can't read the external servers."), f.display())),
    };
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .with_context(|| {
            mango_common::user_text(
                &tr!(
                    "L'elenco dei server esterni è rovinato: aggiungi un server e si ricomincia da un elenco nuovo; quello rovinato resta da parte.",
                    "The list of external servers is damaged: add a server and a new list is started; the damaged one is kept aside."
                ),
                f.display(),
            )
        })
}

/// Whether `read` failed because the file is not a list (and not because it could not be opened).
pub fn is_damaged(error: &anyhow::Error) -> bool {
    error.downcast_ref::<serde_json::Error>().is_some()
}

/// The saved servers, to change them: a damaged file is moved aside (`servers.json.bad`, over an older one) and the list
/// starts empty; the second value says so, for the log.
pub fn read_to_change(paths: &Paths) -> Result<(Servers, bool)> {
    match read(paths) {
        Ok(list) => Ok((list, false)),
        Err(e) if is_damaged(&e) => {
            let f = paths.data.join(FILE);
            let aside = paths.data.join(format!("{FILE}.bad"));
            std::fs::rename(&f, &aside).with_context(|| mango_common::user_text(&tr!("Non riesco a mettere da parte l'elenco rovinato dei server esterni.", "I can't put the damaged list of external servers aside."), f.display()))?;
            Ok((Servers::default(), true))
        }
        Err(e) => Err(e),
    }
}

pub fn write(paths: &Paths, servers: &Servers) -> Result<()> {
    let f = paths.data.join(FILE);
    mango_common::write_atomic(&f, serde_json::to_string_pretty(servers)?)
        .with_context(|| mango_common::user_text(&tr!("Non riesco a salvare i server esterni.", "I can't save the external servers."), f.display()))
}

/// Whether an address (host and port) is on this computer or its network, where servers speak plain http: a private or
/// loopback number, `localhost`, a name without dots or one that ends like a home network's.
fn on_the_local_network(authority: &str) -> bool {
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    }
    .to_ascii_lowercase();
    mango_common::internet::is_local(&host) || !host.contains('.') || [".local", ".lan", ".home.arpa", ".internal"].iter().any(|end| host.ends_with(end))
}

/// The address the user wrote as the base of the API: with no scheme, `http://` on this computer or its network and
/// `https://` anywhere else; `/v1` when it has no path, and without the route of a request pasted with it ("…/v1/models",
/// "…/v1/chat/completions").
pub fn normalize(text: &str) -> Result<String> {
    let text = text.trim().trim_end_matches('/');
    if text.is_empty() {
        bail!("{}", tr!("Scrivi l'indirizzo del server.", "Write the server's address."));
    }
    let url = if text.contains("://") { text.to_string() } else { format!("{}://{text}", if on_the_local_network(host_of(text)) { "http" } else { "https" }) };
    let (scheme, rest) = url.split_once("://").expect("a scheme was added");
    let host = host_of(&url);
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") || host.is_empty() || host.ends_with(':') || rest.contains(char::is_whitespace) {
        bail!("{}", tr!("«{text}» non è l'indirizzo di un server: scrivilo come http://192.168.1.20:8080.", "«{text}» is not a server's address: write it as http://192.168.1.20:8080."));
    }
    // The address is saved and shown as it is: a key written into it would be in the clear.
    if host.contains('@') || rest.contains(['?', '#']) {
        bail!("{}", tr!("Scrivi l'indirizzo senza nome, password o parametri: la chiave va nel suo campo.", "Write the address without a name, password or parameters: the key goes in its own field."));
    }
    let url = ["/chat/completions", "/models"].iter().fold(url.clone(), |u, route| u.strip_suffix(route).map_or(u.clone(), str::to_string));
    let has_path = url.split_once("://").is_some_and(|(_, r)| r.contains('/'));
    Ok(if has_path { url } else { format!("{url}/v1") })
}

/// A key as the user pasted it, checked: it reaches the agent's configuration as text, where quotes, backslashes or
/// braces would break it, and a key has none of them.
pub fn check_key(key: &str) -> Result<()> {
    if !key.chars().all(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\\' | '{' | '}')) {
        bail!("{}", tr!("La chiave ha caratteri che una chiave non ha: incollala senza virgolette né spazi.", "The key has characters a key does not have: paste it without quotes or spaces."));
    }
    Ok(())
}

/// Whether a model of the list writes text: the list says so (`architecture.output_modalities`, `type`), or its name is
/// one of the families that do not (embeddings, speech, pictures). A request to one of those is no proof of anything.
fn writes(m: &Value) -> bool {
    let out = m.pointer("/architecture/output_modalities").and_then(Value::as_array);
    if out.is_some_and(|o| !o.iter().any(|x| x == "text")) || matches!(m["type"].as_str(), Some("embedding" | "embeddings")) {
        return false;
    }
    let id = m["id"].as_str().unwrap_or_default().to_ascii_lowercase();
    !["embed", "rerank", "whisper", "transcribe", "tts", "dall-e", "gpt-image", "moderation", "babbage", "davinci", "realtime", "audio"].iter().any(|w| id.contains(w))
}

/// A model as the server describes it; `ctx` and `price` when it says them.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub ctx: Option<u32>,
    pub images: bool,
    pub price: Option<Price>,
    pub name: Option<String>,
}

/// The price of a model of the list, per million tokens; `Err` for a price that is not fixed (a router that picks the
/// model, `-1`), which the user could not know before paying.
fn price_of(m: &Value) -> Result<Option<Price>, ()> {
    let per_token = |k: &str| m.pointer(&format!("/pricing/{k}")).and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_f64().map(|n| n.to_string()))).and_then(|s| s.parse::<f64>().ok());
    match (per_token("prompt"), per_token("completion")) {
        (Some(i), Some(o)) if i < 0.0 || o < 0.0 => Err(()),
        (Some(i), Some(o)) => Ok(Some(Price { input: (i * 1e6 * 1e4).round() / 1e4, output: (o * 1e6 * 1e4).round() / 1e4 })),
        _ => Ok(None),
    }
}

/// The model can call tools, or the list does not say: the agent sends tools with every request.
fn takes_tools(m: &Value) -> bool {
    m["supported_parameters"].as_array().is_none_or(|p| p.iter().any(|x| x == "tools"))
}

/// What a probe found: the models that write text, and the one that answered the request.
#[derive(Debug, Clone, PartialEq)]
pub struct Probed {
    pub models: Vec<Found>,
    pub answered: String,
}

/// How many models a probe asks before it takes the server's refusal as its answer.
const PROBE_TRIES: usize = 3;

/// Asks the server at `url` (already `normalize`d) for its models and makes the smallest real request the agent would
/// make (streaming, with a tool) with the first model that answers among the first few: a server that lists models but
/// refuses the requests the agent sends is no use. The errors are sentences for the user: the address that does not
/// answer, the key refused, the format refused, no model.
pub fn probe(url: &str, key: Option<&str>) -> Result<Probed> {
    let agent = mango_common::internet::agent_with_replies(url, PROBE_TIMEOUT);
    let auth = key.map(|k| format!("Bearer {k}"));
    let with_key = |r: ureq::RequestBuilder<ureq::typestate::WithoutBody>| match &auth {
        Some(a) => r.header("Authorization", a),
        None => r,
    };
    let host = host_of(url);
    let unreachable = |e: ureq::Error| {
        let sentence = match e {
            ureq::Error::HostNotFound => tr!("Non trovo il server {host}: controlla come hai scritto l'indirizzo.", "I cannot find the server {host}: check how you wrote the address."),
            ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::Pem(_) => tr!(
                "Non riesco a collegarmi in modo sicuro a {host}: il suo certificato non è valido, o il server non usa https (scrivi l'indirizzo con http://).",
                "I cannot connect to {host} securely: its certificate is not valid, or the server does not use https (write the address with http://)."
            ),
            _ => tr!("Il server {host} non risponde: controlla l'indirizzo e che sia acceso.", "The server {host} does not answer: check the address and that it is on."),
        };
        mango_common::user_error(&sentence, &e)
    };
    let mut r = with_key(agent.get(format!("{url}/models"))).call().map_err(unreachable)?;
    let status = r.status().as_u16();
    let body = r.body_mut().read_to_string().unwrap_or_default();
    refused(status, &body, key.is_some())?;
    let listed: Value = serde_json::from_str(&body).ok().filter(|v: &Value| v["data"].is_array()).with_context(|| not_openai(url))?;
    let props = props(&agent, url, auth.as_deref());
    let mut found: Vec<Found> = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| writes(m) && takes_tools(m))
        .filter_map(|m| {
            let price = price_of(m).ok()?;
            let id = m["id"].as_str()?.to_string();
            let said = ["context_length", "max_model_len", "context_window"].iter().find_map(|k| m[*k].as_u64());
            let ctx = said.or_else(|| props.as_ref().and_then(|p| p.0)).and_then(|c| u32::try_from(c).ok());
            let modalities = m.pointer("/architecture/input_modalities").and_then(Value::as_array);
            let images = modalities.is_some_and(|a| a.iter().any(|x| x == "image")) || props.as_ref().is_some_and(|p| p.1);
            let name = m["name"].as_str().map(str::trim).filter(|n| !n.is_empty() && *n != id).map(str::to_string);
            Some(Found { id, ctx, images, price, name })
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    if found.is_empty() {
        // LM Studio lists only the models in memory unless it loads them on request; its own API lists what is downloaded
        let own = agent.get(format!("{}/api/v0/models", url.strip_suffix("/v1").unwrap_or(url)));
        let own = match &auth {
            Some(a) => own.header("Authorization", a),
            None => own,
        };
        let downloaded = own.call().ok().filter(|r| r.status().is_success()).and_then(|mut r| r.body_mut().read_to_string().ok()).and_then(|b| serde_json::from_str::<Value>(&b).ok()).and_then(|v| {
            let list = v["data"].as_array()?;
            Some(list.iter().filter(|m| matches!(m["type"].as_str(), Some("llm" | "vlm"))).count())
        });
        match downloaded {
            Some(0) => bail!("{}", tr!("LM Studio non ha nessun modello scaricato: scaricane uno e riprova.", "LM Studio has no model downloaded: download one and try again.")),
            Some(_) => bail!(
                "{}",
                tr!(
                    "LM Studio ha dei modelli scaricati ma nessuno caricato: caricane uno, o attiva il caricamento al bisogno (Just-In-Time) in Developer › Server Settings.",
                    "LM Studio has models downloaded but none loaded: load one, or turn on loading on request (Just-In-Time) in Developer › Server Settings."
                )
            ),
            None => {
                let models = listed["data"].as_array().map(Vec::as_slice).unwrap_or_default();
                if models.is_empty() {
                    bail!("{}", tr!("Il server {host} non offre nessun modello: caricane uno nel server e riprova.", "The server {host} offers no model: load one in the server and try again."));
                }
                let count = |dropped: &dyn Fn(&Value) -> bool| models.iter().filter(|m| dropped(m)).count();
                let no_text = count(&|m| !writes(m));
                let no_tools = count(&|m| writes(m) && !takes_tools(m));
                let no_price = count(&|m| writes(m) && takes_tools(m) && price_of(m).is_err());
                let total = models.len();
                bail!(
                    "{}",
                    tr!(
                        "Il server {host} offre {total} modelli, ma nessuno va bene a Mango Code: servono modelli che scrivono testo, usano gli strumenti e hanno un prezzo fisso (non scrivono testo: {no_text}; senza strumenti: {no_tools}; prezzo non fisso: {no_price}).",
                        "The server {host} offers {total} models, but none suits Mango Code: it needs models that write text, use tools and have a fixed price (no text output: {no_text}; no tools: {no_tools}; price not fixed: {no_price})."
                    )
                )
            }
        }
    }
    let tool = json!({ "type": "function", "function": { "name": "read", "description": "Reads a file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } });
    // the real request costs: the cheapest paid model first, then the free ones (the first to refuse for too many
    // requests), then those without a price, in the order of the list
    let mut asked: Vec<&Found> = found.iter().collect();
    asked.sort_by(|a, b| {
        let rank = |m: &Found| match m.price {
            Some(p) if p.input + p.output > 0.0 => (0, p.input + p.output),
            Some(_) => (1, 0.0),
            None => (2, 0.0),
        };
        rank(a).partial_cmp(&rank(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut last = None;
    for model in asked.into_iter().take(PROBE_TRIES) {
        let request = json!({ "model": model.id, "messages": [{ "role": "user", "content": "Hi" }], "max_tokens": 1, "stream": true, "tools": [tool] });
        let post = agent.post(format!("{url}/chat/completions")).header("Content-Type", "application/json");
        let post = match &auth {
            Some(a) => post.header("Authorization", a),
            None => post,
        };
        let mut r = post.send(request.to_string()).map_err(unreachable)?;
        let status = r.status().as_u16();
        let body = r.body_mut().read_to_string().unwrap_or_default();
        match refused(status, &body, key.is_some()) {
            Ok(()) => return Ok(Probed { answered: model.id.clone(), models: found }),
            // Another model would get the same answer.
            Err(e) if matches!(status, 401..=403 | 429) || status >= 500 => return Err(e),
            Err(e) => last = Some(e),
        }
    }
    Err(last.expect("at least one model was asked"))
}

/// The context (when it says one) and whether it sees images, from llama-server's `/props` at the root of the address;
/// `None` from a server that has no such route.
fn props(agent: &ureq::Agent, url: &str, auth: Option<&str>) -> Option<(Option<u64>, bool)> {
    let root = url.strip_suffix("/v1").unwrap_or(url);
    let request = agent.get(format!("{root}/props"));
    let request = match auth {
        Some(a) => request.header("Authorization", a),
        None => request,
    };
    let mut r = request.call().ok().filter(|r| r.status().is_success())?;
    let v: Value = serde_json::from_str(&r.body_mut().read_to_string().ok()?).ok()?;
    let ctx = v.pointer("/default_generation_settings/n_ctx").and_then(Value::as_u64);
    Some((ctx, v.pointer("/modalities/vision").and_then(Value::as_bool).unwrap_or(false)))
}

/// An answer that is not a success, as a sentence: the key (401, 403: asked for, or refused when one was sent) or the format
/// (any other 4xx), with what the server says; a 5xx is the server's trouble.
fn refused(status: u16, body: &str, key: bool) -> Result<()> {
    let said = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").or_else(|| v.get("error")).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status {
        200..=299 => Ok(()),
        402 => bail!("{}", tr!("Il servizio chiede un pagamento o del credito (402). ({said})", "The service asks for a payment or credit (402). ({said})")),
        429 => bail!("{}", tr!("Il server rifiuta per troppe richieste o per un limite raggiunto (429): riprova più tardi. ({said})", "The server refuses for too many requests or a limit reached (429): try again later. ({said})")),
        401 | 403 if !key => bail!("{}", tr!("Il server chiede una chiave ({status}): scrivila e riprova. ({said})", "The server asks for a key ({status}): write it and try again. ({said})")),
        401 | 403 => bail!("{}", tr!("Il server rifiuta la chiave ({status}): controlla di averla scritta giusta. ({said})", "The server refuses the key ({status}): check that you wrote it right. ({said})")),
        400..=499 => bail!("{}", tr!("Il server rifiuta le richieste di Mango Code ({status}): non parla il formato di OpenAI. ({said})", "The server refuses Mango Code's requests ({status}): it does not speak OpenAI's format. ({said})")),
        _ => bail!("{}", tr!("Il server risponde con un errore ({status}): riprova quando funziona. ({said})", "The server answers with an error ({status}): try again when it works. ({said})")),
    }
}

fn not_openai(url: &str) -> String {
    tr!(
        "All'indirizzo {url} risponde qualcosa che non è un server compatibile con OpenAI: l'indirizzo finisce di solito con /v1.",
        "At {url} something answers that is not an OpenAI-compatible server: the address usually ends with /v1."
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    /// A server that answers each route with what the test gives (status and body) and keeps the requests it got. A
    /// route written `path#model` answers only the requests for that model.
    pub(crate) struct Fake {
        pub(crate) url: String,
        pub(crate) requests: Arc<Mutex<Vec<String>>>,
    }

    pub(crate) fn fake(routes: &[(&str, u16, &str)]) -> Fake {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let routes: Vec<(String, u16, String)> = routes.iter().map(|(r, s, b)| (r.to_string(), *s, b.to_string())).collect();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let kept = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|n| n.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let line = text.lines().next().unwrap_or("").to_string();
                let path = line.split(' ').nth(1).unwrap_or("").to_string();
                kept.lock().unwrap().push(text.clone());
                let for_it = |r: &str| match r.split_once('#') {
                    Some((p, model)) => p == path && text.contains(&format!("\"model\":\"{model}\"")),
                    None => r == path,
                };
                let (status, body) = routes.iter().find(|(r, _, _)| for_it(r)).map_or((404, "{}".to_string()), |(_, s, b)| (*s, b.clone()));
                let _ = stream.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes());
            }
        });
        Fake { url, requests }
    }

    const MODELS: &str = r#"{"object":"list","data":[{"id":"qwen3.5-9b","object":"model"},{"id":"gemma-4","object":"model"}]}"#;
    const ANSWER: &str = r#"{"choices":[{"message":{"role":"assistant","content":"H"}}]}"#;

    #[test]
    fn an_address_is_the_base_of_the_api() {
        for (written, base) in [
            ("192.168.1.20:8080", "http://192.168.1.20:8080/v1"),
            ("http://localhost:1234/v1/", "http://localhost:1234/v1"),
            ("https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"),
            ("https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1"),
            ("  http://pc.local:8080  ", "http://pc.local:8080/v1"),
            ("openrouter.ai/api/v1", "https://openrouter.ai/api/v1"),
            ("api.openai.com", "https://api.openai.com/v1"),
            ("my-server.example.com:8443/v1/models", "https://my-server.example.com:8443/v1"),
            ("pc.local:8080", "http://pc.local:8080/v1"),
            ("localhost:1234", "http://localhost:1234/v1"),
            ("mypc:8080", "http://mypc:8080/v1"),
            ("10.0.0.5", "http://10.0.0.5/v1"),
            ("[::1]:8080", "http://[::1]:8080/v1"),
        ] {
            assert_eq!(normalize(written).unwrap(), base, "{written}");
        }
        for wrong in ["", "ftp://x", "http://", "a b", "http://me:secret@pc.local:8080/v1", "https://api.example.com/v1?key=sk-1", "pc.local/v1#x"] {
            assert!(normalize(wrong).is_err(), "{wrong}");
        }
    }

    /// llama-server: the models from `/v1/models`, the context and the images from `/props`; then one real request, with
    /// the key, to the first model in order.
    #[test]
    fn a_llama_server_gives_its_models_with_context_and_images() {
        let f = fake(&[
            ("/v1/models", 200, MODELS),
            ("/props", 200, r#"{"default_generation_settings":{"n_ctx":65536},"modalities":{"vision":true}}"#),
            ("/v1/chat/completions", 200, ANSWER),
        ]);
        let probed = probe(&format!("{}/v1", f.url), Some("sk-test")).unwrap();
        assert_eq!(probed.models, [Found { id: "gemma-4".into(), ctx: Some(65_536), images: true, price: None, name: None }, Found { id: "qwen3.5-9b".into(), ctx: Some(65_536), images: true, price: None, name: None }]);
        assert_eq!(probed.answered, "gemma-4");
        let requests = f.requests.lock().unwrap();
        let chat = requests.iter().find(|r| r.starts_with("POST /v1/chat/completions")).expect("a real request");
        assert!(["\"model\":\"gemma-4\"", "\"max_tokens\":1", "\"stream\":true", "\"tools\":"].iter().all(|s| chat.contains(s)), "{chat}");
        assert!(requests.iter().all(|r| r.lines().any(|l| l.eq_ignore_ascii_case("authorization: Bearer sk-test"))), "{requests:?}");
    }

    /// A cloud service says the context and the images of each model in its list; a server that says nothing leaves the
    /// context to the user.
    #[test]
    fn the_context_comes_from_the_list_or_is_left_to_the_user() {
        let f = fake(&[
            ("/api/v1/models", 200, r#"{"data":[{"id":"a/b","context_length":131072,"architecture":{"input_modalities":["text","image"]}},{"id":"c/d","context_length":8192}]}"#),
            ("/api/v1/chat/completions", 200, ANSWER),
        ]);
        let found = probe(&format!("{}/api/v1", f.url), None).unwrap().models;
        assert_eq!(found, [Found { id: "a/b".into(), ctx: Some(131_072), images: true, price: None, name: None }, Found { id: "c/d".into(), ctx: Some(8192), images: false, price: None, name: None }]);
        let f = fake(&[("/v1/models", 200, MODELS), ("/v1/chat/completions", 200, ANSWER)]);
        assert!(probe(&format!("{}/v1", f.url), None).unwrap().models.iter().all(|m| m.ctx.is_none() && !m.images));
    }

    /// A cloud service with prices (OpenRouter): a model that cannot call tools is no use to the agent and is left out,
    /// as one whose price is not fixed; each model keeps its price per million tokens, and the real request goes to the
    /// cheapest one that is paid for (a free one is the first to answer «too many requests»).
    #[test]
    fn a_cloud_list_keeps_the_models_with_tools_and_a_price_and_asks_the_cheapest() {
        let list = r#"{"data":[
            {"id":"anthropic/opus","supported_parameters":["tools","temperature"],"pricing":{"prompt":"0.000015","completion":"0.000075"}},
            {"id":"cheap/small","supported_parameters":["tools"],"pricing":{"prompt":"0.0000001","completion":"0.0000004"}},
            {"id":"free/one:free","supported_parameters":["tools"],"pricing":{"prompt":"0","completion":"0"}},
            {"id":"gemma/no-tools","supported_parameters":["temperature"],"pricing":{"prompt":"0.0000001","completion":"0.0000001"}},
            {"id":"openrouter/auto","supported_parameters":["tools"],"pricing":{"prompt":"-1","completion":"-1"}}
        ]}"#;
        let f = fake(&[("/api/v1/models", 200, list), ("/api/v1/chat/completions", 200, ANSWER)]);
        let probed = probe(&format!("{}/api/v1", f.url), Some("k")).unwrap();
        assert_eq!(probed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["anthropic/opus", "cheap/small", "free/one:free"]);
        assert_eq!(probed.models[0].price, Some(Price { input: 15.0, output: 75.0 }));
        assert_eq!(probed.models[2].price, Some(Price { input: 0.0, output: 0.0 }));
        assert_eq!(probed.answered, "cheap/small");
        let requests = f.requests.lock().unwrap();
        let asked: Vec<&String> = requests.iter().filter(|r| r.starts_with("POST")).collect();
        assert!(asked.len() == 1 && asked[0].contains("\"model\":\"cheap/small\""), "{asked:?}");
    }

    /// Each way it can go wrong is a sentence that says which.
    #[test]
    fn each_refusal_says_what_is_wrong() {
        let said = |routes: &[(&str, u16, &str)]| {
            let f = fake(routes);
            probe(&format!("{}/v1", f.url), Some("k")).unwrap_err().to_string()
        };
        assert!(said(&[("/v1/models", 401, r#"{"error":{"message":"Invalid API key"}}"#)]).contains(&tr!("rifiuta la chiave", "refuses the key")));
        assert!(said(&[("/v1/models", 200, MODELS), ("/v1/chat/completions", 403, "{}")]).contains(&tr!("rifiuta la chiave", "refuses the key")));
        let format = said(&[("/v1/models", 200, MODELS), ("/v1/chat/completions", 400, r#"{"error":{"message":"tools not supported"}}"#)]);
        assert!(format.contains(&tr!("non parla il formato", "does not speak")) && format.contains("tools not supported"), "{format}");
        assert!(said(&[("/v1/models", 200, r#"{"data":[]}"#)]).contains(&tr!("nessun modello", "no model")));
        assert!(said(&[("/v1/models", 200, "<html>router</html>")]).contains("/v1"));
        assert!(said(&[("/v1/models", 200, MODELS), ("/v1/chat/completions", 402, "{}")]).contains("402"));
        assert!(said(&[("/v1/models", 200, MODELS), ("/v1/chat/completions", 429, "{}")]).contains("429"));
        let gone = probe("http://127.0.0.1:9/v1", None).unwrap_err();
        let shown = mango_common::user_phrase(&gone);
        assert!(shown.contains(&tr!("non risponde", "does not answer")), "{shown}");
        assert!(!shown.to_lowercase().contains("os error") && !shown.contains("(io") && !shown.contains('('), "the app's sentence alone, not the system's: {shown}");
        assert!(gone.to_string().len() > shown.len(), "the system's text is kept for the log");
    }

    /// With no key typed the sentence says the server asks for one; with a key, that it is refused.
    #[test]
    fn a_missing_key_and_a_wrong_key_are_told_apart() {
        let f = fake(&[("/v1/models", 401, r#"{"error":{"message":"Missing Authentication header"}}"#)]);
        let url = format!("{}/v1", f.url);
        let none = probe(&url, None).unwrap_err().to_string();
        assert!(none.contains(&tr!("chiede una chiave", "asks for a key")) && !none.contains(&tr!("lasciala vuota", "leave it empty")), "{none}");
        let wrong = probe(&url, Some("sk-wrong")).unwrap_err().to_string();
        assert!(wrong.contains(&tr!("rifiuta la chiave", "refuses the key")) && !wrong.contains(&tr!("chiede una chiave", "asks for a key")), "{wrong}");
    }

    /// LM Studio lists only the models in memory unless it loads them on request: with none loaded the sentence says what to
    /// do in LM Studio, by what its own API says it has downloaded; with loading on request its list offers them all.
    #[test]
    fn lm_studio_with_no_model_loaded_says_what_to_do_there() {
        let list = r#"{"data":[{"id":"text-embedding-nomic-embed-text-v1.5","object":"model"}]}"#;
        let downloaded = r#"{"object":"list","data":[{"id":"text-embedding-nomic-embed-text-v1.5","type":"embeddings","state":"not-loaded"},{"id":"qwen/qwen3-4b","type":"llm","state":"not-loaded"}]}"#;
        let f = fake(&[("/v1/models", 200, list), ("/api/v0/models", 200, downloaded)]);
        let said = probe(&format!("{}/v1", f.url), None).unwrap_err().to_string();
        assert!(said.contains("LM Studio") && said.contains("Just-In-Time") && !said.contains("nessun modello caricato"), "{said}");
        let f = fake(&[("/v1/models", 200, list), ("/api/v0/models", 200, r#"{"data":[{"id":"x","type":"embeddings"}]}"#)]);
        assert!(probe(&format!("{}/v1", f.url), None).unwrap_err().to_string().contains(&tr!("nessun modello scaricato", "no model downloaded")));
        let f = fake(&[("/v1/models", 200, r#"{"data":[]}"#)]);
        let other = probe(&format!("{}/v1", f.url), None).unwrap_err().to_string();
        assert!(!other.contains("LM Studio") && other.contains(&tr!("non offre nessun modello", "offers no model")), "{other}");
        let all = r#"{"data":[{"id":"qwen/qwen3-4b","object":"model"},{"id":"text-embedding-nomic-embed-text-v1.5","object":"model"}]}"#;
        let f = fake(&[("/v1/models", 200, all), ("/v1/chat/completions", 200, ANSWER)]);
        let probed = probe(&format!("{}/v1", f.url), None).unwrap();
        assert_eq!(probed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["qwen/qwen3-4b"]);
    }

    /// The user reads the name the server gives, or the file's name: never a folder, never `.gguf`.
    #[test]
    fn a_model_is_read_by_its_name_or_its_files_name() {
        let model = |id: &str, name: Option<&str>| ServerModel { id: id.into(), ctx: 8192, images: false, price: None, name: name.map(Into::into) };
        for (id, name, label) in [
            (r"C:\models\Qwen3.5-4B-Q4_K_M.gguf", None, "Qwen3.5-4B-Q4_K_M"),
            ("/srv/models/gemma-4.GGUF", None, "gemma-4"),
            ("model.gguf", None, "model"),
            ("qwen/qwen3.7-flash", Some("Qwen: Qwen3.7 Flash"), "Qwen: Qwen3.7 Flash"),
            (r"C:\models\a.gguf", Some(r"D:\other\Named.gguf"), "Named"),
            ("qwen/qwen3-4b", None, "qwen/qwen3-4b"),
            ("Qwen3.5-4B", None, "Qwen3.5-4B"),
        ] {
            assert_eq!(model(id, name).label(), label, "{id}");
        }
    }

    /// A list that names a model gives the name to keep; one that only repeats the id gives none.
    #[test]
    fn a_probe_keeps_the_name_the_list_gives() {
        let f = fake(&[("/v1/models", 200, r#"{"data":[{"id":"a/b","name":"A: B"},{"id":"c","name":"c"},{"id":"d","name":"  "}]}"#), ("/v1/chat/completions", 200, ANSWER)]);
        let found = probe(&format!("{}/v1", f.url), None).unwrap().models;
        assert_eq!(found.iter().map(|m| (m.id.as_str(), m.name.as_deref())).collect::<Vec<_>>(), [("a/b", Some("A: B")), ("c", None), ("d", None)]);
    }

    /// A cloud service lists models that do not write (embeddings, speech, pictures): they are left out, and the request
    /// goes on to the next model when one refuses it; a refusal of the key stops at the first.
    #[test]
    fn only_models_that_write_are_kept_and_the_first_that_answers_is_found() {
        let list = r#"{"data":[{"id":"babbage-002"},{"id":"text-embedding-3-small"},{"id":"whisper-1"},{"id":"gpt-4o-realtime-preview"},{"id":"gpt-4o-audio-preview"},{"id":"o1"},{"id":"gpt-4o"},{"id":"flux","architecture":{"output_modalities":["image"]}},{"id":"nomic","type":"embeddings"}]}"#;
        let f = fake(&[("/v1/models", 200, list), ("/v1/chat/completions#gpt-4o", 200, ANSWER), ("/v1/chat/completions", 400, r#"{"error":{"message":"use max_completion_tokens"}}"#)]);
        let probed = probe(&format!("{}/v1", f.url), None).unwrap();
        assert_eq!(probed.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gpt-4o", "o1"]);
        assert_eq!(probed.answered, "gpt-4o");
        let f = fake(&[("/v1/models", 200, list), ("/v1/chat/completions#gpt-4o", 400, "{}"), ("/v1/chat/completions", 200, ANSWER)]);
        assert_eq!(probe(&format!("{}/v1", f.url), None).unwrap().answered, "o1");
        let f = fake(&[("/v1/models", 200, list), ("/v1/chat/completions", 401, "{}")]);
        assert!(probe(&format!("{}/v1", f.url), Some("k")).is_err());
        assert_eq!(f.requests.lock().unwrap().iter().filter(|r| r.starts_with("POST")).count(), 1, "the key is the same for every model");
    }

    #[test]
    fn a_key_with_what_would_break_the_configuration_is_refused() {
        assert!(check_key("sk-or-v1-0123abcdEF_-.").is_ok());
        for wrong in ["\"sk-1\"", "sk 1", "sk\\1", "{file:x}", "chiave-è"] {
            assert!(check_key(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn a_server_reads_as_its_host_and_its_key_as_a_variable() {
        let s = Server { id: "server-2".into(), url: "https://api.openai.com/v1".into(), key: true, models: vec![], context: None };
        assert_eq!((s.label(), s.credential()), ("api.openai.com".to_string(), "MANGO_SERVER_KEY_SERVER_2".to_string()));
        let mut list = Servers { list: vec![s.clone(), Server { id: "server-7".into(), ..s.clone() }], default: None, last: 0 };
        assert_eq!(list.next_id(), "server-8");
        list.list.pop();
        assert_eq!(list.next_id(), "server-9", "the id of a server removed is not given again");
        assert_eq!(Servers::default().next_id(), "server-1");
        let model = ServerModel { id: "m".into(), ctx: 8192, images: false, price: None, name: None };
        let one = Servers { list: vec![Server { id: "server-1".into(), models: vec![model], ..s.clone() }], default: None, last: 1 };
        let pointing = |model: &str| Servers { default: Some(ModelRef { server: "server-1".into(), model: model.into() }), ..one.clone() };
        assert_eq!(pointing("m").checked_default().map(|d| d.model.as_str()), Some("m"));
        assert_eq!(pointing("gone").checked_default(), None, "a default written by hand that names no model");
    }

    /// A list of models none of which suits the agent says how many the server offers and why they do not fit.
    #[test]
    fn a_server_whose_models_all_fall_away_says_why() {
        let list = r#"{"data":[
            {"id":"text-embedding-3-small"},
            {"id":"whisper-1"},
            {"id":"a/no-tools","supported_parameters":["temperature"]},
            {"id":"openrouter/auto","supported_parameters":["tools"],"pricing":{"prompt":"-1","completion":"-1"}}
        ]}"#;
        let f = fake(&[("/v1/models", 200, list)]);
        let said = probe(&format!("{}/v1", f.url), None).unwrap_err().to_string();
        assert!(said.contains(&tr!("offre 4 modelli", "offers 4 models")) && !said.contains(&tr!("non offre nessun modello", "offers no model")), "{said}");
        for reason in [tr!("non scrivono testo: 2", "no text output: 2"), tr!("senza strumenti: 1", "no tools: 1"), tr!("prezzo non fisso: 1", "price not fixed: 1")] {
            assert!(said.contains(&reason), "{reason} in {said}");
        }
    }

    /// llama-server may say it sees images without saying the context: the context is left to the user, the images are kept.
    #[test]
    fn the_images_of_a_server_that_says_no_context_are_kept() {
        let f = fake(&[("/v1/models", 200, MODELS), ("/props", 200, r#"{"modalities":{"vision":true}}"#), ("/v1/chat/completions", 200, ANSWER)]);
        let found = probe(&format!("{}/v1", f.url), None).unwrap().models;
        assert!(found.iter().all(|m| m.ctx.is_none() && m.images), "{found:?}");
    }

    /// A list that cannot be read is put aside for a change and a new one begins; a list that is there is read as it is.
    #[test]
    fn a_damaged_list_is_put_aside_when_a_server_is_added_or_removed() {
        let dir = std::env::temp_dir().join(format!("servers-damaged-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let paths = Paths::from_dirs(dir.join("dist"), dir.join("data")).unwrap();
        let file = paths.data.join(FILE);
        assert_eq!(read_to_change(&paths).unwrap(), (Servers::default(), false), "no file: an empty list, nothing put aside");
        std::fs::write(&file, "{ \"list\": [").unwrap();
        let damaged = read(&paths).unwrap_err();
        assert!(is_damaged(&damaged) && damaged.to_string().contains(&tr!("si ricomincia da un elenco nuovo", "a new list is started")), "{damaged:#}");
        assert_eq!(read_to_change(&paths).unwrap(), (Servers::default(), true));
        assert!(!file.exists() && std::fs::read_to_string(paths.data.join("servers.json.bad")).unwrap().starts_with("{ \"list\""));
        let kept = Servers { last: 3, ..Servers::default() };
        write(&paths, &kept).unwrap();
        assert_eq!(read_to_change(&paths).unwrap(), (kept, false));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
