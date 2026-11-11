//! The computer's addresses for the links: the home network's and Tailscale's. The services that open a port for the user's
//! other devices (the phone, the shared engine) listen only on these, never on all the networks (`reconcile`).

use std::net::{Ipv4Addr, TcpListener};

pub struct Addresses {
    pub home: Option<Ipv4Addr>,
    pub away: Option<Ipv4Addr>,
}

impl Addresses {
    /// The addresses to listen on.
    pub fn all(&self) -> Vec<Ipv4Addr> {
        self.home.into_iter().chain(self.away).collect()
    }
}

/// A network adapter that is up, as Windows gives it.
struct Adapter {
    /// Its GUID, lower case and without braces.
    id: String,
    ipv4: Vec<Ipv4Addr>,
    /// It has a gateway: it's the real network, not Hyper-V's or WSL's internal one.
    gateway: bool,
    metric: u32,
}

pub fn addresses() -> Addresses {
    choose(&adapters())
}

/// One port on each of the `wanted` addresses: opens it where it is missing, closes it where the address is gone (the Wi-Fi
/// changes them). It returns the sentence for an address where the port did not open, if there is one.
pub fn reconcile(listeners: &mut Vec<(Ipv4Addr, TcpListener)>, wanted: &[Ipv4Addr], port: u16) -> Option<String> {
    use crate::tr;
    listeners.retain(|(ip, _)| wanted.contains(ip));
    let mut error = None;
    for ip in wanted {
        if listeners.iter().any(|(x, _)| x == ip) {
            continue;
        }
        // Non-blocking, to notice that the service closes without a fake connection.
        match TcpListener::bind((*ip, port)).and_then(|l| l.set_nonblocking(true).map(|()| l)) {
            Ok(l) => listeners.push((*ip, l)),
            Err(e) => {
                error = Some(tr!(
                    "La porta {port} non si apre su {ip}: {e}. Forse la usa già un altro programma.",
                    "Port {port} does not open on {ip}: {e}. Another program may be using it."
                ));
            }
        }
    }
    error
}

/// Windows calls the network of this address public (a café's, a hotel's): there the home's rules do not hold, and whoever
/// is on it can read what travels in the clear. Unknown (the address is not any adapter's, Windows does not answer): no.
pub fn is_public(ip: Ipv4Addr) -> bool {
    // Development builds: the warning can be seen without changing the category of the network.
    if cfg!(debug_assertions) && std::env::var_os("MANGO_NETWORK_PUBLIC").is_some() {
        return true;
    }
    let Some(adapter) = adapters().into_iter().find(|a| a.ipv4.contains(&ip)) else { return false };
    match connected_networks(true) {
        Ok(public) => public.contains(&adapter.id),
        Err(e) => {
            eprintln!("network category not read: {e}");
            false
        }
    }
}

/// The adapters (their `Adapter::id`) of the connected networks: only the public ones, or all.
fn connected_networks(only_public: bool) -> windows::core::Result<Vec<String>> {
    use windows::Win32::Networking::NetworkListManager::{
        INetworkListManager, NetworkListManager, NLM_ENUM_NETWORK_CONNECTED, NLM_NETWORK_CATEGORY_PUBLIC,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

    // SAFETY: plain COM calls, on the thread that makes them; the interfaces are released before `CoUninitialize`.
    unsafe {
        // Already initialized in another mode on this thread: COM works all the same, and it is not ours to close.
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let found = (|| {
            let list: INetworkListManager = CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL)?;
            let networks = list.GetNetworks(NLM_ENUM_NETWORK_CONNECTED)?;
            let mut public = Vec::new();
            loop {
                let (mut item, mut count) = ([None], 0);
                networks.Next(&mut item, Some(&mut count))?;
                let Some(network) = item[0].take().filter(|_| count == 1) else { return Ok(public) };
                if only_public && network.GetCategory()? != NLM_NETWORK_CATEGORY_PUBLIC {
                    continue;
                }
                let connections = network.GetNetworkConnections()?;
                loop {
                    let (mut item, mut count) = ([None], 0);
                    connections.Next(&mut item, Some(&mut count))?;
                    let Some(connection) = item[0].take().filter(|_| count == 1) else { break };
                    let g = connection.GetAdapterId()?;
                    public.push(format!(
                        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                        g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6], g.data4[7]
                    ));
                }
            }
        })();
        if initialized {
            CoUninitialize();
        }
        found
    }
}

/// Home: a private address (10/8, 172.16/12, 192.168/16) of an adapter with a gateway, the one Windows uses most
/// (lowest metric). Away: a Tailscale address (100.64.0.0/10), on any adapter.
fn choose(adapters: &[Adapter]) -> Addresses {
    let tailscale = |ip: &Ipv4Addr| ip.octets()[0] == 100 && (ip.octets()[1] & 0xC0) == 64;
    let away = adapters.iter().flat_map(|s| &s.ipv4).find(|ip| tailscale(ip)).copied();
    let home = adapters
        .iter()
        .filter(|s| s.gateway)
        .flat_map(|s| s.ipv4.iter().filter(|ip| ip.is_private()).map(move |ip| (s.metric, *ip)))
        .min_by_key(|(m, _)| *m)
        .map(|(_, ip)| ip);
    Addresses { home, away }
}

fn adapters() -> Vec<Adapter> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
        IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    // The memory is aligned like the structure: u64 is enough.
    let mut buf: Vec<u64> = Vec::new();
    for _ in 0..3 {
        buf = vec![0u64; (size as usize).div_ceil(8)];
        let r = unsafe { GetAdaptersAddresses(AF_INET as u32, flags, std::ptr::null(), buf.as_mut_ptr().cast(), &mut size) };
        match r {
            NO_ERROR => break,
            ERROR_BUFFER_OVERFLOW => continue,
            _ => return Vec::new(),
        }
    }
    let mut out = Vec::new();
    let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    // SAFETY: Windows wrote a list of adapters in the buffer, which lives until the end of the function.
    unsafe {
        while !p.is_null() {
            let a = &*p;
            if a.OperStatus == IfOperStatusUp {
                let mut ipv4 = Vec::new();
                let mut u = a.FirstUnicastAddress;
                while !u.is_null() {
                    let sa = (*u).Address.lpSockaddr;
                    if !sa.is_null() && (*sa).sa_family == AF_INET {
                        let sin = &*(sa as *const SOCKADDR_IN);
                        ipv4.push(Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr)));
                    }
                    u = (*u).Next;
                }
                let id = std::ffi::CStr::from_ptr(a.AdapterName.cast()).to_string_lossy().trim_matches(['{', '}']).to_lowercase();
                out.push(Adapter { id, ipv4, gateway: !a.FirstGatewayAddress.is_null(), metric: a.Ipv4Metric });
            }
            p = a.Next;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ip: &[&str], gateway: bool, metric: u32) -> Adapter {
        Adapter { id: String::new(), ipv4: ip.iter().map(|x| x.parse().unwrap()).collect(), gateway, metric }
    }

    #[test]
    fn home_is_the_real_network_away_is_tailscale() {
        let adapters = [
            s(&["172.22.0.1"], false, 5),           // WSL, without a gateway
            s(&["100.88.1.2"], false, 5),           // Tailscale
            s(&["192.168.1.20"], true, 35),         // Wi-Fi
            s(&["10.0.0.7"], true, 25),             // cable, the most used
            s(&["169.254.3.4", "8.8.4.4"], true, 1), // neither private nor Tailscale
        ];
        let i = choose(&adapters);
        assert_eq!(i.home, Some("10.0.0.7".parse().unwrap()));
        assert_eq!(i.away, Some("100.88.1.2".parse().unwrap()));
    }

    #[test]
    fn ports_open_only_on_the_wanted_addresses_and_follow_them() {
        let port = crate::random_port().unwrap();
        let (here, other): (Ipv4Addr, Ipv4Addr) = ("127.0.0.1".parse().unwrap(), "127.0.0.2".parse().unwrap());
        let mut listeners = Vec::new();

        assert_eq!(reconcile(&mut listeners, &[here], port), None);
        assert!(std::net::TcpStream::connect((here, port)).is_ok());
        // a port on all the networks would answer on every address of the computer
        assert!(std::net::TcpStream::connect((other, port)).is_err(), "the port must not be open on the other addresses");

        assert_eq!(reconcile(&mut listeners, &[other], port), None);
        assert_eq!(listeners.iter().map(|(ip, _)| *ip).collect::<Vec<_>>(), vec![other]);
        assert!(std::net::TcpStream::connect((here, port)).is_err(), "the address that is gone is closed");

        let busy = std::net::TcpListener::bind((here, 0)).unwrap();
        let error = reconcile(&mut listeners, &[other, here], busy.local_addr().unwrap().port()).unwrap();
        assert!(error.contains("127.0.0.1"), "{error}");
    }

    #[test]
    fn the_networks_of_windows_are_matched_to_the_adapters() {
        let all = connected_networks(false).expect("the network list of Windows can be read");
        // the adapter that has the home address is on one of the networks of the list: the ids are written the same way
        if let Some(home) = addresses().home {
            let adapter = adapters().into_iter().find(|a| a.ipv4.contains(&home)).unwrap();
            assert!(all.contains(&adapter.id), "{} not in {all:?}", adapter.id);
        }
        assert!(!is_public(Ipv4Addr::LOCALHOST), "the loopback is no network of the list");
    }

    #[test]
    fn without_a_network_no_links() {
        let i = choose(&[s(&["100.20.0.1"], true, 1)]); // outside 100.64.0.0/10
        assert_eq!(i.home, None);
        assert_eq!(i.away, None);
    }
}
