//! #387 decision path: pure, injected presenter, closed enums. No GTK here —
//! the GTK host lives in the binary crate (nativedialoghost.rs) and is never
//! exercised by tests (no GUI launch).
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Records every presenter call and answers with one fixed outcome.
struct Fixed {
    calls: AtomicUsize,
    outcome: PresenterOutcome,
}
impl Fixed {
    fn new(outcome: PresenterOutcome) -> Arc<Self> {
        Arc::new(Self { calls: AtomicUsize::new(0), outcome })
    }
}
impl Presenter for Fixed {
    fn present(&self, _dialog: &ValidatedDialog, timeout_ms: u64) -> PresenterOutcome {
        assert_eq!(timeout_ms, DIALOG_TIMEOUT_MS, "the pinned timeout reaches the presenter");
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.outcome
    }
}

/// A presenter that explodes: decide() must still answer Denied.
struct Panicking;
impl Presenter for Panicking {
    fn present(&self, _: &ValidatedDialog, _: u64) -> PresenterOutcome {
        panic!("presenter exploded");
    }
}

fn request() -> DialogRequest {
    DialogRequest {
        kind: ActionKind::Computer,
        title: "Captura de pantalla".into(),
        body: "Pi quiere tomar una captura de la pantalla.".into(),
    }
}

#[test]
fn bounds_and_the_timeout_are_pinned_constants() {
    assert_eq!(DIALOG_TIMEOUT_MS, 30_000);
    assert_eq!(TITLE_MAX_CHARS, 120);
    assert_eq!(BODY_MAX_CHARS, 500);
    assert_eq!(MAX_REQUEST_BYTES, 16384);
}

#[test]
fn kind_parse_is_closed_and_carries_fixed_spanish_copy() {
    assert_eq!(ActionKind::parse("computer"), Some(ActionKind::Computer));
    assert_eq!(ActionKind::parse("connector"), Some(ActionKind::Connector));
    // closed set: nothing else parses
    for wrong in ["Computer", "COMPUTER", "terminal", "", "computer "] {
        assert_eq!(ActionKind::parse(wrong), None, "{wrong:?}");
    }
    // the prompt line is fixed host copy (never caller text), Spanish, non-empty
    for kind in [ActionKind::Computer, ActionKind::Connector] {
        assert!(!kind.prompt_line().is_empty());
        assert!(kind.prompt_line().chars().all(|c| !c.is_control()));
    }
    assert_ne!(ActionKind::Computer.prompt_line(), ActionKind::Connector.prompt_line());
}

#[test]
fn valid_request_is_accepted_and_round_trips() {
    let dialog = validate(&request()).expect("valid request");
    assert_eq!(dialog.kind(), ActionKind::Computer);
    assert_eq!(dialog.title(), "Captura de pantalla");
    assert_eq!(dialog.body(), "Pi quiere tomar una captura de la pantalla.");
    // exact boundaries are accepted
    let at_limit = DialogRequest {
        kind: ActionKind::Connector,
        title: "t".repeat(TITLE_MAX_CHARS),
        body: "b".repeat(BODY_MAX_CHARS),
    };
    let dialog = validate(&at_limit).expect("boundary sizes are valid");
    assert_eq!(dialog.kind(), ActionKind::Connector);
    assert_eq!(dialog.title().chars().count(), TITLE_MAX_CHARS);
    assert_eq!(dialog.body().chars().count(), BODY_MAX_CHARS);
}

#[test]
fn oversize_empty_and_whitespace_only_text_is_rejected() {
    let mut over_title = request();
    over_title.title = "t".repeat(TITLE_MAX_CHARS + 1);
    assert!(validate(&over_title).is_err());
    let mut over_body = request();
    over_body.body = "b".repeat(BODY_MAX_CHARS + 1);
    assert!(validate(&over_body).is_err());
    let mut empty_title = request();
    empty_title.title = String::new();
    assert!(validate(&empty_title).is_err());
    let mut empty_body = request();
    empty_body.body = "   ".into();
    assert!(validate(&empty_body).is_err());
    // whitespace-only still counts as empty (ECMAScript trim, U+00A0 included)
    let mut nbsp_body = request();
    nbsp_body.body = "\u{00a0}\u{00a0}".into();
    assert!(validate(&nbsp_body).is_err());
}

#[test]
fn control_characters_are_rejected_but_plain_newlines_pass() {
    for bad in ["\u{0007}campana", "fin\u{007f}", "line\u{000b}break", "\u{001b}[31mrojo"] {
        let mut req = request();
        req.body = bad.into();
        assert!(validate(&req).is_err(), "{bad:?}");
    }
    // LF / TAB / CR are plain text and allowed (question.rs producer rules)
    let mut multiline = request();
    multiline.body = "primera línea\nsegunda línea\tsangría\rvuelto".into();
    assert!(validate(&multiline).is_ok());
    // markup characters are inert text: accepted, never interpreted
    let mut markup = request();
    markup.body = "ver <b>esto</b> y &esto;".into();
    assert!(validate(&markup).is_ok());
}

#[test]
fn every_presenter_outcome_maps_to_the_closed_decision_enum() {
    let cases = [
        (PresenterOutcome::Approved, Decision::Approved),
        (PresenterOutcome::Denied, Decision::Denied(DenyReason::Human)),
        (PresenterOutcome::TimedOut, Decision::Denied(DenyReason::Timeout)),
        (PresenterOutcome::NoDisplay, Decision::Denied(DenyReason::NoDisplay)),
        (PresenterOutcome::Failed, Decision::Denied(DenyReason::PresenterFailed)),
    ];
    for (outcome, expected) in cases {
        let presenter = Fixed::new(outcome);
        assert_eq!(decide(&request(), presenter.as_ref()), expected, "{outcome:?}");
        assert_eq!(presenter.calls.load(Ordering::SeqCst), 1, "{outcome:?}");
    }
}

#[test]
fn invalid_request_denies_without_calling_the_presenter() {
    let mut invalid = request();
    invalid.body = String::new();
    let presenter = Fixed::new(PresenterOutcome::Approved);
    assert_eq!(decide(&invalid, presenter.as_ref()), Decision::Denied(DenyReason::InvalidRequest));
    assert_eq!(presenter.calls.load(Ordering::SeqCst), 0, "rejected input never reaches the presenter");
}

#[test]
fn a_panicking_presenter_denies_and_never_approves() {
    let presenter = Panicking;
    assert_eq!(
        decide(&request(), &presenter),
        Decision::Denied(DenyReason::PresenterFailed)
    );
}

#[test]
fn parse_request_accepts_exactly_the_closed_shape() {
    let ok = json!({"action": "request", "kind": "computer", "title": "Título", "body": "Cuerpo"});
    let parsed = parse_request(&ok).expect("the exact closed shape");
    assert_eq!(parsed.kind, ActionKind::Computer);
    assert_eq!(parsed.title, "Título");
    assert_eq!(parsed.body, "Cuerpo");
    let wrong: Vec<Value> = vec![
        json!({"action": "view", "kind": "computer", "title": "T", "body": "B"}),
        json!({"action": "request", "kind": "shell", "title": "T", "body": "B"}),
        json!({"action": "request", "kind": "computer", "body": "B"}),
        json!({"action": "request", "kind": "computer", "title": "T", "body": "B", "extra": 1}),
        json!({"action": "request", "kind": "computer", "title": 7, "body": "B"}),
        json!({"action": "request", "kind": ["computer"], "title": "T", "body": "B"}),
        Value::Array(vec![]),
        Value::Null,
    ];
    for payload in wrong {
        assert!(parse_request(&payload).is_err(), "{payload}");
    }
}

#[test]
fn oversize_request_payload_is_rejected_whole() {
    let mut payload = json!({"action": "request", "kind": "computer", "title": "T", "body": "B"});
    payload["body"] = Value::String("x".repeat(MAX_REQUEST_BYTES));
    assert!(parse_request(&payload).is_err());
}

#[test]
fn decision_json_is_closed_and_labels_every_denial() {
    assert_eq!(decision_json(&Decision::Approved), json!({"decision": "approved"}));
    for (reason, label) in [
        (DenyReason::Human, "human"),
        (DenyReason::Timeout, "timeout"),
        (DenyReason::NoDisplay, "no_display"),
        (DenyReason::InvalidRequest, "invalid_request"),
        (DenyReason::PresenterFailed, "presenter_failed"),
    ] {
        assert_eq!(
            decision_json(&Decision::Denied(reason)),
            json!({"decision": "denied", "reason": label})
        );
    }
}
