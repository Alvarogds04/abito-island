use super::*;

fn c(id: &str, name: &str, title: &str) -> Candidate {
    Candidate { app_id: id.into(), app_name: name.into(), title: title.into() }
}

#[test]
fn skips_abito_windows_and_returns_the_most_recent_external_one() {
    let recent = vec![
        c("com.abitog.AbitoTauri", "Abito", "Abito"),
        c("firefox.desktop", "Firefox", "Docs"),
        c("code.desktop", "Code", "main.rs"),
    ];
    assert_eq!(pick_external(&recent), Some(ActiveWindow { app: "Firefox".into(), title: "Docs".into() }));
}

#[test]
fn nothing_external_means_no_context() {
    assert_eq!(pick_external(&[]), None);
    assert_eq!(pick_external(&[c("com.abitog.AbitoTauri", "Abito", "x")]), None);
    // NotchBuddy: `guard let appName` — an unnamed app yields no context.
    assert_eq!(pick_external(&[c("x", "  ", "t")]), None);
}

#[test]
fn an_empty_title_still_gives_context_like_notchbuddy() {
    assert_eq!(pick_external(&[c("a", "Files", "")]), Some(ActiveWindow { app: "Files".into(), title: String::new() }));
}

#[test]
fn model_text_is_notchbuddys_exact_format() {
    let w = ActiveWindow { app: "Firefox".into(), title: "Docs".into() };
    assert_eq!(format_context(&w), "Context — App: Firefox, Window: Docs");
}

#[test]
fn stacking_is_reversed_so_the_topmost_window_is_first() {
    let got = from_stacking(vec![
        ("a".into(), "Bottom".into(), "1".into()),
        ("b".into(), "Top".into(), "2".into()),
        ("abito".into(), "AbitoTauri".into(), "Abito".into()),
    ]);
    assert_eq!(pick_external(&got).unwrap().app, "Top");
    assert_eq!(got[0].app_name, "AbitoTauri");
}

#[test]
fn x11_without_class_falls_back_to_the_instance_name() {
    let got = from_stacking(vec![("xterm".into(), String::new(), "sh".into())]);
    assert_eq!(got[0].app_name, "xterm");
}

// ---- chat attach point (NotchBuddy: captured once on chat open, injected in the FIRST message) ----

fn win(app: &str) -> ActiveWindow {
    ActiveWindow { app: app.into(), title: "T".into() }
}

#[test]
fn switch_off_reads_nothing_and_attaches_nothing() {
    let mut cx = ChatContext::default();
    let mut reads = 0;
    cx.on_chat_open(false, || { reads += 1; Some(win("Firefox")) });
    assert_eq!(reads, 0, "no D-Bus/X11 call while off");
    assert_eq!(cx.for_turn(false, true), None);
    assert_eq!(cx.for_turn(true, true), None, "nothing was captured");
}

#[test]
fn captured_once_like_promptcontext_nil() {
    let mut cx = ChatContext::default();
    let mut reads = 0;
    cx.on_chat_open(true, || { reads += 1; Some(win("Firefox")) });
    cx.on_chat_open(true, || { reads += 1; Some(win("Code")) });
    assert_eq!(reads, 1, "a second open does not read again once a context is held");
    assert_eq!(cx.for_turn(true, true), Some("Context — App: Firefox, Window: T".to_string()));
}

#[test]
fn a_failed_read_is_retried_on_the_next_open() {
    let mut cx = ChatContext::default();
    cx.on_chat_open(true, || None);
    cx.on_chat_open(true, || Some(win("Code")));
    assert_eq!(cx.for_turn(true, true).unwrap(), "Context — App: Code, Window: T");
}

#[test]
fn only_the_first_message_of_a_conversation_is_offered_the_context() {
    let mut cx = ChatContext::default();
    cx.on_chat_open(true, || Some(win("Firefox")));
    assert_eq!(cx.for_turn(true, true), Some("Context — App: Firefox, Window: T".to_string()));
    assert_eq!(cx.for_turn(true, false), None, "NotchBuddy: `conversationMessages.isEmpty` only");
    assert!(cx.for_turn(true, true).is_some(), "a new conversation's first message gets it again");
}

#[test]
fn turning_the_switch_off_drops_the_captured_window() {
    let mut cx = ChatContext::default();
    cx.on_chat_open(true, || Some(win("Firefox")));
    cx.on_chat_open(false, || Some(win("never")));
    assert_eq!(cx.for_turn(true, true), None);
}
