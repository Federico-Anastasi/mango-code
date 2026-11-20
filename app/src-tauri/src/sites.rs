//! The folders Mango Code serves as sites to its own browser panel. The agent opens a page it wrote by its file: the
//! folder of that file gets a port of its own on this computer, kept until the app quits, so the page works as on the
//! web (modules, `fetch`, links between its pages) and the model has no server to start, to stop or to find a port for.

use mango_common::tr;
use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct Sites {
    ports: Mutex<HashMap<PathBuf, u16>>,
}

impl Sites {
    /// The address of `file` (a page, or a folder that has an `index.html`) in the site of its folder. Err: the sentence
    /// for the model.
    pub fn address(&self, file: &Path) -> Result<String, String> {
        let shown = file.display();
        let real = std::fs::canonicalize(file).map_err(|_| tr!("Il file non c'è: {shown}", "The file is not there: {shown}"))?;
        let (root, page) = match (real.is_dir(), real.parent(), real.file_name().and_then(|n| n.to_str())) {
            (true, _, _) => (real.clone(), None),
            (false, Some(root), Some(name)) => (root.to_path_buf(), Some(name.to_string())),
            _ => return Err(tr!("Non è una pagina: {shown}", "Not a page: {shown}")),
        };
        let port = self.port(&root).map_err(|e| tr!("Non riesco a servire la cartella {shown}: {e}", "Cannot serve the folder {shown}: {e}"))?;
        let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
        if let (Some(name), Ok(mut segments)) = (&page, url.path_segments_mut()) {
            segments.pop_if_empty().push(name);
        }
        Ok(url.to_string())
    }

    /// The ports of all the sites opened so far.
    pub fn ports(&self) -> Vec<u16> {
        self.ports.lock().unwrap().values().copied().collect()
    }

    /// The port of the folder's site, opened the first time the folder is asked for.
    fn port(&self, root: &Path) -> std::io::Result<u16> {
        let mut ports = self.ports.lock().unwrap();
        if let Some(port) = ports.get(root) {
            return Ok(*port);
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let folder = root.to_path_buf();
        std::thread::Builder::new().name("site".into()).spawn(move || {
            for c in listener.incoming().flatten() {
                let folder = folder.clone();
                let _ = std::thread::Builder::new().name("site-request".into()).spawn(move || phone::serve_computer(&c, &folder));
            }
        })?;
        ports.insert(root.to_path_buf(), port);
        Ok(port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn get(address: &str, host: &str) -> String {
        let url = tauri::Url::parse(address).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
        write!(c, "GET {} HTTP/1.1\r\nHost: {host}\r\n\r\n", url.path()).unwrap();
        let mut reply = String::new();
        c.read_to_string(&mut reply).unwrap();
        reply
    }

    #[test]
    fn a_page_is_served_from_its_folder_on_a_port_that_stays() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<link rel=stylesheet href=style.css>home").unwrap();
        std::fs::write(dir.path().join("my page.html"), "second").unwrap();
        std::fs::write(dir.path().join("style.css"), "body{}").unwrap();
        let sites = Sites::default();

        let home = sites.address(&dir.path().join("index.html")).unwrap();
        assert!(home.starts_with("http://127.0.0.1:") && home.ends_with("/index.html"), "{home}");
        let host = home.trim_start_matches("http://").trim_end_matches("/index.html").to_string();
        assert!(get(&home, &host).ends_with("home"));
        assert!(get(&home.replace("index.html", "style.css"), &host).contains("text/css"));

        let second = sites.address(&dir.path().join("my page.html")).unwrap();
        assert_eq!(second, home.replace("index.html", "my%20page.html"));
        assert!(get(&second, &host).ends_with("second"));
        // the folder itself is its index.html
        assert_eq!(sites.address(dir.path()).unwrap(), home.replace("index.html", ""));
        assert!(get(&home.replace("index.html", ""), &host).ends_with("home"));
    }

    #[test]
    fn only_this_computer_and_only_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("site")).unwrap();
        std::fs::write(dir.path().join("site").join("index.html"), "home").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        let sites = Sites::default();
        let home = sites.address(&dir.path().join("site").join("index.html")).unwrap();
        let host = home.trim_start_matches("http://").trim_end_matches("/index.html").to_string();

        assert!(get(&home, "rebind.example.com").starts_with("HTTP/1.1 403"));
        assert!(get(&home.replace("index.html", "../secret.txt"), &host).starts_with("HTTP/1.1 404"));
        assert!(sites.address(&dir.path().join("missing.html")).is_err());
    }
}
