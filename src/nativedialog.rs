//! #387 native modal approval dialogs for computer-control and connector
//! actions. Decision core only: closed enums, plain-text validation and the
//! injected-presenter decision path. The host command and the GTK presenter
//! live in the binary crate (`nativedialoghost.rs`).
//!
//! Contract:
//! - the caller supplies only plain bounded text (title/body); there is NO
//!   caller-supplied markup or command — the copy is fixed host text,
//! - timeout = deny, absent display = safe deny with a reason,
//! - a panicking or failing presenter can never produce Approved,
//! - an invalid request denies without ever reaching the presenter.
use serde_json::{json, Value};

pub const TITLE_MAX_CHARS: usize = 120;
pub const BODY_MAX_CHARS: usize = 500;
pub const DIALOG_TIMEOUT_MS: u64 = 30_000;
pub const MAX_REQUEST_BYTES: usize = 16384;

/// The only two action kinds this dialog exists for. Closed: nothing else
/// parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Computer,
    Connector,
}

impl ActionKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "computer" => Some(Self::Computer),
            "connector" => Some(Self::Connector),
            _ => None,
        }
    }

    /// Fixed host copy (Spanish, rioplatense voseo): the ONE sentence that
    /// names what is being approved. Never caller-supplied.
    pub fn prompt_line(&self) -> &'static str {
        match self {
            Self::Computer => {
                "La app quiere realizar una acción en tu computadora. ¿La apruebas?"
            }
            Self::Connector => {
                "La app quiere realizar una acción en un conector. ¿La apruebas?"
            }
        }
    }
}

/// What a caller asks to show. Unvalidated input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: ActionKind,
    pub title: String,
    pub body: String,
}

/// A request that passed validation. The presenter sees only this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedDialog {
    kind: ActionKind,
    title: String,
    body: String,
}

impl ValidatedDialog {
    pub fn kind(&self) -> ActionKind {
        self.kind
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn body(&self) -> &str {
        &self.body
    }
}

/// What the injected presenter reports back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenterOutcome {
    Approved,
    Denied,
    TimedOut,
    NoDisplay,
    Failed,
}

/// Why a dialog denied. Closed: every deny is exactly one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    Human,
    Timeout,
    NoDisplay,
    InvalidRequest,
    PresenterFailed,
}

impl DenyReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Timeout => "timeout",
            Self::NoDisplay => "no_display",
            Self::InvalidRequest => "invalid_request",
            Self::PresenterFailed => "presenter_failed",
        }
    }
}

/// The closed decision the command returns. No other shape exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Denied(DenyReason),
}

/// The seam the decision path is unit-tested through. `present` MUST show a
/// modal bounded to `timeout_ms` and must not run on arbitrary threads (GTK:
/// main thread only, see the host module).
pub trait Presenter: Send + Sync {
    fn present(&self, dialog: &ValidatedDialog, timeout_ms: u64) -> PresenterOutcome;
}

fn ecmascript_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Same plain-text rule as the question producer (question.rs `plain`):
/// bounded, non-empty after ECMAScript trim, no C0 controls except LF/TAB/CR
/// and no DEL. C1 characters are allowed; markup characters are inert text.
fn plain(text: &str, max: usize) -> bool {
    text.chars().take(max + 1).count() <= max
        && !text.trim_matches(ecmascript_whitespace).is_empty()
        && text.chars().all(|c| !matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}'
            | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
}

/// Validate a request: plain text only, bounded, non-empty after ECMAScript
/// trim. Markup characters are inert text, never interpreted.
pub fn validate(request: &DialogRequest) -> Result<ValidatedDialog, ()> {
    if !plain(&request.title, TITLE_MAX_CHARS) || !plain(&request.body, BODY_MAX_CHARS) {
        return Err(());
    }
    Ok(ValidatedDialog {
        kind: request.kind,
        title: request.title.clone(),
        body: request.body.clone(),
    })
}

/// The decision path: validate, then ask the presenter exactly once, then map
/// the closed outcome onto the closed decision. An invalid request denies
/// WITHOUT calling the presenter; a panicking presenter denies too.
pub fn decide(request: &DialogRequest, presenter: &dyn Presenter) -> Decision {
    let Ok(dialog) = validate(request) else {
        return Decision::Denied(DenyReason::InvalidRequest);
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        presenter.present(&dialog, DIALOG_TIMEOUT_MS)
    }))
    .unwrap_or(PresenterOutcome::Failed);
    match outcome {
        PresenterOutcome::Approved => Decision::Approved,
        PresenterOutcome::Denied => Decision::Denied(DenyReason::Human),
        PresenterOutcome::TimedOut => Decision::Denied(DenyReason::Timeout),
        PresenterOutcome::NoDisplay => Decision::Denied(DenyReason::NoDisplay),
        PresenterOutcome::Failed => Decision::Denied(DenyReason::PresenterFailed),
    }
}

/// Parse the one closed command shape:
/// `{"action":"request","kind":"computer|connector","title":…,"body":…}`.
/// Extra keys, wrong types, unknown kinds and oversize payloads all refuse.
pub fn parse_request(payload: &Value) -> Result<DialogRequest, ()> {
    if serde_json::to_vec(payload).map_err(|_| ())?.len() > MAX_REQUEST_BYTES {
        return Err(());
    }
    let map = payload.as_object().ok_or(())?;
    if map.len() != 4
        || map.get("action").and_then(Value::as_str) != Some("request")
        || !map.contains_key("kind")
        || !map.contains_key("title")
        || !map.contains_key("body")
    {
        return Err(());
    }
    let kind = ActionKind::parse(map["kind"].as_str().ok_or(())?).ok_or(())?;
    let title = map["title"].as_str().ok_or(())?;
    let body = map["body"].as_str().ok_or(())?;
    Ok(DialogRequest {
        kind,
        title: title.to_owned(),
        body: body.to_owned(),
    })
}

/// The closed JSON projection the command returns.
pub fn decision_json(decision: &Decision) -> Value {
    match decision {
        Decision::Approved => json!({"decision": "approved"}),
        Decision::Denied(reason) => {
            json!({"decision": "denied", "reason": reason.as_str()})
        }
    }
}

#[cfg(test)]
#[path = "nativedialog_tests.rs"]
mod tests;
