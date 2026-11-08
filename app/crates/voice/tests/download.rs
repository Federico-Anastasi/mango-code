//! Download with resume and verification: it touches the network (885 KB), so by hand:
//! `cargo test -p voice --test download -- --ignored`

use std::fs;

#[test]
#[ignore = "downloads 885 KB from Hugging Face"]
fn resumes_a_partial_and_verifies_the_sha256() {
    let vad = voice::FILES[1];
    let dir = std::env::temp_dir().join(format!("mango-voice-dl-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(voice::missing_files(&dir).len(), 2);

    // first whole round
    let mut calls = 0;
    let path = voice::download(vad, &dir, &mut |done, total| {
        calls += 1;
        assert!(done <= total);
    })
    .unwrap();
    assert!(calls > 0);
    assert_eq!(fs::metadata(&path).unwrap().len(), vad.size);
    assert_eq!(mango_common::download::sha256_file(&path).unwrap(), vad.sha256);
    assert!(!voice::missing_files(&dir).iter().any(|f| f.name == vad.name));

    // an attempt interrupted halfway: the next round restarts from there (206) and the file becomes whole again
    let bytes = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let part = dir.join(format!("{}.part", vad.name));
    fs::write(&part, &bytes[..bytes.len() / 2]).unwrap();
    let mut first = None;
    voice::download(vad, &dir, &mut |done, _| {
        first.get_or_insert(done);
    })
    .unwrap();
    assert!(first.unwrap() >= bytes.len() as u64 / 2, "did not resume: first progress {first:?}");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(!part.exists());

    // a whole partial but with a wrong byte is thrown away and reported
    fs::remove_file(&path).unwrap();
    let mut bad = bytes.clone();
    bad[1000] ^= 0xff;
    fs::write(&part, &bad).unwrap();
    let err = voice::download(vad, &dir, &mut |_, _| {}).unwrap_err();
    assert!(err.to_string().contains("sha256"), "{err}");
    assert!(!part.exists());
    let _ = fs::remove_dir_all(&dir);
}
