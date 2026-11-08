//! The user's credentials (the OpenRouter key, the Hugging Face token) in the Windows Credential Manager: never in
//! plain text on a file. Service «MangoCode»; whoever uses them passes them to processes in the environment,
//! without writing them to disk.
//!
//! The Credential Manager is one for the whole machine. With `MANGO_DATA` (the tests) the service changes, derived
//! from the data dir: a test never sees or touches the real credentials.

use crate::tr;
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

/// The service of the real credentials.
pub const SERVICE: &str = "MangoCode";

/// The service for a data dir: the real one without `MANGO_DATA`, otherwise one belonging only to that dir.
pub fn service_for(data: Option<&OsStr>) -> String {
    let Some(data) = data else { return SERVICE.to_string() };
    let hash = Sha256::digest(data.as_encoded_bytes());
    format!("{SERVICE}-test-{}", hash[..6].iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn service() -> String {
    service_for(std::env::var_os("MANGO_DATA").as_deref())
}

pub fn save(name: &str, value: &str) -> Result<()> {
    save_in(&service(), name, value)
}

/// `None` if the credential isn't there.
pub fn read(name: &str) -> Result<Option<String>> {
    read_in(&service(), name)
}

/// Removing what isn't there is not an error.
pub fn remove(name: &str) -> Result<()> {
    remove_in(&service(), name)
}

pub fn save_in(service: &str, name: &str, value: &str) -> Result<()> {
    entry(service, name)?
        .set_password(value)
        .with_context(|| tr!("impossibile salvare «{name}» nel Gestore credenziali", "cannot save «{name}» in the Credential Manager"))
}

pub fn read_in(service: &str, name: &str) -> Result<Option<String>> {
    match entry(service, name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).with_context(|| tr!("impossibile leggere «{name}» dal Gestore credenziali", "cannot read «{name}» from the Credential Manager")),
    }
}

pub fn remove_in(service: &str, name: &str) -> Result<()> {
    match entry(service, name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).with_context(|| tr!("impossibile togliere «{name}» dal Gestore credenziali", "cannot remove «{name}» from the Credential Manager")),
    }
}

fn entry(service: &str, name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, name).with_context(|| tr!("credenziale «{name}» non valida", "invalid credential «{name}»"))
}
