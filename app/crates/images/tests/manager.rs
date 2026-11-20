//! The image manager with the fake engine (`fake-sd`): a picture from the request to the result, the cards taken and
//! given back, an engine that stays on or stops, a picture stopped, an engine that fails in each of its ways. No GPUs.

use engine::{EngineManager, Phase};
use images::{Cancelled, ImageManager, Picture, Progress, Request, Stage};
use mango_common::tr;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod support;
use support::planner;

/// What happened to the cards, in order: `taken [1]`, `given back`.
type Cards = Arc<Mutex<Vec<String>>>;

struct GivesBack(Cards);

impl Drop for GivesBack {
    fn drop(&mut self) {
        self.0.lock().unwrap().push("given back".into());
    }
}

struct Fixture {
    m: ImageManager,
    cards: Cards,
    dir: tempfile::TempDir,
}

fn fixture(mode: &'static str, step_ms: u64) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cards = Cards::default();
    let seen = cards.clone();
    let lender: Box<images::Lender> = Box::new(move |gpus| {
        seen.lock().unwrap().push(format!("taken {gpus:?}"));
        Ok(Box::new(GivesBack(seen.clone())))
    });
    Fixture { m: ImageManager::new(planner(mode, step_ms), lender, dir.path()), cards, dir }
}

/// The signal of a picture nobody stops.
fn never() -> AtomicBool {
    AtomicBool::new(false)
}

fn request(seed: Option<u32>) -> Request {
    Request { model: "img".into(), prompt: "a red vespa".into(), width: 768, height: 512, seed, stay_on: false }
}

/// A picture of a conversation about images: the engine stays on after it.
fn staying_on(model: &str) -> Request {
    Request { model: model.into(), stay_on: true, ..request(None) }
}

/// The port the fake engine that made the picture listens on (its last argument).
fn port_of(p: &Picture) -> u64 {
    reached(p)["args"][3].as_str().unwrap().parse().unwrap()
}

/// The picture of the fake engine is what reached it.
fn reached(p: &Picture) -> Value {
    serde_json::from_slice(&p.png).unwrap()
}

fn error_of(f: &Fixture) -> String {
    format!("{:#}", f.m.generate(&request(None), &never(), &mut |_| {}).unwrap_err())
}

/// No process of the fake engine is left: the port it listened on is told in its arguments, and nobody answers there.
fn engine_is_gone(port: u64) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port as u16)).is_err()
}

#[test]
fn a_picture_is_made_with_what_the_request_and_the_plan_say() {
    let f = fixture("", 120);
    let mut told: Vec<Progress> = Vec::new();

    let p = f.m.generate(&request(Some(42)), &never(), &mut |p| told.push(p.clone())).unwrap();

    assert_eq!((p.model.as_str(), p.seed, p.steps), ("img", 42, 6));
    let got = reached(&p);
    assert_eq!(got["asked"]["prompt"], "a red vespa");
    assert_eq!((got["asked"]["width"].as_u64(), got["asked"]["height"].as_u64(), got["asked"]["seed"].as_u64()), (Some(768), Some(512), Some(42)));
    assert_eq!((got["asked"]["sample_params"]["sample_steps"].as_u64(), got["asked"]["sample_params"]["guidance"]["txt_cfg"].as_f64()), (Some(6), Some(1.0)));
    assert_eq!(got["cards"], "1");
    assert_eq!(got["args"][1], r"C:\fake\d.gguf");

    // preparing, then the steps in order, then (if it is seen) finishing: never back; a preview comes with a step
    assert_eq!((told[0].stage, told[0].step, told[0].steps), (Stage::Preparing, 0, 6));
    let order = |s: Stage| [Stage::Preparing, Stage::Drawing, Stage::Finishing].iter().position(|x| *x == s).unwrap();
    assert!(told.windows(2).all(|w| order(w[0].stage) <= order(w[1].stage)), "{told:?}");
    let drawing: Vec<u32> = told.iter().filter(|p| p.stage == Stage::Drawing).map(|p| p.step).collect();
    assert!(drawing.len() >= 2 && drawing.windows(2).all(|w| w[0] < w[1]) && *drawing.last().unwrap() < 6, "{drawing:?}");
    assert!(told.iter().all(|p| p.steps == 6));
    let previews: Vec<&[u8]> = told.iter().filter_map(|p| p.preview.as_deref()).collect();
    assert!(!previews.is_empty() && previews.iter().all(|p| p.starts_with(b"preview ")), "{}", previews.len());
    assert!(told.iter().filter(|p| p.preview.is_some()).all(|p| p.stage == Stage::Drawing));

    // the cards were taken before the engine started and given back after it stopped
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
    assert!(engine_is_gone(port_of(&p)) && f.m.loaded().is_none());
    assert!(f.dir.path().join("image.log").is_file());
}

/// In a conversation about images the engine stays on between the pictures, without the cards: each picture takes
/// them and gives them back. It stops with `unload`, when another model is asked for, and after a single picture.
#[test]
fn the_engine_stays_on_for_a_conversation_and_stops_for_a_single_picture() {
    let f = fixture("", 5);
    let one = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    assert_eq!(f.m.loaded().as_deref(), Some("img"));
    assert!(!engine_is_gone(port_of(&one)));
    let two = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    assert_eq!(port_of(&two), port_of(&one), "the same engine");
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back", "taken [1]", "given back"]);

    f.m.unload();
    assert!(f.m.loaded().is_none() && engine_is_gone(port_of(&one)));

    // another model: the engine of the first stops, the other's stays on
    let one = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    let other = f.m.generate(&staying_on("other"), &never(), &mut |_| {}).unwrap();
    assert_ne!(port_of(&other), port_of(&one));
    assert!(engine_is_gone(port_of(&one)) && !engine_is_gone(port_of(&other)));
    assert_eq!(f.m.loaded().as_deref(), Some("other"));

    // a single picture uses the engine that is on, and stops it
    let single = f.m.generate(&Request { model: "other".into(), ..request(None) }, &never(), &mut |_| {}).unwrap();
    assert_eq!(port_of(&single), port_of(&other));
    assert!(f.m.loaded().is_none() && engine_is_gone(port_of(&other)));
}

/// `unload` while a picture is being made lets it end, and its engine does not stay on. An engine that stayed on and
/// closed by itself is replaced at the next picture.
#[test]
fn an_unload_during_a_picture_and_an_engine_that_closed_leave_nothing_on() {
    let f = fixture("", 100);
    let m = f.m.clone();
    let unloader = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        m.unload();
    });
    let p = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    unloader.join().unwrap();
    assert!(f.m.loaded().is_none() && engine_is_gone(port_of(&p)));

    let f = fixture("exit-when-idle", 5);
    let one = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !engine_is_gone(port_of(&one)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let two = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    assert_ne!(port_of(&two), port_of(&one));
}

/// Without a seed in the request the manager draws one, tells it, and the next picture gets another.
#[test]
fn a_picture_without_a_seed_gets_one_that_is_told() {
    let f = fixture("", 5);
    let one = f.m.generate(&request(None), &never(), &mut |_| {}).unwrap();
    let two = f.m.generate(&request(None), &never(), &mut |_| {}).unwrap();
    assert_eq!(reached(&one)["asked"]["seed"].as_u64(), Some(u64::from(one.seed)));
    assert_ne!(one.seed, two.seed);
    assert!(one.seed <= 0x7fff_ffff);
}

/// A picture stopped while it is drawn ends as cancelled within a moment, the engine stops and the cards go back; the
/// next picture is made as usual.
#[test]
fn a_picture_can_be_stopped_while_it_is_drawn() {
    let f = fixture("", 400);
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        signal.store(true, Ordering::SeqCst);
    });
    let start = Instant::now();
    let mut steps = Vec::new();

    let e = f.m.generate(&staying_on("img"), &stop, &mut |p| steps.push(p.step)).unwrap_err();

    stopper.join().unwrap();
    assert!(e.is::<Cancelled>(), "{e:#}");
    assert!(start.elapsed() < Duration::from_millis(2000), "the six steps take 2.4 s: {:?}", start.elapsed());
    assert!(steps.iter().all(|s| *s < 6));
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
    assert!(f.m.loaded().is_none());

    // a picture already stopped when its turn comes does not begin: no cards, no engine
    assert!(f.m.generate(&request(None), &stop, &mut |_| panic!("it began")).unwrap_err().is::<Cancelled>());
    assert_eq!(f.cards.lock().unwrap().len(), 2);
    assert_eq!(f.m.generate(&request(Some(7)), &never(), &mut |_| {}).unwrap().seed, 7);
}

/// An engine that ends while it draws (memory ran out) is told as such, with what it wrote last; the cards go back.
#[test]
fn an_engine_that_closes_while_drawing_is_told_with_its_last_lines() {
    let f = fixture("exit", 20);
    let e = error_of(&f);
    assert!(e.contains(&tr!("Il motore delle immagini si è chiuso.", "The image engine closed.")), "{e}");
    assert!(e.contains("code 3") && e.contains("CUDA error: out of memory"), "{e}");
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
}

#[test]
fn an_engine_that_does_not_start_or_never_gets_ready_is_told() {
    let f = fixture("absent", 20);
    let e = error_of(&f);
    assert!(e.contains(&tr!("Il motore delle immagini si è chiuso.", "The image engine closed.")) && e.contains("code 5") && e.contains("a library is missing"), "{e}");

    let f = fixture("loading", 20);
    let start = Instant::now();
    let e = error_of(&f);
    assert!(e.contains("not ready after 2 s"), "{e}");
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
}

#[test]
fn a_job_that_fails_or_is_refused_carries_what_the_engine_said() {
    let f = fixture("fail", 5);
    let e = error_of(&f);
    assert!(e.contains(&tr!("non è riuscito a fare l'immagine", "could not make the picture")) && e.contains("generate_image returned empty results"), "{e}");

    let f = fixture("refuse", 5);
    let e = error_of(&f);
    assert!(e.contains("refused (400)") && e.contains("invalid generation parameters"), "{e}");
}

/// A model the plan refuses asks nobody for the cards.
#[test]
fn a_model_without_a_plan_takes_no_cards() {
    let f = fixture("", 5);
    let e = f.m.generate(&Request { model: "ghost".into(), ..request(None) }, &never(), &mut |_| {}).unwrap_err().to_string();
    assert!(e.contains("«ghost»"), "{e}");
    assert!(f.cards.lock().unwrap().is_empty());
}

/// Pictures asked together are made one after the other as a row: by the same engine, which stays on while one
/// waits, with the cards taken once and given back once, after the last. Then the engine is gone.
#[test]
fn pictures_asked_together_are_a_row_with_one_engine_and_the_cards_taken_once() {
    let f = fixture("", 40);
    let asked: Vec<_> = (1..=3u32)
        .map(|seed| {
            let m = f.m.clone();
            std::thread::spawn(move || m.generate(&request(Some(seed)), &never(), &mut |_| {}).unwrap())
        })
        .collect();
    let made: Vec<Picture> = asked.into_iter().map(|picture| picture.join().unwrap()).collect();
    assert_eq!(made.iter().map(|p| p.seed).collect::<Vec<_>>(), [1, 2, 3]);
    let ports: Vec<u64> = made.iter().map(port_of).collect();
    assert!(ports.iter().all(|port| *port == ports[0]), "one engine for the row: {ports:?}");
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
    assert!(engine_is_gone(ports[0]) && f.m.loaded().is_none());

    // a picture asked alone afterwards starts and stops its own engine, as before
    let alone = f.m.generate(&request(Some(4)), &never(), &mut |_| {}).unwrap();
    assert_ne!(port_of(&alone), ports[0]);
    assert_eq!(f.cards.lock().unwrap().len(), 4);
}

/// Pictures are made in the order they were asked, also when the thread of a later one gets to the manager first.
#[test]
fn pictures_are_made_in_the_order_they_were_asked() {
    let f = fixture("", 20);
    let (first, second) = (f.m.place(), f.m.place());
    let order: Arc<Mutex<Vec<u32>>> = Arc::default();
    let (m, begun) = (f.m.clone(), order.clone());
    let later = std::thread::spawn(move || m.generate_in(second, &request(Some(2)), &never(), &mut |_| begun.lock().unwrap().push(2)).unwrap());
    std::thread::sleep(Duration::from_millis(150));
    assert!(order.lock().unwrap().is_empty(), "the second waits for the first, which has not come yet");
    f.m.generate_in(first, &request(Some(1)), &never(), &mut |_| order.lock().unwrap().push(1)).unwrap();
    later.join().unwrap();
    let order = order.lock().unwrap();
    assert!(order.first() == Some(&1) && order.last() == Some(&2) && order.is_sorted(), "{order:?}");
}

/// A place given up before its turn does not hold the line.
#[test]
fn a_place_that_is_given_up_lets_the_next_picture_through() {
    let f = fixture("", 5);
    let (given_up, kept) = (f.m.place(), f.m.place());
    drop(given_up);
    f.m.generate_in(kept, &request(Some(1)), &never(), &mut |_| {}).unwrap();
    f.m.generate(&request(Some(2)), &never(), &mut |_| {}).unwrap();
}

/// A picture of a row that is stopped before its turn gives back what the one before left for it.
#[test]
fn a_waiting_picture_that_is_stopped_leaves_no_engine_on_and_no_cards_taken() {
    let f = fixture("", 40);
    let (m, stop) = (f.m.clone(), Arc::new(AtomicBool::new(false)));
    let first = std::thread::spawn(move || m.generate(&request(Some(1)), &never(), &mut |_| {}).unwrap());
    // the second waits behind the first, and is stopped while it waits
    std::thread::sleep(Duration::from_millis(60));
    let (m, stopped) = (f.m.clone(), stop.clone());
    let second = std::thread::spawn(move || m.generate(&request(Some(2)), &stopped, &mut |_| {}));
    std::thread::sleep(Duration::from_millis(60));
    stop.store(true, Ordering::SeqCst);
    let port = port_of(&first.join().unwrap());
    assert!(second.join().unwrap().unwrap_err().is::<Cancelled>());
    assert!(engine_is_gone(port) && f.m.loaded().is_none());
    assert_eq!(*f.cards.lock().unwrap(), ["taken [1]", "given back"]);
}

/// With the manager of the models that write: while a picture is drawn its card is on loan there, in the picture's
/// name, and a loan of another program stays; when the picture is done only the picture's loan ends.
#[test]
fn the_cards_come_from_the_manager_of_the_models_that_write_and_go_back_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let engine = EngineManager::new(Box::new(|key, _, _| anyhow::bail!("no model in this test ({key})")), Box::new(Vec::new), dir.path());
    engine.release(Some(&[2]), engine::Requester { pid: None, who: "another program".into() }).unwrap();
    let m = ImageManager::new(planner("", 60), images::lender(engine.clone()), dir.path());
    let seen: Arc<Mutex<Vec<(Vec<String>, Vec<u32>)>>> = Arc::default();
    let (watched, into) = (engine.clone(), seen.clone());

    m.generate(&request(None), &never(), &mut |p| {
        if p.stage == Stage::Drawing {
            let s = watched.state();
            into.lock().unwrap().push((s.loans.iter().map(|l| l.who.clone()).collect(), s.released.clone()));
        }
    })
    .unwrap();

    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty() && seen.iter().all(|(who, released)| who == &["another program", "Mango Code: image"] && released == &[1, 2]), "{seen:?}");
    // the giving back runs on its own thread
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.state().loans.len() > 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let s = engine.state();
    assert_eq!((s.phase, s.loans.iter().map(|l| l.who.as_str()).collect::<Vec<_>>(), s.released.as_slice()), (Phase::Released, vec!["another program"], &[2][..]), "{s:?}");
}

/// The app tells a page it must not reach its engines: the port of every image engine alive is known, from the moment it
/// starts to the moment it stops.
#[test]
fn the_ports_of_the_engines_that_are_alive_are_told() {
    let f = fixture("", 5);
    assert!(f.m.ports().is_empty());
    let one = f.m.generate(&staying_on("img"), &never(), &mut |_| {}).unwrap();
    assert_eq!(f.m.ports(), [port_of(&one) as u16]);
    f.m.unload();
    assert!(f.m.ports().is_empty());
    let single = f.m.generate(&request(None), &never(), &mut |_| {}).unwrap();
    assert!(f.m.ports().is_empty() && engine_is_gone(port_of(&single)));
}
