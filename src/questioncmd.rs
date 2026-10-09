//! Closed question IPC; no route, wire token, permission or attestation.
use crate::question::{Error, QuestionSlot};
use serde::Serialize;
use serde_json::Value;

pub const MAX_REQUEST_BYTES: usize = 16384;
pub enum Command {
    View, Answer { id: String, index: usize }, Text { id: String, text: String },
    Decline { id: String }, Budget { id: String, text: String },
}
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TextBudget { pub bytes: usize, pub allowed: bool, pub reason: Option<&'static str> }
pub fn parse_command(payload: &Value) -> Result<Command, Error> {
    if serde_json::to_vec(payload).map_err(|_| Error::InvalidSchema)?.len() > MAX_REQUEST_BYTES {
        return Err(Error::FrameTooLarge);
    }
    let map = payload.as_object().ok_or(Error::InvalidSchema)?;
    let action = map.get("action").and_then(Value::as_str).ok_or(Error::InvalidSchema)?;
    if action == "view" && map.len() == 1 { return Ok(Command::View); }
    let keys: &[&str] = match action {
        "answer" => &["action", "id", "index"],
        "text" | "budget" => &["action", "id", "text"],
        "decline" => &["action", "id"],
        _ => return Err(Error::InvalidSchema),
    };
    if map.len() != keys.len() || !keys.iter().all(|k| map.contains_key(*k)) {
        return Err(Error::InvalidSchema);
    }
    let id = map["id"].as_str().ok_or(Error::InvalidSchema)?;
    let b = id.as_bytes();
    if b.len() != 36 || b[14] != b'4' || !matches!(b[19], b'8'|b'9'|b'a'|b'b')
        || !b.iter().enumerate().all(|(i, &c)| if matches!(i, 8|13|18|23) { c == b'-' }
            else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }) {
        return Err(Error::InvalidQuestion);
    }
    let id = id.to_owned();
    Ok(match action {
        "answer" => Command::Answer { id, index: map["index"].as_u64().filter(|i| *i <= 3)
            .ok_or(Error::InvalidAnswer)? as usize },
        "decline" => Command::Decline { id },
        _ => {
            let text = map["text"].as_str().ok_or(Error::InvalidAnswer)?;
            if text.chars().any(|c| matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' |
                '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}')) { return Err(Error::InvalidAnswer); }
            if action == "text" { Command::Text { id, text: text.into() } }
            else { Command::Budget { id, text: text.into() } }
        }
    })
}
pub fn collapse_allowed(expanded: bool, pending: bool) -> bool { !(expanded && pending) }
/// A blocked short click must still clear the native press and snap, but must
/// preserve expanded/chat flags. Caller holds the question admission guard.
pub fn guarded_release(core: &mut crate::core::Core, io: &dyn crate::core::WindowIo,
    area: crate::geometry::Rect, client: (f64, f64), cancelled: bool, pending: bool,
) -> crate::core::ReleaseOutcome {
    let blocked = !collapse_allowed(core.expanded, pending);
    core.release(io, area, client, cancelled || blocked)
}
/// Queue the entire admission transaction, not a previously checked resize.
/// Transaction checks the plan and establishes the barrier before calling
/// `apply(resize)` inline under admission lock. False means position only.
/// GTK/OS/WM completion remains asynchronous and needs an actual observation.
pub fn queue_compact_apply(
    enqueue: impl FnOnce(Box<dyn FnOnce() + Send>),
    transaction: impl FnOnce(&mut dyn FnMut(bool)) + Send + 'static,
    apply: impl FnOnce(bool) + Send + 'static,
) {
    enqueue(Box::new(move || {
        let mut apply = Some(apply);
        transaction(&mut |resize| {
            if let Some(apply) = apply.take() { apply(resize); }
        });
    }));
}
pub const NATIVE_RESIZE_TIMEOUT_MS: u64 = 2000;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTransition { #[default] Idle, NativeTransitionBusy, NativeTransitionDegraded }
#[derive(Debug, PartialEq, Eq)]
pub enum ResizeStart { Stable, Request, Stale }
/// Idle means no tracked compact request, NOT proof of arbitrary native state.
/// Only actual matching physical observations resolve a requested transition.
/// Resized carries no causal request ID: generation/size correlation is not
/// cryptographic causality and cannot order every GTK/OS/WM queue operation.
#[derive(Default)]
pub struct NativeResizeBarrier {
    state: NativeTransition, generation: Option<u64>, expected: Option<(u32,u32)>, deadline: Option<u64>,
}
impl NativeResizeBarrier {
    pub fn state(&self) -> NativeTransition { self.state }
    pub fn begin(&mut self, generation: u64, expected: (u32,u32), observed: Option<(u32,u32)>, now: u64) -> ResizeStart {
        if self.generation.is_some_and(|g| generation <= g) { return ResizeStart::Stale; }
        self.generation = Some(generation);
        // Never treat a getter as settling an older queued generation.
        if self.state == NativeTransition::Idle && observed == Some(expected) {
            self.expected = None; self.deadline = None; return ResizeStart::Stable;
        }
        self.expected = Some(expected);
        self.deadline = Some(now.saturating_add(NATIVE_RESIZE_TIMEOUT_MS));
        self.state = NativeTransition::NativeTransitionBusy;
        ResizeStart::Request
    }
    pub fn observe(&mut self, generation: u64, size: (u32,u32)) -> bool {
        if self.generation != Some(generation) || self.expected != Some(size) { return false; }
        self.state = NativeTransition::Idle; self.expected = None; self.deadline = None; true
    }
    /// A newer plan can recover availability only from its own physical target.
    /// An old compact event tagged with the current generation is insufficient.
    pub fn observe_current(&mut self, generation: u64, desired: (u32,u32), size: (u32,u32)) -> bool {
        if self.state == NativeTransition::Idle || !self.generation.is_some_and(|g| generation >= g)
            || desired != size || desired.0 == 0 || desired.1 == 0 { return false; }
        self.generation = Some(generation);
        self.state = NativeTransition::Idle; self.expected = None; self.deadline = None; true
    }
    pub fn timeout(&mut self, generation: u64, now: u64) -> bool {
        if self.generation != Some(generation) || !self.deadline.is_some_and(|d| now >= d) { return false; }
        self.deadline = None; // one invalidation, no retry or additional resize
        self.state = NativeTransition::NativeTransitionDegraded; true
    }
    pub fn tick(&mut self, now: u64) -> bool {
        self.generation.is_some_and(|g| self.timeout(g, now))
    }
}
/// Current Core view uses the approved geometry constants, never stored intent
/// from an obsolete compact request. Callers must reject an unknown scale.
pub fn desired_native_size(expanded: bool, chat: bool, scale: f64) -> (u32,u32) {
    use crate::geometry;
    let logical = if !expanded { geometry::LOGICAL_COMPACT }
        else if chat { geometry::LOGICAL_CHAT } else { geometry::LOGICAL_OVERVIEW };
    let (w,h) = geometry::scaled_size(logical, scale); (w as u32,h as u32)
}
pub fn error_code(error: Error) -> &'static str {
    match error {
        Error::FrameTooLarge => "frame_too_large", Error::InvalidFrame => "invalid_frame",
        Error::InvalidSchema => "invalid_schema", Error::ScopeMismatch => "scope_mismatch",
        Error::InvalidTimestamp => "invalid_timestamp", Error::InvalidQuestion => "invalid_question",
        Error::InvalidAnswer => "invalid_answer", Error::NotLive => "not_live",
        Error::Expired => "expired", Error::GenerationExhausted => "generation_exhausted",
    }
}
/// Read-only: serialize a prospective body and reuse the authoritative answer
/// validator. Preparation is pure; no commit, origin writer or token escapes.
/// Body size is independent of JSON field ordering, and excludes the newline.
pub fn text_budget(slot: &QuestionSlot, id: &str, text: &str, now: u64) -> Result<TextBudget, Error> {
    let active = slot.active().filter(|a| a.question().id() == id).ok_or(Error::NotLive)?;
    let identity = active.identity();
    let validation = slot.prepare_answer(active.connection_id(), identity, id,
        crate::question::HumanAnswer::Text { text: text.into() }, now);
    let reason = match validation {
        Ok(_) => None,
        Err(e @ (Error::InvalidAnswer | Error::FrameTooLarge)) => Some(error_code(e)),
        Err(e) => return Err(e),
    };
    let bytes = serde_json::to_vec(&serde_json::json!({"v":1,"type":"answer","questionVersion":1,
        "project":identity.project,"sessionId":identity.session_id,"at":now,"id":id,
        "source":"human","answer":{"type":"text","text":text}}))
        .map_err(|_| Error::InvalidFrame)?.len();
    Ok(TextBudget { bytes, allowed: reason.is_none(), reason })
}
#[cfg(test)]
#[path = "questioncmd_tests.rs"]
mod tests;
