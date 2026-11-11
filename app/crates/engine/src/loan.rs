//! Who holds the GPUs on loan: the process that asked for `release`. The manager recognizes it from the connection
//! (the Windows TCP table says which process owns the client end) and keeps a handle on it: when the process
//! closes, the loan ends. The open handle also pins the process number, which Windows doesn't reassign while
//! someone holds it.

use std::net::SocketAddr;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

const AF_INET: u32 = 2;

/// A process whose end is awaited.
pub struct Process {
    pub pid: u32,
    h: HANDLE,
}

// A process handle can be used from any thread.
unsafe impl Send for Process {}
unsafe impl Sync for Process {}

impl Process {
    /// `None` if the process isn't there (already closed) or can't be followed.
    pub fn open(pid: u32) -> Option<Process> {
        let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        (!h.is_null()).then_some(Process { pid, h })
    }

    pub fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.h, 0) != WAIT_OBJECT_0 }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.h) };
    }
}

/// The process that holds the `client` end of the connection to `server` (both on 127.0.0.1).
pub fn owner_of(client: SocketAddr, server: SocketAddr) -> Option<u32> {
    let mut size: u32 = 0;
    unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) };
    // The table can grow between the two calls: some margin.
    let mut buf = vec![0u32; (size as usize / 4) + 256];
    let mut size = (buf.len() * 4) as u32;
    if unsafe { GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) } != 0 {
        return None;
    }
    let n = buf[0] as usize;
    let rows = unsafe { std::slice::from_raw_parts(buf.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), n) };
    let port = |p: u32| u16::from_be((p & 0xffff) as u16);
    rows.iter().find(|r| port(r.dwLocalPort) == client.port() && port(r.dwRemotePort) == server.port()).map(|r| r.dwOwningPid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    #[test]
    fn recognizes_the_process_at_the_other_end_of_the_connection() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let c = std::net::TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (s, client) = l.accept().unwrap();
        assert_eq!(owner_of(client, s.local_addr().unwrap()), Some(std::process::id()));
        drop(c);
    }

    #[test]
    fn follows_the_end_of_a_process() {
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // DETACHED_PROCESS: no console at all. With CREATE_NO_WINDOW Windows still starts one, and killing the
            // process while it starts leaves a terminal window open on the screen with an error.
            .creation_flags(0x0000_0008)
            .spawn().unwrap();
        let p = Process::open(child.id()).unwrap();
        assert!(p.alive());
        child.kill().unwrap();
        let _ = child.wait();
        assert!(!p.alive());
    }
}
