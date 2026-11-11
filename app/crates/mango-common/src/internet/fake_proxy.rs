//! An office proxy, fake: it listens on a port of this computer, records the first line of each request it gets, and then does what it is told.
//! `chain.pem` and `leaf-key.pem` are a test certificate (valid a hundred years, for `downloads.example.test`) signed by a root generated once: the root's
//! key was thrown away, nobody can make more, and the root must not be installed on any computer.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

pub(crate) enum Mode {
    /// Opens the tunnel (or passes on the plain request) to this address whatever destination was asked: like a proxy that can reach the world.
    Forward(SocketAddr),
    /// Answers every request with this status, for example 407.
    Refuse(u16),
    /// Opens the tunnel and presents a certificate signed by a root no computer knows (a filter that inspects encrypted traffic).
    Inspect,
}

pub(crate) struct FakeProxy {
    pub(crate) address: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl FakeProxy {
    pub(crate) fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let record = requests.clone();
        let mode = Arc::new(mode);
        std::thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let (record, mode) = (record.clone(), mode.clone());
                std::thread::spawn(move || serve(client, &record, &mode));
            }
        });
        FakeProxy { address, requests }
    }

    /// The first line of every request received, in order.
    pub(crate) fn seen(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn serve(client: TcpStream, record: &Mutex<Vec<String>>, mode: &Mode) {
    let mut reader = BufReader::new(client.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    record.lock().unwrap().push(first.trim().to_owned());
    let mut head = first.clone();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        head.push_str(&line);
        if line.trim().is_empty() {
            break;
        }
    }
    let mut client = client;
    match mode {
        Mode::Refuse(status) => {
            let _ = write!(client, "HTTP/1.1 {status} Proxy Authentication Required\r\nProxy-Authenticate: NTLM\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        Mode::Forward(origin) => {
            let Ok(mut up) = TcpStream::connect(origin) else { return };
            if first.starts_with("CONNECT ") {
                let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            } else {
                // A plain HTTP request handed to the proxy as it is (with the whole address): it passes it to the server.
                let _ = up.write_all(head.as_bytes());
            }
            let mut up_in = up.try_clone().unwrap();
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut reader, &mut up_in);
            });
            let mut piece = [0u8; 16 * 1024];
            while let Ok(n) = up.read(&mut piece) {
                if n == 0 || client.write_all(&piece[..n]).is_err() {
                    break;
                }
            }
            // Closes the client's side too: the copy in progress keeps its socket open.
            let _ = client.shutdown(std::net::Shutdown::Both);
        }
        Mode::Inspect => {
            let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            let _ = present_the_company_certificate(client);
        }
    }
}

fn present_the_company_certificate(mut stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {
    use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
    let chain = CertificateDer::pem_slice_iter(include_bytes!("chain.pem")).collect::<Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_slice(include_bytes!("leaf-key.pem"))?;
    let config = rustls::ServerConfig::builder_with_provider(rustls::crypto::ring::default_provider().into()).with_safe_default_protocol_versions()?.with_no_client_auth().with_single_cert(chain, key)?;
    let mut connection = rustls::ServerConnection::new(config.into())?;
    connection.complete_io(&mut stream)?;
    Ok(())
}
