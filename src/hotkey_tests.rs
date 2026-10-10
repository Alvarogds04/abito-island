use super::*;

#[test]
fn default_is_a_valid_global_combo() {
    let c = Combo::default_combo();
    assert_eq!(c.to_string(), "Ctrl+Alt+A");
    assert!(c.validate().is_ok());
    assert_eq!(Combo::parse("Ctrl+Alt+A").unwrap(), c);
}

#[test]
fn parse_is_case_insensitive_order_insensitive_and_canonical() {
    for text in ["ctrl+alt+a", "Alt+Ctrl+A", "CONTROL+Option+a", " Ctrl + Alt + A "] {
        assert_eq!(Combo::parse(text).unwrap().to_string(), "Ctrl+Alt+A", "{text}");
    }
    assert_eq!(Combo::parse("Super+Shift+Ctrl+Alt+F12").unwrap().to_string(), "Ctrl+Alt+Shift+Super+F12");
    assert_eq!(Combo::parse("Meta+Space").unwrap().to_string(), "Super+Space");
    assert_eq!(Combo::parse("Win+7").unwrap().to_string(), "Super+7");
    assert_eq!(Combo::parse("Ctrl+F1").unwrap().to_string(), "Ctrl+F1");
}

#[test]
fn only_closed_keys_are_accepted_and_junk_is_refused() {
    // a bare key parses (the model) but is refused by validate() (the policy), see the next test
    assert_eq!(Combo::parse("A").unwrap().validate(), Err(ComboError::NeedsModifier));
    for bad in ["", "+", "Ctrl+", "Ctrl+Alt", "Ctrl+Alt+AA", "Ctrl+Alt+Esc", "Ctrl+Alt+Escape", "Ctrl+Alt+Enter",
                "Ctrl+Alt+Tab", "Ctrl+Alt+F13", "Ctrl+Alt+F0", "Ctrl+Alt+ñ", "Ctrl+Alt+;", "Ctrl+Ctrl+A", "Ctrl+Alt+A+B",
                "Ctrl+Alt+Bogus", "Ctrl+Alt+\u{0000}", "Ctrl+Alt+%", "$(reboot)", "Ctrl+Alt+A\n", "Ctrl+Alt+a+"] {
        assert!(Combo::parse(bad).is_err(), "must refuse {bad:?}");
    }
    // overlong input is refused before any parsing work
    assert!(Combo::parse(&"Ctrl+".repeat(200)).is_err());
}

#[test]
fn a_global_grab_needs_a_real_modifier_so_it_never_steals_typing() {
    for bad in ["Shift+A", "Shift+Space", "Shift+F5"] {
        let c = Combo::parse(bad).unwrap();
        assert_eq!(c.validate(), Err(ComboError::NeedsModifier), "{bad}");
    }
    for ok in ["Ctrl+A", "Alt+Space", "Super+Space", "Shift+Ctrl+9", "Alt+F4"] {
        assert!(Combo::parse(ok).unwrap().validate().is_ok(), "{ok}");
    }
}

#[test]
fn x11_masks_and_keysyms_are_the_protocol_values() {
    let c = Combo::parse("Ctrl+Alt+Shift+Super+A").unwrap();
    // ShiftMask 1, ControlMask 4, Mod1 (Alt) 8, Mod4 (Super) 0x40
    assert_eq!(c.x11_modifiers(), 1 | 4 | 8 | 0x40);
    assert_eq!(Combo::parse("Ctrl+A").unwrap().x11_modifiers(), 4);
    assert_eq!(Combo::parse("Ctrl+A").unwrap().keysym(), 0x61);
    assert_eq!(Combo::parse("Ctrl+Z").unwrap().keysym(), 0x7a);
    assert_eq!(Combo::parse("Ctrl+0").unwrap().keysym(), 0x30);
    assert_eq!(Combo::parse("Ctrl+9").unwrap().keysym(), 0x39);
    assert_eq!(Combo::parse("Ctrl+Space").unwrap().keysym(), 0x20);
    assert_eq!(Combo::parse("Ctrl+F1").unwrap().keysym(), 0xffbe);
    assert_eq!(Combo::parse("Ctrl+F12").unwrap().keysym(), 0xffc9);
}

#[test]
fn every_lock_state_is_grabbed_so_numlock_or_capslock_never_breaks_the_hotkey() {
    let variants = lock_variants();
    assert_eq!(variants.len(), 4);
    assert!(variants.contains(&0) && variants.contains(&0x02) && variants.contains(&0x10) && variants.contains(&0x12));
    // an incoming event matches regardless of the lock bits, but never with an extra real modifier
    let c = Combo::parse("Ctrl+Alt+A").unwrap();
    for lock in &variants { assert!(c.matches_state(c.x11_modifiers() | lock)); }
    assert!(!c.matches_state(c.x11_modifiers() | 1), "extra Shift is a different shortcut");
    assert!(!c.matches_state(4), "missing Alt");
    assert!(!c.matches_state(0));
}

#[test]
fn config_fails_closed_to_the_default_and_round_trips() {
    let d = HotkeyConfig::default();
    assert!(d.enabled && d.combo == Combo::default_combo());
    for bad in [None, Some(""), Some("not json"), Some("{}"), Some("[]"), Some(r#"{"v":1}"#),
                Some(r#"{"v":1,"combo":"Ctrl+Alt+Esc"}"#), Some(r#"{"v":1,"combo":7}"#), Some(r#"{"v":2,"combo":"Ctrl+B"}"#),
                Some(r#"{"v":1,"combo":"A"}"#), Some(r#"{"v":1,"combo":"Shift+A"}"#)] {
        assert_eq!(HotkeyConfig::from_text(bad), d, "{bad:?} must fall back to the default");
    }
    let custom = HotkeyConfig::from_text(Some(r#"{"v":1,"combo":"super+shift+7","enabled":false}"#));
    assert_eq!(custom.combo.to_string(), "Shift+Super+7");
    assert!(!custom.enabled);
    assert_eq!(HotkeyConfig::from_text(Some(&custom.to_text())), custom);
    // `enabled` defaults to true when absent; a non-bool is the default (enabled)
    assert!(HotkeyConfig::from_text(Some(r#"{"v":1,"combo":"Ctrl+B"}"#)).enabled);
    assert!(HotkeyConfig::from_text(Some(r#"{"v":1,"combo":"Ctrl+B","enabled":"no"}"#)).enabled);
    assert!(!custom.to_text().contains('\n'));
}

#[test]
fn status_vocabulary_is_closed_and_snake_case() {
    for (s, text) in [(Status::Disabled, "disabled"), (Status::Active, "active"), (Status::Taken, "taken"),
                      (Status::Invalid, "invalid"), (Status::Unsupported, "unsupported")] {
        assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!(text));
    }
}

#[test]
fn toggle_decision_hidden_shows_visible_hides_and_a_pending_question_blocks_hiding() {
    assert_eq!(toggle_decision(true, false), ToggleDecision::Show);
    assert_eq!(toggle_decision(true, true), ToggleDecision::Show, "showing never loses a pending question");
    assert_eq!(toggle_decision(false, false), ToggleDecision::Hide);
    assert_eq!(toggle_decision(false, true), ToggleDecision::Ignore, "a question waiting for the human keeps the island open");
}

#[test]
fn session_kind_is_read_from_the_environment_only() {
    assert_eq!(session_kind(Some("wayland"), None), Session::Wayland);
    assert_eq!(session_kind(None, Some("wayland-0")), Session::Wayland);
    assert_eq!(session_kind(Some("x11"), None), Session::X11);
    assert_eq!(session_kind(Some("tty"), None), Session::Unknown);
    assert_eq!(session_kind(None, None), Session::Unknown);
    // XWayland receives global grabs only while an X11 window is focused: say so
    assert!(Session::Wayland.limited());
    assert!(!Session::X11.limited());
    assert!(!Session::Unknown.limited());
}

#[test]
fn command_schema_is_closed_exact_and_validated() {
    use serde_json::json;
    assert_eq!(parse_command(&json!({"action":"view"})), Ok(Command::View));
    assert_eq!(parse_command(&json!({"action":"enable"})), Ok(Command::Enable));
    assert_eq!(parse_command(&json!({"action":"disable"})), Ok(Command::Disable));
    assert_eq!(parse_command(&json!({"action":"reset"})), Ok(Command::Reset));
    assert_eq!(parse_command(&json!({"action":"set","combo":"super+shift+7"})), Ok(Command::Set(Combo::parse("Shift+Super+7").unwrap())));
    for bad in [json!(null), json!([]), json!("view"), json!({}), json!({"action":1}), json!({"action":"nope"}),
                json!({"action":"view","extra":1}), json!({"action":"set"}), json!({"action":"set","combo":3}),
                json!({"action":"set","combo":"Ctrl+Alt+A","also":true}), json!({"action":"reset","combo":"Ctrl+B"})] {
        assert_eq!(parse_command(&bad), Err(CommandError::InvalidSchema), "{bad}");
    }
    assert_eq!(parse_command(&json!({"action":"set","combo":"Ctrl+Alt+Esc"})), Err(CommandError::InvalidCombo));
    assert_eq!(parse_command(&json!({"action":"set","combo":"A"})), Err(CommandError::NeedsModifier));
    assert_eq!(parse_command(&json!({"action":"set","combo":"Shift+A"})), Err(CommandError::NeedsModifier));
    assert_eq!(CommandError::NeedsModifier.code(), "needs_modifier");
}

#[test]
fn idle_status_follows_the_enabled_flag() {
    let mut c = HotkeyConfig::default();
    assert_eq!(idle_status(&c), Status::Unsupported);
    c.enabled = false;
    assert_eq!(idle_status(&c), Status::Disabled);
}

#[test]
fn hidden_island_keeps_its_session_because_hide_is_only_a_window_hide() {
    // The contract the hotkey relies on: hiding changes the phase to Hidden and nothing else.
    use crate::desktop::{transition, IslandState};
    assert_eq!(transition(IslandState::Compact, "hide"), IslandState::Hidden);
    assert_eq!(transition(IslandState::Expanded, "hide"), IslandState::Hidden);
    assert_eq!(transition(IslandState::Hidden, "restore"), IslandState::Compact);
    // a Pi notice or an expand request never pops a hidden island by itself
    assert_eq!(transition(IslandState::Hidden, "notice"), IslandState::Hidden);
    assert_eq!(transition(IslandState::Hidden, "expand"), IslandState::Hidden);
}

#[test]
fn showing_via_the_hotkey_never_leaves_the_keyboard_with_the_island() {
    // After show() some window managers focus the new map. The hotkey is pressed
    // while the human types somewhere else: the island must hand the keyboard
    // back when it ended up focused and nobody asked for it.
    assert_eq!(focus_after_show(true, false), FocusAction::GiveBack);
    assert_eq!(focus_after_show(false, false), FocusAction::Leave);
    assert_eq!(focus_after_show(true, true), FocusAction::Leave, "a deliberate typing intent keeps the focus");
    assert_eq!(focus_after_show(false, true), FocusAction::Leave);
}

#[test]
fn repeat_guard_tells_a_real_press_from_auto_repeat() {
    use super::x11::{RepeatGuard, STALE_MS};
    let mut g = RepeatGuard::default();
    assert!(g.press(1_000), "first press fires");
    // held: detectable auto-repeat = more presses without a release, after the initial delay
    assert!(!g.press(1_660)); // first repeat after the ~660 ms delay
    for t in (1_693..3_000).step_by(33) { assert!(!g.press(t), "repeat at {t}"); }
    g.release();
    assert!(g.press(3_100), "a press after the release is a new one");
    assert!(!g.press(3_700), "…and its own repeats are ignored again");
    g.release();
    assert!(g.press(3_800) && { g.release(); g.press(3_900) }, "quick deliberate double press = two");
}

#[test]
fn repeat_guard_never_stays_stuck_when_the_release_goes_elsewhere() {
    use super::x11::{RepeatGuard, STALE_MS};
    let mut g = RepeatGuard::default();
    assert!(g.press(5_000));
    // Ctrl/Alt were released first: the key release never reaches us (no release()).
    assert!(!g.press(5_000 + STALE_MS), "exactly at the window it is still the same hold");
    assert!(g.press(5_000 + STALE_MS + STALE_MS + 1), "after a long silence the next press is real");
    // an X timestamp wrap never panics or sticks
    let mut w = RepeatGuard::default();
    assert!(w.press(u64::from(u32::MAX) - 10));
    w.release();
    assert!(w.press(5));
}
