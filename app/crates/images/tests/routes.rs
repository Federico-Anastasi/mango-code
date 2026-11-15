//! The routes for pictures with the fake engine (`fake-sd`): a picture asked, followed to its end and fetched, the
//! requests that are refused, jobs stopped and failed, the engine that stays on, the jobs that are remembered. No GPUs.

use base64::Engine;
use images::routes::Routes;
use images::ImageManager;
use mango_common::tr;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod support;

struct Fixture {
    routes: Routes,
    /// How many times the cards were taken: once for each picture that began.
    taken: Arc<AtomicUsize>,
    dir: tempfile::TempDir,
}

/// The routes over a manager with the fake engine in `mode`, `step_ms` a step, and `default` as the default model.
fn fixture(mode: &'static str, step_ms: u64, default: Option<&'static str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let taken = Arc::new(AtomicUsize::new(0));
    let count = taken.clone();
    let lender: Box<images::Lender> = Box::new(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(()))
    });
    let manager = ImageManager::new(support::planner(mode, step_ms), lender, dir.path());
    let models = Box::new(move || Ok(json!({ "models": [{ "key": "img", "label": "Img" }], "default": default })));
    Fixture { routes: Routes::new(manager, models), taken, dir }
}

impl Fixture {
    fn call(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let body = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
        self.routes.handle(method, path, &body).expect("an image route")
    }

    fn ask(&self, body: Value) -> String {
        let (status, job) = self.call("POST", "/control/image/generate", body);
        assert_eq!(status, 202, "{job}");
        job["id"].as_str().unwrap().to_string()
    }

    fn job(&self, id: &str) -> Value {
        let (status, job) = self.call("GET", &format!("/control/image/jobs/{id}"), Value::Null);
        assert_eq!(status, 200, "{job}");
        job
    }

    /// Follows the job until it has ended, and returns every state it was seen in.
    fn follow(&self, id: &str) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = Vec::new();
        loop {
            let job = self.job(id);
            let ended = ["done", "failed", "cancelled"].contains(&job["status"].as_str().unwrap());
            seen.push(job);
            if ended {
                return seen;
            }
            assert!(Instant::now() < deadline, "the job does not end: {:?}", seen.last());
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn message(&self, method: &str, path: &str, body: Value) -> (u16, String) {
        let (status, reply) = self.call(method, path, body);
        assert_eq!(reply["error"]["type"], "mango_image", "{reply}");
        (status, reply["error"]["message"].as_str().unwrap().to_string())
    }
}

fn picture() -> Value {
    json!({ "prompt": "a red vespa", "width": 768, "height": 512, "model": "img" })
}

#[test]
fn a_picture_asked_over_the_routes_is_followed_to_its_end_and_fetched() {
    let f = fixture("", 150, None);
    let file = f.dir.path().join("pictures").join("vespa.png");
    let (status, job) = f.call("POST", "/control/image/generate", json!({ "prompt": "a red vespa", "width": 768, "height": 512, "model": "img", "seed": 5, "file": file }));
    assert_eq!((status, job["id"].as_str(), job["model"].as_str(), job["prompt"].as_str()), (202, Some("image-1"), Some("img"), Some("a red vespa")));
    assert!(["waiting", "preparing"].contains(&job["status"].as_str().unwrap()), "{job}");
    assert_eq!(f.call("GET", "/control/image/jobs/image-1/picture", Value::Null).0, 409, "not made yet");

    let seen = f.follow("image-1");
    let drawing: Vec<&Value> = seen.iter().filter(|j| j["status"] == "drawing").collect();
    assert!(drawing.iter().any(|j| j["step"].as_u64() > Some(0) && j["steps"] == 6), "{seen:?}");
    let decode = |s: &Value| base64::engine::general_purpose::STANDARD.decode(s.as_str().unwrap()).unwrap();
    assert!(drawing.iter().any(|j| !j["preview"].is_null() && decode(&j["preview"]).starts_with(b"preview ")), "a preview while it is drawn");
    let done = seen.last().unwrap();
    assert_eq!((done["status"].as_str(), done["seed"].as_u64(), done["step"].as_u64(), done["steps"].as_u64()), (Some("done"), Some(5), Some(6), Some(6)));
    assert_eq!(done["file"].as_str(), Some(file.display().to_string().as_str()));
    assert!(done["preview"].is_null() && done["error"].is_null());

    let (status, got) = f.call("GET", "/control/image/jobs/image-1/picture", Value::Null);
    let png = decode(&got["png"]);
    let reached: Value = serde_json::from_slice(&png).unwrap();
    assert_eq!((status, reached["asked"]["prompt"].as_str(), reached["asked"]["seed"].as_u64()), (200, Some("a red vespa"), Some(5)));
    assert_eq!(std::fs::read(&file).unwrap(), png, "the file is the picture");

    let (status, state) = f.call("GET", "/control/image", Value::Null);
    assert_eq!((status, &state["models"][0]["key"], &state["default"], &state["loaded"]), (200, &json!("img"), &Value::Null, &Value::Null));
    assert_eq!(state["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(state["jobs"][0]["status"], "done");
}

#[test]
fn a_request_that_is_not_valid_is_refused_and_begins_nothing() {
    let f = fixture("", 5, None);
    let refused = |body: Value| f.message("POST", "/control/image/generate", body);
    assert_eq!(refused(json!({ "width": 512, "height": 512, "model": "img" })).0, 400);
    assert_eq!(refused(json!({ "prompt": "  ", "width": 512, "height": 512, "model": "img" })), (400, tr!("manca la richiesta («prompt»)", "the request («prompt») is missing")));
    assert_eq!(refused(json!({ "prompt": "x", "width": 0, "height": 512, "model": "img" })).0, 400);
    assert_eq!(refused(json!({ "prompt": "x", "width": 512, "height": 5000, "model": "img" })).0, 400);
    assert_eq!(refused(json!({ "prompt": "x", "width": 512, "height": 512, "model": "img", "steps": 50 })).0, 400, "a field the route does not know");
    assert_eq!(refused(json!({ "prompt": "x", "width": 512, "height": 512, "model": "img", "file": "pictures/x.png" })).0, 400, "a relative file");
    let (status, said) = refused(json!({ "prompt": "x", "width": 512, "height": 512 }));
    assert!(status == 400 && said.contains("«model»"), "{said}");
    assert_eq!(f.taken.load(Ordering::SeqCst), 0);
    assert!(f.call("GET", "/control/image", Value::Null).1["jobs"].as_array().unwrap().is_empty());

    assert_eq!(f.message("GET", "/control/image/jobs/image-9", Value::Null).0, 404);
    assert_eq!(f.message("POST", "/control/image/jobs/image-9/cancel", Value::Null).0, 404);
    assert_eq!(f.message("GET", "/control/image/jobs/image-9/picture", Value::Null).0, 404);
    assert_eq!(f.message("GET", "/control/image/nothing", Value::Null).0, 404);
    assert!(f.routes.handle("GET", "/control/state", b"").is_none(), "not an image route");
}

/// Without `model` the default one is used; a model that does not make images is a job that failed, with its reason.
#[test]
fn the_default_model_is_used_when_none_is_named_and_an_unknown_one_fails() {
    let f = fixture("", 5, Some("img"));
    let id = f.ask(json!({ "prompt": "x", "width": 512, "height": 512 }));
    assert_eq!(f.follow(&id).last().unwrap()["model"], "img");

    let id = f.ask(json!({ "prompt": "x", "width": 512, "height": 512, "model": "ghost" }));
    let failed = f.follow(&id).pop().unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(failed["error"].as_str().unwrap().contains("«ghost»"), "{failed}");
}

/// A job stopped while it is drawn ends as cancelled within a moment; one stopped while it waits never begins.
#[test]
fn a_job_is_stopped_while_it_is_drawn_and_while_it_waits() {
    let f = fixture("", 400, None);
    let (first, second) = (f.ask(picture()), f.ask(picture()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while f.job(&first)["status"] != "drawing" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(f.job(&second)["status"], "waiting");

    assert_eq!(f.call("POST", &format!("/control/image/jobs/{second}/cancel"), Value::Null).0, 200);
    let start = Instant::now();
    assert_eq!(f.call("POST", &format!("/control/image/jobs/{first}/cancel"), Value::Null).0, 200);
    assert_eq!(f.follow(&first).last().unwrap()["status"], "cancelled");
    assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
    assert_eq!(f.follow(&second).last().unwrap()["status"], "cancelled");
    assert_eq!(f.taken.load(Ordering::SeqCst), 1, "the second never took the cards");
    assert_eq!(f.message("GET", &format!("/control/image/jobs/{first}/picture"), Value::Null).0, 409);
}

#[test]
fn a_job_that_fails_says_why_for_the_user_and_in_detail() {
    let f = fixture("fail", 5, None);
    let failed = f.follow(&f.ask(picture())).pop().unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(failed["error"].as_str().unwrap().starts_with(&tr!("Il motore delle immagini non è riuscito a fare l'immagine.", "The image engine could not make the picture.")), "{failed}");
    assert!(!failed["error"].as_str().unwrap().contains("generate_image") && failed["detail"].as_str().unwrap().contains("generate_image returned empty results"), "{failed}");

    // a picture that cannot be written where it was asked is a job that failed too
    let f = fixture("", 5, None);
    let folder_in_the_way = f.dir.path().join("taken");
    std::fs::create_dir_all(&folder_in_the_way).unwrap();
    let failed = f.follow(&f.ask(json!({ "prompt": "x", "width": 512, "height": 512, "model": "img", "file": folder_in_the_way }))).pop().unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(failed["error"].as_str().unwrap().contains(&tr!("non riesco a scriverla", "I cannot write it")), "{failed}");
}

/// A picture asked with `stay_on` leaves the engine on, and the state says with which model; `unload` stops it.
#[test]
fn the_engine_that_stays_on_is_told_and_is_stopped_on_request() {
    let f = fixture("", 5, None);
    let mut asked = picture();
    asked["stay_on"] = json!(true);
    f.follow(&f.ask(asked));
    assert_eq!(f.call("GET", "/control/image", Value::Null).1["loaded"], "img");
    let (status, state) = f.call("POST", "/control/image/unload", Value::Null);
    assert_eq!((status, &state["loaded"]), (200, &Value::Null));
}

/// The jobs that have ended are remembered up to eight: the oldest are forgotten, with their pictures.
#[test]
fn only_the_last_jobs_that_ended_are_remembered() {
    let f = fixture("", 1, None);
    for _ in 0..10 {
        f.follow(&f.ask(picture()));
    }
    let state = f.call("GET", "/control/image", Value::Null).1;
    let ids: Vec<&str> = state["jobs"].as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["image-3", "image-4", "image-5", "image-6", "image-7", "image-8", "image-9", "image-10"]);
    assert_eq!(f.message("GET", "/control/image/jobs/image-1", Value::Null).0, 404);
    assert_eq!(f.call("GET", "/control/image/jobs/image-10/picture", Value::Null).0, 200);
}

/// Two jobs asking for the same file both keep their picture: the second takes the next free name and its job says
/// which; a file that is already there is never replaced either.
#[test]
fn a_picture_never_replaces_a_file_and_the_job_says_where_it_went() {
    let f = fixture("", 5, None);
    let file = f.dir.path().join("pictures").join("cat.png");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let asked = |file: &std::path::Path| json!({ "prompt": "a cat", "width": 512, "height": 512, "model": "img", "file": file });

    // Both are asked before either is written, as two conversations of the same folder would.
    let (first, second) = (f.ask(asked(&file)), f.ask(asked(&file)));
    let (first, second) = (f.follow(&first).pop().unwrap(), f.follow(&second).pop().unwrap());
    let named = |n: &str| f.dir.path().join("pictures").join(n).display().to_string();
    assert_eq!((first["status"].as_str(), first["file"].as_str()), (Some("done"), Some(named("cat.png").as_str())));
    assert_eq!((second["status"].as_str(), second["file"].as_str()), (Some("done"), Some(named("cat-2.png").as_str())));

    // A third finds both names taken; a file put there by someone else is kept as it is.
    std::fs::write(named("cat-3.png"), b"mine").unwrap();
    let third = f.follow(&f.ask(asked(&file))).pop().unwrap();
    assert_eq!(third["file"].as_str(), Some(named("cat-4.png").as_str()));
    assert_eq!(std::fs::read(named("cat-3.png")).unwrap(), b"mine");
    let (_, got) = f.call("GET", &format!("/control/image/jobs/{}/picture", third["id"].as_str().unwrap()), Value::Null);
    let png = base64::engine::general_purpose::STANDARD.decode(got["png"].as_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(named("cat-4.png")).unwrap(), png);
}

/// A model about to be taken off the computer: the picture being made with it is stopped and waited for, the engine
/// that stayed on goes, and a picture asked meanwhile is refused; after that the model can be asked for again.
#[test]
fn a_model_being_retired_has_no_picture_under_way_nor_an_engine_on() {
    let f = fixture("", 300, None);
    let mut asked = picture();
    asked["stay_on"] = json!(true);
    let drawing = f.ask(asked.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    while f.job(&drawing)["status"] != "drawing" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }

    let retired = f.routes.retire("img").unwrap();
    assert_eq!(f.job(&drawing)["status"], "cancelled", "the picture under way was stopped before retire answered");
    assert_eq!(f.routes.manager().loaded(), None, "nothing is left on");
    let refused = f.follow(&f.ask(picture())).pop().unwrap();
    assert_eq!(refused["status"], "failed");
    assert!(refused["error"].as_str().unwrap().contains(&tr!("sta per essere tolto", "is being taken off")), "{refused}");
    assert_eq!(f.taken.load(Ordering::SeqCst), 1, "the refused picture never took the cards");

    drop(retired);
    assert_eq!(f.follow(&f.ask(asked)).last().unwrap()["status"], "done");
    assert_eq!(f.routes.manager().loaded().as_deref(), Some("img"));
    // an engine that stayed on after a picture is stopped too
    let _retired = f.routes.retire("img").unwrap();
    assert_eq!(f.routes.manager().loaded(), None);
}

/// Pictures of other models are not waited for: the ones of the retired model that wait never begin.
#[test]
fn retiring_a_model_does_not_wait_for_the_pictures_of_the_others() {
    let f = fixture("", 400, None);
    let mut other = picture();
    other["model"] = json!("other");
    let (busy, waiting) = (f.ask(other), f.ask(picture()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while f.job(&busy)["status"] != "drawing" {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }

    let start = Instant::now();
    let _retired = f.routes.retire("img").unwrap();
    assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
    assert_eq!(f.job(&busy)["status"], "drawing", "the picture of the other model goes on");
    assert_eq!(f.follow(&busy).last().unwrap()["status"], "done");
    assert_eq!(f.follow(&waiting).last().unwrap()["status"], "cancelled");
    assert_eq!(f.taken.load(Ordering::SeqCst), 1);
}
