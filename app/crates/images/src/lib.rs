//! The image manager: one picture at a time, drawn by a server of the image engine (`sd-server`).
//!
//! `generate` has the plan made for the model (`engine_cfg::image_plan`), takes the cards the plan names from whoever
//! holds them (`lender`: the manager of the models that write puts its model aside), starts the server if it is not
//! on, sends it the request and follows the job step by step. Then the cards go back. A picture asked meanwhile waits
//! for its turn.
//!
//! Whoever asks says whether the server stays on after the picture (`Request::stay_on`). In a conversation about
//! images it does: the next picture finds the model loaded. A single picture, as a model that writes asks for one,
//! starts the server and stops it, and all the memory goes back. A server started holds nothing (it loads the model
//! at the first job); one that stays on after a picture holds the weights in RAM and some memory on the card.
//! Measured with Z-Image Turbo at 512 on a GTX 1660 SUPER: 6.6 GB of RAM and 0.2 GB on the card, 9 seconds of 71
//! saved on the next picture. `unload` stops it when the conversation about images is over.
//!
//! Pictures asked together are a row: while another waits for its turn the server stays on and the cards are not
//! given back, so the model that writes is put aside once and comes back once, after the last picture.
//!
//! `jobs` gives each picture a number, to follow it and stop it from elsewhere; `routes` is how the interface and the
//! other apps ask.

pub mod jobs;
pub mod routes;

use anyhow::{bail, Context, Result};
use base64::Engine;
use engine::{EngineManager, Requester};
use engine_cfg::ImagePlan;
use mango_common::{tail, tr, user_error};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::File;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// How often the job is asked how far it is.
const POLL: Duration = Duration::from_millis(250);

/// The plan of a model that makes images, with the engine's server on the given port.
pub type Planner = dyn Fn(&str, u16) -> Result<ImagePlan> + Send + Sync;

/// Takes the cards (PCI indexes) for a picture from whoever holds them, and answers when they are free. What it
/// returns gives them back when it is dropped.
pub type Lender = dyn Fn(&[u32]) -> Result<Box<dyn Send>> + Send + Sync;

/// A picture to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// Model key in mango-models.json.
    pub model: String,
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    /// Without it the manager draws one, and says which in the `Picture`.
    pub seed: Option<u32>,
    /// The engine stays on after the picture, with the model loaded, for the next one. Without it the engine is
    /// stopped when the picture is made, also one that was on.
    pub stay_on: bool,
}

/// The values on the wire are in English: they are what the interface and the other apps read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// The cards are being freed, the engine starts, loads the model and reads the request.
    Preparing,
    /// `step` of `steps` are done.
    Drawing,
    /// The result is turned into pixels and encoded.
    Finishing,
}

/// How far a picture is. `generate` tells it each time the stage or the step changes, or a new preview is there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub step: u32,
    pub steps: u32,
    /// Since the picture was asked.
    pub seconds: u64,
    /// The picture as it is at this step, small, as a PNG; only while drawing.
    #[serde(skip)]
    pub preview: Option<Vec<u8>>,
}

/// A picture made.
#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    pub png: Vec<u8>,
    /// Model key.
    pub model: String,
    pub seed: u32,
    pub steps: u32,
    /// From the request to the picture.
    pub seconds: f64,
}

/// A model that is being taken off the computer (`ImageManager::retire`): its pictures are refused until this is dropped.
pub struct Retired {
    manager: ImageManager,
    key: String,
}

impl Drop for Retired {
    fn drop(&mut self) {
        let mut using = self.manager.using();
        if let Some(at) = using.retiring.iter().position(|k| k == &self.key) {
            using.retiring.remove(at);
        }
    }
}

/// The picture being made: while it lives, `retire` waits for it.
struct Drawing<'a>(&'a ImageManager);

impl Drop for Drawing<'_> {
    fn drop(&mut self) {
        self.0.using().drawing = None;
    }
}

/// The picture was stopped by whoever asked for it.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&tr!("L'immagine è stata annullata.", "The picture was cancelled."))
    }
}

impl std::error::Error for Cancelled {}

struct Inner {
    planner: Box<Planner>,
    lender: Box<Lender>,
    logs: PathBuf,
    /// One picture at a time, in the order they were asked: the others wait here.
    line: Mutex<Line>,
    moved: Condvar,
    /// The server that stayed on after a picture; none while a picture is being made, which holds it.
    kept: Mutex<Option<Server>>,
    /// What a picture left for the one that waited behind it; that one takes it when its turn comes.
    left: Mutex<Option<Left>>,
    /// How many times `unload` was called: a picture being made meanwhile does not leave its server on.
    unloads: AtomicU64,
    /// Which models are being taken off the computer and which one the picture being made uses.
    using: Mutex<Using>,
}

/// The line of the pictures. Each takes the next number when it is asked; the one whose number is `turn` is made, and
/// `gone` holds the numbers that ended or were given up before their turn.
#[derive(Default)]
struct Line {
    asked: u64,
    turn: u64,
    gone: BTreeSet<u64>,
}

/// A picture's place in the line (`ImageManager::place`). Dropped, it lets the next one through.
pub struct Place {
    inner: Arc<Inner>,
    number: u64,
}

impl Drop for Place {
    fn drop(&mut self) {
        let mut held = self.inner.line.lock().unwrap_or_else(|e| e.into_inner());
        let line = &mut *held;
        line.gone.insert(self.number);
        while line.gone.remove(&line.turn) {
            line.turn += 1;
        }
        drop(held);
        self.inner.moved.notify_all();
    }
}

/// The server of a picture, on, and its cards, still taken, for the next picture of a row. The server stops before
/// the cards go back.
struct Left {
    server: Server,
    gpus: Vec<u32>,
    cards: Box<dyn Send>,
}

#[derive(Default)]
struct Using {
    /// A picture of these models is refused (`retire`).
    retiring: Vec<String>,
    /// The model of the picture being made, from its plan to the end of the picture.
    drawing: Option<String>,
}

/// How long `retire` waits for a picture of the model to stop: a stopped picture ends within a second or two.
const RETIRE_WAIT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct ImageManager(Arc<Inner>);

impl ImageManager {
    /// `logs`: the folder of the engine's log (`image.log`, the last picture's).
    pub fn new(planner: Box<Planner>, lender: Box<Lender>, logs: &Path) -> ImageManager {
        ImageManager(Arc::new(Inner {
            planner,
            lender,
            logs: logs.to_path_buf(),
            line: Mutex::new(Line::default()),
            moved: Condvar::new(),
            kept: Mutex::new(None),
            left: Mutex::new(None),
            unloads: AtomicU64::new(0),
            using: Mutex::new(Using::default()),
        }))
    }

    /// Gets a model ready to be taken off the computer: from now on a picture asked with it is refused (until the
    /// answer is dropped), `stop` is called to stop the pictures of the model that are asked or waiting, the one being
    /// made with it is waited for, and its engine, if it stayed on, is stopped: nothing holds the model's files open
    /// and nothing starts it again. Pictures of other models go on. An error when the picture does not stop in time:
    /// the model is then not retired.
    pub fn retire(&self, key: &str, stop: &dyn Fn()) -> Result<Retired> {
        self.using().retiring.push(key.to_string());
        let retired = Retired { manager: self.clone(), key: key.to_string() };
        stop();
        let deadline = Instant::now() + RETIRE_WAIT;
        while self.using().drawing.as_deref() == Some(key) {
            if Instant::now() >= deadline {
                return Err(user_error(
                    &tr!("Un'immagine di questo modello non si ferma. Riprova tra poco.", "A picture of this model does not stop. Try again in a moment."),
                    format!("the picture with «{key}» did not end within {} s", RETIRE_WAIT.as_secs()),
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if self.loaded().as_deref() == Some(key) {
            self.unload();
        }
        Ok(retired)
    }

    fn using(&self) -> std::sync::MutexGuard<'_, Using> {
        self.0.using.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The picture with `model` begins, unless the model is being taken off the computer.
    fn begin(&self, model: &str) -> Result<Drawing<'_>> {
        let mut using = self.using();
        if using.retiring.iter().any(|k| k == model) {
            return Err(user_error(
                &tr!("Questo modello sta per essere tolto dal computer: l'immagine non parte.", "This model is being taken off the computer: the picture does not begin."),
                format!("«{model}» is being retired"),
            ));
        }
        using.drawing = Some(model.to_string());
        Ok(Drawing(self))
    }

    /// Stops the engine that stayed on after a picture, and gives its memory back. A picture being made goes on, and
    /// its engine stops when it is made.
    pub fn unload(&self) {
        self.0.unloads.fetch_add(1, Ordering::SeqCst);
        drop(self.left().take());
        drop(self.kept().take());
    }

    fn left(&self) -> std::sync::MutexGuard<'_, Option<Left>> {
        self.0.left.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The model of the engine that stayed on after a picture, if one did.
    pub fn loaded(&self) -> Option<String> {
        self.kept().as_ref().map(|s| s.key.clone())
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Option<Server>> {
        self.0.kept.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Makes a picture and returns it; `progress` is told how far it is. It waits for its turn if another is being made.
    /// When `stop` becomes true the picture ends with `Cancelled` within a moment and its engine stops; one that was
    /// waiting for its turn does not begin.
    pub fn generate(&self, request: &Request, stop: &AtomicBool, progress: &mut dyn FnMut(&Progress)) -> Result<Picture> {
        self.generate_in(self.place(), request, stop, progress)
    }

    /// A place in the line of the pictures, for `generate_in`. Taken where the picture is asked, it keeps the order of
    /// the requests whichever thread gets to the manager first.
    pub fn place(&self) -> Place {
        let mut line = self.line();
        let number = line.asked;
        line.asked += 1;
        Place { inner: self.0.clone(), number }
    }

    fn line(&self) -> std::sync::MutexGuard<'_, Line> {
        self.0.line.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `generate` for a picture that already has its place in the line.
    pub fn generate_in(&self, place: Place, request: &Request, stop: &AtomicBool, progress: &mut dyn FnMut(&Progress)) -> Result<Picture> {
        let mut line = self.line();
        while line.turn != place.number {
            line = self.0.moved.wait(line).unwrap_or_else(|e| e.into_inner());
        }
        drop(line);
        // What the picture before left for this one. Taken here, so that a picture that does not begin gives it all
        // back; the cards are declared first: a server that is not used stops before they go back.
        let (left_cards, left_server) = self.left().take().map_or((None, None), |l| (Some((l.gpus, l.cards)), Some(l.server)));
        let stopped = || stop.load(Ordering::SeqCst).then(|| anyhow::Error::new(Cancelled)).map_or(Ok(()), Err);
        stopped()?;
        // Declared after the turn and before the server, so the picture is no longer «being made» only once its server
        // has gone or been kept.
        let _drawing = self.begin(&request.model)?;
        let unloads = self.0.unloads.load(Ordering::SeqCst);
        let start = Instant::now();
        let mut told: Option<Progress> = None;
        let mut tell = |stage: Stage, step: u32, steps: u32, preview: Option<Vec<u8>>| {
            let now = Progress { stage, step, steps, seconds: start.elapsed().as_secs(), preview };
            // The seconds alone are not news.
            if told.as_ref().is_none_or(|t| (t.stage, t.step, t.steps) != (now.stage, now.step, now.steps) || now.preview.is_some()) {
                progress(&now);
                told = Some(now);
            }
        };

        let plan = (self.0.planner)(&request.model, mango_common::random_port()?)?;
        tell(Stage::Preparing, 0, plan.steps, None);
        // The server that stayed on serves this picture if it is this model's, on the same card; another one stops here.
        let kept = left_server.or_else(|| self.kept().take()).filter(|s| s.serves(&plan));
        let gpus: Vec<u32> = plan.gpus.iter().map(|g| g.index).collect();
        // Declared before the server: when the server is not kept it stops before the cards go back.
        let cards = match left_cards {
            Some((taken, cards)) if taken == gpus => cards,
            other => {
                drop(other);
                (self.0.lender)(&gpus)?
            }
        };
        stopped()?;
        let mut server = match kept.and_then(|mut on| on.still_running().is_ok().then_some(on)) {
            Some(on) => on,
            None => {
                let mut new = Server::start(&plan, &self.0.logs)?;
                new.wait_ready(&plan, &|| stop.load(Ordering::SeqCst))?;
                new
            }
        };

        let seed = request.seed.unwrap_or_else(random_seed);
        let job = server.submit(&json!({
            "prompt": request.prompt,
            "width": request.width,
            "height": request.height,
            "seed": seed,
            "preview": "proj",
            "sample_params": { "sample_steps": plan.steps, "guidance": { "txt_cfg": plan.cfg_scale } },
        }))?;
        let mut preview_step = 0;
        loop {
            std::thread::sleep(POLL);
            stopped()?;
            let state = server.job(&job)?;
            let stage = state["progress"]["stage"].as_str().unwrap_or_default();
            match state["status"].as_str().unwrap_or_default() {
                "completed" => {
                    let encoded = state["result"]["images"][0]["b64_json"].as_str().with_context(|| server.broken("the finished job carries no picture"))?;
                    let png = base64::engine::general_purpose::STANDARD.decode(encoded).with_context(|| server.broken("the picture is not base64"))?;
                    if self.0.unloads.load(Ordering::SeqCst) == unloads {
                        let line = self.line();
                        let another_waits = (line.turn + 1..line.asked).any(|number| !line.gone.contains(&number));
                        drop(line);
                        if another_waits {
                            *self.left() = Some(Left { server, gpus, cards });
                        } else if request.stay_on {
                            *self.kept() = Some(server);
                        }
                    }
                    return Ok(Picture { png, model: plan.key, seed, steps: plan.steps, seconds: start.elapsed().as_secs_f64() });
                }
                "failed" | "cancelled" => {
                    let said = state["error"]["message"].as_str().unwrap_or("no reason given").to_string();
                    return Err(user_error(
                        &tr!("Il motore delle immagini non è riuscito a fare l'immagine. Riprova; se succede ancora, apri i log di Mango Code.", "The image engine could not make the picture. Try again; if it happens again, open the Mango Code logs."),
                        format!("{said}\n{}", tail(&server.log, 12)),
                    ));
                }
                _ if stage == "sampling" => {
                    let (done, total) = (number(&state["progress"]["completed"]), number(&state["progress"]["total"]));
                    let step = number(&state["preview"]["step"]);
                    let preview = (step > preview_step).then(|| state["preview"]["b64_json"].as_str()).flatten();
                    let preview = preview.and_then(|p| base64::engine::general_purpose::STANDARD.decode(p).ok());
                    if preview.is_some() {
                        preview_step = step;
                    }
                    tell(Stage::Drawing, done, if total == 0 { plan.steps } else { total }, preview);
                }
                _ if matches!(stage, "vae_decode" | "encoding") => tell(Stage::Finishing, plan.steps, plan.steps, None),
                _ => {}
            }
        }
    }

}

fn number(v: &Value) -> u32 {
    v.as_u64().unwrap_or(0) as u32
}

/// A seed the engine takes: a positive 31-bit number, different at every call.
fn random_seed() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    (std::collections::hash_map::RandomState::new().build_hasher().finish() & 0x7fff_ffff) as u32
}

/// The cards for a picture come from the manager of the models that write: a model on one of them is put aside (its
/// conversation saved where the engine can), and comes back by itself when the picture is done.
pub fn lender(engine: EngineManager) -> Box<Lender> {
    Box::new(move |gpus| {
        if gpus.is_empty() {
            return Ok(Box::new(()));
        }
        let loan = engine.lend(Some(gpus), Requester { pid: None, who: "Mango Code: image".to_string() })?;
        Ok(Box::new(Lent { engine: engine.clone(), loan }))
    })
}

struct Lent {
    engine: EngineManager,
    loan: u64,
}

impl Drop for Lent {
    fn drop(&mut self) {
        // Giving back restarts the model that was put aside and waits for it: the picture does not wait for that.
        let (engine, loan) = (self.engine.clone(), self.loan);
        let _ = std::thread::Builder::new().name("image-give-back".into()).spawn(move || {
            if let Err(e) = engine.give_back(loan, &mut |_| {}) {
                engine.log(json!({ "event": "give_back", "who": "image", "error": format!("{e:#}") }));
            }
        });
    }
}

/// A server of the engine with a model: it stops when this is dropped.
struct Server {
    child: Child,
    url: String,
    log: PathBuf,
    agent: ureq::Agent,
    /// What it was started for: the model, the program and its environment, which names the card.
    key: String,
    exe: PathBuf,
    env: Vec<(String, String)>,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn start(plan: &ImagePlan, logs: &Path) -> Result<Server> {
        let log = logs.join(format!("{}.log", plan.spec.name));
        let out = File::create(&log).with_context(|| format!("log {}", log.display()))?;
        let mut cmd = Command::new(&plan.spec.exe);
        cmd.args(&plan.spec.args).stdin(Stdio::null()).stdout(out.try_clone()?).stderr(out).creation_flags(mango_common::CREATE_NO_WINDOW);
        for k in &plan.spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &plan.spec.env {
            cmd.env(k, v);
        }
        cmd.current_dir(plan.spec.cwd.as_deref().unwrap_or(logs));
        let child = cmd.spawn().map_err(|e| {
            user_error(
                &tr!("Il motore delle immagini non parte. Riprova; se succede ancora, apri i log di Mango Code.", "The image engine does not start. Try again; if it happens again, open the Mango Code logs."),
                format!("{}: {e}", plan.spec.exe.display()),
            )
        })?;
        let agent = mango_common::internet::agent_with_replies(&plan.url, Duration::from_secs(30));
        Ok(Server { child, url: plan.url.clone(), log, agent, key: plan.key.clone(), exe: plan.spec.exe.clone(), env: plan.spec.env.clone() })
    }

    /// It is the server this plan would start, apart from the port.
    fn serves(&self, plan: &ImagePlan) -> bool {
        (&self.key, &self.exe, &self.env) == (&plan.key, &plan.spec.exe, &plan.spec.env)
    }

    /// Waits for the server to say it is ready. `stop` ends the wait when the picture is no longer wanted.
    fn wait_ready(&mut self, plan: &ImagePlan, stop: &dyn Fn() -> bool) -> Result<()> {
        let url = plan.spec.health_url.as_deref().with_context(|| "the image plan has no address to ask for readiness")?;
        let start = Instant::now();
        loop {
            if stop() {
                return Err(anyhow::Error::new(Cancelled));
            }
            if matches!(self.call("GET", url, None), Ok((200, state)) if state["state"] == "ready") {
                return Ok(());
            }
            self.still_running()?;
            if start.elapsed().as_secs() >= plan.spec.ready_timeout_s {
                bail!("{}", self.broken(&format!("the server is not ready after {} s", plan.spec.ready_timeout_s)));
            }
            std::thread::sleep(POLL);
        }
    }

    /// Sends the job and returns its id.
    fn submit(&mut self, body: &Value) -> Result<String> {
        let (status, reply) = self.call("POST", &format!("{}/sdcpp/v1/img_gen", self.url), Some(body)).or_else(|e| self.gone(e))?;
        match reply["id"].as_str() {
            Some(id) if status == 202 => Ok(id.to_string()),
            _ => bail!("{}", self.broken(&format!("the request was refused ({status}): {reply}"))),
        }
    }

    fn job(&mut self, id: &str) -> Result<Value> {
        let (status, reply) = self.call("GET", &format!("{}/sdcpp/v1/jobs/{id}", self.url), None).or_else(|e| self.gone(e))?;
        if status != 200 {
            bail!("{}", self.broken(&format!("the job is gone ({status}): {reply}")));
        }
        Ok(reply)
    }

    fn call(&self, method: &str, url: &str, body: Option<&Value>) -> Result<(u16, Value)> {
        let mut reply = match body {
            Some(body) => self.agent.post(url).header("Content-Type", "application/json").send(body.to_string()),
            None => self.agent.get(url).call(),
        }
        .with_context(|| format!("{method} {url}"))?;
        // A picture of 2048 pixels a side is a few megabytes of base64.
        let text = reply.body_mut().with_config().limit(256 << 20).read_to_string().with_context(|| format!("{method} {url}: reading the reply"))?;
        Ok((reply.status().as_u16(), serde_json::from_str(&text).unwrap_or(Value::String(text))))
    }

    /// A call that did not get through: the server closed (out of memory, most often), or it is another trouble.
    fn gone<T>(&mut self, e: anyhow::Error) -> Result<T> {
        self.still_running()?;
        Err(e.context(self.broken("the server does not answer")))
    }

    /// An error if the server's process has ended, with the last lines of its log.
    fn still_running(&mut self) -> Result<()> {
        let Ok(Some(status)) = self.child.try_wait() else { return Ok(()) };
        let code = status.code().map_or("?".into(), |c| c.to_string());
        Err(user_error(
            &tr!(
                "Il motore delle immagini si è chiuso. Se la memoria non basta, chiudi i programmi che ne occupano tanta o scegli un'immagine più piccola, e riprova.",
                "The image engine closed. If memory is not enough, close the programs that use a lot of it or choose a smaller picture, and try again."
            ),
            format!("the image engine exited (code {code}).\n{}", tail(&self.log, 12)),
        ))
    }

    /// The sentence for the user when the server misbehaves, with `what` and the last lines of its log as the detail.
    fn broken(&self, what: &str) -> String {
        mango_common::user_text(
            &tr!("Il motore delle immagini non risponde come dovrebbe. Riprova; se succede ancora, apri i log di Mango Code.", "The image engine does not answer as it should. Try again; if it happens again, open the Mango Code logs."),
            format!("{what}\n{}", tail(&self.log, 12)),
        )
    }
}
