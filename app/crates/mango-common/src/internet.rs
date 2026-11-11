//! The app's outgoing connections: one place says how to leave (proxy and certificates) and how to explain a failure.
//! Every HTTP call of the app starts from `config` or `agent`: Windows' certificates, and the proxy that Windows (or the
//! `HTTPS_PROXY` / `NO_PROXY` variables) names for that address. Calls to this computer and to the local network
//! (`127.0.0.1`, `localhost`, `192.168.x.x`, Tailscale's `100.x`) never go through a proxy.

use crate::tr;
use std::net::IpAddr;
use std::time::Duration;
use ureq::config::ConfigBuilder;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
use ureq::typestate::AgentScope;
use ureq::{Agent, Proxy};

/// Where the proxy to use is read from: environment variables and Windows' settings. The tests give fake ones.
pub(crate) struct Sources<'a> {
    pub var: &'a dyn Fn(&str) -> Option<String>,
    pub system: &'a dyn Fn(&str) -> Option<String>,
}

fn real_var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

#[cfg(test)]
thread_local! {
    /// The tests that go through functions that take no `Sources` (a download, a report) name here this thread's fake Windows proxy; the environment variables don't count.
    static FAKE_SYSTEM_PROXY: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Runs `f` with this as the Windows proxy (and no proxy variable), in this thread only.
#[cfg(test)]
pub(crate) fn with_system_proxy<R>(proxy: &str, f: impl FnOnce() -> R) -> R {
    FAKE_SYSTEM_PROXY.with(|p| *p.borrow_mut() = Some(proxy.to_owned()));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    FAKE_SYSTEM_PROXY.with(|p| *p.borrow_mut() = None);
    result.unwrap_or_else(|e| std::panic::resume_unwind(e))
}

fn with_real_sources<R>(f: impl FnOnce(&Sources) -> R) -> R {
    #[cfg(test)]
    if let Some(proxy) = FAKE_SYSTEM_PROXY.with(|p| p.borrow().clone()) {
        return f(&Sources { var: &|_| None, system: &|_| Some(proxy.clone()) });
    }
    f(&Sources { var: &real_var, system: &windows_proxy })
}

/// The start of every HTTP agent of the app: the caller adds the timeouts and builds.
pub fn config(url: &str) -> ConfigBuilder<AgentScope> {
    with_real_sources(|sources| config_with(url, sources))
}

pub(crate) fn config_with(url: &str, sources: &Sources) -> ConfigBuilder<AgentScope> {
    let proxy = proxy_for_with(url, sources).and_then(|p| Proxy::new(&p).ok());
    let tls = TlsConfig::builder().provider(TlsProvider::Rustls).root_certs(RootCerts::PlatformVerifier).build();
    Agent::config_builder().proxy(proxy).tls_config(tls)
}

/// An agent whose whole round (connect, ask, receive) lasts at most `timeout`. Status errors (4xx, 5xx) are errors.
pub fn agent(url: &str, timeout: Duration) -> Agent {
    Agent::new_with_config(config(url).timeout_global(Some(timeout)).build())
}

/// Like `agent`, but an error status is a reply to read, not an error: for a server whose error replies matter.
pub fn agent_with_replies(url: &str, timeout: Duration) -> Agent {
    Agent::new_with_config(config(url).timeout_global(Some(timeout)).http_status_as_error(false).build())
}

/// The proxy for this address (`http://host:port`), if there is one.
pub fn proxy_for(url: &str) -> Option<String> {
    with_real_sources(|sources| proxy_for_with(url, sources))
}

fn proxy_for_with(url: &str, sources: &Sources) -> Option<String> {
    let (https, host) = split_url(url)?;
    if is_local(&host) {
        return None;
    }
    if (sources.var)("NO_PROXY").or_else(|| (sources.var)("no_proxy")).is_some_and(|list| excluded(&host, &list)) {
        return None;
    }
    let names: &[&str] = if https { &["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] } else { &["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] };
    if let Some(proxy) = names.iter().find_map(|n| (sources.var)(n)) {
        return Some(with_scheme(&proxy));
    }
    (sources.system)(url)
}

/// What the program the app starts needs to leave through the same proxy as the app: the agent (Bun) and the servers it starts read only
/// `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, never Windows' settings. Nothing is added if the user's environment already names a proxy (the
/// program inherits it) or Windows has none. Without `NO_PROXY` Bun sends even `127.0.0.1` to the proxy, and the agent could not reach the
/// engine: it covers this computer, the local network (Bun reads address ranges) and the engine's own address, which can be another PC's.
pub fn child_proxy_env(engine_url: &str) -> Vec<(String, String)> {
    with_real_sources(|sources| child_proxy_env_with(engine_url, sources))
}

fn child_proxy_env_with(engine_url: &str, sources: &Sources) -> Vec<(String, String)> {
    const NAMES: [&str; 6] = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
    if NAMES.iter().any(|n| (sources.var)(n).is_some()) {
        return Vec::new();
    }
    // Windows answers per address (an auto-configuration script can): any one address stands for the sites the agent opens.
    let (plain, secure) = (proxy_for_with("http://example.com/", sources), proxy_for_with("https://example.com/", sources));
    if plain.is_none() && secure.is_none() {
        return Vec::new();
    }
    let mut local = ["localhost", "127.0.0.0/8", "[::1]", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"].join(",");
    if let Some((_, host)) = split_url(engine_url) {
        local = format!("{local},{host}");
    }
    let no_proxy = match (sources.var)("NO_PROXY").or_else(|| (sources.var)("no_proxy")) {
        Some(theirs) => format!("{theirs},{local}"),
        None => local,
    };
    let mut vars = vec![("NO_PROXY".to_owned(), no_proxy)];
    vars.extend(plain.map(|p| ("HTTP_PROXY".to_owned(), p)));
    vars.extend(secure.map(|p| ("HTTPS_PROXY".to_owned(), p)));
    vars
}

/// Is the address https, and its lowercase host (without the brackets of an IPv6 one).
fn split_url(url: &str) -> Option<(bool, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => host_port.split(':').next()?,
    };
    (!host.is_empty()).then(|| (scheme.eq_ignore_ascii_case("https"), host.to_ascii_lowercase()))
}

/// This computer or its local network: never through the proxy (a company proxy can't reach a home network, and the app's own servers are here).
fn is_local(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        // 100.64.0.0/10 is where Tailscale puts the computers of the user's own network.
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local() || (ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        Err(_) => false,
    }
}

/// Is `host` in the list of those that skip the proxy? The list is `NO_PROXY`'s (comma separated) or Windows' (semicolons): `*`, `<local>` (names without dots),
/// whole names (they cover their subdomains too), `.domain`, and patterns with `*` like `10.*`.
fn excluded(host: &str, list: &str) -> bool {
    list.split([',', ';', ' ']).map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty()).any(|entry| {
        let entry = entry.split_once("://").map_or(entry.as_str(), |(_, rest)| rest);
        let entry = entry.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map_or(entry, |(name, _)| name);
        match entry {
            "*" => true,
            "<local>" => !host.contains('.'),
            _ if entry.contains('*') => matches_pattern(entry, host),
            _ => host == entry.trim_start_matches('.') || host.ends_with(&format!(".{}", entry.trim_start_matches('.'))),
        }
    })
}

/// Does the pattern with `*` (any sequence) match all of `text`?
fn matches_pattern(pattern: &str, text: &str) -> bool {
    let pieces: Vec<&str> = pattern.split('*').collect();
    let (first, last) = (pieces[0], pieces[pieces.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut rest = &text[first.len()..text.len() - last.len()];
    for piece in &pieces[1..pieces.len() - 1] {
        match rest.find(piece) {
            Some(i) => rest = &rest[i + piece.len()..],
            None => return false,
        }
    }
    true
}

fn with_scheme(proxy: &str) -> String {
    if proxy.contains("://") { proxy.to_owned() } else { format!("http://{proxy}") }
}

/// From Windows' proxy list (`host:port`, or `http=a:1;https=b:2`, sometimes several) the entry for the address' scheme; SOCKS ones aren't used.
fn entry_for(list: &str, scheme: &str) -> Option<String> {
    let entries: Vec<&str> = list.split([';', ' ']).map(str::trim).filter(|v| !v.is_empty()).collect();
    let of_scheme = entries.iter().find_map(|v| v.split_once('=').filter(|(name, _)| name.eq_ignore_ascii_case(scheme)).map(|(_, value)| value));
    let plain = entries.iter().find(|v| !v.contains('=') || v.contains("://")).copied();
    of_scheme.or(plain).map(with_scheme)
}

/// Windows' proxy settings for this user, for this address: the auto-configuration script or the detection (WinHTTP resolves it), otherwise the manual proxy with its exclusion list.
#[cfg(windows)]
fn windows_proxy(url: &str) -> Option<String> {
    // Debug builds: the integration tests give the app a Windows proxy without touching the computer's settings.
    if cfg!(debug_assertions) {
        if let Some(fake) = real_var("MANGO_WINDOWS_PROXY") {
            return Some(with_scheme(&fake));
        }
    }
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows::Win32::Networking::WinHttp::*;

    fn text(p: PWSTR) -> Option<String> {
        // SAFETY: WinHTTP gives zero-terminated strings, or null.
        (!p.is_null()).then(|| unsafe { p.to_string().ok() }).flatten()
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    let (https, host) = split_url(url)?;
    let scheme = if https { "https" } else { "http" };
    // SAFETY: the structures start zeroed and WinHTTP fills them; the strings WinHTTP allocates are freed once with GlobalFree, after being copied.
    unsafe {
        let mut settings = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        WinHttpGetIEProxyConfigForCurrentUser(&mut settings).ok()?;
        let (detect, script, manual, bypass) = (settings.fAutoDetect.as_bool(), text(settings.lpszAutoConfigUrl), text(settings.lpszProxy), text(settings.lpszProxyBypass));
        for p in [settings.lpszAutoConfigUrl, settings.lpszProxy, settings.lpszProxyBypass] {
            if !p.is_null() {
                let _ = GlobalFree(HGLOBAL(p.0.cast()));
            }
        }

        if detect || script.is_some() {
            let session = WinHttpOpen(w!("Mango Code"), WINHTTP_ACCESS_TYPE_NO_PROXY, PCWSTR::null(), PCWSTR::null(), 0);
            if !session.is_null() {
                let script_wide = script.as_deref().map(wide);
                let mut options = WINHTTP_AUTOPROXY_OPTIONS { fAutoLogonIfChallenged: true.into(), ..Default::default() };
                if detect {
                    options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
                    options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
                }
                if let Some(s) = &script_wide {
                    options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
                    options.lpszAutoConfigUrl = PCWSTR(s.as_ptr());
                }
                let address = wide(url);
                let mut info = WINHTTP_PROXY_INFO::default();
                let ok = WinHttpGetProxyForUrl(session, PCWSTR(address.as_ptr()), &mut options, &mut info).is_ok();
                let answer = ok.then(|| (info.dwAccessType, text(info.lpszProxy)));
                for p in [info.lpszProxy, info.lpszProxyBypass] {
                    if !p.is_null() {
                        let _ = GlobalFree(HGLOBAL(p.0.cast()));
                    }
                }
                let _ = WinHttpCloseHandle(session);
                // The script answered: its word counts, even when it says "direct".
                if let Some((kind, list)) = answer {
                    return if kind == WINHTTP_ACCESS_TYPE_NAMED_PROXY { list.and_then(|l| entry_for(&l, scheme)) } else { None };
                }
            }
        }

        if bypass.as_deref().is_some_and(|b| excluded(&host, b)) {
            return None;
        }
        manual.and_then(|m| entry_for(&m, scheme))
    }
}

#[cfg(not(windows))]
fn windows_proxy(_: &str) -> Option<String> {
    None
}

/// Did the connection fail because the certificate of the server (or of a filter in between) isn't accepted by Windows? True for `ureq` errors and for any error that carries one in its causes.
pub fn is_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    // From the encrypted connection the certificate error arrives inside an I/O error.
    fn about_trust(e: &(dyn std::error::Error + 'static)) -> bool {
        match (e.downcast_ref::<rustls::Error>(), e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref())) {
            (Some(r), _) => matches!(r, rustls::Error::InvalidCertificate(_)),
            (None, Some(inner)) => inner.downcast_ref::<rustls::Error>().is_some_and(|r| matches!(r, rustls::Error::InvalidCertificate(_))),
            _ => false,
        }
    }
    let mut current = Some(error);
    while let Some(e) = current {
        let inside_ureq: Option<&(dyn std::error::Error + 'static)> = match e.downcast_ref::<ureq::Error>() {
            Some(ureq::Error::Io(io)) => Some(io),
            Some(ureq::Error::Rustls(r)) => Some(r),
            _ => None,
        };
        if about_trust(e) || inside_ureq.is_some_and(about_trust) {
            return true;
        }
        current = e.source();
    }
    false
}

/// The sentence for the user when a certificate isn't accepted.
pub fn certificate_message() -> String {
    tr!(
        "La rete di questo computer passa da un filtro aziendale: il certificato che presenta non è tra quelli che Windows accetta. Chiedi a chi gestisce il computer di installare in Windows il certificato dell'azienda (Mango Code usa quelli di Windows), oppure riprova da un'altra rete.",
        "This computer's network goes through a company filter: the certificate it presents is not among those Windows accepts. Ask whoever manages the computer to install the company certificate in Windows (Mango Code uses Windows's own), or try again from another network."
    )
}

/// A sentence for the user when the network fails because of the proxy or of a certificate Windows doesn't know; `None` for any other error.
pub fn explain(error: &ureq::Error, url: &str) -> Option<String> {
    explain_with(error, url, proxy_for(url))
}

fn explain_with(error: &ureq::Error, url: &str, proxy: Option<String>) -> Option<String> {
    if is_certificate_error(error) {
        return Some(certificate_message());
    }
    let host = split_url(url).map_or_else(|| url.to_owned(), |(_, h)| h);
    let proxy = proxy.map(|p| p.trim_start_matches("http://").trim_end_matches('/').to_owned());
    match (error, proxy) {
        (ureq::Error::ConnectProxyFailed(_), Some(proxy)) => Some(tr!(
            "Il proxy di questo computer ({proxy}) ha rifiutato la connessione a {host}: forse chiede nome utente e password, o non lascia passare questo sito. Chiedi a chi gestisce la rete di far passare {host}, oppure riprova da un'altra rete.",
            "This computer's proxy ({proxy}) refused the connection to {host}: it may ask for a user name and password, or not allow this site. Ask whoever manages the network to let {host} through, or try again from another network."
        )),
        (ureq::Error::Io(_) | ureq::Error::Timeout(_) | ureq::Error::HostNotFound | ureq::Error::ConnectionFailed, Some(proxy)) => Some(tr!(
            "Non riesco a raggiungere {host} passando dal proxy di questo computer ({proxy}). Controlla le impostazioni proxy di Windows, oppure riprova da un'altra rete.",
            "I can't reach {host} through this computer's proxy ({proxy}). Check Windows's proxy settings, or try again from another network."
        )),
        _ => None,
    }
}

/// The error of a failed HTTP call: the sentence about the proxy or the certificate when that is the cause, otherwise the generic one with the technical detail.
pub fn network_failure(error: ureq::Error, url: &str) -> anyhow::Error {
    match explain(&error, url) {
        Some(message) => anyhow::anyhow!("{message}"),
        None => crate::network_error(error),
    }
}

#[cfg(test)]
#[path = "internet/fake_proxy.rs"]
pub(crate) mod fake_proxy;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{lang, Lang};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};

    fn vars<'a>(map: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        move |n| map.get(n).map(|v| (*v).to_owned())
    }

    fn proxy(url: &str, variables: &[(&str, &str)], system: Option<&str>) -> Option<String> {
        let map: HashMap<_, _> = variables.iter().copied().collect();
        let var = vars(&map);
        let sys = |_: &str| system.map(str::to_owned);
        proxy_for_with(url, &Sources { var: &var, system: &sys })
    }

    fn child_env(engine: &str, variables: &[(&str, &str)], system: Option<&str>) -> HashMap<String, String> {
        let map: HashMap<_, _> = variables.iter().copied().collect();
        let var = vars(&map);
        let sys = |_: &str| system.map(str::to_owned);
        child_proxy_env_with(engine, &Sources { var: &var, system: &sys }).into_iter().collect()
    }

    #[test]
    fn the_agent_gets_windows_proxy_and_never_sends_the_engine_through_it() {
        let env = child_env("http://192.168.1.20:47431", &[], Some("http://proxy.company:8080"));
        assert_eq!(env["HTTP_PROXY"], "http://proxy.company:8080");
        assert_eq!(env["HTTPS_PROXY"], "http://proxy.company:8080");
        let covered: Vec<&str> = env["NO_PROXY"].split(',').collect();
        for must in ["localhost", "127.0.0.0/8", "192.168.0.0/16", "100.64.0.0/10", "192.168.1.20"] {
            assert!(covered.contains(&must), "{must} in {covered:?}");
        }
        // the engine can be reached by a name too (Tailscale)
        assert!(child_env("http://pc-fisso.tailnet.ts.net:47431", &[], Some("http://p:1"))["NO_PROXY"].ends_with(",pc-fisso.tailnet.ts.net"));
    }

    #[test]
    fn nothing_is_added_when_the_user_names_a_proxy_or_windows_has_none() {
        assert!(child_env("http://127.0.0.1:1", &[("HTTPS_PROXY", "mine:1")], Some("windows:1")).is_empty());
        assert!(child_env("http://127.0.0.1:1", &[("http_proxy", "mine:1")], None).is_empty());
        assert!(child_env("http://127.0.0.1:1", &[], None).is_empty());
        // only NO_PROXY from the user: kept, with ours after it
        let env = child_env("http://127.0.0.1:1", &[("NO_PROXY", "intranet.corp")], Some("windows:1"));
        assert!(env["NO_PROXY"].starts_with("intranet.corp,localhost,"), "{}", env["NO_PROXY"]);
    }

    #[test]
    fn without_a_proxy_it_leaves_directly() {
        assert_eq!(proxy("https://huggingface.co/x", &[], None), None);
    }

    #[test]
    fn windows_proxy_applies_when_there_are_no_variables() {
        assert_eq!(proxy("https://huggingface.co/x", &[], Some("http://proxy.company:8080")).as_deref(), Some("http://proxy.company:8080"));
    }

    #[test]
    fn variables_win_over_windows_and_each_one_for_its_scheme() {
        let v = [("HTTPS_PROXY", "secure.company:3128"), ("HTTP_PROXY", "http://plain.company:3129")];
        assert_eq!(proxy("https://huggingface.co/x", &v, Some("http://windows:1")).as_deref(), Some("http://secure.company:3128"));
        assert_eq!(proxy("http://example.com/x", &v, Some("http://windows:1")).as_deref(), Some("http://plain.company:3129"));
        assert_eq!(proxy("https://huggingface.co/x", &[("ALL_PROXY", "all.company:1")], None).as_deref(), Some("http://all.company:1"));
    }

    #[test]
    fn toward_this_computer_and_the_local_network_the_proxy_is_never_used() {
        let v = [("ALL_PROXY", "http://proxy.company:8080")];
        for url in [
            "http://127.0.0.1:47431/api",
            "http://localhost:8080/",
            "http://[::1]:9/",
            "http://127.9.9.9/x",
            "https://app.localhost/",
            "http://192.168.1.20:8000/v1",
            "http://10.0.0.5/x",
            "http://172.16.3.4/x",
            "http://169.254.1.1/x",
            "http://[fd12::1]/x",
            "http://100.101.102.103:8000/x",
            "http://user:pw@127.0.0.1:1/x",
        ] {
            assert_eq!(proxy(url, &v, Some("http://windows:1")), None, "{url}");
        }
        assert!(proxy("http://172.32.0.1/x", &v, None).is_some(), "172.32 is not private");
        assert!(proxy("http://100.128.0.1/x", &v, None).is_some(), "100.128 is not Tailscale's");
    }

    #[test]
    fn no_proxy_excludes_the_listed_hosts_and_their_subdomains() {
        let v = [("HTTPS_PROXY", "http://proxy.company:8080"), ("NO_PROXY", "internal.company, .cdn.example.com,203.0.113.*")];
        assert_eq!(proxy("https://internal.company/x", &v, None), None);
        assert_eq!(proxy("https://models.internal.company/x", &v, None), None);
        assert_eq!(proxy("https://a.cdn.example.com/x", &v, None), None);
        assert_eq!(proxy("https://203.0.113.9/x", &v, None), None);
        assert_eq!(proxy("https://huggingface.co/x", &v, None).as_deref(), Some("http://proxy.company:8080"));
        // NO_PROXY counts for Windows' proxy too.
        assert_eq!(proxy("https://internal.company/x", &[("no_proxy", "internal.company")], Some("http://windows:1")), None);
    }

    #[test]
    fn windows_exclusion_list_says_what_skips_the_proxy() {
        assert!(excluded("printer", "<local>"));
        assert!(!excluded("huggingface.co", "<local>"));
        assert!(excluded("site.internal.company", "*.company;<local>"));
        assert!(excluded("192.168.1.5", "10.*;192.168.*"));
        assert!(!excluded("192.169.1.5", "10.*;192.168.*"));
        assert!(excluded("anything.it", "*"));
        assert!(excluded("example.com", "https://example.com:443"));
        assert!(!excluded("example.com", ""));
        assert!(matches_pattern("a*c*e", "abcde") && !matches_pattern("a*c*e", "abde") && matches_pattern("*", "x"));
    }

    #[test]
    fn from_windows_list_the_entry_of_the_scheme_is_taken() {
        assert_eq!(entry_for("proxy.company:8080", "https").as_deref(), Some("http://proxy.company:8080"));
        assert_eq!(entry_for("http=a:1;https=b:2;ftp=c:3", "https").as_deref(), Some("http://b:2"));
        assert_eq!(entry_for("http=a:1;https=b:2", "http").as_deref(), Some("http://a:1"));
        assert_eq!(entry_for("http=a:1", "https"), None);
        assert_eq!(entry_for("socks=s:1080", "https"), None);
        assert_eq!(entry_for("a:1 b:2", "https").as_deref(), Some("http://a:1"));
        assert_eq!(entry_for("https://secure:443", "https").as_deref(), Some("https://secure:443"));
    }

    /// A company server, fake: answers `hello` to any request.
    fn origin() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
            }
        });
        address
    }

    fn get_with(url: &str, variables: &[(&str, &str)], system: Option<&str>) -> Result<String, ureq::Error> {
        let map: HashMap<_, _> = variables.iter().copied().collect();
        let var = vars(&map);
        let sys = |_: &str| system.map(str::to_owned);
        let agent = Agent::new_with_config(config_with(url, &Sources { var: &var, system: &sys }).timeout_global(Some(Duration::from_secs(10))).build());
        agent.get(url).call()?.into_body().read_to_string()
    }

    #[test]
    fn a_download_from_an_external_host_goes_through_the_configured_proxy() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Forward(origin()));
        assert_eq!(get_with("http://downloads.example.test:8080/file", &[], Some(&proxy.address)).unwrap(), "hello");
        assert_eq!(proxy.seen(), ["CONNECT downloads.example.test:8080 HTTP/1.1"]);
        // The same with the proxy in the environment variables.
        let other = fake_proxy::FakeProxy::start(fake_proxy::Mode::Forward(origin()));
        assert_eq!(get_with("http://downloads.example.test/file", &[("HTTP_PROXY", &other.address)], None).unwrap(), "hello");
        assert_eq!(other.seen(), ["CONNECT downloads.example.test:80 HTTP/1.1"]);
    }

    #[test]
    fn a_call_to_this_computer_does_not_go_through_the_proxy() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Refuse(502));
        let port = origin().port();
        for host in ["127.0.0.1", "localhost"] {
            let url = format!("http://{host}:{port}/health");
            assert_eq!(get_with(&url, &[("ALL_PROXY", &proxy.address)], Some(&proxy.address)).unwrap(), "hello", "{host}");
        }
        assert!(proxy.seen().is_empty(), "{:?}", proxy.seen());
    }

    #[test]
    fn no_proxy_keeps_a_host_out_of_the_proxy() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Refuse(502));
        // The name doesn't exist: if it doesn't go through the proxy, the error is the DNS' and the proxy sees nothing.
        let result = get_with("http://missing.example.invalid/x", &[("HTTP_PROXY", &proxy.address), ("NO_PROXY", "example.invalid")], None);
        assert!(result.is_err());
        assert!(proxy.seen().is_empty(), "{:?}", proxy.seen());
    }

    #[test]
    fn a_certificate_from_a_root_this_computer_does_not_know_is_refused_with_the_right_sentence() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Inspect);
        let url = "https://downloads.example.test/file";
        let error = get_with(url, &[], Some(&proxy.address)).unwrap_err();
        assert!(is_certificate_error(&error), "{error:?}");
        let message = explain_with(&error, url, Some(proxy.address.clone())).unwrap();
        let expected = if lang() == Lang::It { "La rete di questo computer passa da un filtro aziendale" } else { "This computer's network goes through a company filter" };
        assert!(message.starts_with(expected), "{message}");
    }

    #[test]
    fn a_proxy_that_refuses_says_which_one() {
        let proxy = fake_proxy::FakeProxy::start(fake_proxy::Mode::Refuse(407));
        let url = "http://downloads.example.test/file";
        let error = get_with(url, &[], Some(&proxy.address)).unwrap_err();
        let message = explain_with(&error, url, Some(proxy.address.clone())).unwrap();
        assert!(message.contains("127.0.0.1:") && message.contains("downloads.example.test"), "{message}");
        assert!(message.contains(if lang() == Lang::It { "ha rifiutato" } else { "refused" }), "{message}");
    }

    #[test]
    fn an_unreachable_proxy_is_not_taken_for_a_site_that_does_not_answer() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let proxy = format!("http://127.0.0.1:{port}");
        let url = "http://downloads.example.test/file";
        let error = get_with(url, &[], Some(&proxy)).unwrap_err();
        let message = explain_with(&error, url, Some(proxy.clone())).unwrap();
        assert!(message.contains(if lang() == Lang::It { "passando dal proxy" } else { "through this computer's proxy" }), "{message}");
        // Without a proxy, any other network error has no sentence of its own.
        assert_eq!(explain_with(&error, url, None), None);
    }

    #[test]
    fn windows_proxy_settings_are_read_without_errors() {
        // Reads only: whatever this computer has, there is an answer and it has the shape of an address.
        let answer = windows_proxy("https://huggingface.co/");
        assert!(answer.as_ref().is_none_or(|p| Proxy::new(p).is_ok()), "{answer:?}");
    }
}
