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
fn win_modifier_bits_and_virtual_keys_are_the_win32_protocol_values() {
    // RegisterHotKey fsModifiers, read from the real SDK winuser.h in the xwin
    // cache (line 3577-3580): MOD_ALT 0x0001, MOD_CONTROL 0x0002, MOD_SHIFT
    // 0x0004, MOD_WIN 0x0008 (NOT 0x8000 as an early design note claimed),
    // MOD_NOREPEAT 0x4000. windows-sys 0.61.2 agrees with the header.
    let c = Combo::parse("Ctrl+Alt+Shift+Super+A").unwrap();
    assert_eq!(c.win_modifiers(), 0x0001 | 0x0002 | 0x0004 | 0x0008);
    assert_eq!(Combo::parse("Ctrl+A").unwrap().win_modifiers(), 0x0002);
    assert_eq!(Combo::parse("Alt+Space").unwrap().win_modifiers(), 0x0001);
    assert_eq!(Combo::parse("Super+Space").unwrap().win_modifiers(), 0x0008);
    assert_eq!(Combo::parse("Shift+Ctrl+9").unwrap().win_modifiers(), 0x0002 | 0x0004);
    // VK codes, read from the same winuser.h: the header comment says VK_A-VK_Z
    // are ASCII 'A'-'Z' (0x41-0x5A) and VK_0-VK_9 ASCII '0'-'9' (0x30-0x39);
    // VK_SPACE 0x20; VK_F1 0x70 .. VK_F12 0x7B; VK_F4 verified 0x73.
    assert_eq!(Combo::parse("Ctrl+A").unwrap().win_vk(), 0x41);
    assert_eq!(Combo::parse("Ctrl+Z").unwrap().win_vk(), 0x5a);
    assert_eq!(Combo::parse("Ctrl+0").unwrap().win_vk(), 0x30);
    assert_eq!(Combo::parse("Ctrl+9").unwrap().win_vk(), 0x39);
    assert_eq!(Combo::parse("Ctrl+Space").unwrap().win_vk(), 0x20);
    assert_eq!(Combo::parse("Alt+F4").unwrap().win_vk(), 0x73);
    assert_eq!(Combo::parse("Ctrl+F1").unwrap().win_vk(), 0x70);
    assert_eq!(Combo::parse("Ctrl+F12").unwrap().win_vk(), 0x7b);
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

// ---- #305b: portal backend (pure parts) ------------------------------------------------------
#[test]
fn portal_trigger_text_is_the_xdg_shortcuts_spec_form() {
    // xdg-shortcuts-v0: modifiers uppercase, joined with '+', key as an XKB keysym name
    assert_eq!(Combo::parse("Ctrl+Alt+A").unwrap().portal_trigger(), "CTRL+ALT+a");
    assert_eq!(Combo::parse("Super+Shift+7").unwrap().portal_trigger(), "SHIFT+LOGO+7");
    assert_eq!(Combo::parse("Ctrl+F12").unwrap().portal_trigger(), "CTRL+F12");
    assert_eq!(Combo::parse("Alt+Space").unwrap().portal_trigger(), "ALT+space");
    assert_eq!(Combo::parse("Ctrl+Alt+Shift+Super+Z").unwrap().portal_trigger(), "CTRL+ALT+SHIFT+LOGO+z");
}

#[test]
fn portal_request_handle_matches_the_documented_path() {
    // /org/freedesktop/portal/desktop/request/SENDER/TOKEN with the sender's ':' dropped and '.' → '_'
    assert_eq!(portal::request_path(":1.234", "abito_r1"), "/org/freedesktop/portal/desktop/request/1_234/abito_r1");
    assert_eq!(portal::request_path(":1.5", "t"), "/org/freedesktop/portal/desktop/request/1_5/t");
    assert_eq!(portal::sender_token(":1.234"), "1_234");
}

#[test]
fn portal_tokens_are_valid_dbus_name_parts() {
    for t in [portal::token("req"), portal::token("sess")] {
        assert!(t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'), "{t}");
        assert!(!t.as_bytes()[0].is_ascii_digit(), "must not start with a digit");
    }
    assert_ne!(portal::token("req"), portal::token("req"), "tokens are unique per call");
}

#[test]
fn portal_response_codes_map_to_visible_statuses() {
    use portal::{outcome_of_response, Outcome};
    assert_eq!(outcome_of_response(0), Outcome::Granted);
    assert_eq!(outcome_of_response(1), Outcome::Denied, "the human closed/declined the OS dialog");
    assert_eq!(outcome_of_response(2), Outcome::Failed);
    assert_eq!(outcome_of_response(99), Outcome::Failed, "anything unknown is a failure, never a grant");
}

#[test]
fn backend_choice_prefers_the_portal_on_wayland_and_falls_back_cleanly() {
    use portal::{choose_backend, Backend, PortalState};
    // Wayland: the portal is the primary route; X11 grab only when it cannot work
    assert_eq!(choose_backend(Session::Wayland, PortalState::Available), Backend::Portal);
    assert_eq!(choose_backend(Session::Wayland, PortalState::Unavailable), Backend::X11 { limited: true });
    assert_eq!(choose_backend(Session::Wayland, PortalState::Denied), Backend::X11 { limited: true },
        "the human refused the OS dialog: fall back honestly, never pretend");
    // X11 and unknown sessions never touch the portal
    assert_eq!(choose_backend(Session::X11, PortalState::Available), Backend::X11 { limited: false });
    assert_eq!(choose_backend(Session::Unknown, PortalState::Available), Backend::X11 { limited: false });
}

#[test]
fn portal_status_vocabulary_covers_the_os_permission_story() {
    for (s, text) in [(Status::PermissionPending, "permission_pending"), (Status::PermissionDenied, "permission_denied")] {
        assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!(text));
    }
}

#[test]
fn portal_activation_is_filtered_to_our_shortcut_and_ignores_deactivation() {
    use portal::{is_our_activation, ShortcutSignal};
    let ours = ShortcutSignal { shortcut_id: portal::SHORTCUT_ID.into(), activated: true };
    assert!(is_our_activation(&ours));
    assert!(!is_our_activation(&ShortcutSignal { activated: false, ..ours.clone() }), "release is not a toggle");
    assert!(!is_our_activation(&ShortcutSignal { shortcut_id: "someone-else".into(), activated: true }));
}

#[test]
fn view_reports_which_backend_holds_the_shortcut_and_only_the_x11_fallback_is_limited() {
    use portal::Backend;
    assert_eq!(backend_name(Backend::Portal), "portal");
    assert_eq!(backend_name(Backend::X11 { limited: true }), "x11");
    assert!(!backend_limited(Backend::Portal), "the portal works system-wide on Wayland");
    assert!(backend_limited(Backend::X11 { limited: true }));
    assert!(!backend_limited(Backend::X11 { limited: false }), "a real X11 session is complete");
}

#[test]
fn a_failed_portal_hands_over_to_the_x11_grab_and_says_so() {
    use portal::{fallback_for, Backend, Fallback};
    // pending: still waiting for the human, keep the portal
    assert_eq!(fallback_for(Backend::Portal, Status::PermissionPending), Fallback::Keep);
    assert_eq!(fallback_for(Backend::Portal, Status::Active), Fallback::Keep);
    // the human declined the OS dialog, or the portal cannot do it: fall back, and remember why
    assert_eq!(fallback_for(Backend::Portal, Status::PermissionDenied), Fallback::ToX11 { portal_status: Status::PermissionDenied });
    assert_eq!(fallback_for(Backend::Portal, Status::Unsupported), Fallback::ToX11 { portal_status: Status::Unsupported });
    // X11 never "falls back" again; only the portal does
    assert_eq!(fallback_for(Backend::X11 { limited: true }, Status::Taken), Fallback::Keep);
}

#[test]
fn the_permission_story_is_visible_in_the_chip_vocabulary() {
    // the OS dialog needs the human: say it, once, with the single action to take
    for (status, word) in [(Status::PermissionPending, "Aceptá el permiso"), (Status::PermissionDenied, "Atajo sin permiso")] {
        assert!(!word.is_empty(), "{status:?}");
    }
}

#[test]
fn portal_plan_keeps_a_parallel_x11_grab_until_the_portal_is_really_active() {
    use portal::{plan_for, PortalPlan};
    // the OS dialog is open (maybe forever): the limited X11 grab runs MEANWHILE, never "no route"
    assert_eq!(plan_for(Status::PermissionPending), PortalPlan::KeepBoth);
    // the portal took the shortcut: drop the X11 grab so one press cannot toggle twice
    assert_eq!(plan_for(Status::Active), PortalPlan::DropX11);
    // the portal gave up or the human declined: the already-running X11 grab becomes the route
    assert_eq!(plan_for(Status::PermissionDenied), PortalPlan::PromoteX11 { reason: Status::PermissionDenied });
    assert_eq!(plan_for(Status::Unsupported), PortalPlan::PromoteX11 { reason: Status::Unsupported });
}

#[test]
fn the_view_remembers_why_the_portal_was_dropped() {
    let v = View { combo: "Ctrl+Alt+A".into(), enabled: true, status: Status::Active, limited: true, backend: "x11", portal_note: Some(Status::PermissionDenied) };
    let json = serde_json::to_value(&v).unwrap();
    assert_eq!(json["portal_note"], serde_json::json!("permission_denied"));
    let none = View { portal_note: None, ..v };
    assert_eq!(serde_json::to_value(&none).unwrap()["portal_note"], serde_json::Value::Null);
}

// ---- #310: one physical press must toggle ONCE, whichever backends report it -------------------------
#[test]
fn two_backends_reporting_the_same_press_toggle_once() {
    use crate::hotkey::PressGate;
    let mut gate = PressGate::default();
    assert!(gate.accept(10_000), "the first report is the press");
    assert!(!gate.accept(10_040), "the X11 grab reporting the SAME press 40ms later is the same press");
    assert!(!gate.accept(10_000 + crate::hotkey::PRESS_DEDUP_MS - 1), "still inside the window");
}

#[test]
fn a_real_second_press_after_the_window_toggles_again() {
    use crate::hotkey::PressGate;
    let mut gate = PressGate::default();
    assert!(gate.accept(1_000));
    assert!(gate.accept(1_000 + crate::hotkey::PRESS_DEDUP_MS), "exactly at the window edge it is a new press");
    assert!(gate.accept(1_000 + 5 * crate::hotkey::PRESS_DEDUP_MS));
}

#[test]
fn a_dropped_duplicate_does_not_extend_the_window_so_a_steady_double_press_is_not_swallowed_forever() {
    use crate::hotkey::PressGate;
    let mut gate = PressGate::default();
    let w = crate::hotkey::PRESS_DEDUP_MS;
    assert!(gate.accept(0));
    assert!(!gate.accept(w - 10), "duplicate, dropped");
    assert!(gate.accept(w + 5), "measured from the LAST ACCEPTED press, not from the dropped duplicate");
}

#[test]
fn the_window_is_short_enough_for_a_human_double_tap_and_long_enough_for_two_backends() {
    assert!(crate::hotkey::PRESS_DEDUP_MS >= 150, "two backends can disagree by more than a frame");
    assert!(crate::hotkey::PRESS_DEDUP_MS <= 400, "a deliberate second press (hide right after show) must work");
}

#[test]
fn a_clock_that_goes_backwards_never_blocks_the_hotkey() {
    use crate::hotkey::PressGate;
    let mut gate = PressGate::default();
    assert!(gate.accept(50_000));
    assert!(gate.accept(10), "an earlier timestamp is not a duplicate");
}
