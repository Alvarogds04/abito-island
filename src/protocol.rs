//! Pure protocol module for the Pi → desktop notice transport — unit M2.
//!
//! Port of the behaviour-carrying half of the committed Electron sources
//! (read-only, `worktrees/legacy-electron/apps/desktop`):
//! - `core.cjs` `LIMITS` (line 3), `token`/`sessionToken` (lines 6-7),
//!   `decode` (lines 10-33), `NoticeStore` (lines 35-60),
//! - `transport.cjs` stream framing (lines 63-86: batch cap, newline
//!   splitting, oversized tail) and the per-connection frame quota
//!   (lines 73-75).
//!
//! Pure module by contract: no sockets, no clock — `now` is always passed in,
//! so every window (freshness, expiry, rate) is unit-testable without sleep.
//! The unit tests mirror the applicable cases of the legacy
//! `test/core.test.cjs` and the framing cases of `test/transport.test.cjs`,
//! and were written test-first (RED → GREEN).
//!
//! Protocol, unchanged wire format: newline-delimited JSON frames,
//! `{"v":1,"type",…,"project","sessionId","at"[,"id"]}`; `hello` opens the
//! handshake, the receiver answers one exact `{"v":1,"type":"ready"}\n`,
//! then `heartbeat`/`settled` frames follow; only `settled` can become a
//! notice. **A settled turn is never a successful task or a passed test** —
//! the notice text stays generic (display only).

use std::collections::HashMap;
use std::fmt;

use serde::Serialize;
use serde_json::Value;

// --- LIMITS (core.cjs line 3: byte-for-byte values) ------------------------

pub const FRAME_BYTES: usize = 512;
pub const FRESH_MS: u64 = 15_000;
pub const EXPIRY_MS: u64 = 60_000;
pub const QUEUE: usize = 8;
pub const DEDUPE: usize = 256;
pub const CONNECTIONS: usize = 4;
pub const FRAMES_PER_MINUTE: u32 = 120;
pub const HANDSHAKE_MS: u64 = 3_000;
pub const IDLE_MS: u64 = 30_000;
/// transport.cjs line 66: a batch is bounded at `frameBytes * 8` even when it
/// contains many individually valid frames.
pub const BATCH_FACTOR: usize = 8;
/// transport.cjs line 74: the per-connection frame window.
pub const RATE_WINDOW_MS: u64 = 60_000;
/// transport.cjs line 81: the exact handshake answer, newline included
/// (adapter.cjs compares the bytes literally and closes on any deviation).
pub const READY_LINE: &[u8] = b"{\"v\":1,\"type\":\"ready\"}\n";

// --- identity helpers (core.cjs lines 4-7) ---------------------------------

/// `core.cjs projectId`: SHA-256 of the real path, lowercase hex — the same
/// bytes `createHash('sha256').update(cwd).digest('hex')` produces in Node.
pub fn project_id(cwd: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(cwd.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// `core.cjs sessionToken`: session ids are labels, never paths —
/// `[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?`, at most 128 chars.
pub fn session_token(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let bytes = value.as_bytes();
    let last = bytes.len() - 1;
    bytes.iter().enumerate().all(|(index, &byte)| {
        if byte.is_ascii_alphanumeric() {
            return true; // first and last must be alphanumeric; checked by position below
        }
        index != 0 && index != last && matches!(byte, b'.' | b'_' | b'-')
    })
}

/// `core.cjs token`: event ids are `[a-zA-Z0-9_-]{1,128}`.
pub fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

// --- messages ---------------------------------------------------------------

/// One decoded wire frame. `kind` is the `type` field on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    #[serde(rename = "v")]
    pub v: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "project")]
    pub project: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "at")]
    pub at: i64,
    #[serde(rename = "id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// The handshake a connection proved: afterwards every frame must match this
/// session and may not be older than the hello (`core.cjs decode`, identity
/// branch: "Invalid session or replay").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub project: String,
    pub session_id: String,
    pub at: i64,
}

/// Rejections, one per legacy `throw` message in `core.cjs decode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// `'Invalid frame'`: more than `frameBytes` bytes.
    FrameTooLarge,
    /// `'Invalid frame'`: not valid UTF-8 JSON (fatal decoder in core.cjs).
    InvalidFrame,
    /// `'Invalid message'`: parsed but not a JSON object.
    InvalidMessage,
    /// `'Invalid schema or scope'`: key set, `v`, project, session, timestamp.
    InvalidSchemaOrScope,
    /// `'Handshake required'`: non-hello before an identity exists.
    HandshakeRequired,
    /// `'Invalid session or replay'`: post-handshake session/time violation.
    InvalidSessionOrReplay,
    /// `'Invalid event id'`: `settled` without a valid `id`.
    InvalidEventId,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            DecodeError::FrameTooLarge | DecodeError::InvalidFrame => "Invalid frame",
            DecodeError::InvalidMessage => "Invalid message",
            DecodeError::InvalidSchemaOrScope => "Invalid schema or scope",
            DecodeError::HandshakeRequired => "Handshake required",
            DecodeError::InvalidSessionOrReplay => "Invalid session or replay",
            DecodeError::InvalidEventId => "Invalid event id",
        };
        write!(f, "{text}")
    }
}

impl std::error::Error for DecodeError {}

/// `core.cjs decode`: parse one frame and validate it against `project` and
/// the connection `identity` (None until the handshake completed).
pub fn decode(
    bytes: &[u8],
    project: &str,
    identity: Option<&Identity>,
    now: u64,
) -> Result<Message, DecodeError> {
    // Size gate first (core.cjs line 11), then a fatal UTF-8 JSON parse —
    // a decoding failure and a non-object are distinct legacy throws.
    if bytes.len() > FRAME_BYTES {
        return Err(DecodeError::FrameTooLarge);
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| DecodeError::InvalidFrame)?;
    let Value::Object(object) = value else {
        return Err(DecodeError::InvalidMessage);
    };
    // Exact key set: `id` only participates when `type` is exactly "settled"
    // (core.cjs line 16: keys.length must equal Object.keys().length).
    let kind = object.get("type").and_then(Value::as_str);
    let mut keys: Vec<&str> = vec!["v", "type", "project", "sessionId", "at"];
    if kind == Some("settled") {
        keys.push("id");
    }
    if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    // The remaining schema half of the combined legacy condition: every
    // violation is the same `Invalid schema or scope` throw.
    if json_integer(object.get("v")) != Some(1) {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    let expected_project = project;
    let project = object
        .get("project")
        .and_then(Value::as_str)
        .ok_or(DecodeError::InvalidSchemaOrScope)?;
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or(DecodeError::InvalidSchemaOrScope)?;
    let at = json_integer(object.get("at")).ok_or(DecodeError::InvalidSchemaOrScope)?;
    let message = Message {
        v: 1,
        kind: kind.unwrap_or_default().to_string(),
        project: project.to_string(),
        session_id: session_id.to_string(),
        at,
        id: object.get("id").and_then(Value::as_str).map(str::to_string),
    };
    validate(&message, expected_project, identity, now)?;
    Ok(message)
}

/// The validation half of `decode`, reusable at the `NoticeStore::accept`
/// boundary (core.cjs re-decodes there so callers cannot bypass
/// normalization).
pub fn validate(
    message: &Message,
    project: &str,
    identity: Option<&Identity>,
    now: u64,
) -> Result<(), DecodeError> {
    // --- schema + scope (core.cjs lines 18-22) ---
    if message.v != 1
        || message.project != project
        || !session_token(&message.session_id)
        || !safe_integer(message.at)
        || message.at as i128 > now as i128
        || (message.at as i128) < (now.saturating_sub(FRESH_MS) as i128)
    {
        return Err(DecodeError::InvalidSchemaOrScope);
    }
    // --- identity phase (core.cjs lines 24-29) ---
    match identity {
        None => {
            if message.kind != "hello" {
                return Err(DecodeError::HandshakeRequired);
            }
        }
        Some(proved) => {
            if message.kind != "heartbeat" && message.kind != "settled" {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
            if message.session_id != proved.session_id || message.project != proved.project {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
            if message.at < proved.at {
                return Err(DecodeError::InvalidSessionOrReplay);
            }
        }
    }
    // --- settlement event id (core.cjs line 31) ---
    if message.kind == "settled"
        && !message
            .id
            .as_deref()
            .map(token)
            .unwrap_or(false)
    {
        return Err(DecodeError::InvalidEventId);
    }
    Ok(())
}

/// `Number.isSafeInteger`: an integer magnitude within 2^53 − 1. JSON
/// numbers without a decimal/exponent parse straight to integers; the rest
/// must be integral finite floats (parity with JS's rounding-free checks).
fn json_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                return (integer.abs() <= MAX_SAFE_INTEGER).then_some(integer);
            }
            let float = number.as_f64()?;
            if float.fract() == 0.0 && float.is_finite() && float.abs() <= MAX_SAFE_INTEGER as f64 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Largest integer JavaScript still calls a safe integer (2^53 − 1).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn safe_integer(value: i64) -> bool {
    value.abs() <= MAX_SAFE_INTEGER
}

// --- framing (transport.cjs lines 63-86) ------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingError {
    /// line 66: `pending + chunk > frameBytes * 8` — destroy before reading.
    BatchCap,
    /// line 86: after all complete frames are yielded, a remainder longer
    /// than `frameBytes` can never become a valid frame — destroy.
    OversizedTail,
}

/// Result of one inbound chunk: complete frames in arrival order, plus a
/// fatal condition the connection must honour **after** those frames are
/// processed (legacy processes every complete line first, then checks the
/// tail).
#[derive(Debug, PartialEq, Eq)]
pub struct Framed {
    pub frames: Vec<Vec<u8>>,
    pub fatal: Option<FramingError>,
}

/// Newline-delimited stream framer with the legacy batch/tail bounds.
pub struct Framer {
    pending: Vec<u8>,
}

impl Framer {
    pub fn new() -> Self {
        Framer {
            pending: Vec::new(),
        }
    }

    /// Feed one read from the socket. `Err` means the connection dies before
    /// this chunk is looked at at all (batch cap is checked first, exactly
    /// like transport.cjs line 66).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Framed, FramingError> {
        if self.pending.len() + chunk.len() > FRAME_BYTES * BATCH_FACTOR {
            return Err(FramingError::BatchCap);
        }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
            // The newline is framing, not payload (transport.cjs line 69).
            let frame: Vec<u8> = self.pending.drain(..=end).collect();
            frames.push(frame[..end].to_vec());
        }
        // Line 86 runs AFTER every complete frame of this chunk was yielded.
        let fatal = if self.pending.len() > FRAME_BYTES {
            Some(FramingError::OversizedTail)
        } else {
            None
        };
        Ok(Framed { frames, fatal })
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

impl Default for Framer {
    fn default() -> Self {
        Self::new()
    }
}

// --- per-connection frame quota (transport.cjs lines 73-75) -----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaError {
    /// `'Rate exceeded'` — the connection is destroyed (legacy `throw`
    /// inside the data handler ends the socket).
    RateExceeded,
}

/// Fixed one-minute window, one per connection: reset only when the current
/// window is at least 60 000 ms old, every frame (valid or not) counts, and
/// frame `FRAMES_PER_MINUTE + 1` is rejected.
pub struct FrameQuota {
    frames: u32,
    period_start_ms: u128,
}

impl FrameQuota {
    pub fn new(now_ms: u128) -> Self {
        FrameQuota {
            frames: 0,
            period_start_ms: now_ms,
        }
    }

    pub fn check(&mut self, now_ms: u128) -> Result<(), QuotaError> {
        // transport.cjs lines 74-75: fixed window, every frame counts,
        // rejected frames keep consuming budget.
        if now_ms.saturating_sub(self.period_start_ms) >= RATE_WINDOW_MS as u128 {
            self.frames = 0;
            self.period_start_ms = now_ms;
        }
        self.frames += 1;
        if self.frames > FRAMES_PER_MINUTE {
            return Err(QuotaError::RateExceeded);
        }
        Ok(())
    }
}

// --- notice store (core.cjs lines 35-60) ------------------------------------

/// One displayed notice. The text is fixed and generic on purpose:
/// settling a turn never claims the task went well or the tests passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub session_id: String,
    pub at: i64,
    pub expires_at: i64,
    pub title: &'static str,
    pub detail: &'static str,
    pub emotion: &'static str,
}

pub const NOTICE_TITLE: &str = "Pi terminó su turno";
pub const NOTICE_DETAIL: &str =
    "No confirma que la tarea haya salido bien ni que las pruebas hayan pasado.";
pub const NOTICE_EMOTION: &str = "idle";

/// Bounded queue (8) + session-scoped dedupe (256) + one-minute expiry —
/// ported from `core.cjs NoticeStore`.
pub struct NoticeStore {
    project: String,
    queue: Vec<Notice>,
    seen: HashMap<(String, String), u64>,
}

impl NoticeStore {
    pub fn new(project: impl Into<String>) -> Self {
        NoticeStore {
            project: project.into(),
            queue: Vec::new(),
            seen: HashMap::new(),
        }
    }

    /// Drop expired queue entries and expired dedupe keys (core.cjs line 37).
    pub fn prune(&mut self, now: u64) {
        self.queue.retain(|entry| entry.expires_at > now as i64);
        self.seen.retain(|_, expiry| *expiry > now);
    }

    /// Re-validate at this boundary, ignore anything but `settled`, dedupe by
    /// `sessionId:id`, saturate at `DEDUPE`, enqueue bounded by `QUEUE`.
    /// Returns true only for a notice that actually entered the queue.
    pub fn accept(&mut self, event: &Message, now: u64) -> bool {
        self.prune(now);
        // Also validate at this boundary: callers cannot bypass normalization
        // (core.cjs line 43 re-decodes the event with `now` as the clock).
        let boundary = Identity {
            project: self.project.clone(),
            session_id: event.session_id.clone(),
            at: now.saturating_sub(FRESH_MS) as i64,
        };
        if validate(event, &self.project, Some(&boundary), now).is_err() {
            return false;
        }
        if event.kind != "settled" {
            return false; // a hello or heartbeat is never a notice
        }
        let Some(id) = event.id.clone() else {
            return false;
        };
        let key = (event.session_id.clone(), id.clone());
        if self.seen.contains_key(&key) || self.seen.len() >= DEDUPE {
            return false;
        }
        self.seen.insert(key, now + EXPIRY_MS);
        self.queue.push(Notice {
            id,
            session_id: event.session_id.clone(),
            at: event.at,
            expires_at: event.at.saturating_add(EXPIRY_MS as i64),
            title: NOTICE_TITLE,
            detail: NOTICE_DETAIL,
            emotion: NOTICE_EMOTION,
        });
        if self.queue.len() > QUEUE {
            let excess = self.queue.len() - QUEUE;
            self.queue.drain(0..excess);
        }
        true
    }

    /// Pruned copy of the queue, oldest first (main.cjs snapshot order).
    pub fn snapshot(&mut self, now: u64) -> Vec<Notice> {
        self.prune(now);
        self.queue.clone()
    }

    /// Remove one exact notice (`id` + `sessionId`); dedupe is untouched, so
    /// a dismissed event can never reappear (core.test.cjs line 45).
    pub fn dismiss(&mut self, id: &str, session_id: &str, now: u64) {
        self.prune(now);
        self.queue
            .retain(|entry| !(entry.id == id && entry.session_id == session_id));
    }

    pub fn project(&self) -> &str {
        &self.project
    }
}

// --- tests: written first, RED then GREEN -----------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const NOW: u64 = 100_000;

    fn project() -> String {
        project_id("/project")
    }

    fn hello_value(project: &str) -> Value {
        json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW})
    }

    fn settled_value(project: &str) -> Value {
        json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1",
               "at":NOW, "id":"event-1"})
    }

    fn parse(value: &Value, project: &str, identity: Option<&Identity>, now: u64) -> Result<Message, DecodeError> {
        decode(value.to_string().as_bytes(), project, identity, now)
    }

    fn identity_of(project: &str) -> Identity {
        Identity {
            project: project.to_string(),
            session_id: "session-1".to_string(),
            at: NOW as i64,
        }
    }

    // ported from legacy test/core.test.cjs:19
    #[test]
    fn strict_handshake_schema_scope_identity_bytes_and_timestamps() {
        let project = project();
        let hello = hello_value(&project);
        let parsed = parse(&hello, &project, None, NOW).expect("a strict handshake is accepted");
        assert_eq!(parsed.session_id, "session-1");
        for bad in [
            json!(null),
            json!([]),
            json!({}),
            json!({"v":2, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW}),
            json!({"v":1, "type":"hello", "project":"f".repeat(64), "sessionId":"session-1", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"../secret", "at":NOW}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW, "text":"private"}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW + 1}),
            json!({"v":1, "type":"hello", "project":project, "sessionId":"session-1", "at":NOW - (FRESH_MS + 1)}),
        ] {
            assert!(parse(&bad, &project, None, NOW).is_err(), "must reject {bad}");
        }
        // byte-level gates: oversized frame and invalid UTF-8
        let oversized = vec![b'x'; FRAME_BYTES + 1];
        assert!(decode(&oversized, &project, None, NOW).is_err());
        assert!(decode(&[0xff], &project, None, NOW).is_err());
        // a settlement is not a handshake
        let complete = settled_value(&project);
        assert!(parse(&complete, &project, None, NOW).is_err(), "handshake required");
        let identity = identity_of(&project);
        let wrong_session = json!({"v":1, "type":"settled", "project":project,
                                   "sessionId":"other", "at":NOW, "id":"event-1"});
        assert!(parse(&wrong_session, &project, Some(&identity), NOW).is_err());
        let replay = json!({"v":1, "type":"settled", "project":project,
                            "sessionId":"session-1", "at":NOW - 1, "id":"event-1"});
        assert!(parse(&replay, &project, Some(&identity), NOW).is_err(), "at < identity.at is replay");
        assert!(parse(&hello, &project, Some(&identity), NOW).is_err(), "hello after handshake");
        // and the happy post-handshake path really works
        assert!(parse(&complete, &project, Some(&identity), NOW).is_ok());
    }

    // ported from legacy test/core.test.cjs:35
    #[test]
    fn only_generic_settlement_never_proves_success() {
        let project = project();
        let identity = identity_of(&project);
        let event = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        let notice = store.snapshot(NOW).into_iter().next().expect("one notice");
        assert_eq!(notice.title, "Pi terminó su turno");
        assert!(notice.detail.starts_with("No confirma"), "generic detail: {}", notice.detail);
        assert!(notice.detail.contains("pruebas"), "generic detail: {}", notice.detail);
        assert_eq!(notice.emotion, "idle");
        // a stowaway key, a custom text or an action verb is a schema error —
        // the producer can never narrate an outcome or ask for an approval.
        for extra in [
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "success":true}),
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "text":"<script>secret</script>"}),
            json!({"v":1, "type":"settled", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1", "action":"approve"}),
        ] {
            assert!(parse(&extra, &project, Some(&identity), NOW).is_err(), "must reject {extra}");
        }
        let wrong_type = json!({"v":1, "type":"tests_passed", "project":project, "sessionId":"session-1", "at":NOW, "id":"event-1"});
        assert!(parse(&wrong_type, &project, Some(&identity), NOW).is_err());
        assert!(parse(&wrong_type, &project, None, NOW).is_err());
    }

    // ported from legacy test/core.test.cjs:41
    #[test]
    fn bounded_queue_session_scoped_dedupe_expiry_and_saturation() {
        let project = project();
        let identity = identity_of(&project);
        let decode_at = |value: &Value, now: u64| decode(value.to_string().as_bytes(), &project, Some(&identity), now);
        let event = decode_at(&settled_value(&project), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(store.accept(&event, NOW));
        let event_id = event.id.clone().expect("settled carries id");
        store.dismiss(&event_id, &event.session_id, NOW);
        assert!(!store.accept(&event, NOW), "a dismissed event stays deduped");
        let other_session = json!({"v":1, "type":"settled", "project":project,
                                   "sessionId":"session-2", "at":NOW, "id":"event-1"});
        // legacy passes the raw object straight to store.accept; decode it
        // with session-2's own proved identity instead (the store boundary
        // re-validates per event session anyway).
        let identity_2 = Identity {
            project: project.clone(),
            session_id: "session-2".to_string(),
            at: NOW as i64,
        };
        let other = decode(other_session.to_string().as_bytes(), &project, Some(&identity_2), NOW)
            .expect("session-2 settled");
        assert!(store.accept(&other, NOW), "dedupe is session-scoped");
        for i in 0..DEDUPE {
            let value = json!({"v":1, "type":"settled", "project":project,
                               "sessionId":"session-1", "at":NOW, "id":format!("id-{i}")});
            let message = decode_at(&value, NOW).expect("valid settled");
            store.accept(&message, NOW);
        }
        assert_eq!(store.snapshot(NOW).len(), QUEUE, "queue bounded at 8");
        let overflow = json!({"v":1, "type":"settled", "project":project,
                              "sessionId":"session-1", "at":NOW, "id":"overflow"});
        let overflow = decode_at(&overflow, NOW).expect("valid settled");
        assert!(!store.accept(&overflow, NOW), "dedupe map saturates at 256");
        assert_eq!(store.snapshot(NOW + EXPIRY_MS + 1).len(), 0, "notices expire at one minute");
        assert!(!store.accept(&event, NOW + EXPIRY_MS + 1), "expired dedupe but stale timestamp");
        let fresh = json!({"v":1, "type":"settled", "project":project,
                           "sessionId":"session-1", "at":(NOW + EXPIRY_MS + 1), "id":"fresh"});
        let identity_fresh = Identity {
            project: project.clone(),
            session_id: "session-1".to_string(),
            at: (NOW + EXPIRY_MS + 1 - FRESH_MS) as i64,
        };
        let fresh = decode(fresh.to_string().as_bytes(), &project, Some(&identity_fresh), NOW + EXPIRY_MS + 1)
            .expect("fresh settled");
        assert!(store.accept(&fresh, NOW + EXPIRY_MS + 1));
        // identity.time moved forward: the old event no longer validates
        let hello_new = Identity {
            project: project.clone(),
            session_id: "session-1".to_string(),
            at: (NOW + 1) as i64,
        };
        assert!(decode(serde_json::to_string(&event).unwrap().as_bytes(), &project, Some(&hello_new), NOW + 1).is_err());
    }

    // ported from legacy test/core.test.cjs:57
    #[test]
    fn heartbeats_cannot_create_notices_or_extend_expiry() {
        let project = project();
        let identity = identity_of(&project);
        let heartbeat_value = json!({"v":1, "type":"heartbeat", "project":project,
                                     "sessionId":"session-1", "at":NOW});
        let heartbeat = parse(&heartbeat_value, &project, Some(&identity), NOW).expect("valid heartbeat");
        let settled = parse(&settled_value(&project), &project, Some(&identity), NOW).expect("settled");
        let mut store = NoticeStore::new(project.clone());
        assert!(!store.accept(&heartbeat, NOW), "a heartbeat is never a notice");
        assert!(store.accept(&settled, NOW));
        let late = json!({"v":1, "type":"heartbeat", "project":project,
                          "sessionId":"session-1", "at":NOW + EXPIRY_MS});
        let late = parse(&late, &project, Some(&identity), NOW + EXPIRY_MS).expect("still in window");
        assert!(!store.accept(&late, NOW + EXPIRY_MS));
        assert!(store.snapshot(NOW + EXPIRY_MS).is_empty(), "heartbeats never extend expiry");
    }

    // ported from legacy test/core.test.cjs:244
    #[test]
    fn supported_session_ids_are_labels_never_paths() {
        let project = project();
        let ok = json!({"v":1, "type":"hello", "project":project, "sessionId":"session.1", "at":NOW});
        assert!(parse(&ok, &project, None, NOW).is_ok());
        for bad in [".", "..", ".hidden", "a/b", "a\\b", " a ", "a\n"] {
            let value = json!({"v":1, "type":"hello", "project":project, "sessionId":bad, "at":NOW});
            assert!(parse(&value, &project, None, NOW).is_err(), "must reject {bad:?}");
        }
    }

    // ported from legacy test/core.test.cjs:6 (token) + core.cjs:5
    #[test]
    fn project_id_matches_node_sha256_and_event_ids_are_bounded() {
        // sha256("/project") as computed by Node: createHash('sha256').update('/project')
        assert_eq!(
            project_id("/project"),
            "ea0135bca5e3bd815f5b7b8f8c83d86f584697bc29e0cc3b30937153abef2844"
        );
        for ok in ["a", "event-1", "f".repeat(128).as_str(), "A_9-z"] {
            assert!(token(ok), "token must accept {ok:?}");
        }
        for bad in ["", "with space", "plus+sign", "f".repeat(129).as_str(), "ñ"] {
            assert!(!token(bad), "token must reject {bad:?}");
        }
        assert!(session_token("session.1"));
        assert!(session_token("s"));
        assert!(!session_token(""));
        assert!(!session_token("f".repeat(129).as_str()));
    }

    // ported from legacy test/transport.test.cjs:100 (fragmented greeting)
    #[test]
    fn framing_handles_fragments_without_losing_frames() {
        let project = project();
        let greeting = format!("{}\n", hello_value(&project));
        let bytes = greeting.as_bytes();
        let mut framer = Framer::new();
        let first = framer.push(&bytes[..12]).expect("batch ok");
        assert!(first.frames.is_empty(), "no line yet");
        assert!(first.fatal.is_none());
        let second = framer.push(&bytes[12..]).expect("batch ok");
        assert_eq!(second.frames.len(), 1);
        assert_eq!(second.frames[0], &bytes[..bytes.len() - 1], "newline is framing, not payload");
        // a frame may be exactly frameBytes long (legacy rejects only >512)
        let mut framer = Framer::new();
        let mut exact = vec![b'a'; FRAME_BYTES];
        exact.push(b'\n');
        let framed = framer.push(&exact).expect("batch ok");
        assert_eq!(framed.frames.len(), 1);
        assert_eq!(framed.frames[0].len(), FRAME_BYTES);
        assert!(framed.fatal.is_none());
        // two frames in one chunk keep their order
        let mut framer = Framer::new();
        let joined = format!("{greeting}{greeting}");
        let framed = framer.push(joined.as_bytes()).expect("batch ok");
        assert_eq!(framed.frames.len(), 2);
        assert!(framed.fatal.is_none());
    }

    // ported from legacy transport.cjs:66 and :86
    #[test]
    fn batch_cap_and_oversized_tail_close_after_complete_frames() {
        // complete frames are yielded FIRST, then the oversized tail is fatal
        // (legacy processes every line in the while loop, checks the tail after)
        let mut framer = Framer::new();
        let mut chunk = b"{}\n".to_vec();
        chunk.extend(vec![b'z'; 600]);
        let framed = framer.push(&chunk).expect("batch under cap");
        assert_eq!(framed.frames.len(), 1, "the complete frame is still delivered");
        assert_eq!(framed.fatal, Some(FramingError::OversizedTail));
        // pending + chunk strictly greater than frameBytes * 8 dies before reading
        let mut framer = Framer::new();
        framer.push(&vec![b'd'; FRAME_BYTES * BATCH_FACTOR - 1]).expect("under cap");
        assert_eq!(
            framer.push(&vec![b'e'; 2]).unwrap_err(),
            FramingError::BatchCap
        );
        // exactly at the cap is not a batch error — the tail gate reports it
        let mut framer = Framer::new();
        framer.push(&vec![b'd'; FRAME_BYTES * BATCH_FACTOR - 6]).expect("under cap");
        let framed = framer.push(&vec![b'e'; 6]).expect("exactly at the cap");
        assert!(framed.frames.is_empty());
        assert_eq!(framed.fatal, Some(FramingError::OversizedTail));
    }

    // ported from legacy transport.cjs:73-75
    #[test]
    fn frame_quota_is_a_fixed_one_minute_window_per_connection() {
        let mut quota = FrameQuota::new(1_000);
        for i in 0..FRAMES_PER_MINUTE {
            quota.check(1_000 + u128::from(i))
                .unwrap_or_else(|e| panic!("frame {i} inside the window: {e:?}"));
        }
        assert_eq!(quota.check(1_500).unwrap_err(), QuotaError::RateExceeded);
        // rejected attempts keep consuming budget inside the same window
        assert_eq!(quota.check(1_600).unwrap_err(), QuotaError::RateExceeded);
        // fixed window: exactly period + 60 000 resets the counter
        assert!(quota.check(61_000).is_ok());
        assert!(quota.check(61_001).is_ok());
    }
}
