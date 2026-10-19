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
