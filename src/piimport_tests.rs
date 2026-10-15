//! #408 T8 — the click-scoped import of the human's Pi `nan` connection. FAKE Pi dirs only (a temp dir
//! with synthetic values built at runtime); the real ~/.pi/agent is never read and no value is printed.
use super::*;
use crate::agentclient::AccountStore;
use serde_json::json;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("abito-pi-import-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn dir(&self, name: &str) -> std::path::PathBuf { let d = self.0.join(name); std::fs::create_dir_all(&d).unwrap(); d }
}
impl Drop for Temp {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// A synthetic key that cannot collide with anything real.
fn secret() -> String { ["synthetic", "pi", "key", "0001"].join("-") }
fn write_private(path: &std::path::Path, value: &serde_json::Value) {
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
fn models_doc() -> serde_json::Value {
    json!({"providers": {
        "other": {"baseUrl": "https://other.example/v1", "api": "openai-completions", "apiKey": "unrelated-placeholder", "models": [{"id": "x"}]},
        "nan": {"baseUrl": "https://api.nan.builders/v1", "api": "openai-completions", "models": [
            {"id": "model-a", "name": "A"}, {"id": "model-b"}, {"id": "model-a"}, {"name": "no id"}]}}})
}
fn auth_doc(key: &str) -> serde_json::Value { json!({"nan": {"type": "api_key", "key": key}, "anthropic": {"type": "oauth"}}) }
fn pi_dir(t: &Temp) -> std::path::PathBuf {
    let d = t.dir("pi");
    write_private(&d.join("models.json"), &models_doc());
    write_private(&d.join("auth.json"), &auth_doc(&secret()));
    d
}
fn store(t: &Temp) -> AccountStore { AccountStore::load(t.0.join("abito").join("accounts.json")).unwrap() }

#[test]
fn status_reports_only_existence_and_the_model_count() {
    let t = Temp::new();
    let d = pi_dir(&t);
    assert_eq!(status(&d), PiStatus { exists: true, models: 2 }, "duplicate ids and entries without id are not counted");
    let json = serde_json::to_string(&status(&d)).unwrap();
    assert_eq!(json, r#"{"exists":true,"models":2}"#, "no path, no key length, no prefix");
    assert_eq!(status(&t.0.join("nope")), PiStatus { exists: false, models: 0 });
}

#[test]
fn status_never_reads_auth_json() {
    let t = Temp::new();
    let d = pi_dir(&t);
    std::fs::remove_file(d.join("auth.json")).unwrap();
    assert_eq!(status(&d), PiStatus { exists: true, models: 2 });
}

#[test]
fn nan_without_a_provider_or_models_does_not_exist() {
    let t = Temp::new();
    let d = t.dir("pi");
    write_private(&d.join("models.json"), &json!({"providers": {"other": {"models": [{"id": "x"}]}}}));
    assert_eq!(status(&d).exists, false);
    write_private(&d.join("models.json"), &json!({"providers": {"nan": {"baseUrl": "https://api.nan.builders/v1", "models": []}}}));
    assert_eq!(status(&d).exists, false);
    write_private(&d.join("models.json"), &json!(["not", "an", "object"]));
    assert_eq!(status(&d).exists, false);
}

#[test]
fn refuses_unsafe_pi_files() {
    for (case, mode) in [("group-readable", 0o640), ("world-readable", 0o644)] {
        let t = Temp::new();
        let d = pi_dir(&t);
        std::fs::set_permissions(d.join("auth.json"), std::fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(read_nan(&d).err(), Some(PiError::Unsafe), "{case}");
    }
    let t = Temp::new();
    let d = pi_dir(&t);
    std::fs::set_permissions(d.join("models.json"), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(read_nan(&d).err(), Some(PiError::Unsafe), "models.json too");
    assert_eq!(status(&d).exists, false, "an unsafe models.json is not read for status either");

    let t = Temp::new();
    let d = pi_dir(&t);
    let real = t.0.join("elsewhere.json");
    write_private(&real, &auth_doc(&secret()));
    std::fs::remove_file(d.join("auth.json")).unwrap();
    symlink(&real, d.join("auth.json")).unwrap();
    assert_eq!(read_nan(&d).err(), Some(PiError::Unsafe), "symlink");

    let t = Temp::new();
    let d = pi_dir(&t);
    std::fs::remove_file(d.join("auth.json")).unwrap();
    std::fs::create_dir(d.join("auth.json")).unwrap();
    assert_eq!(read_nan(&d).err(), Some(PiError::Unsafe), "not a regular file");
}

#[test]
fn refuses_a_missing_or_non_api_key_credential() {
    let t = Temp::new();
    let d = pi_dir(&t);
    std::fs::remove_file(d.join("auth.json")).unwrap();
    assert_eq!(read_nan(&d).err(), Some(PiError::Invalid), "no auth.json");
    for doc in [
        json!({"anthropic": {"type": "api_key", "key": "x"}}),
        json!({"nan": {"type": "oauth", "key": "x"}}),
        json!({"nan": {"type": "api_key"}}),
        json!({"nan": {"type": "api_key", "key": ""}}),
        json!({"nan": {"type": "api_key", "key": 7}}),
        json!({"nan": "plain"}),
    ] {
        write_private(&d.join("auth.json"), &doc);
        assert_eq!(read_nan(&d).err(), Some(PiError::Invalid), "{doc}");
    }
    assert_eq!(read_nan(&t.0.join("nope")).err(), Some(PiError::Missing));
}

#[test]
fn pi_nan_debug_never_prints_the_key() {
    let t = Temp::new();
    let nan = read_nan(&pi_dir(&t)).unwrap();
    assert!(!format!("{nan:?}").contains(&secret()));
    assert_eq!((nan.base_url.as_str(), nan.models.clone()), ("https://api.nan.builders/v1", vec!["model-a".to_string(), "model-b".to_string()]));
}

#[test]
fn import_copies_once_into_the_private_store_and_the_key_never_appears_in_a_view() {
    let t = Temp::new();
    let d = pi_dir(&t);
    let mut s = store(&t);
    let mut published = Vec::new();
    let out = s.import_pi_nan(&d, |v| published.push(v)).expect("import");
    assert_eq!((out.replaced, out.models), (false, 2));
    for v in published.iter().chain(std::iter::once(&s.view())) {
        let text = v.to_string();
        assert!(!text.contains(&secret()), "the key is in a view/IPC payload");
        assert!(!text.to_lowercase().contains("apikey"), "no key field at all in views");
    }
    let view = s.view();
    let acc = &view["accounts"][0];
    assert_eq!((acc["accountId"].as_str(), acc["provider"].as_str(), acc["hasCredential"].as_bool()), (Some("nan"), Some("nan"), Some(true)));
    assert_eq!(acc["config"]["models"], json!(["model-a", "model-b"]));
    assert_eq!(acc["config"]["baseUrl"], json!("https://api.nan.builders/v1"));
    // owner-only store, and the key lives ONLY there
    let path = t.0.join("abito").join("accounts.json");
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(std::fs::read_to_string(&path).unwrap().contains(&secret()));
    // afterwards Abito does not depend on the Pi files
    std::fs::remove_dir_all(&d).unwrap();
    assert_eq!(AccountStore::load(path).unwrap().view()["accounts"][0]["hasCredential"], json!(true));
}

#[test]
fn importing_again_replaces_the_account_and_says_so() {
    let t = Temp::new();
    let d = pi_dir(&t);
    let mut s = store(&t);
    s.import_pi_nan(&d, |_| {}).unwrap();
    write_private(&d.join("auth.json"), &auth_doc("synthetic-rotated-key-0002"));
    let out = s.import_pi_nan(&d, |_| {}).unwrap();
    assert!(out.replaced);
    assert_eq!(s.view()["accounts"].as_array().unwrap().len(), 1, "replaced, not duplicated");
    let disk = std::fs::read_to_string(t.0.join("abito").join("accounts.json")).unwrap();
    assert!(disk.contains("synthetic-rotated-key-0002") && !disk.contains(&secret()), "only the new key remains");
}

#[test]
fn a_refused_import_changes_nothing() {
    let t = Temp::new();
    let d = pi_dir(&t);
    let mut s = store(&t);
    s.import_pi_nan(&d, |_| {}).unwrap();
    let before = std::fs::read(t.0.join("abito").join("accounts.json")).unwrap();
    write_private(&d.join("auth.json"), &json!({"nan": {"type": "oauth"}}));
    let mut called = false;
    assert!(s.import_pi_nan(&d, |_| called = true).is_err());
    assert!(!called, "nothing is published");
    assert_eq!(std::fs::read(t.0.join("abito").join("accounts.json")).unwrap(), before);
    // an insecure endpoint from the Pi file is refused by the store's own URL rule
    write_private(&d.join("auth.json"), &auth_doc(&secret()));
    let mut doc = models_doc();
    doc["providers"]["nan"]["baseUrl"] = json!("http://api.nan.builders/v1");
    write_private(&d.join("models.json"), &doc);
    assert_eq!(s.import_pi_nan(&d, |_| {}).err().map(|e| e.code), Some("pi_invalid".to_string()));
}

#[test]
fn remove_deletes_the_key_and_leaves_no_copy() {
    let t = Temp::new();
    let d = pi_dir(&t);
    let mut s = store(&t);
    s.import_pi_nan(&d, |_| {}).unwrap();
    let out = s.command(&json!({"action": "abito_account_remove", "accountId": "nan"}), |_| {}).expect("remove");
    assert_eq!(out["accounts"].as_array().unwrap().len(), 0);
    let disk = std::fs::read_to_string(t.0.join("abito").join("accounts.json")).unwrap();
    assert!(!disk.contains(&secret()) && !disk.contains("nan"), "no other copy in the store");
    // closed schema + unknown account
    assert!(s.command(&json!({"action": "abito_account_remove", "accountId": "nan"}), |_| {}).is_err(), "already gone");
    assert!(s.command(&json!({"action": "abito_account_remove", "accountId": "nan", "extra": 1}), |_| {}).is_err());
    assert!(s.command(&json!({"action": "abito_account_remove"}), |_| {}).is_err());
}

#[test]
fn replacing_the_key_from_the_ui_is_write_only() {
    let t = Temp::new();
    let d = pi_dir(&t);
    let mut s = store(&t);
    s.import_pi_nan(&d, |_| {}).unwrap();
    let cfg = s.view()["accounts"][0]["config"].clone();
    let mut config = cfg.clone();
    config["apiKey"] = json!("synthetic-ui-key-0003");
    let out = s.command(&json!({"action": "abito_account_save", "accountId": "nan", "provider": "nan", "config": config}), |_| {}).unwrap();
    assert!(!out.to_string().contains("synthetic-ui-key-0003"), "the new key is never echoed");
    let disk = std::fs::read_to_string(t.0.join("abito").join("accounts.json")).unwrap();
    assert!(disk.contains("synthetic-ui-key-0003") && !disk.contains(&secret()));
    // saving without apiKey keeps the stored one
    s.command(&json!({"action": "abito_account_save", "accountId": "nan", "provider": "nan", "config": cfg}), |_| {}).unwrap();
    assert!(std::fs::read_to_string(t.0.join("abito").join("accounts.json")).unwrap().contains("synthetic-ui-key-0003"));
}

#[test]
fn default_dir_is_home_pi_agent_and_needs_a_home() {
    assert_eq!(default_dir(Some("/home/x")), Some(std::path::PathBuf::from("/home/x/.pi/agent")));
    assert_eq!(default_dir(None), None);
    assert_eq!(default_dir(Some("")), None);
}

#[test]
fn the_host_command_payload_is_a_closed_pair() {
    assert_eq!(parse_action(&json!({"action": "status"})), Some(PiAction::Status));
    assert_eq!(parse_action(&json!({"action": "import"})), Some(PiAction::Import));
    for bad in [json!({}), json!({"action": "read"}), json!({"action": "import", "path": "/tmp"}), json!("import"), json!({"action": 1})] {
        assert_eq!(parse_action(&bad), None, "{bad}");
    }
}
