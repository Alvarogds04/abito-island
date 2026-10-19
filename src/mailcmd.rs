//! #490 — closed `mail_action` for the island's mail card. Slice 1: `{action:"send"}` through
//! the Resend HTTP API with the user's own key (keychain only, never read back to the page).
//!
//! Adapted from NotchBuddy Sources/App/IslandViewContent.swift (`sendMail`, `sendViaResend`)
//! @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Same request (Bearer key, `from`/`to`/
//! `subject`/`text`, base64 `attachments`, 200/201 = sent, an empty subject falls back to the
//! file name or "File", an empty body is sent as one space). Differences: Abito has no Apple
//! Mail fallback; with no Resend account the answer is `not_configured` (SMTP is the next
//! slice). Nothing here logs, stores or returns the key.
use crate::bridge::BridgeError;
use crate::secrets::{SecretStore, StoreError};
use base64::Engine;
use serde_json::{json, Map, Value};

#[cfg(test)]
#[path = "mailcmd_tests.rs"]
mod tests;

/// The one real endpoint. Tests pass a loopback URL; the host never takes one from the page.
pub const RESEND_URL: &str = "https://api.resend.com/emails";
pub const KEY_ID: &str = "resend-api-key";
pub const FROM_ID: &str = "resend-from";
pub const MAX_TO: usize = 254;
pub const MAX_SUBJECT: usize = 120;
pub const MAX_BODY: usize = 4000;
/// Same cap as chat attachments (`uploads::MAX_FILE_BYTES`), applied to the decoded bytes.
pub const MAX_ATTACHMENT_BYTES: usize = crate::uploads::MAX_FILE_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub name: String,
    /// Already-validated base64 (standard alphabet), passed through to Resend as is.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub attachment: Option<Attachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailError {
    /// The service answered something other than 200/201 (or redirected).
    Rejected,
    /// No connection, timeout or an unreadable answer.
    Network,
}

fn bad() -> BridgeError {
    BridgeError::denied("invalid mail request")
}

fn has_control(s: &str, keep_whitespace: bool) -> bool {
    s.chars().any(|c| c.is_control() && !(keep_whitespace && matches!(c, '\n' | '\t')))
}

/// One plain address: no whitespace, one `@`, a dotted domain (not a deliverability check).
fn address_ok(a: &str) -> bool {
    if a.is_empty() || a.chars().count() > MAX_TO || a.chars().any(|c| c.is_whitespace() || matches!(c, ',' | ';' | '<' | '>')) {
        return false;
    }
    let mut parts = a.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    let labels: Vec<&str> = domain.split('.').collect();
    !local.is_empty() && labels.len() >= 2 && labels.iter().all(|l| !l.is_empty())
}

/// Closed schema: `{action:"send", to, subject, body, attachment?:{name,data}}`.
pub fn parse_mail(payload: &Value) -> Result<Draft, BridgeError> {
    let map = payload.as_object().ok_or_else(bad)?;
    if map.get("action").and_then(Value::as_str) != Some("send") {
        return Err(bad());
    }
    let has_attachment = map.contains_key("attachment");
    if map.len() != 4 + usize::from(has_attachment) {
        return Err(bad());
    }
    let text = |k: &str| map.get(k).and_then(Value::as_str).ok_or_else(bad);
    let to = text("to")?.trim_matches(' ').to_owned();
    let subject = text("subject")?.to_owned();
    let body = text("body")?.to_owned();
    if !address_ok(&to)
        || subject.chars().count() > MAX_SUBJECT
        || has_control(&subject, false)
        || body.chars().count() > MAX_BODY
        || has_control(&body, true)
    {
        return Err(bad());
    }
    let attachment = if has_attachment { Some(parse_attachment(map.get("attachment"))?) } else { None };
    let subject = if subject.trim().is_empty() {
        attachment.as_ref().map_or_else(|| "File".to_owned(), |a| a.name.clone())
    } else {
        subject
    };
    Ok(Draft { to, subject, body, attachment })
}

fn parse_attachment(v: Option<&Value>) -> Result<Attachment, BridgeError> {
    let obj: &Map<String, Value> = v.and_then(Value::as_object).ok_or_else(bad)?;
    if obj.len() != 2 {
        return Err(bad());
    }
    let name = obj.get("name").and_then(Value::as_str).ok_or_else(bad)?;
    let data = obj.get("data").and_then(Value::as_str).ok_or_else(bad)?;
    // Check the size before decoding: base64 is 4 chars per 3 bytes.
    if data.is_empty() || data.len() > MAX_ATTACHMENT_BYTES / 3 * 4 + 4 {
        return Err(bad());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| bad())?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(bad());
    }
    Ok(Attachment { name: crate::uploads::sanitize_name(name), data: data.to_owned() })
}

/// The Resend request body (NotchBuddy `payload`).
pub fn resend_body(from: &str, d: &Draft) -> Value {
    let mut body = json!({
        "from": from,
        "to": [d.to],
        "subject": d.subject,
        "text": if d.body.is_empty() { " " } else { d.body.as_str() },
    });
    if let Some(a) = &d.attachment {
        body["attachments"] = json!([{ "filename": a.name, "content": a.data }]);
    }
    body
}

/// POSTs one mail. 200 and 201 are the only successes; redirects are never followed and
/// nothing about the answer body is read or surfaced.
#[cfg(target_os = "linux")]
pub async fn send_resend(endpoint: &str, key: &str, from: &str, d: &Draft) -> Result<(), MailError> {
    use std::time::Duration;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| MailError::Network)?;
    let payload = serde_json::to_vec(&resend_body(from, d)).map_err(|_| MailError::Network)?;
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| MailError::Network)?;
    match response.status().as_u16() {
        200 | 201 => Ok(()),
        _ => Err(MailError::Rejected),
    }
}

#[cfg(not(target_os = "linux"))]
pub async fn send_resend(_: &str, _: &str, _: &str, _: &Draft) -> Result<(), MailError> {
    Err(MailError::Network)
}

/// What the keychain holds for Resend, or the answer to give instead of sending.
pub fn resend_credentials(store: &dyn SecretStore) -> Result<(String, String), Value> {
    let read = |k: &str| match store.read(k) {
        Ok(v) => Ok(v.filter(|s| !s.is_empty())),
        Err(StoreError::Unavailable | StoreError::Failed) => Err(json!({"ok": false, "reason": "keychain_unavailable"})),
    };
    let key = read(KEY_ID)?;
    let from = read(FROM_ID)?;
    match (key, from) {
        (Some(k), Some(f)) => Ok((k, f)),
        // NotchBuddy: «Set sender address in Settings.» when only the key is set.
        (Some(_), None) => Err(json!({"ok": false, "reason": "no_sender"})),
        _ => Err(json!({"ok": false, "reason": "not_configured"})),
    }
}

pub fn outcome(r: Result<(), MailError>) -> Value {
    match r {
        Ok(()) => json!({"ok": true}),
        Err(MailError::Rejected) => json!({"ok": false, "reason": "rejected"}),
        Err(MailError::Network) => json!({"ok": false, "reason": "network"}),
    }
}

/// Credentials → one send → the page's answer (`{ok}` or `{ok:false, reason}`; no secrets).
pub async fn send_answer(store: &dyn SecretStore, endpoint: &str, d: &Draft) -> Value {
    match resend_credentials(store) {
        Ok((key, from)) => outcome(send_resend(endpoint, &key, &from, d).await),
        Err(answer) => answer,
    }
}
