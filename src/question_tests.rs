use super::*;
use crate::protocol::{Identity, FRESH_MS};
use serde_json::{json, Value};

const NOW: u64 = 100_000;
const ID: &str = "12345678-1234-4abc-8abc-123456789abc";
const OTHER_ID: &str = "12345678-1234-4abc-9abc-123456789abd";

fn identity() -> Identity {
    Identity { project: "a".repeat(64), session_id: "session-1".into(), at: (NOW - FRESH_MS) as i64 }
}
fn base(kind: &str) -> Value {
    json!({"v":1,"type":kind,"questionVersion":1,"project":identity().project,
           "sessionId":"session-1","at":NOW})
}
fn question_value() -> Value {
    let mut value = base("question");
    value.as_object_mut().unwrap().extend(json!({"id":ID,"kind":"question","text":"¿Qué rama?",
        "options":[{"value":"main","label":"Main","description":""},
                   {"value":"dev","label":"Desarrollo","description":"Otra rama"}],
        "allowFreeText":true,"expiresAt":NOW+30_000}).as_object().unwrap().clone());
    value
}
fn parse(value: &Value) -> Result<Inbound, Error> {
    decode(&serde_json::to_vec(value).unwrap(), &identity(), NOW)
}
fn question(value: Value) -> Question {
    match parse(&value).unwrap() { Inbound::Question(q) => q, _ => panic!("expected question") }
}
fn slot() -> QuestionSlot {
    let mut slot = QuestionSlot::new();
    assert!(matches!(slot.admit(7, &identity(), question(question_value()), NOW).unwrap(), Admission::Accepted));
    slot
}
fn body(line: &[u8]) -> Value {
    assert_eq!(line.last(), Some(&b'\n'));
    serde_json::from_slice(&line[..line.len()-1]).unwrap()
}

#[test]
fn question_handshake_exact_bytes_and_legacy_unchanged() {
    assert!(matches!(parse(&base("questions_hello")).unwrap(), Inbound::Hello));
    assert_eq!(QUESTIONS_READY_LINE, b"{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1}\n");
    assert_eq!(crate::protocol::READY_LINE, b"{\"v\":1,\"type\":\"ready\"}\n");
    assert_eq!(crate::protocol::FRAME_BYTES, 512);
    let mut extra = base("questions_hello"); extra["payload"] = json!(null);
    assert!(parse(&extra).is_err());
}

#[test]
fn question_busy_reason_capability_is_exact_closed_and_body_bounded() {
    let mut hello = base("questions_hello"); hello["busyReason"] = json!(1);
    assert!(parse(&hello).is_ok());
    for bad in [json!(null),json!(0),json!(2),json!(true),json!("1"),json!(1.0),json!(1.5)] {
        hello["busyReason"] = bad; assert!(parse(&hello).is_err());
    }
    hello["busyReason"] = json!(1);
    let raw = hello.to_string();
    let duplicate = raw.replacen("{", "{\"busyReason\":1,", 1);
    assert!(decode(duplicate.as_bytes(), &identity(), NOW).is_err());
    let exact = format!("{raw}{}", " ".repeat(FRAME_BYTES-raw.len()));
    assert!(decode(exact.as_bytes(), &identity(), NOW).is_ok());
    assert!(decode(format!("{exact} ").as_bytes(), &identity(), NOW).is_err());
    let mut q = question_value(); q["busyReason"] = json!(1); assert!(parse(&q).is_err());
}
#[test]
fn question_busy_detail_is_only_system_busy_and_minimal_frames_stay_unchanged() {
    for (reason, code) in [(BusyReason::NativeTransitionBusy,"native_transition_busy"),
                           (BusyReason::NativeTransitionDegraded,"native_transition_degraded")] {
        let frame = body(&busy_line_with_reason(&identity(), ID, NOW, reason).unwrap());
        assert_eq!(frame["busyReason"], code); assert_eq!(frame["reason"], "busy");
        assert_eq!(frame["source"], "system"); assert_eq!(frame.as_object().unwrap().len(), 10);
    }
    for (reason, human) in [(CloseReason::Cancelled,false),(CloseReason::Expired,false),(CloseReason::Busy,true)] {
        assert!(closed_with_detail(&identity(), ID, reason, human, NOW, Some(BusyReason::NativeTransitionBusy)).is_err());
    }
    assert!(body(&busy_line(&identity(), ID, NOW).unwrap()).get("busyReason").is_none());
    assert!(body(slot().prepare_decline(7, &identity(), ID, NOW).unwrap().line()).get("busyReason").is_none());
}
#[test]
fn question_schema_scope_and_integer_timestamps_fail_closed() {
    for invalid in [json!(null), json!([]), json!({}), base("unknown"), base("answer")] {
        assert!(parse(&invalid).is_err());
    }
    for (key, value) in [
        ("v", json!(2)), ("questionVersion", json!(2)), ("at", json!(100000.0)),
        ("at", json!(0)), ("at", json!(-1)), ("at", json!(NOW+1)),
        ("at", json!(NOW-FRESH_MS-1)), ("at", json!(9_007_199_254_740_992u64)),
        ("project", json!("b".repeat(64))), ("project", json!("A".repeat(64))),
        ("sessionId", json!("other")), ("sessionId", json!("../path")),
        ("recommended", json!(0)), ("text", json!("private\u{0000}content")),
        ("expiresAt", json!(130000.0)), ("expiresAt", json!(NOW+29_999)),
        ("expiresAt", json!(NOW+900_001)),
    ] {
        let mut frame = question_value(); frame[key] = value;
        assert!(parse(&frame).is_err(), "invalid field: {key}");
    }
}

#[test]
fn question_options_kinds_uuid_and_text_bounds() {
    assert!(parse(&question_value()).is_ok());
    let mut empty = question_value(); empty["options"] = json!([]);
    assert!(parse(&empty).is_ok());
    empty["allowFreeText"] = json!(false); assert!(parse(&empty).is_err());
    for (key, replacement) in [
        ("kind", json!("permission")), ("kind", json!("approval")),
        ("id", json!("12345678-1234-1abc-8abc-123456789abc")),
        ("id", json!("12345678-1234-4ABC-8abc-123456789abc")),
        ("id", json!("12345678-1234-4abc-7abc-123456789abc")),
        ("text", json!("")), ("text", json!("ñ".repeat(501))),
    ] {
        let mut frame = question_value(); frame[key] = replacement;
        assert!(parse(&frame).is_err(), "invalid field: {key}");
    }
    let mut approval = question_value(); approval["kind"] = json!("approval");
    approval["allowFreeText"] = json!(false); assert!(parse(&approval).is_ok());
    for value in ["", "main", "bad token", "ñ", &"x".repeat(129)] {
        let mut frame = question_value(); frame["options"][1]["value"] = json!(value);
        assert!(parse(&frame).is_err());
    }
    for (key, value) in [("label", json!("")), ("label", json!("a".repeat(61))),
                         ("description", json!("a".repeat(161))), ("preselected", json!(true))] {
        let mut frame = question_value(); frame["options"][0][key] = value;
        assert!(parse(&frame).is_err());
    }
    for count in [1,5] {
        let mut frame = question_value();
        frame["options"] = json!((0..count).map(|i| json!({"value":format!("v{i}"),"label":"L","description":""})).collect::<Vec<_>>());
        assert!(parse(&frame).is_err());
    }
    let mut bound = question_value(); bound["text"] = json!("ñ".repeat(500));
    bound["options"][0]["label"] = json!("ñ".repeat(60));
    bound["options"][0]["description"] = json!("ñ".repeat(160));
    assert!(parse(&bound).is_ok());
}

#[test]
fn question_raw_malformed_duplicate_keys_and_body_limit() {
    for bytes in [&b"{"[..], &b"\xff"[..], &vec![b'x';4097][..]] {
        assert!(decode(bytes, &identity(), NOW).is_err());
    }
    let raw = serde_json::to_string(&base("questions_hello")).unwrap();
    let duplicate = raw.replacen("{", "{\"v\":1,", 1);
    assert!(decode(duplicate.as_bytes(), &identity(), NOW).is_err());
    let padded = format!("{raw}{}", " ".repeat(4096-raw.len()));
    assert!(decode(padded.as_bytes(), &identity(), NOW).is_ok());
    assert!(decode(format!("{padded} ").as_bytes(), &identity(), NOW).is_err());
    let newer = Identity { at: NOW as i64+1, ..identity() };
    assert!(decode(raw.as_bytes(), &newer, NOW).is_err());
    let mut bad_identity = identity(); bad_identity.project = "g".repeat(64);
    let mut frame = base("questions_hello"); frame["project"] = json!(bad_identity.project);
    assert!(decode(&serde_json::to_vec(&frame).unwrap(), &bad_identity, NOW).is_err());
}

#[test]
fn question_cancel_and_rejected_exact_typed_schema() {
    for reason in ["expired","cancelled"] {
        let mut value = base("question_cancel"); value["id"] = json!(ID); value["reason"] = json!(reason);
        assert!(matches!(parse(&value).unwrap(), Inbound::Cancel(_)));
        value["answer"] = json!("injected"); assert!(parse(&value).is_err());
    }
    for reason in ["not_live","invalid_answer","scope_mismatch"] {
        let mut value = base("question_answer_rejected"); value["id"] = json!(ID); value["reason"] = json!(reason);
        assert!(matches!(parse(&value).unwrap(), Inbound::AnswerRejected(_)));
        value["reason"] = json!("retry"); assert!(parse(&value).is_err());
    }
}

#[test]
fn question_same_connection_second_question_is_busy_and_keeps_the_first() {
    // one pending question per originating connection: its own writer carries one outcome
    let mut slot = slot();
    let mut value = question_value(); value["id"] = json!(OTHER_ID);
    let Admission::Busy(line) = slot.admit(7, &identity(), question(value), NOW).unwrap() else { panic!("expected busy") };
    let frame = body(&line); assert_eq!(frame["type"], "question_closed");
    assert_eq!(frame["reason"], "busy"); assert_eq!(frame["source"], "system"); assert_eq!(frame["id"], OTHER_ID);
    assert_eq!(slot.len(), 1);
    assert_eq!(slot.active().unwrap().question().id(), ID);
}

#[test]
fn question_prepare_validates_original_scope_option_index_and_preserves_on_failure() {
    let mut slot = slot();
    assert!(slot.prepare_answer(8, &identity(), ID, HumanAnswer::Option { index:0 }, NOW).is_err());
    let wrong = Identity { session_id:"other".into(), ..identity() };
    assert!(slot.prepare_answer(7, &wrong, ID, HumanAnswer::Option { index:0 }, NOW).is_err());
    assert!(slot.prepare_answer(7, &identity(), OTHER_ID, HumanAnswer::Option { index:0 }, NOW).is_err());
    assert!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:2 }, NOW).is_err());
    assert!(slot.active().is_some());
    let delivery = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:1 }, NOW).unwrap();
    let frame = body(delivery.line());
    assert_eq!(frame, json!({"v":1,"type":"answer","questionVersion":1,"project":identity().project,
        "sessionId":"session-1","at":NOW,"id":ID,"source":"human","answer":{"type":"option","value":"dev"}}));
    assert!(slot.active().is_some(), "preparation is not delivery");
    let other = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:0 }, NOW).unwrap();
    slot.commit_delivery(delivery).unwrap(); assert!(slot.active().is_none());
    assert!(slot.commit_delivery(other).is_err());
    assert!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:0 }, NOW).is_err());
}

#[test]
fn question_free_text_retains_bytes_and_rejects_controls_whitespace_and_overlimits() {
    let slot = slot();
    let text = "  respuesta\ncon\ttabulación 🙂  ";
    let delivery = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.into() }, NOW).unwrap();
    assert_eq!(body(delivery.line())["answer"]["text"], text);
    for text in ["", " \n\t ", "private\u{0000}", "bad\u{007f}", "bad\u{000b}", &"a".repeat(2001)] {
        assert!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.into() }, NOW).is_err());
        assert!(slot.active().is_some());
    }
    for (kind, allow) in [("approval",false), ("question",false)] {
        let mut value = question_value(); value["kind"] = json!(kind); value["allowFreeText"] = json!(allow);
        let mut slot = QuestionSlot::new(); slot.admit(7, &identity(), question(value), NOW).unwrap();
        assert!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:"yes".into() }, NOW).is_err());
    }
}

#[test]
fn question_answer_whole_multibyte_body_exact4096_and_one_byte_more() {
    let slot = slot();
    let seed = "🙂".to_string();
    let seed_line = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:seed }, NOW).unwrap();
    let overhead = seed_line.line().len()-1-4;
    let budget = FRAME_BYTES-overhead;
    let text = format!("{}{}", "🙂".repeat(budget/4), "a".repeat(budget%4));
    assert!(text.chars().count() <= 2000);
    let exact = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.clone() }, NOW).unwrap();
    assert_eq!(exact.line().len()-1,4096);
    assert_eq!(body(exact.line())["answer"]["text"],text);
    assert_eq!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:format!("{text}a") }, NOW).unwrap_err(), Error::FrameTooLarge);
    assert!(slot.active().is_some());
}

#[test]
fn question_answer_json_escaping_counts_serialized_bytes() {
    let slot = slot();
    let text = "\"\\\n\t".repeat(500);
    assert_eq!(text.chars().count(),2000);
    assert!(serde_json::to_vec(&text).unwrap().len()>4000);
    assert_eq!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text }, NOW).unwrap_err(), Error::FrameTooLarge);
    let text = "\"\\\n\t".repeat(100);
    let delivery = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.clone() }, NOW).unwrap();
    assert_eq!(body(delivery.line())["answer"]["text"], text);
    let overhead = delivery.line().len()-1-(serde_json::to_vec(&text).unwrap().len()-2);
    let budget = FRAME_BYTES-overhead;
    let text = format!("{}{}", "\"".repeat(budget/2), "a".repeat(budget%2));
    assert!(text.chars().count() <= 2000);
    let exact = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.clone() }, NOW).unwrap();
    assert_eq!(exact.line().len()-1, FRAME_BYTES);
    assert_eq!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:format!("{text}a") }, NOW).unwrap_err(), Error::FrameTooLarge);
}

#[test]
fn question_expiry_disconnect_cancel_never_answer_and_match_origin() {
    let mut slot = slot();
    assert!(slot.expire(8, ID, NOW+30_000).unwrap().is_none());
    assert!(slot.expire(7, OTHER_ID, NOW+30_000).unwrap().is_none());
    assert!(slot.expire(7, ID, NOW+29_999).unwrap().is_none());
    assert!(!slot.disconnect(8)); assert!(slot.active().is_some());
    assert_eq!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:0 }, NOW+30_000).unwrap_err(),Error::Expired);
    let expired = slot.expire(7, ID, NOW+30_000).unwrap().unwrap();
    assert_eq!(body(&expired)["type"],"question_closed");
    assert_eq!(body(&expired)["reason"],"expired");
    assert_eq!(body(&expired)["source"],"system");
    assert!(body(&expired).get("answer").is_none()); assert!(slot.active().is_none());
    let mut expired_question = question_value(); expired_question["at"] = json!(NOW-1);
    expired_question["expiresAt"] = json!(NOW+29_999);
    let q = question(expired_question);
    assert!(slot.admit(7,&identity(),q,NOW+29_999).is_err());
    let mut slot = super::tests::slot();
    let mut value = base("question_cancel"); value["id"] = json!(ID); value["reason"] = json!("cancelled");
    let Inbound::Cancel(cancel) = parse(&value).unwrap() else { unreachable!() };
    assert!(slot.cancel(8,&identity(),&cancel,NOW).unwrap().is_none());
    let closed = slot.cancel(7,&identity(),&cancel,NOW).unwrap().unwrap();
    assert_eq!(body(&closed)["source"],"system"); assert!(body(&closed).get("answer").is_none());
    assert!(slot.active().is_none());
    let mut slot = super::tests::slot(); assert!(slot.disconnect(7)); assert!(slot.active().is_none());
}

#[test]
fn question_human_decline_is_close_not_answer_and_old_preparation_cannot_consume_new_slot() {
    let mut slot = slot();
    let old = slot.prepare_decline(7,&identity(),ID,NOW).unwrap();
    assert_eq!(body(old.line())["reason"],"cancelled");
    assert_eq!(body(old.line())["source"],"human");
    assert!(body(old.line()).get("answer").is_none());
    assert!(slot.disconnect(7));
    slot.admit(7,&identity(),question(question_value()),NOW).unwrap();
    assert!(slot.commit_delivery(old).is_err()); assert!(slot.active().is_some());
    let decline = slot.prepare_decline(7,&identity(),ID,NOW).unwrap();
    slot.commit_delivery(decline).unwrap(); assert!(slot.active().is_none());
}

#[test]
fn question_cancel_wrong_id_scope_and_expired_reason_are_unanswered() {
    let mut slot = slot();
    let mut value = base("question_cancel");
    value["id"] = json!(OTHER_ID); value["reason"] = json!("expired");
    let Inbound::Cancel(other) = parse(&value).unwrap() else { unreachable!() };
    assert!(slot.cancel(7, &identity(), &other, NOW).unwrap().is_none());
    value["id"] = json!(ID);
    let Inbound::Cancel(cancel) = parse(&value).unwrap() else { unreachable!() };
    let wrong = Identity { session_id:"other".into(), ..identity() };
    assert!(slot.cancel(7, &wrong, &cancel, NOW).is_err());
    assert!(slot.active().is_some());
    let line = slot.cancel(7, &identity(), &cancel, NOW).unwrap().unwrap();
    assert_eq!(body(&line), json!({"v":1,"type":"question_closed","questionVersion":1,
        "project":identity().project,"sessionId":"session-1","at":NOW,"id":ID,
        "reason":"expired","source":"system"}));
    assert!(slot.active().is_none());
}

#[test]
fn question_state_admission_revalidates_and_late_human_answer_stays_allowed_until_deadline() {
    let mut slot = slot();
    let wrong = Identity { session_id:"other".into(), ..identity() };
    assert!(slot.admit(8, &wrong, question(question_value()), NOW).is_err());
    assert_eq!(slot.active().unwrap().connection_id(), 7);
    let delivery = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:0 }, NOW+29_999).unwrap();
    assert_eq!(body(delivery.line())["at"], NOW+29_999);
    slot.commit_delivery(delivery).unwrap();
    assert!(slot.active().is_none());
}

#[test]
fn question_timestamp_boundaries_nested_extras_and_duplicates() {
    let mut frame = question_value();
    frame["at"] = json!(NOW-FRESH_MS);
    frame["expiresAt"] = json!(NOW-FRESH_MS+900_000);
    assert!(parse(&frame).is_ok());
    let mut null = question_value(); null["allowFreeText"] = json!(null);
    assert!(parse(&null).is_err());
    let raw = serde_json::to_string(&question_value()).unwrap();
    let duplicate = raw.replacen("\"value\":\"main\"", "\"value\":\"main\",\"value\":\"forged\"", 1);
    assert!(decode(duplicate.as_bytes(), &identity(), NOW).is_err());
    let duplicate = raw.replacen("{", "{\"type\":\"question\",", 1);
    assert!(decode(duplicate.as_bytes(), &identity(), NOW).is_err());
    let exponent = raw.replacen("\"at\":100000", "\"at\":1e5", 1);
    assert!(decode(exponent.as_bytes(), &identity(), NOW).is_err());
    let mut missing = question_value(); missing.as_object_mut().unwrap().remove("allowFreeText");
    assert!(parse(&missing).is_err());
    for (key, value) in [("label", json!("unsafe\u{0007}label")), ("description", json!("unsafe\u{000c}text"))] {
        let mut frame = question_value(); frame["options"][0][key] = value;
        assert!(parse(&frame).is_err());
    }
    let mut plain = question_value(); plain["text"] = json!("line one\nline two\tend");
    plain["options"][0]["description"] = json!("line one\nline two\tend");
    assert!(parse(&plain).is_ok());
    let slot = slot();
    assert_eq!(slot.prepare_decline(7, &identity(), ID, MAX_SAFE_INTEGER+1).unwrap_err(), Error::InvalidTimestamp);
}

#[test]
fn question_resolved_accepts_only_producer_status_and_exact_scoped_schema() {
    for status in ["answered", "human_cancelled"] {
        let mut frame = base("question_resolved");
        frame["id"] = json!(ID); frame["status"] = json!(status);
        let Inbound::Resolved(resolved) = parse(&frame).expect("producer resolution must parse")
            else { panic!("expected typed resolution") };
        assert_eq!(resolved.id(), ID);
        assert_eq!(resolved.status(), if status == "answered" {
            ResolutionStatus::Answered
        } else { ResolutionStatus::HumanCancelled });
        for (key, value) in [
            ("status", json!("sent")), ("status", json!("expired")),
            ("status", json!(null)), ("text", json!("injected")),
            ("source", json!("human")), ("answer", json!({"type":"option","value":"main"})),
            ("questionVersion", json!(2)), ("v", json!(2)),
            ("project", json!("b".repeat(64))), ("sessionId", json!("other")),
            ("at", json!(NOW+1)), ("at", json!(NOW-FRESH_MS-1)),
            ("at", json!(100000.0)), ("id", json!("invalid-uuid")),
        ] {
            let mut invalid = frame.clone(); invalid[key] = value;
            assert!(parse(&invalid).is_err(), "invalid resolution field: {key}");
        }
        for key in ["status", "id", "questionVersion", "at", "project", "sessionId", "v"] {
            let mut missing = frame.clone(); missing.as_object_mut().unwrap().remove(key);
            assert!(parse(&missing).is_err(), "missing resolution field: {key}");
        }
        let raw = serde_json::to_string(&frame).unwrap();
        let duplicate = raw.replacen("{", "{\"status\":\"answered\",", 1);
        assert!(decode(duplicate.as_bytes(), &identity(), NOW).is_err());
        let exact = format!("{raw}{}", " ".repeat(FRAME_BYTES-raw.len()));
        assert!(decode(exact.as_bytes(), &identity(), NOW).is_ok());
        assert!(decode(format!("{exact} ").as_bytes(), &identity(), NOW).is_err());
    }
}

#[test]
fn question_approval_requires_exactly_two_options() {
    for count in [0, 1, 2, 3, 4, 5] {
        let mut frame = question_value(); frame["kind"] = json!("approval");
        frame["allowFreeText"] = json!(false);
        frame["options"] = json!((0..count).map(|i|
            json!({"value":format!("v{i}"),"label":"L","description":""})).collect::<Vec<_>>());
        assert_eq!(parse(&frame).is_ok(), count == 2, "approval option count {count}");
    }
}

#[test]
fn question_text_matches_producer_controls_and_ecmascript_trim_without_rewriting() {
    for text in [" \t\r\n", "\u{feff}", "\u{00a0}\u{2028}\u{2029}"] {
        for field in ["text", "label"] {
            let mut frame = question_value();
            if field == "text" { frame[field] = json!(text); }
            else { frame["options"][0][field] = json!(text); }
            assert!(parse(&frame).is_err(), "blank producer field: {field}");
        }
        assert!(slot().prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.into() }, NOW).is_err());
    }
    for text in [" literal\n\t\rtext ", "\u{0085}", "\u{009f}", "\u{feff}literal\u{feff}"] {
        let mut frame = question_value(); frame["text"] = json!(text);
        frame["options"][0]["label"] = json!(text);
        frame["options"][0]["description"] = json!(text);
        assert!(parse(&frame).is_ok(), "producer permits this literal text");
        let slot = slot();
        let prepared = slot.prepare_answer(7, &identity(), ID, HumanAnswer::Text { text:text.into() }, NOW).unwrap();
        assert_eq!(body(prepared.line())["answer"]["text"], text);
    }
}

#[test]
fn question_human_output_timestamp_cannot_precede_emitted_question() {
    let slot = slot();
    assert_eq!(slot.prepare_answer(7, &identity(), ID, HumanAnswer::Option { index:0 }, NOW-1).unwrap_err(), Error::InvalidTimestamp);
    assert_eq!(slot.prepare_decline(7, &identity(), ID, NOW-1).unwrap_err(), Error::InvalidTimestamp);
    assert!(slot.active().is_some());
}

#[test]
fn question_diagnostics_do_not_leak_payloads() {
    let mut value = question_value(); value["text"] = json!("secret-private-question");
    let q = question(value); assert!(!format!("{q:?}").contains("secret-private-question"));
    assert_eq!(Error::InvalidAnswer.to_string(),"invalid_answer");
    let slot = slot();
    let prepared = slot.prepare_answer(7,&identity(),ID,HumanAnswer::Text { text:"secret-private-answer".into() },NOW).unwrap();
    assert!(!format!("{prepared:?}").contains("secret-private-answer"));
}

// ---- P1: optional `agent` identity on the `question` frame --------------------------------
#[test]
fn without_the_agent_field_everything_is_exactly_as_before_and_the_agent_is_pi() {
    let q = question(question_value());
    assert_eq!(q.agent(), "pi", "backward compatible: no field = Pi");
    assert_eq!(q.agent_label(), "Pi");
}

#[test]
fn a_valid_agent_identity_is_accepted_and_labelled_for_display() {
    for (wire, label) in [("pi", "Pi"), ("claude-code", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"), ("gemini-cli", "Gemini Cli"),
                          ("my_agent.v2", "My Agent.V2"), ("a", "A"), ("agent-0123456789-abcdefghij", "Agent-0123456789-Abcdefghij")] {
        let mut v = question_value();
        v["agent"] = json!(wire);
        let q = question(v);
        assert_eq!(q.agent(), wire, "{wire}");
        assert!(!q.agent_label().is_empty());
        if ["pi", "claude-code", "codex", "opencode"].contains(&wire) { assert_eq!(q.agent_label(), label, "{wire}"); }
    }
}

#[test]
fn the_agent_field_is_a_short_safe_slug_or_the_whole_frame_is_refused() {
    for bad in [json!(""), json!("   "), json!("Claude Code"), json!("CLAUDE"), json!("claude code"), json!("claude\ncode"), json!("claude\u{0}"),
                json!("claude/code"), json!("claude<script>"), json!("../x"), json!("%s"), json!("{x}"), json!("ñandú"), json!("🙂"),
                json!("-leading"), json!(".leading"), json!("a".repeat(33)), json!(7), json!(null), json!(true), json!(["pi"]), json!({"id":"pi"})] {
        let mut v = question_value();
        v["agent"] = bad.clone();
        assert!(parse(&v).is_err(), "must refuse agent = {bad}");
    }
    // exactly 32 chars is the cap
    let mut v = question_value();
    v["agent"] = json!(format!("a{}", "b".repeat(31)));
    assert!(parse(&v).is_ok());
}

#[test]
fn the_agent_field_exists_only_on_the_question_frame() {
    // an unknown key is still refused everywhere else (the schema stays closed)
    for kind in ["question_cancel", "question_resolved", "question_answer_rejected", "questions_hello"] {
        let mut v = base(kind);
        v["agent"] = json!("codex");
        if kind != "questions_hello" { v["id"] = json!(ID); }
        assert!(parse(&v).is_err(), "{kind} must not accept `agent`");
    }
}

#[test]
fn the_agent_identity_never_changes_who_may_answer_or_how() {
    // same scope rules, same one-live-question slot, same answer frame for any agent
    let mut v = question_value();
    v["agent"] = json!("claude-code");
    let mut slot = QuestionSlot::new();
    assert!(matches!(slot.admit(7, &identity(), question(v), NOW).unwrap(), Admission::Accepted));
    let mut second = question_value();
    second["id"] = json!(OTHER_ID);
    second["agent"] = json!("codex");
    assert!(matches!(slot.admit(8, &identity(), question(second), NOW).unwrap(), Admission::Accepted), "queued behind the first, whatever the agent");
    assert_eq!(slot.active().unwrap().question().agent(), "claude-code");
    assert_eq!(slot.queue().nth(1).unwrap().question().agent(), "codex");
}

// ---- queue: every question is kept, one shown at a time, oldest first ----------

fn qid(n: usize) -> String { format!("12345678-1234-4abc-8abc-12345678{n:04x}") }
fn queued(n: usize, expires_in: u64) -> Question {
    let mut v = question_value(); v["id"] = json!(qid(n)); v["expiresAt"] = json!(NOW + expires_in);
    question(v)
}
fn ids(slot: &QuestionSlot) -> Vec<String> { slot.queue().map(|a| a.question().id().to_string()).collect() }

#[test]
fn queue_keeps_overlapping_questions_oldest_first_and_shows_the_oldest() {
    let mut slot = QuestionSlot::new();
    for n in 1..=3 {
        assert!(matches!(slot.admit(n as u64, &identity(), queued(n, 60_000), NOW).unwrap(), Admission::Accepted));
    }
    assert_eq!(ids(&slot), vec![qid(1), qid(2), qid(3)]);
    assert_eq!(slot.active().unwrap().question().id(), qid(1));
    assert_eq!(slot.len(), 3);
}

#[test]
fn queue_is_bounded_and_the_overflowing_agent_gets_busy() {
    let mut slot = QuestionSlot::new();
    assert_eq!(QUEUE_CAP, 8);
    for n in 1..=QUEUE_CAP { assert!(matches!(slot.admit(n as u64, &identity(), queued(n, 60_000), NOW).unwrap(), Admission::Accepted)); }
    let Admission::Busy(line) = slot.admit(99, &identity(), queued(99, 60_000), NOW).unwrap() else { panic!("overflow must be busy") };
    let frame = body(&line); assert_eq!(frame["reason"], "busy"); assert_eq!(frame["id"], qid(99));
    assert_eq!(slot.len(), QUEUE_CAP);
    assert!(!ids(&slot).contains(&qid(99)));
}

#[test]
fn only_the_head_can_be_answered_the_next_one_waits() {
    let mut slot = QuestionSlot::new();
    for n in 1..=2 { slot.admit(n as u64, &identity(), queued(n, 60_000), NOW).unwrap(); }
    assert!(slot.prepare_answer(2, &identity(), &qid(2), HumanAnswer::Option { index: 0 }, NOW).is_err(), "queued, not shown yet");
    assert!(slot.prepare_decline(2, &identity(), &qid(2), NOW).is_err());
    assert_eq!(slot.len(), 2);
}

#[test]
fn answering_the_head_leaves_the_others_and_promotes_the_next() {
    let mut slot = QuestionSlot::new();
    for n in 1..=3 { slot.admit(n as u64, &identity(), queued(n, 60_000), NOW).unwrap(); }
    let delivery = slot.prepare_answer(1, &identity(), &qid(1), HumanAnswer::Option { index: 1 }, NOW).unwrap();
    assert_eq!(body(delivery.line())["id"], qid(1));
    slot.commit_delivery(delivery).unwrap();
    assert_eq!(ids(&slot), vec![qid(2), qid(3)]);
    assert_eq!(slot.active().unwrap().connection_id(), 2);
    // declining the new head also leaves the last one untouched
    let decline = slot.prepare_decline(2, &identity(), &qid(2), NOW).unwrap();
    assert_eq!(body(decline.line())["reason"], "cancelled");
    slot.commit_delivery(decline).unwrap();
    assert_eq!(ids(&slot), vec![qid(3)]);
}

#[test]
fn each_question_keeps_its_own_expiry_even_when_queued() {
    let mut slot = QuestionSlot::new();
    slot.admit(1, &identity(), queued(1, 300_000), NOW).unwrap();
    slot.admit(2, &identity(), queued(2, 30_000), NOW).unwrap();
    slot.admit(3, &identity(), queued(3, 300_000), NOW).unwrap();
    // the middle one expires while the head is still live
    let later = NOW + 30_000;
    assert_eq!(slot.expire(2, &qid(2), later - 1).unwrap(), None, "not due yet");
    let line = slot.expire(2, &qid(2), later).unwrap().expect("expired");
    assert_eq!(body(&line)["reason"], "expired");
    assert_eq!(ids(&slot), vec![qid(1), qid(3)]);
    assert_eq!(slot.due(later), Vec::<u64>::new());
    // an expired head is skipped for the human, the next becomes current
    assert_eq!(slot.due(NOW + 300_000), vec![1, 3]);
}

#[test]
fn a_producer_cancel_or_disconnect_removes_only_that_question() {
    let mut slot = QuestionSlot::new();
    for n in 1..=3 { slot.admit(n as u64, &identity(), queued(n, 60_000), NOW).unwrap(); }
    assert!(slot.disconnect(2));
    assert_eq!(ids(&slot), vec![qid(1), qid(3)]);
    let cancel = match decode(&serde_json::to_vec(&json!({"v":1,"type":"question_cancel","questionVersion":1,
        "project":identity().project,"sessionId":"session-1","at":NOW,"id":qid(3),"reason":"cancelled"})).unwrap(), &identity(), NOW).unwrap() {
        Inbound::Cancel(c) => c, _ => unreachable!() };
    assert!(slot.cancel(3, &identity(), &cancel, NOW).unwrap().is_some());
    assert_eq!(ids(&slot), vec![qid(1)]);
    assert!(!slot.disconnect(42), "unknown connection changes nothing");
}

#[test]
fn a_stale_ticket_never_consumes_another_queued_question() {
    let mut slot = QuestionSlot::new();
    slot.admit(1, &identity(), queued(1, 60_000), NOW).unwrap();
    slot.admit(2, &identity(), queued(2, 60_000), NOW).unwrap();
    let ticket = slot.prepare_answer(1, &identity(), &qid(1), HumanAnswer::Option { index: 0 }, NOW).unwrap();
    assert!(slot.disconnect(1));
    assert!(slot.commit_delivery(ticket).is_err());
    assert_eq!(ids(&slot), vec![qid(2)]);
}
