//! F099 — closed, gated focus of an already-running terminal / agent session
//! window / editor. Every rule here is asserted through the public surface
//! (`focus_command`, the classification seam, `focus_from_windows`): rejected
//! input must produce a public Spanish reason, spend no rate budget and call
//! no effect.
use super::*;
use crate::bridge::RateLimiter;
use serde_json::json;

const ORIGIN_OK: &str = "tauri://localhost/";

fn ok_payload() -> serde_json::Value {
    json!({"target": "terminal"})
}

fn win(instance: &str, class: &str, title: &str) -> WindowInfo {
    WindowInfo {
        instance: instance.to_string(),
        class: class.to_string(),
        title: title.to_string(),
    }
}

#[test]
fn closed_target_enum_parses_only_the_three_exact_strings() {
    for raw in ["terminal", "session", "editor"] {
        assert!(Target::parse(raw).is_some(), "{raw}");
    }
    for raw in [
        "Terminal", "SESSION", "Editor", "terminal ", " terminal", "", "rm -rf /",
        "terminal\x00", "edit", "sess", "term", "pi", "null", "--flag",
    ] {
        assert!(Target::parse(raw).is_none(), "{raw:?}");
    }
}

#[test]
fn invalid_payloads_are_public_spanish_errors_without_effect_or_budget() {
    let mut rate = RateLimiter::new();
    let mut focused = Vec::new();
    for payload in [
        json!(null), json!({}), json!({"target": 1}), json!({"target": "Terminal"}),
        json!({"target": "terminal", "extra": true}), json!({"Target": "terminal"}),
        json!({"target": "terminal session"}), json!({"target": ""}),
        json!({"target": "terminal\n"}), json!({"target": "editor", "cmd": "rm -rf /"}),
    ] {
        let e = focus_command("main", ORIGIN_OK, &payload, &mut rate, 0, |t| {
            focused.push(t);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(e.code, "denied");
        assert!(e.message.contains("Objetivo inválido"), "{}", e.message);
    }
    assert!(focused.is_empty());
    for _ in 0..30 {
        rate.check(0).expect("rejected input consumes no rate budget");
    }
}

#[test]
fn sender_gate_precedes_validation_and_focus() {
    for (label, origin) in [("second", ORIGIN_OK), ("main", "https://example.test/"), ("", "")] {
        let mut rate = RateLimiter::new();
        let e = focus_command(label, origin, &ok_payload(), &mut rate, 0,
            |_| panic!("a rejected sender must never focus")).unwrap_err();
        assert_eq!(e.code, "denied");
    }
}

#[test]
fn focus_effect_receives_the_parsed_target_never_the_raw_string() {
    for (raw, expected) in [
        ("terminal", Target::Terminal),
        ("session", Target::Session),
        ("editor", Target::Editor),
    ] {
        let mut rate = RateLimiter::new();
        let mut seen = None;
        focus_command("main", ORIGIN_OK, &json!({"target": raw}), &mut rate, 0, |t| {
            seen = Some(t);
            Ok(())
        })
        .expect("valid target focuses");
        assert_eq!(seen, Some(expected));
    }
}

#[test]
fn focus_effect_failure_is_a_public_error_not_false_success() {
    let mut rate = RateLimiter::new();
    let e = focus_command("main", ORIGIN_OK, &ok_payload(), &mut rate, 0,
        |_| Err("No encontré una ventana de terminal abierta.".to_string())).unwrap_err();
    assert_eq!(e.code, "denied");
    assert!(e.message.contains("No encontré una ventana de terminal"), "{}", e.message);
}

#[test]
fn rate_gate_precedes_focus() {
    let mut rate = RateLimiter::new();
    let mut calls = 0usize;
    for _ in 0..30 {
        focus_command("main", ORIGIN_OK, &ok_payload(), &mut rate, 0, |_| {
            calls += 1;
            Ok(())
        })
        .expect("within budget");
    }
    assert_eq!(calls, 30);
    let e = focus_command("main", ORIGIN_OK, &ok_payload(), &mut rate, 0,
        |_| panic!("rate rejection must not focus")).unwrap_err();
    assert_eq!(e, BridgeError::rate_exceeded());
    assert_eq!(calls, 30);
    // a later window admits calls again
    focus_command("main", ORIGIN_OK, &ok_payload(), &mut rate, 1_000, |_| {
        calls += 1;
        Ok(())
    })
    .expect("fresh window");
    assert_eq!(calls, 31);
}

#[test]
fn classification_uses_only_closed_allowlists_and_marks_session_titles() {
    // editor classes win even when a title mentions the agent (no session match)
    assert_eq!(classify_window(&win("gedit", "gedit", "pi")), Some(Target::Editor));
    // terminal classes...
    assert_eq!(
        classify_window(&win("gnome-terminal-server", "gnome-terminal-server", "htop")),
        Some(Target::Terminal)
    );
    assert_eq!(
        classify_window(&win("org.gnome.Terminal", "org.gnome.Terminal", "")),
        Some(Target::Terminal)
    );
    assert_eq!(classify_window(&win("alacritty", "Alacritty", "herdr")), Some(Target::Session));
    assert_eq!(classify_window(&win("kitty", "kitty", "pi — ~/Apps/sb")), Some(Target::Session));
    // "pip" is not the "pi" token
    assert_eq!(classify_window(&win("konsole", "konsole", "pip install")), Some(Target::Terminal));
    // editor classes
    assert_eq!(classify_window(&win("Code", "code", "src/main.rs")), Some(Target::Editor));
    assert_eq!(
        classify_window(&win("org.gnome.TextEditor", "org.gnome.TextEditor", "notes")),
        Some(Target::Editor)
    );
    assert_eq!(classify_window(&win("java", "jetbrains-idea", "x")), Some(Target::Editor));
    // nothing else matches, ever
    assert_eq!(classify_window(&win("firefox", "firefox", "pi")), None);
    assert_eq!(classify_window(&win("nautilus", "org.gnome.Nautilus", "pi")), None);
    assert_eq!(classify_window(&win("", "", "")), None);
}

#[test]
fn allowlists_are_closed_and_never_blanket_substring_matches() {
    // a closed list cannot grow by accident and must not match unrelated names
    for other in ["appletviewer", "codesign", "cursoring", "zombie"] {
        assert_eq!(matches_allowlist(other, EDITOR_CLASSES), false, "{other}");
        assert_eq!(matches_allowlist(other, TERMINAL_CLASSES), false, "{other}");
    }
    // every allowlist entry matches itself (lowercase is the stored form)
    for entry in TERMINAL_CLASSES.iter().chain(EDITOR_CLASSES.iter()) {
        assert!(matches_allowlist(entry, TERMINAL_CLASSES) || matches_allowlist(entry, EDITOR_CLASSES),
            "{entry} must match its own list");
    }
}

#[test]
fn topmost_matching_window_wins_in_stacking_order() {
    let windows = [
        win("gnome-terminal-server", "gnome-terminal-server", "htop"), // 0 terminal
        win("Code", "code", "main.rs"),                               // 1 editor
        win("kitty", "kitty", "pi"),                                  // 2 terminal + session
    ];
    assert_eq!(pick_window_index(Target::Terminal, &windows), Some(2), "topmost terminal");
    assert_eq!(pick_window_index(Target::Session, &windows), Some(2));
    assert_eq!(pick_window_index(Target::Editor, &windows), Some(1));
    assert_eq!(pick_window_index(Target::Session, &windows[..2]), None);
}

#[test]
fn focus_from_windows_is_honest_when_no_window_matches() {
    // connect ok but no matching window: Spanish reason, nothing focused
    let e = focus_from_windows(Target::Terminal, &[], |_| -> bool {
        panic!("no candidate, never a focus attempt")
    })
    .unwrap_err();
    assert_eq!(e, no_window_reason(Target::Terminal));
    assert!(e.contains("No encontré una ventana"), "{e}");
    assert!(e.contains("sesión de agente") == false, "terminal reason must not name the session target");

    // the per-target reason really is per-target
    assert!(no_window_reason(Target::Session).contains("sesión de agente"));
    assert!(no_window_reason(Target::Editor).contains("editor"));

    // a failed activation is reported, never faked as success
    let windows = [win("kitty", "kitty", "htop")];
    let e = focus_from_windows(Target::Terminal, &windows, |_| false).unwrap_err();
    assert_eq!(e, PLATFORM_FOCUS_REASON);
    assert!(focus_from_windows(Target::Terminal, &windows, |_| true).is_ok());
}
