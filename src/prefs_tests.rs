use super::*;
use serde_json::json;

#[test]
fn sound_is_off_unless_the_human_turned_it_on_and_it_fails_closed() {
    assert!(!Prefs::default().sound, "silence is the island contract");
    for bad in [None, Some(""), Some("not json"), Some("{}"), Some("[]"), Some("null"), Some(r#"{"v":2,"sound":true}"#), Some(r#"{"sound":true}"#),
                Some(r#"{"v":1,"sound":"yes"}"#), Some(r#"{"v":1,"sound":1}"#), Some(r#"{"v":1}"#)] {
        assert_eq!(Prefs::from_text(bad), Prefs::default(), "{bad:?} must read as sound OFF");
    }
    assert!(Prefs::from_text(Some(r#"{"v":1,"sound":true}"#)).sound);
    assert!(!Prefs::from_text(Some(r#"{"v":1,"sound":false}"#)).sound);
}

#[test]
fn prefs_round_trip_as_one_line() {
    for sound in [true, false] {
        let p = Prefs { sound };
        assert_eq!(Prefs::from_text(Some(&p.to_text())), p);
        assert!(!p.to_text().contains('\n'));
    }
}

#[test]
fn command_set_is_closed_and_exact() {
    assert_eq!(parse_command(&json!({"action":"view"})), Ok(Command::View));
    assert_eq!(parse_command(&json!({"action":"sound_on"})), Ok(Command::SoundOn));
    assert_eq!(parse_command(&json!({"action":"sound_off"})), Ok(Command::SoundOff));
    for bad in [json!(null), json!([]), json!("sound_on"), json!({}), json!({"action":1}), json!({"action":"sound"}), json!({"action":"sound_on","volume":0.5}),
                json!({"action":"view","x":1}), json!({"action":"set","sound":true}), json!({"sound":true})] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad}");
    }
}
