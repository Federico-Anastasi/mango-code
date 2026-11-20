//! The loopback ports the app itself listens on, which a page shown on the phone never reaches: the one place where a
//! listener of the app is written down. Whoever opens one adds its port here (`Ports::add`); the phone service asks for
//! the whole list at every call of a page (`owned`). The engines and the image engines, which come and go, keep their own
//! lists, and the folder sites (`sites.rs`) are told apart: the one the panel shows is the page itself.

use std::sync::Mutex;

/// The ports of the app's listeners that live as long as the run: the control server of the engine, the sharing of the
/// engine, the voice service, the debugging port of the browser panel and, in the tests, the one of the window.
#[derive(Default)]
pub struct Ports(Mutex<Vec<u16>>);

impl Ports {
    pub fn add(&self, port: u16) {
        let mut ports = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !ports.contains(&port) {
            ports.push(port);
        }
    }

    pub fn all(&self) -> Vec<u16> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Every port a page must not reach: `listeners`, the engines' and the image engines' ports, and every folder site except the
/// one at `shown`, the address the panel shows now (a page may call the site it comes from, not the other folders).
pub fn owned(listeners: Vec<u16>, engines: Vec<u16>, images: Vec<u16>, sites: Vec<u16>, shown: Option<&str>) -> Vec<u16> {
    let shown = shown.and_then(|url| tauri::Url::parse(url).ok()).and_then(|url| url.port());
    listeners.into_iter().chain(engines).chain(images).chain(sites.into_iter().filter(|port| Some(*port) != shown)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_of_listener_is_told_and_only_the_site_on_show_is_left_out() {
        let ports = Ports::default();
        ports.add(8195);
        ports.add(8195);
        ports.add(4097);
        assert_eq!(ports.all(), [8195, 4097]);
        let told = |shown: Option<&str>| {
            let mut told = owned(ports.all(), vec![9001], vec![9002], vec![9100, 9101], shown);
            told.sort_unstable();
            told
        };
        assert_eq!(told(None), [4097, 8195, 9001, 9002, 9100, 9101]);
        assert_eq!(told(Some("http://127.0.0.1:9100/index.html")), [4097, 8195, 9001, 9002, 9101]);
        assert_eq!(told(Some("http://localhost:3000/")), [4097, 8195, 9001, 9002, 9100, 9101]);
        assert_eq!(told(Some("file:///C:/site/index.html")), [4097, 8195, 9001, 9002, 9100, 9101]);
        assert_eq!(told(Some("not an address")), [4097, 8195, 9001, 9002, 9100, 9101]);
    }
}
