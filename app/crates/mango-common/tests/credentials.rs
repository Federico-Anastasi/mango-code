//! The Windows Credential Manager is one for the whole machine, and the «MangoCode» service holds the user's real
//! credentials: each of these tests uses a service of its own and removes it at the end.

use mango_common::credentials::{read_in, save_in, service_for, remove_in, SERVICE};
use std::ffi::OsStr;

/// A service belonging to this test only; `Drop` removes the entries even if the test fails halfway.
struct TestService {
    service: String,
}

impl TestService {
    fn new() -> TestService {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        TestService { service: format!("MangoCode-test-cred-{}-{nanos}", std::process::id()) }
    }
}

impl Drop for TestService {
    fn drop(&mut self) {
        for name in ["key", "a", "b"] {
            let _ = remove_in(&self.service, name);
        }
    }
}

#[test]
fn saves_reads_and_removes() {
    let t = TestService::new();
    assert_eq!(read_in(&t.service, "key").unwrap(), None, "nothing there before saving");
    save_in(&t.service, "key", "sk-or-v1-fake").unwrap();
    assert_eq!(read_in(&t.service, "key").unwrap().as_deref(), Some("sk-or-v1-fake"));
    save_in(&t.service, "key", "second").unwrap();
    assert_eq!(read_in(&t.service, "key").unwrap().as_deref(), Some("second"), "saving again replaces");
    remove_in(&t.service, "key").unwrap();
    assert_eq!(read_in(&t.service, "key").unwrap(), None);
    remove_in(&t.service, "key").expect("removing what isn't there is not an error");
}

#[test]
fn different_names_do_not_mix() {
    let t = TestService::new();
    save_in(&t.service, "a", "one").unwrap();
    save_in(&t.service, "b", "two").unwrap();
    assert_eq!(read_in(&t.service, "a").unwrap().as_deref(), Some("one"));
    assert_eq!(read_in(&t.service, "b").unwrap().as_deref(), Some("two"));
    remove_in(&t.service, "b").unwrap();
    assert_eq!(read_in(&t.service, "a").unwrap().as_deref(), Some("one"));
}

#[test]
fn the_real_service_is_only_for_the_real_data() {
    assert_eq!(service_for(None), SERVICE);
    let a = service_for(Some(OsStr::new(r"C:\Temp\test-a")));
    let b = service_for(Some(OsStr::new(r"C:\Temp\test-b")));
    assert!(a.starts_with("MangoCode-test-") && b.starts_with("MangoCode-test-"), "{a} {b}");
    assert_ne!(a, SERVICE);
    assert_ne!(a, b, "different data, different services");
    assert_eq!(a, service_for(Some(OsStr::new(r"C:\Temp\test-a"))), "the same data gives the same service, in every process");
}
