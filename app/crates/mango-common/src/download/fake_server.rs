//! A local HTTP server for tests: serves fixed bytes with `Range` support, and can break off halfway, stall
//! without closing, or pretend not to know the range.

use std::collections::HashMap;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tiny_http::{Header, Response, Server, StatusCode};

#[derive(Clone)]
pub struct Route {
    pub body: Vec<u8>,
    /// The 200 reply breaks off after this many bytes (the rest never arrives).
    pub interrupt_at: Option<usize>,
    /// The 200 reply sends this many bytes and then keeps the connection open without data (like a stalled
    /// network) until the test calls `FakeServer::release`, then drops it. The server serves one request at a
    /// time: the next request waits for the release.
    pub stall_at: Option<usize>,
    /// Always replies with the whole file and 200, even to a request with `Range`.
    pub ignore_range: bool,
}

impl Route {
    pub fn file(body: Vec<u8>) -> Route {
        Route { body, interrupt_at: None, stall_at: None, ignore_range: false }
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub range: Option<String>,
}

pub struct FakeServer {
    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub url: String,
    routes: Arc<Mutex<HashMap<String, Route>>>,
    log: Arc<Mutex<Vec<Request>>>,
    released: Arc<AtomicBool>,
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
}

/// Reads `data` and then fails, like a connection that drops; if it has a `stall`, it first stays mute until
/// the flag is set.
struct DropsAfter {
    data: Vec<u8>,
    pos: usize,
    stall: Option<Arc<AtomicBool>>,
}

impl Read for DropsAfter {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.data.len() {
            while self.stall.as_ref().is_some_and(|f| !f.load(Ordering::SeqCst)) {
                std::thread::sleep(Duration::from_millis(10));
            }
            return Err(io::Error::new(io::ErrorKind::ConnectionReset, "connection dropped"));
        }
        let n = buf.len().min(self.data.len() - self.pos);
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl FakeServer {
    pub fn start<const N: usize>(routes: [(&str, Route); N]) -> FakeServer {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let routes: Arc<Mutex<HashMap<String, Route>>> =
            Arc::new(Mutex::new(routes.into_iter().map(|(p, v)| (p.to_string(), v)).collect()));
        let log = Arc::new(Mutex::new(Vec::new()));
        let released = Arc::new(AtomicBool::new(false));
        let thread = {
            let (server, routes, log, released) = (server.clone(), routes.clone(), log.clone(), released.clone());
            std::thread::spawn(move || {
                for rq in server.incoming_requests() {
                    let path = rq.url().to_string();
                    let range = rq
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("Range"))
                        .map(|h| h.value.as_str().to_string());
                    log.lock().unwrap().push(Request { range: range.clone() });
                    let route = routes.lock().unwrap().get(&path).cloned();
                    let _ = match route {
                        None => rq.respond(Response::empty(404)),
                        Some(v) => reply(rq, v, range, &released),
                    };
                }
            })
        };
        FakeServer { url, routes, log, released, server, thread: Some(thread) }
    }

    pub fn set(&self, path: &str, route: Route) {
        self.routes.lock().unwrap().insert(path.to_string(), route);
    }

    /// Drops the stalled connections (`Route::stall_at`), now and in the future.
    pub fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
    }

    pub fn requests(&self) -> Vec<Request> {
        self.log.lock().unwrap().clone()
    }
}

fn reply(rq: tiny_http::Request, v: Route, range: Option<String>, released: &Arc<AtomicBool>) -> io::Result<()> {
    let total = v.body.len();
    let from = range
        .as_deref()
        .filter(|_| !v.ignore_range)
        .and_then(|r| r.strip_prefix("bytes="))
        .and_then(|r| r.strip_suffix('-'))
        .and_then(|n| n.parse::<usize>().ok());
    match from {
        Some(from) => {
            let h = Header::from_bytes("Content-Range", format!("bytes {from}-{}/{total}", total - 1)).unwrap();
            let rest = v.body[from..].to_vec();
            rq.respond(Response::from_data(rest).with_status_code(StatusCode(206)).with_header(h))
        }
        None => match v.interrupt_at.or(v.stall_at) {
            Some(n) => {
                let stall = v.stall_at.map(|_| released.clone());
                let r = DropsAfter { data: v.body[..n].to_vec(), pos: 0, stall };
                rq.respond(Response::new(StatusCode(200), vec![], r, Some(total), None))
            }
            None => rq.respond(Response::from_data(v.body)),
        },
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.release();
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
