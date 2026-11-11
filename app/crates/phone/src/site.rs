//! The pages of the computer's browser panel, seen from the phone.
//!
//! * **The preview port** (`Role::Preview`, answered by `serve`): every request needs the phone's session and goes to
//!   what the panel on the computer is showing *right now*, nothing else. A page of the computer (`http://localhost:<port>` or
//!   `http://127.0.0.1:<port>`) is relayed to that loopback address; the path and query come from the phone, the host
//!   and port never do. A local file (`file://`) is served read-only from its folder. With nothing to show, or with a
//!   page of the internet, the reply is a page that says so.
//! * **On the main port**: `/phone/preview` says what the panel shows and asks it to open a page, `/phone/file` hands a
//!   document of a project to the phone.

use crate::files;
use crate::http::{error, relay, respond, Head, Upstream};
use crate::{Inner, Page, Shown};
use mango_common::tr;
use serde::Deserialize;
use std::net::TcpStream;
use std::path::PathBuf;

const PREVIEW: &str = "/phone/preview";
const FILE: &str = "/phone/file";
/// An order to open a page is a few lines of JSON.
const MAX_OPEN: u64 = 16 * 1024;
const NOTICE: &str = include_str!("notice.html");

/// Where the panel's page lives, as far as the phone may be served from it.
#[derive(Debug, PartialEq)]
pub(crate) enum Target {
    /// A server on this computer: the address the relay connects to (`host` is `localhost` or `127.0.0.1`), the path asked.
    Http { host: &'static str, port: u16, path: String },
    /// A local file: its folder is served, and `entry` (the file's name) answers `/`.
    Folder { root: PathBuf, entry: String },
    /// Anything else: a site of the internet, `data:`, a blank panel.
    Other,
}

/// `http://localhost:<port>/…` or `http://127.0.0.1:<port>/…` and nothing else: host, port, path with query.
pub(crate) fn loopback_page(url: &str) -> Option<(&'static str, u16, String)> {
    let rest = url.get(..7).filter(|s| s.eq_ignore_ascii_case("http://")).map(|_| &url[7..])?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h, p.parse::<u16>().ok()?),
        Some(_) => return None,
        None => (authority, 80),
    };
    let host = match host.to_ascii_lowercase().as_str() {
        "localhost" => "localhost",
        "127.0.0.1" => "127.0.0.1",
        _ => return None,
    };
    let tail = tail.split('#').next().unwrap_or("");
    let path = if tail.starts_with('/') { tail.to_string() } else { format!("/{tail}") };
    (port != 0).then_some((host, port, path))
}

pub(crate) fn target(shown: &Shown) -> Target {
    if let Some((host, port, path)) = loopback_page(&shown.url) {
        return Target::Http { host, port, path };
    }
    match &shown.file {
        Some(file) if file.is_dir() => Target::Folder { root: file.clone(), entry: String::new() },
        Some(file) => match (file.parent(), file.file_name().and_then(|n| n.to_str())) {
            (Some(root), Some(name)) => Target::Folder { root: root.to_path_buf(), entry: name.to_string() },
            _ => Target::Other,
        },
        None => Target::Other,
    }
}

/// A request on the preview port, already checked (address, origin, session, method, body).
pub(crate) fn serve(c: &TcpStream, d: &Inner, head: &Head, rest: Vec<u8>, length: u64) {
    let Some(shown) = d.computer.shown() else {
        return notice(c, 404, tr!("Nessuna pagina", "No page"), tr!("Il browser del computer non sta mostrando nessuna pagina. Per vederne una tocca «Apri» sulla scheda del file nella conversazione.", "The browser on the computer is not showing a page. To see one, tap “Open” on the file card in the conversation."));
    };
    match target(&shown) {
        Target::Http { host, port, .. } => {
            if let Err(e) = relay(c, head, rest, length, &Upstream::site(host, port)) {
                notice(c, 502, tr!("La pagina non risponde", "The page does not answer"), tr!("Il server di questa pagina, sul computer, non risponde: {e:#}", "The server of this page, on the computer, does not answer: {e:#}"));
            }
        }
        Target::Folder { root, entry } => folder(c, head, &root, &entry),
        Target::Other => notice(
            c,
            404,
            tr!("Pagina non disponibile", "Page not available"),
            tr!(
                "Il browser del computer mostra una pagina che non è sul computer. Dal telefono si vedono solo le pagine del computer.",
                "The browser on the computer is showing a page that is not on the computer. From the phone only the computer's own pages can be seen."
            ),
        ),
    }
}

/// A local file's folder, read-only.
fn folder(c: &TcpStream, head: &Head, root: &std::path::Path, entry: &str) {
    if !matches!(head.method.as_str(), "GET" | "HEAD") {
        return respond(c, 405, "application/json", &error(&tr!("la cartella si legge soltanto", "the folder is read-only")), &[]);
    }
    let asked = crate::http::decode(head.path());
    let relative = if asked == "/" { format!("/{entry}") } else { asked };
    match files::inside(root, &relative) {
        Some(file) => files::send(c, head, &file, None),
        None => notice(c, 404, tr!("File non trovato", "File not found"), tr!("Questo file non c'è nella cartella della pagina.", "This file is not in the page's folder.")),
    }
}

fn notice(c: &TcpStream, status: u16, title: String, text: String) {
    let page = NOTICE
        .replace("{lang}", mango_common::i18n::lang().code())
        .replace("{title}", &html(&title))
        .replace("{text}", &html(&text));
    respond(c, status, "text/html; charset=utf-8", &page, &["Cache-Control: no-store"]);
}

fn html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// What the web UI on the phone needs: the preview port and the panel's page (`null` if there is none): the path to open, its
/// title and, for the moment it has none, a label (the server's address or the file's name).
fn state(d: &Inner) -> serde_json::Value {
    let page = d.computer.shown().map(|shown| match target(&shown) {
        Target::Http { host, port, path } => serde_json::json!({ "path": path, "title": shown.title, "label": format!("{host}:{port}{path}"), "local": true }),
        Target::Folder { entry, .. } => serde_json::json!({ "path": format!("/{}", files::percent(&entry)), "title": shown.title, "label": entry, "local": true }),
        Target::Other => serde_json::json!({ "path": "/", "title": shown.title, "label": "", "local": false }),
    });
    serde_json::json!({ "port": d.preview_port, "page": page })
}

#[derive(Deserialize)]
struct Open {
    url: Option<String>,
    directory: Option<String>,
    path: Option<String>,
}

pub(crate) fn is_preview_route(path: &str) -> bool {
    path == PREVIEW
}

pub(crate) fn is_file_route(path: &str) -> bool {
    path == FILE
}

/// `/phone/preview`: `GET` says what the panel shows; `POST` asks the panel to open a page of this computer first,
/// either an address (`{"url"}`) or an HTML file of a project (`{"directory","path"}`), and then says the same.
pub(crate) fn preview_route(c: &TcpStream, d: &Inner, head: &Head, rest: Vec<u8>, length: u64, address: &str) {
    let fail = |status: u16, message: &str| {
        d.log(serde_json::json!({ "event": "preview", "outcome": status, "address": address }));
        respond(c, status, "application/json", &error(message), &[]);
    };
    let reply = || respond(c, 200, "application/json", &state(d).to_string(), &["Cache-Control: no-store"]);
    match head.method.as_str() {
        "GET" => reply(),
        "POST" => {
            let Some(body) = crate::http::body(c, rest, length, MAX_OPEN) else {
                return fail(400, &tr!("serve un corpo con Content-Length", "a body with Content-Length is needed"));
            };
            let Ok(order) = serde_json::from_slice::<Open>(&body) else {
                return fail(400, &tr!("richiesta non valida", "invalid request"));
            };
            let page = match (order.url, order.directory, order.path) {
                (Some(url), None, None) => match loopback_page(&url) {
                    Some(_) => Page::Url(url),
                    None => return fail(400, &tr!("si aprono solo le pagine del computer (localhost o 127.0.0.1)", "only the computer's own pages (localhost or 127.0.0.1) can be opened")),
                },
                (None, Some(directory), Some(path)) => {
                    let file = match project_file(d, &directory, &path) {
                        Ok(f) => f,
                        Err((status, message)) => return fail(status, &message),
                    };
                    if !file.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm")) {
                        return fail(400, &tr!("non è una pagina HTML", "it is not an HTML page"));
                    }
                    Page::File(file)
                }
                _ => return fail(400, &tr!("richiesta non valida", "invalid request")),
            };
            if let Err((status, message)) = d.computer.open(page) {
                return fail(status, &message);
            }
            d.log(serde_json::json!({ "event": "preview", "outcome": 200, "address": address }));
            reply();
        }
        _ => fail(405, &tr!("metodo non ammesso", "method not allowed")),
    }
}

fn project_file(d: &Inner, directory: &str, path: &str) -> Result<PathBuf, (u16, String)> {
    let folders = d.computer.project_folders().map_err(|e| (502, e))?;
    files::project_file(&folders, directory, path)
}

/// `GET /phone/file?directory=…&path=…`: a document of a project, as a download; with `&info=1` its size as JSON.
/// Only a file inside the folder of the conversation's project (see `files::project_file`); the log has the outcome and
/// never the name.
pub(crate) fn file_route(c: &TcpStream, d: &Inner, head: &Head, address: &str) {
    let fail = |status: u16, message: &str| {
        d.log(serde_json::json!({ "event": "file", "outcome": status, "address": address }));
        respond(c, status, "application/json", &error(message), &[]);
    };
    if !matches!(head.method.as_str(), "GET" | "HEAD") {
        return fail(405, &tr!("metodo non ammesso", "method not allowed"));
    }
    let query = |name: &str| {
        head.url.split_once('?').and_then(|(_, q)| q.split('&').find_map(|p| p.strip_prefix(name).and_then(|v| v.strip_prefix('='))).map(crate::http::decode))
    };
    let (Some(directory), Some(path)) = (query("directory"), query("path")) else {
        return fail(400, &tr!("servono directory e path", "directory and path are needed"));
    };
    let real = match project_file(d, &directory, &path) {
        Ok(f) => f,
        Err((status, message)) => return fail(status, &message),
    };
    d.log(serde_json::json!({ "event": "file", "outcome": 200, "address": address }));
    if query("info").is_some() {
        let meta = std::fs::metadata(&real);
        let body = serde_json::json!({ "size": meta.as_ref().map_or(0, |m| m.len()), "isDir": meta.is_ok_and(|m| m.is_dir()) });
        return respond(c, 200, "application/json", &body.to_string(), &["Cache-Control: no-store"]);
    }
    let name = real.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    files::send(c, head, &real, Some(name));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_computers_own_pages_are_relayed() {
        let page = |u: &str| loopback_page(u).map(|(h, p, path)| format!("{h}:{p}{path}"));
        assert_eq!(page("http://127.0.0.1:3000/").as_deref(), Some("127.0.0.1:3000/"));
        assert_eq!(page("http://localhost:5173/a/b?x=1#top").as_deref(), Some("localhost:5173/a/b?x=1"));
        assert_eq!(page("HTTP://LocalHost:8080").as_deref(), Some("localhost:8080/"));
        assert_eq!(page("http://localhost/x").as_deref(), Some("localhost:80/x"));
        assert_eq!(page("http://127.0.0.1:3000?a=1").as_deref(), Some("127.0.0.1:3000/?a=1"));
        for no in [
            "https://localhost:3000/",
            "http://192.168.1.5:3000/",
            "http://example.com/",
            "http://localhost.evil.com:3000/",
            "http://127.0.0.1.nip.io:3000/",
            "http://127.0.0.1:3000@evil.com/",
            "http://evil.com@127.0.0.1:3000/",
            "http://[::1]:3000/",
            "http://0.0.0.0:3000/",
            "http://127.0.0.2:3000/",
            "http://localhost:0/",
            "http://localhost:99999/",
            "http://localhost:/",
            "http://localhost:3000x/",
            "file:///C:/site/index.html",
            "ftp://localhost/",
            "localhost:3000",
            "",
        ] {
            assert!(loopback_page(no).is_none(), "{no}");
        }
    }

    #[test]
    fn a_local_file_serves_its_folder() {
        let shown = |url: &str, file: Option<&str>| Shown { url: url.into(), title: String::new(), file: file.map(PathBuf::from) };
        assert_eq!(target(&shown("http://localhost:3000/x", None)), Target::Http { host: "localhost", port: 3000, path: "/x".into() });
        assert_eq!(
            target(&shown("file:///C:/site/index.html", Some("C:/site/index.html"))),
            Target::Folder { root: PathBuf::from("C:/site"), entry: "index.html".into() }
        );
        assert_eq!(target(&shown("https://example.com/", None)), Target::Other);
        assert_eq!(target(&shown("about:blank", None)), Target::Other);
    }
}
