//! Files from the computer's disk to the phone: the folder of a local page and the documents of a project.
//!
//! Nothing here trusts a path it is given. A request names a file relative to a folder (`inside`) or by its absolute path
//! inside a project (`project_file`); both resolve the real file on disk, with links and `..` followed, and refuse it if it
//! does not end up under the folder.

use crate::http::{finish, respond, Head};
use mango_common::tr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Component, Path, PathBuf};

/// Names Windows opens as devices, whatever the extension: `CON.html` is the console.
const DEVICES: &[&str] = &["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

/// The type a browser needs to show a file; the rest is a plain download.
pub(crate) fn mime(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// The real file that `relative` (a request path, already decoded) names under `root`: `None` if it is not there, is
/// not a file (a folder gives its `index.html`), or leads out of `root` in any way: `..`, a drive, a stream, a device
/// name, a link.
pub(crate) fn inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in relative.split('/').filter(|p| !p.is_empty() && *p != ".") {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part == ".." || part.contains(['\\', ':', '\0']) || DEVICES.contains(&stem.as_str()) {
            return None;
        }
        path.push(part);
    }
    let root = std::fs::canonicalize(root).ok()?;
    let mut real = std::fs::canonicalize(&path).ok()?;
    if real.is_dir() {
        real = std::fs::canonicalize(real.join("index.html")).ok()?;
    }
    (real.starts_with(&root) && real.is_file()).then_some(real)
}

/// The real file at `path` (absolute) if it lies inside `directory` (absolute) and `directory` is, or is inside, one of
/// the project `folders`. Err: the status and the sentence for the user.
pub(crate) fn project_file(folders: &[PathBuf], directory: &str, path: &str) -> Result<PathBuf, (u16, String)> {
    let (directory, path) = (Path::new(directory), Path::new(path));
    if !directory.is_absolute() || !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return Err((400, tr!("serve un percorso assoluto", "an absolute path is needed")));
    }
    let resolve = |p: &Path| {
        std::fs::canonicalize(p).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => (404, tr!("il file non c'è", "the file is not there")),
            _ => (500, format!("{}: {e}", p.display())),
        })
    };
    let directory = resolve(directory)?;
    // The agent also lists a "global" project whose folder is the root of the disk: it is every folder, so it is not a project.
    let projects = folders.iter().filter_map(|f| std::fs::canonicalize(f).ok()).filter(|f| f.parent().is_some());
    if !projects.into_iter().any(|f| directory.starts_with(f)) {
        return Err((403, tr!("la cartella non è un progetto", "the folder is not a project")));
    }
    let real = resolve(path)?;
    if real.starts_with(&directory) {
        Ok(real)
    } else {
        Err((403, tr!("il file non è nella cartella del progetto", "the file is not inside the project folder")))
    }
}

/// The part of the file a `Range` header asks for: `Some((first, last))`, `None` for the whole file.
/// `Err`: the range cannot be satisfied.
fn range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Ok(None) };
    // One range is served; several, or what is not understood, get the whole file.
    let Some((from, to)) = spec.split_once('-').filter(|_| !spec.contains(',')) else { return Ok(None) };
    let last = len.saturating_sub(1);
    let (first, end) = match (from.trim().parse::<u64>(), to.trim().parse::<u64>()) {
        (Ok(a), Ok(b)) => (a, b.min(last)),
        (Ok(a), Err(_)) if to.trim().is_empty() => (a, last),
        (Err(_), Ok(n)) if from.trim().is_empty() && n > 0 => (len.saturating_sub(n), last),
        _ => return Ok(None),
    };
    if len == 0 || first > end {
        return Err(());
    }
    Ok(Some((first, end)))
}

/// Sends `path` (already checked by the caller): the whole file or the part asked with `Range`, nothing after the head
/// for `HEAD`. With `download`, the browser saves it under that name instead of showing it.
pub(crate) fn send(c: &TcpStream, head: &Head, path: &Path, download: Option<&str>) {
    let opened = File::open(path).and_then(|f| f.metadata().map(|m| (f, m.len())));
    let Ok((mut file, len)) = opened else {
        return respond(c, 404, "application/json", &crate::http::error(&tr!("il file non c'è", "the file is not there")), &[]);
    };
    let part = match range(head.header("range"), len) {
        Ok(p) => p,
        Err(()) => {
            let line = format!("Content-Range: bytes */{len}");
            return respond(c, 416, "application/json", &crate::http::error(&tr!("intervallo non valido", "range not satisfiable")), &[&line]);
        }
    };
    let (status, first, size) = match part {
        Some((a, b)) => ("206 Partial Content", a, b - a + 1),
        None => ("200 OK", 0, len),
    };
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {size}\r\nAccept-Ranges: bytes\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        mime(path)
    );
    if part.is_some() {
        h.push_str(&format!("Content-Range: bytes {first}-{}/{len}\r\n", first + size - 1));
    }
    if let Some(name) = download {
        h.push_str(&format!("Content-Disposition: attachment; filename=\"{}\"; filename*=UTF-8''{}\r\n", ascii(name), percent(name)));
    }
    h.push_str("\r\n");
    let mut c = c;
    let sent = c.write_all(h.as_bytes()).and_then(|_| {
        if head.method == "HEAD" {
            return Ok(());
        }
        file.seek(SeekFrom::Start(first))?;
        std::io::copy(&mut (&mut file).take(size), &mut c).map(|_| ())
    });
    if sent.is_ok() {
        let _ = c.flush();
    }
    finish(c);
}

/// A file name as the plain `filename=` parameter can carry it: no quotes, slashes or non-ASCII.
fn ascii(name: &str) -> String {
    name.chars().map(|ch| if ch.is_ascii_graphic() && !matches!(ch, '"' | '\\' | '/' | '%') || ch == ' ' { ch } else { '_' }).collect()
}

/// The bytes of `s` as a URL component.
pub(crate) fn percent(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_range_is_served_the_rest_is_the_whole_file() {
        assert_eq!(range(None, 100), Ok(None));
        assert_eq!(range(Some("bytes=0-9"), 100), Ok(Some((0, 9))));
        assert_eq!(range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(range(Some("bytes=50-5000"), 100), Ok(Some((50, 99))));
        assert_eq!(range(Some("bytes=0-1,5-6"), 100), Ok(None));
        assert_eq!(range(Some("lines=1-2"), 100), Ok(None));
        assert_eq!(range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(range(Some("bytes=9-3"), 100), Err(()));
        assert_eq!(range(Some("bytes=0-0"), 0), Err(()));
    }

    #[test]
    fn names_are_safe_in_the_download_header() {
        assert_eq!(ascii("Relazione \"finale\" è.docx"), "Relazione _finale_ _.docx");
        assert_eq!(percent("è b.docx"), "%C3%A8%20b.docx");
    }
}
