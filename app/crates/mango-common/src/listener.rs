//! Who listens on a local port: a server that answers on a port is the program the app started only if its process is one
//! of the app's own, and another program may take the port between the choice of it and the bind.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER};

const AF_INET: u32 = 2;

/// The process that answers a connection to `127.0.0.1:port`: the listener bound to that address, which Windows prefers to
/// one bound to every address. `None` when nothing listens there.
pub fn loopback_listener(port: u16) -> std::io::Result<Option<u32>> {
    let mut size: u32 = 0;
    unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) };
    // The table can grow between the two calls: some margin, and a few more tries when it still does.
    for _ in 0..5 {
        let mut buf = vec![0u32; (size as usize / 4) + 256];
        let mut given = (buf.len() * 4) as u32;
        match unsafe { GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut given, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) } {
            0 => {
                let rows = unsafe { std::slice::from_raw_parts(buf.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), buf[0] as usize) };
                let on_port: Vec<(Ipv4Addr, u32)> = rows
                    .iter()
                    .filter(|row| u16::from_be((row.dwLocalPort & 0xffff) as u16) == port)
                    .map(|row| (Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()), row.dwOwningPid))
                    .collect();
                return Ok(answering(&on_port));
            }
            122 => size = given + 1024,
            code => return Err(std::io::Error::from_raw_os_error(code as i32)),
        }
    }
    Err(std::io::Error::other("the table of listening ports kept growing"))
}

/// Of the listeners of one port (their address and process), the one a connection to the loopback address reaches.
fn answering(listeners: &[(Ipv4Addr, u32)]) -> Option<u32> {
    [Ipv4Addr::LOCALHOST, Ipv4Addr::UNSPECIFIED].into_iter().find_map(|address| listeners.iter().find(|(bound, _)| *bound == address).map(|(_, pid)| *pid))
}

/// Whether `pid` is `root` or one of the processes `root` started, directly or not.
pub fn descends_from(pid: u32, root: u32) -> bool {
    descends(&crate::stragglers::processes().into_iter().collect(), pid, root)
}

/// `descends_from` on a list of processes, each with its parent.
fn descends(parents: &HashMap<u32, u32>, pid: u32, root: u32) -> bool {
    let mut current = pid;
    // The chain is bounded: a parent id that was reused can close a loop.
    for _ in 0..64 {
        if current == root {
            return true;
        }
        match parents.get(&current) {
            Some(&parent) if parent != 0 => current = parent,
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn the_process_that_listens_on_the_loopback_address_is_found() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(loopback_listener(port).unwrap(), Some(std::process::id()));
        drop(listener);
        assert_eq!(loopback_listener(port).unwrap(), None, "nobody listens any more");
    }

    #[test]
    fn a_listener_of_every_address_answers_unless_one_of_the_loopback_address_exists() {
        let (all, local, other) = ((Ipv4Addr::UNSPECIFIED, 1), (Ipv4Addr::LOCALHOST, 2), (Ipv4Addr::new(192, 168, 1, 5), 3));
        assert_eq!(answering(&[all, other]), Some(1));
        assert_eq!(answering(&[all, local]), Some(2));
        assert_eq!(answering(&[other]), None, "a listener of the network card does not answer the loopback address");
        assert_eq!(answering(&[]), None);
    }

    #[test]
    fn a_process_descends_from_the_ones_that_started_it_through_any_number_of_steps() {
        let parents = HashMap::from([(4, 3), (3, 2), (2, 1), (1, 0), (10, 11), (11, 10)]);
        assert!(descends(&parents, 4, 1) && descends(&parents, 4, 3) && descends(&parents, 4, 4));
        assert!(!descends(&parents, 1, 4) && !descends(&parents, 4, 9) && !descends(&parents, 4, 0));
        assert!(!descends(&parents, 10, 1), "a parent id that was reused closes a loop: it ends");
    }

    #[test]
    fn a_process_of_the_system_descends_from_the_ones_that_started_it() {
        // a child of this process, as the other tests that start programs here: a grandchild under `cmd` ended at once
        // with code 1 on GitHub's Windows runners; the steps above one are proven by the test of `descends`
        let mut child = Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let (me, pid) = (std::process::id(), child.id());
        assert!(descends_from(pid, me), "the child is under this process");
        assert!(!descends_from(me, pid));
        assert!(descends_from(pid, pid));
        let parent = crate::stragglers::processes().into_iter().find(|&(id, _)| id == me).map(|(_, parent)| parent).unwrap();
        assert!(descends_from(pid, parent), "and under the process that started this one");
        let _ = child.kill();
        let _ = child.wait();
    }
}
