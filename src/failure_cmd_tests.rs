use super::*;
use serde_json::json;

fn env() -> Env { Env { version: "0.2.0".into(), os: "Ubuntu".into(), session: "x11".into(), home: "/home/a".into(), user: "alvaro".into() } }
fn stored(step: &str, at: u64) -> Stored { Stored { record: failure::record_failure("island", step, "boom", &env(), at), count: 1 } }
fn tmp(tag: &str) -> std::path::PathBuf { let d = std::env::temp_dir().join(format!("abito-fcmd-{}-{tag}", std::process::id())); let _ = std::fs::remove_dir_all(&d); d }

#[test]
fn schema_accepts_only_the_closed_shapes() {
    let fp = "3fa9c01b7d2e";
    assert_eq!(parse_command(&json!({"action":"view"})), Some(Command::View));
    assert_eq!(parse_command(&json!({"action":"preview"})), Some(Command::Preview(None)));
    assert_eq!(parse_command(&json!({"action":"preview","fingerprint":fp})), Some(Command::Preview(Some(fp.into()))));
    assert_eq!(parse_command(&json!({"action":"later","fingerprint":fp})), Some(Command::Later(fp.into())));
    assert_eq!(parse_command(&json!({"action":"never","fingerprint":fp})), Some(Command::Never(fp.into())));
    assert_eq!(parse_command(&json!({"action":"set_enabled","enabled":false})), Some(Command::SetEnabled(false)));
    assert_eq!(parse_command(&json!({"action":"send","title":" t ","body":"b"})), Some(Command::Send { title: "t".into(), body: "b".into() }));
}

#[test]
fn schema_refuses_everything_else() {
    let fp = "3fa9c01b7d2e";
    for bad in [json!(null), json!({}), json!({"action":"view","x":1}), json!({"action":"nope"}),
        json!({"action":"later"}), json!({"action":"later","fingerprint":"XYZ"}), json!({"action":"never","fingerprint":"3FA9C01B7D2E"}),
        json!({"action":"never","fingerprint":fp,"x":1}), json!({"action":"preview","fingerprint":"../etc"}),
        json!({"action":"set_enabled","enabled":"yes"}), json!({"action":"send","title":"","body":"b"}),
        json!({"action":"send","title":"a\nb","body":"b"}), json!({"action":"send","title":"t","body":"  "}),
        json!({"action":"send","title":"t","body":"x".repeat(BODY_MAX + 1)}), json!({"action":"send","title":"x".repeat(TITLE_MAX + 1),"body":"b"}),
        json!({"action":"send","title":"t","body":"a\u{0}b"}), json!({"action":"send","title":"t","body":"b","url":"https://evil.example"})] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn prefs_default_on_round_trip_and_ignore_garbage() {
    let d = tmp("prefs");
    assert_eq!(Prefs::load(&d), Prefs::default());
    assert!(Prefs::default().enabled);
    let mut p = Prefs::default(); p.enabled = false; p.muted.insert("3fa9c01b7d2e".into());
    p.save(&d).unwrap();
    assert_eq!(Prefs::load(&d), p);
    std::fs::write(d.join(PREFS_FILE), r#"{"enabled":"x","muted":["bad","3fa9c01b7d2e",5]}"#).unwrap();
    let q = Prefs::load(&d);
    assert!(q.enabled && q.muted.len() == 1);
    std::fs::write(d.join(PREFS_FILE), "not json").unwrap();
    assert_eq!(Prefs::load(&d), Prefs::default());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn pending_hides_muted_postponed_and_everything_when_the_switch_is_off() {
    let (a, b, c) = (stored("a", 10), stored("b", 30), stored("c", 20));
    let all = vec![a.clone(), b.clone(), c.clone()];
    let none = BTreeSet::new();
    let steps = |v: Vec<Stored>| v.iter().map(|s| s.record.step.clone()).collect::<Vec<_>>();
    assert_eq!(steps(pending(&all, &Prefs::default(), &none)), ["b", "c", "a"], "newest first");
    let mut prefs = Prefs::default();
    prefs.muted.insert(failure::fingerprint_of(&b.record));
    let mut later = BTreeSet::new(); later.insert(failure::fingerprint_of(&c.record));
    assert_eq!(steps(pending(&all, &prefs, &later)), ["a"]);
    prefs.enabled = false;
    assert!(pending(&all, &prefs, &none).is_empty(), "switch off: no notice at all");
}

#[test]
fn manual_report_has_a_neutral_record_and_a_known_fingerprint_finds_its_own() {
    let s = stored("voice", 5);
    let fp = failure::fingerprint_of(&s.record);
    assert_eq!(record_for(&[s.clone()], Some(&fp), &env(), 9), Some(s.record.clone()));
    assert_eq!(record_for(&[s.clone()], Some("000000000000"), &env(), 9), None);
    let m = record_for(&[], None, &env(), 9).unwrap();
    assert_eq!((m.step.as_str(), m.at_secs), ("manual-report", 9));
}

#[test]
fn context_lines_are_the_other_failures_oldest_first() {
    let (a, b, c) = (stored("a", 1), stored("b", 3), stored("c", 2));
    let lines = context_lines(&[b.clone(), a.clone(), c.clone()], &a.record);
    assert_eq!(lines, ["[island/c] boom", "[island/b] boom"]);
}

#[test]
fn prefs_file_is_created_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp("prefsmode");
    Prefs::default().save(&d).unwrap();
    let mode = std::fs::metadata(d.join(PREFS_FILE)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let _ = std::fs::remove_dir_all(&d);
}
