//! Honest unavailable transport backend for non-Linux targets.
//!
//! Windows' real answer (named pipes) and a macOS backend each remain separate
//! human decisions; this fallback never pretends that a receiver exists.

pub use crate::transport_view::{
    DeliveryState, HumanReplyError, PendingQuestionView, PreviewScan, QuestionDeliveryView,
    QuestionOptionView, QuestionOutcome, QuestionSnapshot, TransportError, TransportOptions,
    INSTALLED_RUNTIME_LEAF, RESERVED_RUNTIME_NAMES, SOCKET_DIR_ENV,
};

use crate::question;
use std::convert::Infallible;
use std::path::{Path, PathBuf};

const UNAVAILABLE_REASON: &str = "the local notice transport needs a per-OS receiver; this target has none in this port yet";

pub fn resolve_runtime() -> Result<PathBuf, TransportError> {
    Err(TransportError::Unavailable(UNAVAILABLE_REASON))
}

pub struct Transport {
    /// An uninhabited field proves that no transport can be constructed here.
    never: Infallible,
}

impl Transport {
    /// The `ABITO_DESKTOP_SOCKET=…` path the producer connects to.
    pub fn endpoint(&self) -> &Path {
        match self.never {}
    }

    pub fn runtime(&self) -> &Path {
        match self.never {}
    }

    pub fn question_snapshot(&self) -> QuestionSnapshot {
        match self.never {}
    }

    /// Read-only budget for the matching live slot. No prune, ticket commit,
    /// origin write or private scope is exposed. Send revalidates at its own time.
    pub fn question_text_budget(&self, _id: &str, _text: &str) -> Result<crate::questioncmd::TextBudget, question::Error> {
        match self.never {}
    }

    /// Host geometry transaction: admission cannot race the pending check and
    /// inline runtime resize call. This does not await queued backend/WM work.
    /// The closure MUST NOT reenter transport or publish questions.
    /// Conservative: an unpruned expired slot also blocks until normal expiry.
    pub fn with_question_pending<T>(&self, _operation: impl FnOnce(bool) -> T) -> T {
        match self.never {}
    }

    /// Check, establish the barrier and call/enqueue native work under the SAME
    /// admission mutex. Callbacks run after unlocking; closures must not reenter
    /// transport. `apply(false)` may reposition but MUST NOT request a resize.
    pub fn compact_resize(&self, _generation: u64, _expected: (u32, u32), _current: impl FnOnce() -> bool,
        _observed: impl FnOnce() -> Option<(u32, u32)>, _apply: impl FnOnce(bool)) -> bool {
        match self.never {}
    }

    /// Actual physical Resized observation only; no getter, synthetic ACK or
    /// receipt is substituted. A matching late observation can clear degraded.
    pub fn native_resize_observed(&self, _generation: u64, _size: (u32, u32)) {
        match self.never {}
    }

    /// Recovery under a newer host plan requires that plan's current physical
    /// target, not the old compact size. `current` must validate the actual
    /// observation and a consistent generation/geometry snapshot under this
    /// lock; callbacks stay outside it. This is observation, not causal proof.
    pub fn native_resize_observed_current(&self, _size: (u32, u32), _current: impl FnOnce() -> Option<(u64, (u32, u32))>) {
        match self.never {}
    }

    /// Host-only entry points. UI supplies exactly an id and index/text, never
    /// scope/source/connection or an opaque wire token. Trusted human input must
    /// still be enforced by the later closed IPC/UI gate; this is not attestation.
    pub fn answer(&self, _id: &str, _index: usize) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    pub fn answer_text(&self, _id: &str, _text: String) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    pub fn decline(&self, _id: &str) -> Result<(), HumanReplyError> {
        match self.never {}
    }

    /// Linux `close()` stops accepting and performs identity-checked cleanup.
    /// This stub cannot own resources because no instance can be constructed.
    pub fn close(&self) -> Result<(), TransportError> {
        match self.never {}
    }
}

pub fn create_transport(_options: TransportOptions) -> Result<Transport, TransportError> {
    Err(TransportError::Unavailable(UNAVAILABLE_REASON))
}

/// No receiver on this target, so there is nothing to scan (honest empty, not a fake hit).
pub fn preview_scan() -> Vec<PreviewScan> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_resolution_fails_closed() {
        assert!(matches!(
            resolve_runtime(),
            Err(TransportError::Unavailable(
                "the local notice transport needs a per-OS receiver; this target has none in this port yet"
            ))
        ));
    }

    #[test]
    fn transport_creation_fails_closed() {
        let options = TransportOptions::new(PathBuf::new(), "test");
        assert!(matches!(
            create_transport(options),
            Err(TransportError::Unavailable(
                "the local notice transport needs a per-OS receiver; this target has none in this port yet"
            ))
        ));
    }
}
