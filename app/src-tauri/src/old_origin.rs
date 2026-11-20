//! Reads what the window's browser kept for the origin the app prefers (`http://127.0.0.1:<port>`): every key of its
//! storage and the drafts with their attachments, the state of the versions that kept the interface's state in the
//! browser (`ui_state.rs`).
//!
//! The browser hands the storage of an origin only to a page served from it, and the agent may not be able to serve that
//! origin: another program can hold the port. So the app serves it itself, without the network: a hidden window of the
//! same browser profile loads a small page from that origin, and the app answers every request to the origin from inside
//! the window (WebView2's `WebResourceRequested`), so no request leaves for the program that holds the port. The page
//! reads the storage and posts it back to the same origin, where the app takes it. The browser's data is only read.

use crate::ui_state::{Old, UiState};
use mango_common::tr;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
use windows_webview::core::{HSTRING, PWSTR};
use windows_webview::Win32::Foundation::E_OUTOFMEMORY;
use windows_webview::Win32::UI::Shell::SHCreateMemStream;

const LABEL: &str = "old-origin";
/// The longest the window waits for the page to read everything. A read takes well under a second.
const LIMIT: Duration = Duration::from_secs(20);

/// The page that reads the storage: it is the only document the app serves from the old origin.
const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Mango Code</title><script>
const post = (path, body) => fetch(path, { method: "POST", body }).then((r) => { if (!r.ok) throw new Error(path + " " + r.status) });
const open = (name) => new Promise((ok, ko) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) });
(async () => {
  try {
    const entries = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    const drafts = {};
    if ((await indexedDB.databases()).some((d) => d.name === "opencode-drafts")) {
      const db = await open("opencode-drafts");
      try {
        if (db.objectStoreNames.contains("documents")) {
          const names = db.objectStoreNames.contains("blobs") ? ["documents", "blobs"] : ["documents"];
          const read = (make) => new Promise((ok, ko) => { const r = make(db.transaction(names)); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) });
          const keys = await read((t) => t.objectStore("documents").getAllKeys());
          const values = await read((t) => t.objectStore("documents").getAll());
          keys.forEach((key, i) => { if (typeof values[i] === "string") drafts[String(key)] = values[i] });
          if (names.length === 2) {
            const ids = new Set(Object.values(drafts).flatMap((doc) => [...doc.matchAll(/"id":"([0-9a-f]{64})"/g)].map((m) => m[1])));
            for (const id of ids) {
              try {
                const blob = await read((t) => t.objectStore("blobs").get(id));
                if (blob instanceof Blob) await post("/blob/" + id, blob);
                else await post("/skipped", id + ": not in the browser's store");
              } catch (e) { await post("/skipped", id + ": " + ((e && e.message) || e)) }
            }
          }
        }
      } finally { db.close() }
    }
    await post("/state", JSON.stringify({ entries, drafts }));
    await post("/done", "");
  } catch (e) { fetch("/failed", { method: "POST", body: String((e && e.message) || e) }) }
})();
</script>"#;

/// What the app takes from the page, in the order it arrives.
pub(crate) enum Message {
    State(Vec<u8>),
    Blob(String, Vec<u8>),
    Skipped(String),
    /// Something the page asked that the app does not answer: told to the log, and the read goes on.
    Note(String),
    Done,
    Failed(String),
}

/// Takes the messages of the page until it says it is done. The attachments go straight to the app's folder (`ui`
/// checks that each is the bytes its id names); what cannot be stored is told to `log` and left out, and the rest goes on.
pub(crate) fn collect(ui: &UiState, messages: &Receiver<Message>, limit: Duration, log: &dyn Fn(&str)) -> anyhow::Result<Old> {
    let deadline = Instant::now() + limit;
    let mut old = None;
    loop {
        match messages.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::State(bytes)) => old = Some(serde_json::from_slice::<Old>(&bytes)?),
            Ok(Message::Blob(id, bytes)) => {
                if let Err(e) = ui.put_blob(&id, &bytes) {
                    log(&format!("an attachment of the old storage was not copied ({id}): {e:#}"));
                }
            }
            Ok(Message::Skipped(what)) => log(&format!("an attachment of the old storage was not read ({what})")),
            Ok(Message::Note(note)) => log(&note),
            Ok(Message::Done) => return old.ok_or_else(|| anyhow::anyhow!("the page finished without sending the storage")),
            Ok(Message::Failed(why)) => anyhow::bail!("{why}"),
            Err(_) => anyhow::bail!("{}", tr!("la lettura è durata troppo", "the read took too long")),
        }
    }
}

/// The old origin's storage, read with a hidden window while the window of the app shows its own page.
pub(crate) fn read(app: &AppHandle, port: u16) -> anyhow::Result<Old> {
    let ui = app.state::<UiState>().inner().clone();
    let origin = format!("http://127.0.0.1:{port}");
    let (sender, messages) = channel();
    let window = crate::window_profile(WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse()?)))
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .inner_size(200.0, 200.0)
        .build()?;
    let problems = sender.clone();
    window.with_webview(move |webview| unsafe {
        if let Err(e) = answer_for(webview, origin, sender) {
            let _ = problems.send(Message::Failed(format!("{e}")));
        }
    })?;
    let paths = app.state::<crate::AppState>().paths.get().cloned();
    let log = |line: &str| {
        if let Some(paths) = &paths {
            crate::startup_log(paths, line);
        }
    };
    let old = collect(&ui, &messages, LIMIT, &log);
    let _ = window.destroy();
    old
}

/// Answers every request of the window to `origin` itself and sends what the page posts. The page loads from the origin
/// and nothing goes to the network: a request that cannot be read or answered ends the read, and one the app has no answer
/// for gets a 404.
unsafe fn answer_for(webview: tauri::webview::PlatformWebview, origin: String, sender: Sender<Message>) -> windows_webview::core::Result<()> {
    let core = webview.controller().CoreWebView2()?;
    let environment = webview.environment();
    core.AddWebResourceRequestedFilter(&HSTRING::from(format!("{origin}/*")), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
    let served = origin.clone();
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let reply = match read_request(&args, &served) {
            Ok((method, path, body)) => route(&method, &path, body, &sender),
            Err(e) => {
                let _ = sender.send(Message::Failed(format!("a request of the page could not be read: {e}")));
                Reply::refused(500, "Internal Server Error")
            }
        };
        let answered = SHCreateMemStream(Some(&reply.body)).ok_or_else(|| windows_webview::core::Error::from(E_OUTOFMEMORY)).and_then(|stream| {
            let headers = HSTRING::from(format!("Content-Type: {}\r\nCache-Control: no-store", reply.kind));
            let response = environment.CreateWebResourceResponse(Some(&stream), reply.status, &HSTRING::from(reply.reason), &headers)?;
            args.SetResponse(&response)
        });
        if let Err(e) = &answered {
            let _ = sender.send(Message::Failed(format!("a request of the page could not be answered: {e}")));
        }
        answered
    }));
    let mut token = 0;
    core.add_WebResourceRequested(&handler, &mut token)?;
    core.Navigate(&HSTRING::from(format!("{origin}/")))
}

/// The method, the path (after the origin) and the body of a request. A request without a body has an empty one; a body
/// that cannot be read is an error.
unsafe fn read_request(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequestedEventArgs,
    origin: &str,
) -> windows_webview::core::Result<(String, String, Vec<u8>)> {
    let request = args.Request()?;
    let mut uri = PWSTR::null();
    request.Uri(&mut uri)?;
    let mut method = PWSTR::null();
    request.Method(&mut method)?;
    let (uri, method) = (take_pwstr(uri), take_pwstr(method));
    let body = match request.Content() {
        Ok(stream) => read_all(&stream)?,
        // The interface is null when the request has no body: that is not a failure.
        Err(e) if e.code().is_ok() => Vec::new(),
        Err(e) => return Err(e),
    };
    Ok((method, uri.strip_prefix(origin).unwrap_or("").to_string(), body))
}

/// What the app answers.
struct Reply {
    status: i32,
    reason: &'static str,
    kind: &'static str,
    body: Vec<u8>,
}

impl Reply {
    fn ok(kind: &'static str, body: &[u8]) -> Self {
        Self { status: 200, reason: "OK", kind, body: body.to_vec() }
    }

    fn refused(status: i32, reason: &'static str) -> Self {
        Self { status, reason, kind: "text/plain", body: Vec::new() }
    }
}

/// The answer to one request of the page, and what it says to the app's side. 500 when nobody is waiting for it any more.
fn route(method: &str, path: &str, body: Vec<u8>, sender: &Sender<Message>) -> Reply {
    let message = match (method, path) {
        ("GET", "/") => return Reply::ok("text/html; charset=utf-8", PAGE.as_bytes()),
        ("POST", "/state") => Message::State(body),
        ("POST", "/done") => Message::Done,
        ("POST", "/failed") => Message::Failed(String::from_utf8_lossy(&body).into_owned()),
        ("POST", "/skipped") => Message::Skipped(String::from_utf8_lossy(&body).into_owned()),
        ("POST", blob) if blob.starts_with("/blob/") => Message::Blob(blob["/blob/".len()..].to_string(), body),
        _ => {
            let _ = sender.send(Message::Note(format!("a request of the page that has no answer: {method} {path}")));
            return Reply::refused(404, "Not Found");
        }
    };
    if sender.send(message).is_ok() {
        Reply::ok("text/plain", b"ok")
    } else {
        Reply::refused(500, "Internal Server Error")
    }
}

pub(crate) unsafe fn read_all(stream: &windows_webview::Win32::System::Com::IStream) -> windows_webview::core::Result<Vec<u8>> {
    let mut all = Vec::new();
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let mut read = 0u32;
        stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut read)).ok()?;
        if read == 0 {
            return Ok(all);
        }
        all.extend_from_slice(&chunk[..read as usize]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::Mutex;

    fn id_of(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn state_message(entries: &[(&str, &str)], drafts: &[(&str, &str)]) -> Message {
        let old = Old {
            entries: entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            drafts: drafts.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        };
        Message::State(serde_json::to_vec(&old).unwrap())
    }

    #[test]
    fn the_storage_the_page_posted_comes_with_its_attachments_stored() {
        let dir = tempfile::tempdir().unwrap();
        let ui = UiState::in_dir(dir.path());
        let (sender, messages) = channel();
        let id = id_of(b"picture");
        sender.send(Message::Blob(id.clone(), b"picture".to_vec())).unwrap();
        sender.send(state_message(&[("k", "v")], &[("d", "{}")])).unwrap();
        sender.send(Message::Done).unwrap();
        let old = collect(&ui, &messages, Duration::from_secs(5), &|line| panic!("{line}")).unwrap();
        assert_eq!(old.entries.get("k").map(String::as_str), Some("v"));
        assert_eq!(old.drafts.get("d").map(String::as_str), Some("{}"));
        assert_eq!(ui.get_blob(&id).unwrap(), Some(b"picture".to_vec()));
    }

    #[test]
    fn an_attachment_that_is_not_its_id_is_left_out_and_logged_and_the_rest_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let ui = UiState::in_dir(dir.path());
        let (sender, messages) = channel();
        let wrong = "a".repeat(64);
        sender.send(Message::Blob(wrong.clone(), b"picture".to_vec())).unwrap();
        sender.send(Message::Skipped("unreadable".into())).unwrap();
        sender.send(state_message(&[("k", "v")], &[])).unwrap();
        sender.send(Message::Done).unwrap();
        let logged = Mutex::new(Vec::new());
        let old = collect(&ui, &messages, Duration::from_secs(5), &|line| logged.lock().unwrap().push(line.to_string())).unwrap();
        assert_eq!(old.entries.len(), 1);
        assert_eq!(ui.get_blob(&wrong).unwrap(), None);
        assert_eq!(logged.lock().unwrap().len(), 2);
    }


    #[test]
    fn every_request_of_the_page_gets_an_answer_and_what_is_not_known_is_told() {
        let (sender, messages) = channel();
        let page = route("GET", "/", Vec::new(), &sender);
        assert_eq!((page.status, page.kind), (200, "text/html; charset=utf-8"));
        assert!(String::from_utf8(page.body).unwrap().contains("indexedDB"));
        assert_eq!(route("POST", "/state", b"{}".to_vec(), &sender).status, 200);
        assert_eq!(route("POST", "/blob/abc", b"bytes".to_vec(), &sender).status, 200);
        assert_eq!(route("POST", "/done", Vec::new(), &sender).status, 200);
        assert!(matches!(messages.try_recv(), Ok(Message::State(body)) if body == b"{}"));
        assert!(matches!(messages.try_recv(), Ok(Message::Blob(id, body)) if id == "abc" && body == b"bytes"));
        assert!(matches!(messages.try_recv(), Ok(Message::Done)));
        for (method, path) in [("GET", "/favicon.ico"), ("POST", "/other"), ("PUT", "/state")] {
            assert_eq!(route(method, path, Vec::new(), &sender).status, 404, "{method} {path}");
            assert!(matches!(messages.try_recv(), Ok(Message::Note(note)) if note.contains(path)));
        }
    }

    #[test]
    fn a_request_nobody_waits_for_any_more_is_answered_with_an_error() {
        let (sender, messages) = channel();
        drop(messages);
        assert_eq!(route("POST", "/state", b"{}".to_vec(), &sender).status, 500);
        assert_eq!(route("GET", "/nothing", Vec::new(), &sender).status, 404);
    }

    #[test]
    fn what_the_page_asks_and_the_app_does_not_answer_goes_to_the_log_and_the_read_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let ui = UiState::in_dir(dir.path());
        let (sender, messages) = channel();
        sender.send(Message::Note("a request of the page that has no answer: GET /x".into())).unwrap();
        sender.send(state_message(&[], &[])).unwrap();
        sender.send(Message::Done).unwrap();
        let logged = Mutex::new(Vec::new());
        collect(&ui, &messages, Duration::from_secs(5), &|line| logged.lock().unwrap().push(line.to_string())).unwrap();
        assert_eq!(logged.lock().unwrap().len(), 1);
    }
    #[test]
    fn a_page_that_fails_or_never_finishes_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let ui = UiState::in_dir(dir.path());
        let (sender, messages) = channel();
        sender.send(Message::Failed("quota".into())).unwrap();
        assert!(collect(&ui, &messages, Duration::from_secs(5), &|_| {}).unwrap_err().to_string().contains("quota"));
        sender.send(Message::Done).unwrap();
        assert!(collect(&ui, &messages, Duration::from_secs(5), &|_| {}).is_err(), "done without a state");
        sender.send(Message::State(b"not a storage".to_vec())).unwrap();
        sender.send(Message::Done).unwrap();
        assert!(collect(&ui, &messages, Duration::from_secs(5), &|_| {}).is_err(), "a state that cannot be read is not an empty one");
        assert!(collect(&ui, &messages, Duration::from_millis(50), &|_| {}).is_err(), "nothing arrives");
    }
}
