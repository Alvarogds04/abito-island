//! #306 — client of the island agent protocol `island-agent/1` (the daemon of
//! `apps/desktop-daemon`), PURE part: session handoff, frame codec, the closed set
//! of commands the settings UI may issue, and the allowlisted view state.
//!
//! Security model (the reason this lives in Rust, not in the WebView):
//! - the per-launch TOKEN and the socket ENDPOINT never leave this module: `Session`
//!   redacts the token in `Debug`, and `ClientState` (the only thing serialized to the
//!   UI) has no field that could carry either;
//! - the UI can only send the commands of [`parse_ui_command`] (no `send`, no `abort`,
//!   no `settings_set`, no `local_account_create`: nothing that reaches the chat or
//!   the engine);
//! - API keys travel ONLY as `auth_reply` values, are validated, never stored in the
//!   state, never echoed, and redacted from `Debug`;
//! - server frames are folded into allowlisted fields; unknown or malformed frames are
//!   ignored (never forwarded raw).
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fmt;

#[cfg(test)]
#[path = "agentclient_tests.rs"]
mod tests;

pub const PROTOCOL: &str = "island-agent/1";
pub const MAX_SESSION_BYTES: usize = 4096;
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_REPLY_CHARS: usize = 4096;

// ---- session.json ----------------------------------------------------------------------
pub struct Session {
    pub endpoint: String,
    pub pid: u32,
    token: String,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session").field("endpoint", &self.endpoint).field("pid", &self.pid).field("token", &"<redacted>").finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionError;

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

impl Session {
    pub fn parse(text: &str) -> Result<Session, SessionError> {
        if text.len() > MAX_SESSION_BYTES {
            return Err(SessionError);
        }
        let v: Value = serde_json::from_str(text).map_err(|_| SessionError)?;
        let o = v.as_object().ok_or(SessionError)?;
        if o.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
            return Err(SessionError);
        }
        let token = o.get("token").and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 512 && !has_control(t)).ok_or(SessionError)?;
        let endpoint = o.get("endpoint").and_then(Value::as_str).ok_or(SessionError)?;
        if !endpoint_ok(endpoint) {
            return Err(SessionError);
        }
        let pid = o.get("pid").and_then(Value::as_u64).filter(|p| *p > 0 && *p <= u64::from(u32::MAX)).ok_or(SessionError)?;
        Ok(Session { endpoint: endpoint.to_owned(), pid: pid as u32, token: token.to_owned() })
    }

    /// The `hello` line for the handshake (the ONLY place the token is read).
    pub fn hello(&self) -> String {
        hello_line(&self.token)
    }
}

/// `<runtime>/p-XXXXXX/s`: absolute, normalized, no control bytes, exact leaf shape.
fn endpoint_ok(e: &str) -> bool {
    if !e.starts_with('/') || e.len() > 107 || has_control(e) {
        return false;
    }
    let parts: Vec<&str> = e.split('/').skip(1).collect();
    if parts.len() < 3 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return false;
    }
    let n = parts.len();
    let dir = parts[n - 2];
    parts[n - 1] == "s" && dir.len() == 8 && dir.starts_with("p-") && dir[2..].bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn hello_line(token: &str) -> String {
    format!("{{\"type\":\"hello\",\"protocol\":\"{PROTOCOL}\",\"token\":{}}}\n", serde_json::to_string(token).unwrap_or_default())
}

// ---- frame codec -------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    TooLarge,
    Malformed,
}

#[derive(Default)]
pub struct FrameBuffer {
    pending: Vec<u8>,
}

impl FrameBuffer {
    /// Feed bytes; returns the complete frames (objects) found. LF is the only separator.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, FrameError> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=at).collect();
            if line.len() > MAX_FRAME_BYTES + 1 {
                return Err(FrameError::TooLarge);
            }
            let v: Value = serde_json::from_slice(&line[..line.len() - 1]).map_err(|_| FrameError::Malformed)?;
            if !v.is_object() {
                return Err(FrameError::Malformed);
            }
            out.push(v);
        }
        if self.pending.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge);
        }
        Ok(out)
    }
}

// ---- the closed command set ---------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

pub enum UiCommand {
    /// Local: read the current state.
    View,
    /// Local: ask the daemon for every list again.
    Refresh,
    Wire(String),
    /// An answer to an `auth_prompt`; the value may be a secret and is redacted from Debug.
    AuthReply { flow_id: String, prompt_id: String, value: String },
}

impl fmt::Debug for UiCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UiCommand::View => f.write_str("View"),
            UiCommand::Refresh => f.write_str("Refresh"),
            UiCommand::Wire(w) => f.debug_tuple("Wire").field(w).finish(),
            UiCommand::AuthReply { flow_id, prompt_id, .. } => f
                .debug_struct("AuthReply").field("flow_id", flow_id).field("prompt_id", prompt_id).field("value", &"<redacted>").finish(),
        }
    }
}

fn ordered(fields: &[(&str, &str)]) -> String {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), serde_json::to_string(v).unwrap_or_default())).collect();
    format!("{{{}}}\n", body.join(","))
}

impl UiCommand {
    /// The wire line (empty for the local commands).
    pub fn line(&self) -> String {
        match self {
            UiCommand::Wire(w) => w.clone(),
            UiCommand::AuthReply { flow_id, prompt_id, value } => ordered(&[("type", "auth_reply"), ("flowId", flow_id), ("promptId", prompt_id), ("value", value)]),
            _ => String::new(),
        }
    }

    /// The five list requests a refresh sends.
    pub fn refresh_lines(&self) -> Vec<String> {
        ["providers_list", "accounts_list", "profiles_list", "connectors_list", "settings_get"].iter().map(|t| ordered(&[("type", t)])).collect()
    }
}

fn strict_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}
fn flow_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':'))
}
fn label_ok(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 80 && !has_control(s)
}

pub fn parse_ui_command(payload: &Value) -> Result<UiCommand, CommandError> {
    let map: &Map<String, Value> = payload.as_object().ok_or(CommandError)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(CommandError)?;
    let get = |k: &str| map.get(k).and_then(Value::as_str).ok_or(CommandError);
    let exact = |n: usize| if map.len() == n { Ok(()) } else { Err(CommandError) };
    let wire = |fields: &[(&str, &str)]| Ok(UiCommand::Wire(ordered(fields)));
    match action {
        "view" => exact(1).map(|_| UiCommand::View),
        "refresh" => exact(1).map(|_| UiCommand::Refresh),
        // #310: one click connects a code agent. The id is an allowlist, so nothing the page sends can
        // name a path, a command or any other agent; the daemon does the install (with a backup).
        "agents_list" => {
            exact(1)?;
            wire(&[("type", "agents_list")])
        }
        "agent_connect" | "agent_disconnect" => {
            exact(2)?;
            let id = get("agentId")?;
            if !AGENT_IDS.contains(&id) {
                return Err(CommandError);
            }
            wire(&[("type", action), ("agentId", id)])
        }
        "connectors_list" | "settings_get" | "profile_deactivate" => {
            exact(1)?;
            wire(&[("type", action)])
        }
        "account_create" => {
            exact(3)?;
            let (provider, label) = (get("provider")?, get("label")?);
            if !strict_id(provider) || !label_ok(label) {
                return Err(CommandError);
            }
            wire(&[("type", "account_create"), ("provider", provider), ("label", label)])
        }
        "auth_start" => {
            exact(3)?;
            let (id, method) = (get("accountId")?, get("method")?);
            if !strict_id(id) || !matches!(method, "oauth" | "api_key") {
                return Err(CommandError);
            }
            wire(&[("type", "auth_start"), ("accountId", id), ("method", method)])
        }
        "auth_cancel" => {
            exact(2)?;
            let f = get("flowId")?;
            if !flow_id(f) {
                return Err(CommandError);
            }
            wire(&[("type", "auth_cancel"), ("flowId", f)])
        }
        "auth_reply" => {
            exact(4)?;
            let (f, p, v) = (get("flowId")?, get("promptId")?, get("value")?);
            if !flow_id(f) || !flow_id(p) || v.is_empty() || v.chars().count() > MAX_REPLY_CHARS || has_control(v) {
                return Err(CommandError);
            }
            Ok(UiCommand::AuthReply { flow_id: f.into(), prompt_id: p.into(), value: v.into() })
        }
        "account_logout" | "account_remove" => {
            exact(2)?;
            let id = get("accountId")?;
            if !strict_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", action), ("accountId", id)])
        }
        "profile_select" => {
            exact(2)?;
            let id = get("id")?;
            if !strict_id(id) {
                return Err(CommandError);
            }
            wire(&[("type", "profile_select"), ("id", id)])
        }
        _ => Err(CommandError),
    }
}

// ---- the view state the UI sees -----------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NoDaemon,
    BadSession,
    Refused,
    Lost,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClientState {
    connection: String,
    providers: Vec<Value>,
    accounts: Vec<Value>,
    profiles: Value,
    auth: Value,
    connectors: Value,
    /// The engine's last refusal of a command: a code from its closed set and a counter, so the
    /// page can tell "an error arrived AFTER my command" without parsing any text.
    last_error: Value,
    /// The engine's `agents` frame, folded to a flat closed view (None until it speaks).
    agents: Value,
}

/// The code agents the island can connect (the installers exist for these).
pub const AGENT_IDS: [&str; 3] = ["claude-code", "codex", "opencode"];

fn clip(v: &Value, key: &str, max: usize) -> Value {
    v.get(key).and_then(Value::as_str).map(|s| Value::from(s.chars().filter(|c| !c.is_control()).take(max).collect::<String>())).unwrap_or(Value::Null)
}
fn https(v: &Value, key: &str) -> Value {
    match v.get(key).and_then(Value::as_str) {
        Some(u) if u.starts_with("https://") && u.len() <= 2000 && !has_control(u) => Value::from(u),
        _ => Value::Null,
    }
}

impl ClientState {
    fn new(connection: &str) -> ClientState {
        ClientState {
            connection: connection.into(),
            providers: vec![],
            accounts: vec![],
            profiles: json!({"profiles": [], "active": null}),
            auth: json!({"flowId": null, "prompt": null, "event": null, "last": null}),
            connectors: json!({"state": "loading", "items": []}),
            last_error: json!({"code": null, "n": 0}),
            agents: Value::Null,
        }
    }
    pub fn connected() -> ClientState {
        ClientState::new("connected")
    }
    pub fn disconnected(reason: Reason) -> ClientState {
        ClientState::new(match reason {
            Reason::NoDaemon => "no_daemon",
            Reason::BadSession => "bad_session",
            Reason::Refused => "refused",
            Reason::Lost => "lost",
        })
    }

    pub fn note_connectors_error(&mut self, code: &str) {
        let state = if code == "unavailable" { "unavailable" } else { "failed" };
        self.connectors = json!({"state": state, "items": []});
    }

    /// Fold one server frame in. Unknown or malformed frames change nothing.
    pub fn apply(&mut self, frame: &Value) -> Result<(), ()> {
        let Some(t) = frame.get("type").and_then(Value::as_str) else { return Ok(()) };
        let items = |key: &str| frame.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        match t {
            "providers" => {
                self.providers = items("providers").iter().take(100).map(|p| json!({
                    "id": clip(p, "id", 64), "name": clip(p, "name", 120), "configured": p.get("configured").and_then(Value::as_bool).unwrap_or(false),
                    "methods": p.get("methods").and_then(Value::as_array).map(|m| m.iter().filter_map(Value::as_str).filter(|x| matches!(*x, "oauth" | "api_key")).collect::<Vec<_>>()).unwrap_or_default(),
                })).collect();
            }
            "accounts" => {
                self.accounts = items("accounts").iter().take(100).map(account_view).collect();
            }
            "account" => {
                if let Some(a) = frame.get("account") {
                    let v = account_view(a);
                    match self.accounts.iter_mut().find(|x| x["accountId"] == v["accountId"]) {
                        Some(slot) => *slot = v,
                        None => self.accounts.push(v),
                    }
                }
            }
            "profiles" => {
                self.profiles = json!({
                    "profiles": items("profiles").iter().take(64).map(|p| json!({"id": clip(p, "id", 64), "label": clip(p, "label", 80), "provider": clip(p, "provider", 64), "modelId": clip(p, "modelId", 200)})).collect::<Vec<_>>(),
                    "active": clip(frame, "active", 64),
                });
            }
            "auth_started" => {
                self.auth = json!({"flowId": clip(frame, "flowId", 128), "prompt": null, "event": null, "last": null});
            }
            "auth_prompt" => {
                let options: Vec<Value> = items("options").iter().take(20).map(|o| json!({"id": clip(o, "id", 128), "label": clip(o, "label", 200)})).collect();
                self.auth["prompt"] = json!({
                    "flowId": clip(frame, "flowId", 128), "promptId": clip(frame, "promptId", 128), "accountId": clip(frame, "accountId", 64),
                    "kind": clip(frame, "kind", 32), "message": clip(frame, "message", 1000), "placeholder": clip(frame, "placeholder", 200),
                    "secret": frame.get("secret").and_then(Value::as_bool).unwrap_or(false), "options": options,
                });
            }
            "auth_event" => {
                self.auth["event"] = json!({
                    "kind": clip(frame, "kind", 32), "message": clip(frame, "message", 1000), "instructions": clip(frame, "instructions", 1000),
                    "userCode": clip(frame, "userCode", 100), "url": https(frame, "url"), "verificationUri": https(frame, "verificationUri"),
                });
            }
            "auth_done" => {
                self.auth["prompt"] = Value::Null;
                self.auth["event"] = Value::Null;
                self.auth["last"] = json!({
                    "accountId": clip(frame, "accountId", 64), "ok": frame.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "cancelled": frame.get("cancelled").and_then(Value::as_bool).unwrap_or(false), "message": clip(frame, "message", 300),
                });
            }
            "connectors" => {
                let rows: Vec<Value> = items("connectors").iter().take(128).map(|c| json!({
                    "id": clip(c, "id", 64), "label": clip(c, "label", 128), "mode": clip(c, "mode", 32),
                    "enabled": c.get("enabled").and_then(Value::as_bool).unwrap_or(false), "configured": c.get("configured").and_then(Value::as_bool).unwrap_or(false),
                    "status": c.get("status").map(|s| clip(s, "state", 32)).unwrap_or(Value::Null),
                })).collect();
                self.connectors = json!({"state": "ready", "items": rows});
            }
            "agents" => {
                // Only the three known ids, one entry each (the first wins), a closed state and a closed
                // detail. No name, path or hook line from the engine is ever forwarded to the page.
                let Some(list) = frame.get("agents").and_then(Value::as_array) else { return Ok(()) };
                let mut seen: Vec<&str> = Vec::new();
                let mut out: Vec<Value> = Vec::new();
                for a in list.iter().take(64) {
                    let Some(id) = a.get("id").and_then(Value::as_str).and_then(|i| AGENT_IDS.iter().copied().find(|k| *k == i)) else { continue };
                    if seen.contains(&id) {
                        continue;
                    }
                    seen.push(id);
                    let state = match a.get("state").and_then(Value::as_str) {
                        Some(x @ ("not_connected" | "connected" | "outdated" | "working" | "unavailable" | "error")) => x,
                        _ => "error",
                    };
                    let detail = match a.get("detail").and_then(Value::as_str) {
                        Some(d @ ("config_invalid" | "not_writable" | "backup_failed")) => json!(d),
                        _ => Value::Null,
                    };
                    out.push(json!({"id": id, "state": state, "backup": a.get("backup").and_then(Value::as_bool).unwrap_or(false), "detail": detail}));
                }
                self.agents = Value::Array(out);
            }
            "error" => {
                // the daemon's closed code set (anything else reads as plain `failed`), never free text
                let code = match frame.get("code").and_then(Value::as_str) {
                    Some(c @ ("bad_request" | "busy" | "not_busy" | "unavailable" | "rate_limited" | "unknown_ask" | "failed")) => c,
                    _ => "failed",
                };
                let n = self.last_error["n"].as_u64().unwrap_or(0) + 1;
                self.last_error = json!({"code": code, "n": n});
                if frame.get("code").and_then(Value::as_str) == Some("unavailable") && self.connectors["state"] == "loading" {
                    self.note_connectors_error("unavailable");
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn account_view(a: &Value) -> Value {
    let mut v = json!({
        "accountId": clip(a, "accountId", 64), "label": clip(a, "label", 80), "provider": clip(a, "provider", 64),
        "authMethod": match a.get("authMethod").and_then(Value::as_str) { Some(m @ ("oauth" | "api_key")) => m, _ => "none" },
        "configured": a.get("configured").and_then(Value::as_bool).unwrap_or(false),
    });
    if a.get("local").and_then(Value::as_bool) == Some(true) {
        v["local"] = json!(true);
    }
    v
}
