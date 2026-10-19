use super::*;
use serde_json::json;

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("abito-voice-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn voice_is_off_by_default_with_the_system_voice() {
    let p = VoicePrefs::default();
    assert!(!p.enabled);
    assert_eq!(p.output, Output::System);
    assert_eq!(p.gender, Gender::Female);
}

#[test]
fn the_closed_parser_accepts_only_the_known_shapes() {
    assert_eq!(parse_command(&json!({"action":"status"})), Some(Command::Status));
    assert_eq!(parse_command(&json!({"action":"download_model"})), Some(Command::Download));
    assert_eq!(parse_command(&json!({"action":"remove_model"})), Some(Command::Remove));
    let prefs = json!({"enabled":true,"output":"elevenlabs","gender":"male"});
    assert_eq!(
        parse_command(&json!({"action":"set_prefs","prefs":prefs})),
        Some(Command::SetPrefs(VoicePrefs { enabled: true, output: Output::ElevenLabs, gender: Gender::Male }))
    );
}

#[test]
fn anything_else_is_rejected() {
    for bad in [
        json!({"action":"status","x":1}),
        json!({"action":"nope"}),
        json!({"action":"set_prefs"}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"loud","gender":"male"}}),
        json!({"action":"set_prefs","prefs":{"enabled":"yes","output":"off","gender":"male"}}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"off","gender":"male","extra":1}}),
        json!({"action":"set_prefs","prefs":{"enabled":true,"output":"off"}}),
        json!([]),
        json!("status"),
    ] {
        assert_eq!(parse_command(&bad), None, "{bad}");
    }
}

#[test]
fn prefs_round_trip_and_a_corrupt_file_falls_back_to_off() {
    let d = dir("prefs");
    let p = VoicePrefs { enabled: true, output: Output::Off, gender: Gender::Male };
    save_prefs_in(&d, &p).unwrap();
    assert_eq!(load_prefs_in(&d), p);
    std::fs::write(d.join("voice.json"), "{not json").unwrap();
    assert_eq!(load_prefs_in(&d), VoicePrefs::default());
}

#[test]
fn the_wake_phrase_is_split_from_the_command() {
    assert_eq!(split_wake("ok abito pon música"), Some("pon música".to_string()));
    assert_eq!(split_wake("Okay, Abito: añade una pastilla"), Some("añade una pastilla".to_string()));
    assert_eq!(split_wake("ok abito"), Some(String::new()));
    assert_eq!(split_wake("abito pon música"), None);
    assert_eq!(split_wake("hola qué tal"), None);
}
