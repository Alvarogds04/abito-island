//! #489 integration pollers: n8n and Vercel (more services follow in later slices). Pure and
//! network-free: every poller takes an [`Http`] seam and the key store, and returns the
//! [`Update`] the island card consumes. The host (`integrationshost.rs`) owns the real HTTP
//! client, the timers and the event emission.
//!
//! Adapted from Coucou windows/src-tauri/src/integrations.rs @71b773f, Copyright (c) 2026 Louis
//! Raillé, MIT. Differences: the HTTP client and the key store are injected (no network in
//! tests), Spanish messages, the n8n base URL must pass `files::n8n_url` (https, or loopback
//! http, no credentials) before any request is made, and a service polls only when the human
//! declared its pill and saved its key.
use crate::secrets::SecretStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(test)]
#[path = "integrations_tests.rs"]
mod tests;

/// Island event carrying one [`Update`].
pub const UPDATE_EVENT: &str = "integration:update";

/// A finished HTTP exchange; the body is already size-capped by the client.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Why no response arrived (connection, TLS, timeout). Carries no URL on purpose: a
/// self-hosted base URL can hold a secret path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetError(pub String);

/// The HTTP seam. Only GET so far; POST joins with the services that need it.
pub trait Http {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, NetError>;
}

/// What the island receives. `event` is set only when something actually changed: it drives
/// the pill badge and the sound.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<Event>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

pub const N8N: &str = "integration_n8n";
pub const VERCEL: &str = "integration_vercel";

/// (pill id, first-run delay s, interval s): Coucou's cadence.
pub const POLLERS: [(&str, u64, u64); 2] = [(N8N, 3, 15), (VERCEL, 5, 30)];

/// Remembers the newest id per service so an event fires once, not on every poll. The very
/// first load only fills the card.
#[derive(Default)]
pub struct Seen(Mutex<HashMap<&'static str, String>>);

impl Seen {
    pub fn is_new(&self, key: &'static str, id: &str) -> bool {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match map.insert(key, id.to_string()) {
            Some(previous) => previous != id,
            None => false,
        }
    }
    pub fn forget(&self, key: &'static str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

fn key(store: &dyn SecretStore, name: &str) -> Option<String> {
    store.read(name).ok().flatten().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The card's error line for a refused request.
pub fn status_error(code: u16, forbidden_hint: &str) -> String {
    match code {
        401 => "Clave de API no válida (401)".to_string(),
        403 => forbidden_hint.to_string(),
        _ => format!("Error de API {code}"),
    }
}

fn failed(id: &'static str, error: String) -> Update {
    Update { id, data: json!({}), error: Some(error), event: None }
}

/// Runs the poller for `id`; `None` when the service is unknown, has no key, or has nothing
/// to say this round.
pub fn poll(id: &str, http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    match id {
        N8N => poll_n8n(http, store, seen),
        VERCEL => poll_vercel(http, store, seen),
        _ => None,
    }
}

// ── Vercel ────────────────────────────────────────────────────────────────────

pub fn poll_vercel(http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    let token = key(store, "vercel-token")?;
    let auth = format!("Bearer {token}");
    let response = http
        .get("https://api.vercel.com/v6/deployments?limit=5", &[("Authorization", &auth), ("Accept", "application/json")])
        .ok()?;
    if !(200..300).contains(&response.status) {
        return Some(failed(VERCEL, status_error(response.status, "El token no tiene acceso")));
    }
    let json: Value = serde_json::from_str(&response.body).unwrap_or(json!({}));
    let deployments = vercel_deployments(&json);
    let event = deployments.first().and_then(|latest| {
        let id = latest.get("id")?.as_str()?;
        if !seen.is_new("vercel", id) {
            return None;
        }
        Some(Event {
            success: latest.get("state")?.as_str()? == "READY",
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });
    Some(Update { id: VERCEL, data: json!({ "deployments": deployments }), error: None, event })
}

/// Only finished deployments (READY, ERROR, CANCELED), newest first as Vercel sends them.
pub fn vercel_deployments(json: &Value) -> Vec<Value> {
    const TERMINAL: [&str; 3] = ["READY", "ERROR", "CANCELED"];
    let Some(list) = json.get("deployments").and_then(Value::as_array) else { return vec![] };
    list.iter()
        .filter_map(|d| {
            let state = d.get("state")?.as_str()?;
            if !TERMINAL.contains(&state) {
                return None;
            }
            let meta = d.get("meta");
            let pick = |keys: [&str; 3]| {
                meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str))).map(str::to_string)
            };
            Some(json!({
                "id": d.get("uid")?.as_str()?,
                "projectName": d.get("name")?.as_str()?,
                "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                "state": state,
                "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
            }))
        })
        .collect()
}

// ── n8n ───────────────────────────────────────────────────────────────────────

/// The validated base URL, no trailing slash. `None` for anything `files::n8n_url` refuses.
pub fn n8n_base(raw: &str) -> Option<String> {
    crate::files::n8n_url(raw.trim()).map(|u| u.trim_end_matches('/').to_string())
}

fn n8n_get(http: &dyn Http, url: &str, api_key: &str) -> Option<Value> {
    let response = http.get(url, &[("X-N8N-API-KEY", api_key), ("Accept", "application/json")]).ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    serde_json::from_str(&response.body).ok()
}

pub fn poll_n8n(http: &dyn Http, store: &dyn SecretStore, seen: &Seen) -> Option<Update> {
    let api_key = key(store, "n8n-api-key")?;
    let base = n8n_base(&key(store, "n8n-url")?)?;
    // Same two shapes as the Swift poller: the public API first, then /rest.
    let mut items = None;
    for url in [
        format!("{base}/api/v1/executions?limit=1&includeData=false"),
        format!("{base}/rest/executions?limit=1&includeData=false"),
    ] {
        let Some(json) = n8n_get(http, &url, &api_key) else { continue };
        items = match &json {
            Value::Object(o) => o.get("data").and_then(Value::as_array).cloned(),
            Value::Array(a) => Some(a.clone()),
            _ => None,
        };
        if items.is_some() {
            break;
        }
    }
    let first = items?.into_iter().next()?;
    let id = match first.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return None,
    };
    let status = first.get("status").and_then(Value::as_str).unwrap_or("");
    if !["success", "error", "crashed", "canceled", "failed"].contains(&status) || !seen.is_new("n8n", &id) {
        return None;
    }
    let success = status == "success";
    let mut name = "Workflow".to_string();
    let mut detail = None;
    for url in [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ] {
        let Some(json) = n8n_get(http, &url, &api_key) else { continue };
        name = json
            .get("workflowData")
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .or_else(|| json.get("name").and_then(Value::as_str))
            .unwrap_or("Workflow")
            .to_string();
        detail = n8n_detail(&json, success);
        break;
    }
    Some(Update {
        id: N8N,
        data: json!({ "workflow": name, "status": status }),
        error: None,
        event: Some(Event { success, label: name, detail }),
    })
}

fn n8n_detail(json: &Value, success: bool) -> Option<String> {
    let result = json.get("data")?.get("resultData")?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            if let Some(node) = error.get("node").and_then(|n| n.get("name")).and_then(Value::as_str) {
                if !node.is_empty() {
                    return Some(format!("{node}\n{message}"));
                }
            }
            return Some(message.to_string());
        }
        for (node, value) in result.get("runData")?.as_object()? {
            if let Some(message) = value
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
            {
                return Some(format!("{node}\n{message}"));
            }
        }
        return None;
    }
    let last_node = result.get("lastNodeExecuted")?.as_str()?;
    let items = result
        .get("runData")?
        .get(last_node)?
        .as_array()?
        .first()?
        .get("data")?
        .get("main")?
        .as_array()?
        .first()?
        .as_array()?;
    let count = items.len();
    let header = format!("→ {last_node} · {count} item{}", if count == 1 { "" } else { "s" });
    let fields = items
        .first()
        .and_then(|i| i.get("json"))
        .and_then(Value::as_object)
        .map(|obj| obj.iter().take(4).map(|(k, v)| format!("{k}: {}", fmt_value(v))).collect::<Vec<_>>().join("\n"))
        .filter(|s| !s.is_empty());
    Some(match fields {
        Some(f) => format!("{header}\n{f}"),
        None => header,
    })
}

fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(50).collect(),
        Value::Array(a) => format!("[{}]", a.len()),
        Value::Object(_) => "{…}".into(),
        other => other.to_string(),
    }
}

// ── Command surface ───────────────────────────────────────────────────────────

/// `integration_action` payload: `{action:"view"}` answers every cached update;
/// `{action:"refresh", id}` polls one service now (only a declared one with a key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    View,
    Refresh(&'static str),
}

pub fn parse_command(payload: &Value) -> Option<Command> {
    let map = payload.as_object()?;
    match map.get("action")?.as_str()? {
        "view" if map.len() == 1 => Some(Command::View),
        "refresh" if map.len() == 2 => {
            let id = map.get("id")?.as_str()?;
            POLLERS.iter().find(|(known, _, _)| *known == id).map(|(known, _, _)| Command::Refresh(known))
        }
        _ => None,
    }
}

/// True when the human put this service's pill on the island (main or declared).
pub fn declared(prefs: &crate::prefs::Prefs, id: &str) -> bool {
    prefs.main_pill() == id || prefs.declared_pills().iter().any(|p| p == id)
}
