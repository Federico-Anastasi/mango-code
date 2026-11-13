//! The engine of another PC, seen from the PC that uses it ("Use the engine of another PC").
//!
//! The other PC shares its engine (`share.rs`) and gives a **code**, `mango://ip:port/key`. Here the code is read, checked
//! with the PC (`GET /mango/models`, the key as a bearer) and kept in `<data>\remote-engine.json` as long as this PC uses
//! that engine. The key is in the clear in that file, like the phone's and the sharing's: it is in the user's own data
//! folder. It never goes to a log, an error text or the screen.

use crate::share::SharedModel;
use anyhow::{Context, Result};
use mango_common::tr;
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Weak;
use std::time::Duration;

/// How long the other PC has to answer: a PC that is off or on another network does not.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);
/// What the other PC offers: its models (those that are on its disk and fit) and which one is running.
#[derive(Debug, Deserialize)]
pub struct Offered {
    pub models: Vec<SharedModel>,
    #[serde(default)]
    pub running: Option<String>,
}

/// Why a code does not work, with the sentence for the user (what happened and what to do).
#[derive(Debug)]
pub enum Failure {
    BadCode,
    Rejected,
    Unreachable,
    NoModels,
    /// Something answered, but not as Mango Code does: what it said.
    NotMango(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&match self {
            Failure::BadCode => tr!(
                "Questo non è un codice di collegamento. Si copia con «Copia il codice» in Impostazioni › Collegamenti, sul PC con il motore.",
                "This is not a connection code. Copy it with \"Copy the code\" in Settings › Connections, on the PC with the engine."
            ),
            Failure::Rejected => tr!(
                "Il codice non è valido, oppure la condivisione è spenta su quel PC. Copia di nuovo il codice da Impostazioni › Collegamenti, sul PC con il motore.",
                "The code is not valid, or sharing is off on that PC. Copy the code again from Settings › Connections, on the PC with the engine."
            ),
            Failure::Unreachable => tr!(
                "Il PC con il motore non risponde: è acceso? Mango Code è aperto lì, con la condivisione accesa?",
                "The PC with the engine does not answer: is it turned on? Is Mango Code open there, with sharing on?"
            ),
            Failure::NoModels => tr!(
                "Quel PC non ha modelli pronti. Apri Mango Code lì e scarica un modello da Impostazioni › Modelli.",
                "That PC has no model ready. Open Mango Code there and download a model from Settings › Models."
            ),
            Failure::NotMango(what) => tr!(
                "A quell'indirizzo c'è qualcosa che non è Mango Code ({what}). Copia di nuovo il codice dal PC con il motore.",
                "Something that is not Mango Code answers at that address ({what}). Copy the code again from the PC with the engine."
            ),
        })
    }
}

impl std::error::Error for Failure {}

impl Failure {
    /// A short name for the page, which chooses its own behaviour from it.
    pub fn code(&self) -> &'static str {
        match self {
            Failure::BadCode => "bad_code",
            Failure::Rejected => "rejected",
            Failure::Unreachable => "unreachable",
            Failure::NoModels => "no_models",
            Failure::NotMango(_) => "not_mango",
        }
    }
}

/// The address of the other PC and the key.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Code {
    /// `ip:port`.
    pub address: String,
    pub key: String,
}

impl std::fmt::Debug for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Code({}, key hidden)", self.address)
    }
}

impl Code {
    /// `mango://ip:port/key`, with a key of 48 lowercase hexadecimal digits; the spaces and line breaks around a paste do
    /// not count. Anything else is not a code, and the error does not repeat what was pasted.
    pub fn parse(text: &str) -> std::result::Result<Code, Failure> {
        let rest = text.trim().strip_prefix("mango://").ok_or(Failure::BadCode)?;
        let (address, key) = rest.split_once('/').ok_or(Failure::BadCode)?;
        let (ip, port) = address.split_once(':').ok_or(Failure::BadCode)?;
        let ip: Ipv4Addr = ip.parse().map_err(|_| Failure::BadCode)?;
        let port: u16 = port
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| port.parse().ok())
            .flatten()
            .filter(|p| *p != 0)
            .ok_or(Failure::BadCode)?;
        if key.len() != 48 || !key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(Failure::BadCode);
        }
        Ok(Code { address: format!("{ip}:{port}"), key: key.to_string() })
    }

    /// Where the engine's routes are: `http://ip:port`.
    pub fn base(&self) -> String {
        format!("http://{}", self.address)
    }
}

/// What the PC said when it was asked, in five seconds at most.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Yes,
    /// The key is refused (401): the PC is there, and the chat says to paste its new code.
    Refused,
    No,
}

pub fn answer(code: &Code) -> Answer {
    let url = format!("{}/mango/models", code.base());
    match mango_common::internet::agent(&url, ANSWER_WITHIN).get(&url).header("Authorization", format!("Bearer {}", code.key)).call() {
        Err(ureq::Error::StatusCode(401)) => Answer::Refused,
        Ok(_) | Err(ureq::Error::StatusCode(_)) => Answer::Yes,
        Err(_) => Answer::No,
    }
}

/// Asks the PC whether it answers, on a thread of its own, and writes it in `reachable` (a refused key is an answer) until
/// nobody holds `reachable` any more. Every `every`; after a refused key every `refused_every`, so the other PC's log
/// does not get a refusal every few seconds, and `every` again as soon as the answer changes. A new key is a new watch.
pub fn watch(code: Code, reachable: Weak<AtomicBool>, every: Duration, refused_every: Duration) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut wait = every;
        loop {
            std::thread::sleep(wait);
            let answer = answer(&code);
            let Some(r) = reachable.upgrade() else { return };
            r.store(answer != Answer::No, Ordering::SeqCst);
            wait = if answer == Answer::Refused { refused_every } else { every };
        }
    })
}

/// Asks the PC what it offers: it proves the code and gives the models. Five seconds at most.
pub fn verify(code: &Code) -> std::result::Result<Offered, Failure> {
    let url = format!("{}/mango/models", code.base());
    let reply = mango_common::internet::agent(&url, ANSWER_WITHIN).get(&url).header("Authorization", format!("Bearer {}", code.key)).call();
    let body = match reply {
        Ok(mut r) => r.body_mut().read_to_string().map_err(|_| Failure::Unreachable)?,
        Err(ureq::Error::StatusCode(401)) => return Err(Failure::Rejected),
        Err(ureq::Error::StatusCode(status)) => return Err(Failure::NotMango(tr!("errore {status}", "error {status}"))),
        Err(_) => return Err(Failure::Unreachable),
    };
    let offered: Offered = serde_json::from_str(&body).map_err(|_| Failure::NotMango(tr!("risposta non riconosciuta", "unrecognized reply")))?;
    if offered.models.is_empty() {
        return Err(Failure::NoModels);
    }
    Ok(offered)
}

/// Where the code is kept while this PC uses the engine of another.
pub fn file(data: &Path) -> PathBuf {
    mango_common::remote_engine_file(data)
}

/// The code saved by an earlier "use this PC's engine", or none.
pub fn saved(data: &Path) -> Result<Option<Code>> {
    let file = file(data);
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| tr!("lettura di {}", "reading {}", file.display())),
    };
    let code: Code = serde_json::from_str(&text).with_context(|| tr!("{} non si legge", "{} cannot be read", file.display()))?;
    // The same rule as a pasted code: a file edited by hand is not trusted more than a paste.
    Code::parse(&format!("mango://{}/{}", code.address, code.key))
        .map(Some)
        .map_err(|_| anyhow::anyhow!("{}", tr!("{} non contiene un codice valido", "{} does not hold a valid code", file.display())))
}

pub fn save(data: &Path, code: &Code) -> Result<()> {
    let file = file(data);
    let unsaved = || mango_common::user_text(&tr!("Non riesco a salvare il codice dell'altro PC.", "I can't save the other PC's code."), file.display());
    std::fs::create_dir_all(data).with_context(unsaved)?;
    mango_common::write_atomic(&file, serde_json::to_string_pretty(code)?).with_context(unsaved)
}

/// Back to the engine of this PC: removes the file (and with it the key).
pub fn forget(data: &Path) -> Result<()> {
    let file = file(data);
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| mango_common::user_text(&tr!("Non riesco a togliere il codice dell'altro PC.", "I can't remove the other PC's code."), file.display()))
        }
        _ => Ok(()),
    }
}
