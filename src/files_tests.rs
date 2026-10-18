use super::*;
use crate::bridge::RateLimiter;
use serde_json::json;
use std::path::{Path, PathBuf};

const ORIGIN: &str = "tauri://localhost/";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-files-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_payload_is_closed_and_paths_must_be_existing_absolute_targets() {
    let dir = scratch("payload");
    let file = dir.join("a.txt");
    std::fs::write(&file, b"x").unwrap();
    let d = dir.to_str().unwrap();
    let f = file.to_str().unwrap();

    assert_eq!(parse_open(&json!({"action":"vscode"})).unwrap(), OpenRequest::Vscode(None));
    assert_eq!(parse_open(&json!({"action":"vscode","path":d})).unwrap(), OpenRequest::Vscode(Some(dir.clone())));
    assert_eq!(parse_open(&json!({"action":"vscode_file","path":f})).unwrap(), OpenRequest::VscodeFile(file.clone()));
    assert_eq!(parse_open(&json!({"action":"n8n"})).unwrap(), OpenRequest::N8n);

    for bad in [
        json!(null), json!("vscode"), json!({}), json!({"action":"shell"}), json!({"action":1}),
        json!({"action":"vscode","path":"relative/dir"}),
        json!({"action":"vscode","path":"--wait"}),
        json!({"action":"vscode","path":f}),           // a file where a folder is required
        json!({"action":"vscode","path":"/nonexistent-abito-dir"}),
        json!({"action":"vscode","path":""}),
        json!({"action":"vscode","path":d,"extra":1}),
        json!({"action":"vscode_file"}),
        json!({"action":"vscode_file","path":d}),      // a folder where a file is required
        json!({"action":"vscode_file","path":"a.txt"}),
        json!({"action":"vscode_file","path":format!("{f}\0")}),
        json!({"action":"n8n","path":d}),
        json!({"action":"n8n","url":"https://x.test"}),
    ] {
        let e = parse_open(&bad).expect_err(&bad.to_string());
        assert_eq!(e.code, "denied", "{bad}");
        assert!(e.message.starts_with("Denied: "), "{bad}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn gates_run_sender_then_payload_then_rate_and_a_rejected_call_spends_nothing() {
    let mut rate = RateLimiter::new();
    let mut effects = 0;
    for (label, origin, payload) in [
        ("other", ORIGIN, json!({"action":"n8n"})),
        ("main", "https://example.test/", json!({"action":"n8n"})),
        ("main", ORIGIN, json!({"action":"rm"})),
    ] {
        let e = open_command(label, origin, &payload, &mut rate, 0, |_| { effects += 1; Ok(true) }).unwrap_err();
        assert_eq!(e.code, "denied");
    }
    assert_eq!(effects, 0);
    for _ in 0..30 { rate.check(0).expect("rejected input consumes no rate budget"); }

    let mut rate = RateLimiter::new();
    let mut seen = Vec::new();
    let answer = open_command("main", ORIGIN, &json!({"action":"n8n"}), &mut rate, 0, |r| { seen.push(r); Ok(true) }).unwrap();
    assert_eq!(seen, vec![OpenRequest::N8n]);
    assert_eq!(answer, json!({"opened": true}));
    let failed = open_command("main", ORIGIN, &json!({"action":"n8n"}), &mut rate, 0, |_| Ok(false)).unwrap();
    assert_eq!(failed, json!({"opened": false}));
    let e = open_command("main", ORIGIN, &json!({"action":"n8n"}), &mut rate, 0, |_| Err("boom".into())).unwrap_err();
    assert_eq!(e.code, "denied");
}

#[test]
fn launch_plan_is_one_fixed_program_and_one_argument() {
    let code = Path::new("/usr/bin/code");
    let dir = PathBuf::from("/work/proj");
    let file = PathBuf::from("/work/proj/src/a.rs");
    assert_eq!(launch_plan(Some(code), &OpenRequest::Vscode(Some(dir.clone()))),
        Launch::Spawn { program: code.to_path_buf(), arg: Some(dir.clone()) });
    assert_eq!(launch_plan(Some(code), &OpenRequest::Vscode(None)),
        Launch::Spawn { program: code.to_path_buf(), arg: None });
    assert_eq!(launch_plan(Some(code), &OpenRequest::VscodeFile(file.clone())),
        Launch::Spawn { program: code.to_path_buf(), arg: Some(file.clone()) });
    // No `code`: the folder (the file's folder for a file) is revealed, never the file itself.
    assert_eq!(launch_plan(None, &OpenRequest::Vscode(Some(dir.clone()))), Launch::RevealFolder(dir.clone()));
    assert_eq!(launch_plan(None, &OpenRequest::Vscode(None)), Launch::Nothing);
    assert_eq!(launch_plan(None, &OpenRequest::VscodeFile(file)), Launch::RevealFolder(PathBuf::from("/work/proj/src")));
    assert_eq!(launch_plan(None, &OpenRequest::N8n), Launch::Nothing);
}

#[test]
fn n8n_url_is_https_or_loopback_http_without_credentials() {
    for good in ["https://n8n.example.com", "https://n8n.example.com:5678/home", "http://localhost:5678",
        "http://127.0.0.1:5678/", "http://[::1]:5678"] {
        assert!(n8n_url(good).is_some(), "{good}");
    }
    for bad in ["", "http://n8n.example.com", "http://192.168.1.5:5678", "ftp://x.test", "file:///etc/passwd",
        "javascript:alert(1)", "https://user:pw@n8n.example.com", "https://x.test/a b", "https://x.test/\n",
        "not a url", "n8n.example.com", "http://localhost.evil.test"] {
        assert!(n8n_url(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn find_on_path_takes_only_absolute_directories_and_executable_files() {
    let a = scratch("path-a");
    let b = scratch("path-b");
    let bin = b.join("code");
    std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A non-executable look-alike earlier on the path is skipped.
        std::fs::write(a.join("code"), b"x").unwrap();
    }
    let path = std::env::join_paths([Path::new("relative/dir"), a.as_path(), b.as_path()]).unwrap();
    #[cfg(unix)]
    assert_eq!(find_on_path_in("code", &path), Some(bin));
    assert_eq!(find_on_path_in("definitely-not-here", &path), None);
    assert_eq!(find_on_path_in("../code", &path), None);
    assert_eq!(find_on_path_in("", &path), None);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}
