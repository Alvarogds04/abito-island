use super::*;
use crate::secrets::StoreError;
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Default)]
struct Keys(BTreeMap<String, String>);
impl SecretStore for Keys {
    fn read(&self, k: &str) -> Result<Option<String>, StoreError> { Ok(self.0.get(k).cloned()) }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> { unreachable!("pollers never write keys") }
    fn delete(&self, _: &str) -> Result<(), StoreError> { unreachable!("pollers never delete keys") }
}
fn keys(pairs: &[(&str, &str)]) -> Keys { Keys(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()) }

/// Scripted fake: (url substring → status, body); records every request.
struct Fake {
    routes: Vec<(&'static str, u16, String)>,
    log: RefCell<Vec<(String, Vec<(String, String)>)>>,
}
impl Fake {
    fn new(routes: Vec<(&'static str, u16, &str)>) -> Fake {
        Fake { routes: routes.into_iter().map(|(a, b, c)| (a, b, c.to_string())).collect(), log: RefCell::new(vec![]) }
    }
    fn urls(&self) -> Vec<String> { self.log.borrow().iter().map(|(u, _)| u.clone()).collect() }
}
impl Http for Fake {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, NetError> {
        self.log.borrow_mut().push((url.to_string(), headers.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()));
        self.routes.iter().find(|(p, _, _)| url.contains(p)).map(|(_, s, b)| Response { status: *s, body: b.clone() })
            .ok_or(NetError("offline".into()))
    }
}

const VERCEL_BODY: &str = r#"{"deployments":[
 {"uid":"d2","name":"web","url":"web-d2.vercel.app","state":"READY","createdAt":1700000002000,"meta":{"githubCommitMessage":"fix","githubCommitRef":"main"}},
 {"uid":"d1","name":"api","url":"api.vercel.app","state":"BUILDING","createdAt":1700000001000},
 {"uid":"d0","name":"web","state":"ERROR","createdAt":1700000000000}]}"#;

#[test]
fn no_key_means_no_request() {
    let http = Fake::new(vec![]);
    assert!(poll(VERCEL, &http, &keys(&[]), &Seen::default()).is_none());
    assert!(poll(N8N, &http, &keys(&[("n8n-url", "https://n8n.example.com")]), &Seen::default()).is_none());
    assert!(poll(N8N, &http, &keys(&[("n8n-api-key", "k")]), &Seen::default()).is_none());
    assert!(poll("integration_unknown", &http, &keys(&[("vercel-token", "t")]), &Seen::default()).is_none());
    assert!(http.urls().is_empty());
}

#[test]
fn vercel_keeps_finished_deployments_and_first_poll_is_silent() {
    let http = Fake::new(vec![("api.vercel.com", 200, VERCEL_BODY)]);
    let store = keys(&[("vercel-token", " tok ")]);
    let seen = Seen::default();
    let first = poll(VERCEL, &http, &store, &seen).unwrap();
    assert_eq!(first.event, None);
    assert_eq!(first.error, None);
    let list = first.data["deployments"].as_array().unwrap();
    assert_eq!(list.len(), 2, "BUILDING is not finished");
    assert_eq!(list[0]["id"], "d2");
    assert_eq!(list[0]["commitMessage"], "fix");
    assert_eq!(list[0]["branch"], "main");
    assert_eq!(list[1]["commitMessage"], Value::Null);
    let sent = http.log.borrow()[0].clone();
    assert!(sent.1.contains(&("Authorization".into(), "Bearer tok".into())), "token trimmed, bearer");
    // same newest id again: still silent
    assert_eq!(poll(VERCEL, &http, &store, &seen).unwrap().event, None);
}

#[test]
fn vercel_new_deployment_fires_one_event() {
    let store = keys(&[("vercel-token", "t")]);
    let seen = Seen::default();
    poll(VERCEL, &Fake::new(vec![("vercel", 200, VERCEL_BODY)]), &store, &seen).unwrap();
    let newer = VERCEL_BODY.replace(r#""uid":"d2","name":"web""#, r#""uid":"d3","name":"shop""#).replace("READY", "ERROR");
    let up = poll(VERCEL, &Fake::new(vec![("vercel", 200, &newer)]), &store, &seen).unwrap();
    assert_eq!(up.event, Some(Event { success: false, label: "shop".into(), detail: None }));
    assert_eq!(poll(VERCEL, &Fake::new(vec![("vercel", 200, &newer)]), &store, &seen).unwrap().event, None);
}

#[test]
fn vercel_errors_are_plain_lines() {
    let store = keys(&[("vercel-token", "secret-token")]);
    for (code, text) in [(401, "Clave de API no válida (401)"), (403, "El token no tiene acceso"), (500, "Error de API 500")] {
        let up = poll(VERCEL, &Fake::new(vec![("vercel", code, "{}")]), &store, &Seen::default()).unwrap();
        assert_eq!(up.error.as_deref(), Some(text));
        assert_eq!(up.data, json!({}));
        assert!(!format!("{up:?}").contains("secret-token"));
    }
    // a dead network says nothing at all (Coucou: silent)
    assert!(poll(VERCEL, &Fake::new(vec![]), &store, &Seen::default()).is_none());
}

const N8N_LIST: &str = r#"{"data":[{"id":"41","status":"success"}]}"#;
const N8N_DETAIL_OK: &str = r#"{"workflowData":{"name":"Nightly"},"data":{"resultData":{"lastNodeExecuted":"Set","runData":{"Set":[{"data":{"main":[[{"json":{"a":"x","n":3,"l":[1,2],"o":{"k":1}}}]]}}]}}}}"#;
const N8N_DETAIL_ERR: &str = r#"{"name":"Sync","data":{"resultData":{"error":{"message":"boom","node":{"name":"HTTP"}}}}}"#;

fn n8n_store() -> Keys { keys(&[("n8n-api-key", "nk"), ("n8n-url", "https://n8n.example.com/")]) }

#[test]
fn n8n_first_poll_silent_then_reports_the_finished_execution() {
    let seen = Seen::default();
    let http = Fake::new(vec![("/executions/41", 200, N8N_DETAIL_OK), ("/executions?limit=1", 200, N8N_LIST)]);
    assert!(poll(N8N, &http, &n8n_store(), &seen).is_none(), "first load fills silently");
    let next = r#"{"data":[{"id":42,"status":"success"}]}"#;
    let http = Fake::new(vec![("/executions/42", 200, N8N_DETAIL_OK), ("/executions?limit=1", 200, next)]);
    let up = poll(N8N, &http, &n8n_store(), &seen).unwrap();
    assert_eq!(up.data, json!({"workflow":"Nightly","status":"success"}));
    let ev = up.event.unwrap();
    assert!(ev.success);
    assert_eq!(ev.label, "Nightly");
    assert_eq!(ev.detail.as_deref(), Some("→ Set · 1 item\na: x\nl: [2]\nn: 3\no: {…}"));
    let sent = &http.log.borrow()[0];
    assert_eq!(sent.0, "https://n8n.example.com/api/v1/executions?limit=1&includeData=false");
    assert!(sent.1.contains(&("X-N8N-API-KEY".into(), "nk".into())));
}

#[test]
fn n8n_failure_detail_and_rest_fallback() {
    let seen = Seen::default();
    let list = |id: &str| format!(r#"[{{"id":"{id}","status":"error"}}]"#);
    let l1 = list("1");
    let l2 = list("2");
    // public API 404 → /rest answers (bare array shape)
    let http = Fake::new(vec![("/api/v1/", 404, "{}"), ("/rest/executions?limit", 200, &l1)]);
    assert!(poll(N8N, &http, &n8n_store(), &seen).is_none());
    let http = Fake::new(vec![("/api/v1/", 404, "{}"), ("/rest/executions/2?includeData=true", 200, N8N_DETAIL_ERR), ("/rest/executions?limit", 200, &l2)]);
    let ev = poll(N8N, &http, &n8n_store(), &seen).unwrap().event.unwrap();
    assert!(!ev.success);
    assert_eq!(ev.label, "Sync");
    assert_eq!(ev.detail.as_deref(), Some("HTTP\nboom"));
}

#[test]
fn n8n_running_execution_is_not_reported_and_unknown_detail_is_workflow() {
    let seen = Seen::default();
    let running = Fake::new(vec![("executions?limit", 200, r#"{"data":[{"id":"9","status":"running"}]}"#)]);
    assert!(poll(N8N, &running, &n8n_store(), &seen).is_none());
    assert!(poll(N8N, &running, &n8n_store(), &seen).is_none());
    let http = Fake::new(vec![("executions?limit", 200, r#"{"data":[{"id":"10","status":"success"}]}"#)]);
    let _ = poll(N8N, &http, &n8n_store(), &Seen::default());
    let seen = Seen::default();
    poll(N8N, &Fake::new(vec![("executions?limit", 200, r#"{"data":[{"id":"1","status":"success"}]}"#)]), &n8n_store(), &seen);
    let up = poll(N8N, &Fake::new(vec![("executions?limit", 200, r#"{"data":[{"id":"2","status":"success"}]}"#)]), &n8n_store(), &seen).unwrap();
    assert_eq!(up.event.unwrap().label, "Workflow");
}

#[test]
fn n8n_base_url_must_be_safe_before_any_request() {
    for bad in ["http://n8n.example.com", "http://192.168.1.5:5678", "https://u:p@n8n.example.com", "file:///etc/passwd", "n8n.example.com"] {
        let http = Fake::new(vec![("", 200, N8N_LIST)]);
        let store = keys(&[("n8n-api-key", "k"), ("n8n-url", bad)]);
        assert!(poll(N8N, &http, &store, &Seen::default()).is_none(), "{bad}");
        assert!(http.urls().is_empty(), "{bad}");
    }
    assert_eq!(n8n_base("http://localhost:5678/").as_deref(), Some("http://localhost:5678"));
    assert_eq!(n8n_base(" https://n8n.example.com/sub/ ").as_deref(), Some("https://n8n.example.com/sub"));
}

#[test]
fn cadence_matches_coucou() {
    assert_eq!(POLLERS, [(N8N, 3, 15), (VERCEL, 5, 30)]);
}

#[test]
fn command_is_closed() {
    assert_eq!(parse_command(&json!({"action":"view"})), Some(Command::View));
    assert_eq!(parse_command(&json!({"action":"refresh","id":"integration_n8n"})), Some(Command::Refresh(N8N)));
    for bad in [json!({"action":"refresh"}), json!({"action":"refresh","id":"integration_stripe"}), json!({"action":"refresh","id":"integration_n8n","x":1}),
        json!({"action":"view","id":"integration_n8n"}), json!({"action":"poll"}), json!("view"), json!({"action":7}), json!({"action":"refresh","id":["integration_n8n"]})] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn declared_means_main_or_declared_pill() {
    let prefs = crate::prefs::Prefs::from_text(Some(r#"{"v":1,"declared_pills":["integration_n8n"]}"#));
    assert!(declared(&prefs, "integration_n8n"));
    assert!(!declared(&prefs, "integration_vercel"));
    assert!(!declared(&crate::prefs::Prefs::default(), "integration_stripe"));
}
