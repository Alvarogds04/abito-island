use super::*;
use crate::protocol::Identity;
use crate::question::{self, HumanAnswer, Inbound};
use serde_json::json;

const ID: &str = "12345678-1234-4abc-8abc-123456789abc";
const NOW: u64 = 100_000;
fn slot(free: bool) -> QuestionSlot {
    let identity = Identity { project: "a".repeat(64), session_id: "session-1".into(), at: NOW as i64 };
    let body = json!({"v":1,"type":"question","questionVersion":1,"project":identity.project,
        "sessionId":"session-1","at":NOW,"id":ID,"kind":"question","text":"Pregunta",
        "options":[{"value":"private-a","label":"A","description":""},
                   {"value":"private-b","label":"B","description":""}],
        "allowFreeText":free,"expiresAt":NOW+30_000});
    let Inbound::Question(q) = question::decode(body.to_string().as_bytes(), &identity, NOW).unwrap() else { panic!() };
    let mut slot = QuestionSlot::new(); slot.admit(7, &identity, q, NOW).unwrap(); slot
}
#[test]
fn questioncmd_accepts_only_closed_shapes() {
    assert!(matches!(parse_command(&json!({"action":"view"})), Ok(Command::View)));
    assert!(matches!(parse_command(&json!({"action":"answer","id":ID,"index":3})),
        Ok(Command::Answer { index:3, .. })));
    assert!(matches!(parse_command(&json!({"action":"decline","id":ID})), Ok(Command::Decline { .. })));
    for action in ["text", "budget"] {
        assert!(parse_command(&json!({"action":action,"id":ID,"text":" literal\n🙂 "})).is_ok());
    }
}
#[test]
fn questioncmd_rejects_stowaways_and_automation() {
    for key in ["endpoint","scope","project","sessionId","token","value","source","human","isTrusted"] {
        let mut v = json!({"action":"answer","id":ID,"index":0}); v[key] = json!("opaque");
        assert!(parse_command(&v).is_err());
    }
    for v in [json!(null), json!([]), json!({"action":"auto_answer"}),
        json!({"action":"view","id":ID}), json!({"action":"answer","id":ID}),
        json!({"action":"decline","id":ID,"text":"x"}),
        json!({"action":"text","id":ID,"text":12})] { assert!(parse_command(&v).is_err()); }
}
#[test]
fn questioncmd_checks_indices_uuid_and_controls() {
    for index in [json!(-1), json!(4), json!(1.0), json!("1"), json!(true)] {
        assert!(parse_command(&json!({"action":"answer","id":ID,"index":index})).is_err());
    }
    for id in ["", "12345678-1234-3abc-8abc-123456789abc", "12345678-1234-4abc-7abc-123456789abc",
        "12345678-1234-4ABC-8abc-123456789abc", "not-a-uuid"] {
        assert!(parse_command(&json!({"action":"decline","id":id})).is_err());
    }
    for c in ['\0','\u{0008}','\u{000b}','\u{001f}','\u{007f}'] {
        for action in ["text","budget"] {
            assert!(parse_command(&json!({"action":action,"id":ID,"text":format!("x{c}")})).is_err());
        }
    }
}
#[test]
fn questioncmd_bounds_ipc_but_budget_accepts_invalid_drafts() {
    for text in ["".into(), " ".into(), "🙂".repeat(2001)] {
        assert!(parse_command(&json!({"action":"budget","id":ID,"text":text})).is_ok());
    }
    assert!(parse_command(&json!({"action":"budget","id":ID,"text":"x".repeat(MAX_REQUEST_BYTES)})).is_err());
}
#[test]
fn questioncmd_collapse_guard_matrix() {
    assert!(!collapse_allowed(true, true));
    assert!(collapse_allowed(false, true));
    assert!(collapse_allowed(true, false));
    assert!(collapse_allowed(false, false));
}
#[test]
fn questioncmd_guarded_click_preserves_pending_chat_and_clears_press() {
    use crate::{core::{Core, WindowIo, ReleaseOutcome}, geometry::Rect};
    struct Io;
    impl WindowIo for Io {
        fn outer_position(&self) -> (i32, i32) { (0, 0) }
        fn size(&self) -> (i32, i32) { (672, 256) }
        fn scale(&self) -> f64 { 1.0 }
        fn set_outer_position(&self, _x: i32, _y: i32) {}
    }
    let area = Rect { x:0, y:0, w:1920, h:1080 };
    for (expanded, pending) in [(true,true), (true,false), (false,true)] {
        let mut core = Core::new(); core.expanded = expanded; core.chat = expanded;
        core.press(&Io, (20.0, 20.0));
        let result = guarded_release(&mut core, &Io, area, (20.0, 20.0), false, pending);
        assert!(!core.press_active());
        if expanded && pending {
            assert!(matches!(result, ReleaseOutcome::Cancelled));
            assert!(core.expanded); assert!(core.chat);
        } else {
            assert!(matches!(result, ReleaseOutcome::Toggle(_)));
            assert_eq!(core.expanded, !expanded);
        }
    }
}
#[test]
fn questioncmd_queued_compact_apply_checks_and_applies_inside_admission_guard() {
    use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}};
    // The fake main queue deliberately runs only after a possible admission or
    // plan invalidation. try_lock proves both check and apply retain the guard.
    for (pending_after_queue, current_after_queue) in [(false,true), (true,true), (false,false)] {
        let admission = Arc::new(Mutex::new(false));
        let current = Arc::new(AtomicBool::new(true));
        let applied = Arc::new(AtomicUsize::new(0));
        let (guard_lock, check_lock, apply_lock) = (admission.clone(), admission.clone(), admission.clone());
        let (check_current, apply_count) = (current.clone(), applied.clone());
        let mut queued = None;
        queue_compact_apply(|task| queued = Some(task), move |operation| {
            let guard = guard_lock.lock().unwrap();
            assert!(check_lock.try_lock().is_err(), "plan checked outside admission guard");
            if !*guard && check_current.load(Ordering::SeqCst) {
                let mut barrier = NativeResizeBarrier::default();
                assert_eq!(barrier.begin(1, (304,44), None, 0), ResizeStart::Request);
                assert_eq!(barrier.state(), NativeTransition::NativeTransitionBusy);
                operation(true);
            }
        }, move |resize| {
            assert!(resize);
            assert!(apply_lock.try_lock().is_err(), "resize applied outside admission guard");
            apply_count.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(applied.load(Ordering::SeqCst), 0, "no work before main queue execution");
        *admission.lock().unwrap() = pending_after_queue;
        current.store(current_after_queue, Ordering::SeqCst);
        queued.unwrap()();
        assert_eq!(applied.load(Ordering::SeqCst), usize::from(!pending_after_queue && current_after_queue));
        assert!(admission.try_lock().is_ok(), "guard released after application");
    }
}
#[test]
fn questioncmd_native_resize_requires_matching_observation_and_bounds_timeout() {
    let mut barrier = NativeResizeBarrier::default();
    assert_eq!(barrier.begin(7, (304,44), Some((672,176)), 100), ResizeStart::Request);
    assert_eq!(barrier.state(), NativeTransition::NativeTransitionBusy);
    assert!(!barrier.observe(6, (304,44)));
    assert!(!barrier.observe(7, (304,45)));
    assert!(!barrier.timeout(7, 2099));
    assert!(barrier.timeout(7, 2100));
    assert_eq!(barrier.state(), NativeTransition::NativeTransitionDegraded);
    assert!(!barrier.timeout(7, 9999)); // one deadline, not repeated invalidation
    assert!(barrier.observe(7, (304,44))); // late matching actual observation
    assert_eq!(barrier.state(), NativeTransition::Idle);
}
#[test]
fn questioncmd_native_resize_known_size_never_bypasses_unsettled_generation() {
    let mut barrier = NativeResizeBarrier::default();
    assert_eq!(barrier.begin(1, (304,44), Some((304,44)), 0), ResizeStart::Stable);
    assert_eq!(barrier.state(), NativeTransition::Idle);
    assert_eq!(barrier.begin(2, (304,44), None, 10), ResizeStart::Request);
    assert_eq!(barrier.begin(3, (304,44), Some((304,44)), 20), ResizeStart::Request);
    assert!(!barrier.timeout(2, 9999));
    assert!(!barrier.observe(2, (304,44)));
    assert_eq!(barrier.begin(2, (304,44), Some((304,44)), 30), ResizeStart::Stale);
    assert_eq!(barrier.state(), NativeTransition::NativeTransitionBusy);
    assert!(barrier.timeout(3, 2020));
    assert_eq!(barrier.state(), NativeTransition::NativeTransitionDegraded);
    assert_eq!(barrier.begin(4, (304,44), Some((304,44)), 2030), ResizeStart::Request);
    assert!(barrier.observe(4, (304,44)));
}
#[test]
fn questioncmd_native_recovery_only_accepts_current_plan_physical_size() {
    for (expanded, chat, expected) in [(false,false,(304,44)),(false,true,(304,44)),
                                     (true,false,(672,176)),(true,true,(672,256))] {
        assert_eq!(desired_native_size(expanded, chat, 1.0), expected);
        assert_eq!(desired_native_size(expanded, chat, 2.0), (expected.0*2, expected.1*2));
    }
    for timed_out in [false,true] {
        let mut barrier = NativeResizeBarrier::default();
        barrier.begin(7, (304,44), None, 0);
        if timed_out { assert!(barrier.timeout(7, 2000)); }
        // Merely advancing the host view never proves the window has resized.
        assert!(!barrier.observe_current(8, (672,176), (304,44)));
        assert!(!barrier.observe_current(8, (672,176), (672,177)));
        assert_ne!(barrier.state(), NativeTransition::Idle);
        assert!(barrier.observe_current(8, (672,176), (672,176)));
        assert_eq!(barrier.state(), NativeTransition::Idle);
        assert!(!barrier.timeout(7, 9999));
        barrier.begin(9, (304,44), None, 10000);
        assert!(!barrier.observe_current(8, (672,176), (672,176)));
        assert_eq!(barrier.state(), NativeTransition::NativeTransitionBusy);
    }
}
#[test]
fn questioncmd_budget_exact_wire_boundary_without_mutation() {
    let slot = slot(true);
    let overhead = text_budget(&slot, ID, "", NOW).unwrap().bytes;
    // Multibyte text reaches the byte cap without exceeding 2000 codepoints.
    for target in [4096, 4097] {
        let room = target - overhead;
        let text = format!("{}{}", "🙂".repeat(room/4), "x".repeat(room%4));
        let budget = text_budget(&slot, ID, &text, NOW).unwrap();
        assert_eq!(budget.bytes, target);
        assert_eq!(budget.allowed, target == 4096);
        assert_eq!(budget.reason, if target == 4096 { None } else { Some("frame_too_large") });
        let active = slot.active().unwrap();
        let prepared = slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Text { text }, NOW);
        if target == 4096 { assert_eq!(prepared.unwrap().line().len(), target+1); }
        else { assert!(matches!(prepared, Err(Error::FrameTooLarge))); }
        assert!(slot.active().is_some());
    }
}
#[test]
fn questioncmd_budget_literal_escaping_validation_and_privacy() {
    let slot = slot(true);
    for text in [" \"\\\n\t\r🙂 ", "\u{0085}", "\u{feff}x"] {
        let active = slot.active().unwrap();
        let prepared = slot.prepare_answer(7, active.identity(), ID, HumanAnswer::Text { text: text.into() }, NOW).unwrap();
        assert_eq!(text_budget(&slot, ID, text, NOW).unwrap().bytes, prepared.line().len()-1);
    }
    for text in ["", " \u{feff}", "x\0"] {
        let budget = text_budget(&slot, ID, text, NOW).unwrap();
        assert!(!budget.allowed); assert_eq!(budget.reason, Some("invalid_answer"));
    }
    assert!(!text_budget(&slot, ID, &"x".repeat(2001), NOW).unwrap().allowed);
    assert!(matches!(text_budget(&slot, "wrong-id", "secret", NOW), Err(Error::NotLive)));
    assert!(matches!(text_budget(&slot, ID, "secret", NOW+30_000), Err(Error::Expired)));
    assert!(!text_budget(&self::slot(false), ID, "x", NOW).unwrap().allowed);
    let v = serde_json::to_string(&text_budget(&slot, ID, "secret", NOW).unwrap()).unwrap();
    for secret in ["secret","session-1","private-a","project","source"] { assert!(!v.contains(secret)); }
    assert!(slot.active().is_some());
}
