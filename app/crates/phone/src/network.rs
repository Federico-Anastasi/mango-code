//! The computer's addresses for the links: the home network's and Tailscale's.

use std::net::Ipv4Addr;

pub(crate) struct Addresses {
    pub home: Option<Ipv4Addr>,
    pub away: Option<Ipv4Addr>,
}

/// A network adapter that is up, as Windows gives it.
struct Adapter {
    ipv4: Vec<Ipv4Addr>,
    /// It has a gateway: it's the real network, not Hyper-V's or WSL's internal one.
    gateway: bool,
    metric: u32,
}

pub(crate) fn addresses() -> Addresses {
    choose(&adapters())
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
                out.push(Adapter { ipv4, gateway: !a.FirstGatewayAddress.is_null(), metric: a.Ipv4Metric });
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
        Adapter { ipv4: ip.iter().map(|x| x.parse().unwrap()).collect(), gateway, metric }
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
    fn without_a_network_no_links() {
        let i = choose(&[s(&["100.20.0.1"], true, 1)]); // outside 100.64.0.0/10
        assert_eq!(i.home, None);
        assert_eq!(i.away, None);
    }
}
