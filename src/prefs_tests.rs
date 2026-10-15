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
        let p = Prefs { sound, ..Prefs::default() };
        assert_eq!(Prefs::from_text(Some(&p.to_text())), p);
        assert!(!p.to_text().contains('\n'));
    }
}

#[test]
fn optional_name_preserves_v1_sound_and_anonymous_defaults() {
    for text in [None, Some(r#"{"v":1,"sound":true}"#),
                 Some(r#"{"v":1,"sound":true,"display_name":42}"#),
                 Some(r#"{"v":1,"sound":true,"display_name":"   "}"#)] {
        let p = Prefs::from_text(text);
        assert_eq!(p.display_name, None);
        if text.is_some() { assert!(p.sound); }
        let encoded: Value = serde_json::from_str(&p.to_text()).unwrap();
        assert_eq!(encoded["v"], 1);
        assert!(encoded.get("display_name").is_none());
    }
    let p = Prefs::from_text(Some(r#"{"v":1,"sound":true,"display_name":"  Ana  "}"#));
    assert_eq!(p.display_name.as_deref(), Some("Ana"));
    assert!(p.sound);
    assert_eq!(Prefs::from_text(Some(&p.to_text())), p);
}

#[test]
fn name_command_is_explicit_bounded_and_rejections_leave_state_and_writes_unchanged() {
    let mut current = Prefs { sound: true, ..Prefs::default() };
    let mut writes = 0;
    for value in [json!(null), json!(42), json!({}), json!("A\u{0}B"), json!("A\nB"), json!("x".repeat(81))] {
        let before = current.clone();
        let command = parse_command(&json!({"action":"set_display_name", "display_name":value}));
        assert_eq!(command, Err(CommandError));
        if let Ok(command) = command {
            let _ = update(&current, &command, |_| { writes += 1; true });
        }
        assert_eq!(current, before);
        assert_eq!(writes, 0);
    }
    for text in ["Ana", "<img src=x onerror=alert(1)>", "\"&<>'", &"😀".repeat(80)] {
        let command = parse_command(&json!({"action":"set_display_name", "display_name":text})).unwrap();
        current = update(&current, &command, |_| { writes += 1; true }).unwrap();
        assert_eq!(current.display_name.as_deref(), Some(text));
        assert!(current.sound);
        assert_eq!(Prefs::from_text(Some(&current.to_text())), current);
    }
    assert_eq!(writes, 4);
    for bad in [json!({"action":"set_display_name"}), json!({"action":"set_display_name","display_name":"Ana","x":1}),
                json!({"action":"sound_off","display_name":"Ana"})] {
        assert_eq!(parse_command(&bad), Err(CommandError));
    }
}

#[test]
fn name_sound_clear_reload_and_failed_save_are_independent() {
    let original = Prefs::default();
    let name = parse_command(&json!({"action":"set_display_name","display_name":" Ana "})).unwrap();
    assert_eq!(update(&original, &name, |_| false), Err(CommandError));
    assert_eq!(original, Prefs::default(), "failed save must not publish a name");
    let named = update(&original, &name, |_| true).unwrap();
    assert_eq!(named.display_name.as_deref(), Some("Ana"));
    let sound = update(&named, &Command::SoundOn, |_| true).unwrap();
    let reloaded = Prefs::from_text(Some(&sound.to_text()));
    assert!(reloaded.sound);
    assert_eq!(reloaded.display_name.as_deref(), Some("Ana"));
    let same = update(&reloaded, &name, |_| panic!("no-op must not write")).unwrap();
    assert_eq!(same, reloaded);
    let view = update(&reloaded, &Command::View, |_| panic!("view must not write")).unwrap();
    assert_eq!(view, reloaded);
    for blank in ["", "   "] {
        let clear = parse_command(&json!({"action":"set_display_name","display_name":blank})).unwrap();
        let anonymous = update(&reloaded, &clear, |_| true).unwrap();
        assert!(anonymous.sound);
        assert_eq!(anonymous.display_name, None);
        assert_eq!(Prefs::from_text(Some(&anonymous.to_text())), anonymous);
    }
}

// Public transaction seam used by settingshost: real fields, concurrent callers,
// serialized persistence callbacks and publication. No Tauri or avatar fixture.
#[test]
fn concurrent_name_sound_transactions_preserve_both_and_publish_in_commit_order() {
    use std::sync::{Barrier, Mutex};
    let current = Mutex::new(Prefs::default());
    let serial = Mutex::new(());
    let disk = Mutex::new(Prefs::default().to_text());
    let writes = Mutex::new(Vec::new());
    let events = Mutex::new(Vec::new());
    let start = Barrier::new(3);
    std::thread::scope(|scope| {
        for payload in [json!({"action":"sound_on"}), json!({"action":"set_display_name","display_name":"Ana"})] {
            let command = parse_command(&payload).unwrap();
            let (current, serial, disk, writes, events, start) = (&current, &serial, &disk, &writes, &events, &start);
            scope.spawn(move || {
                start.wait();
                transact(serial, current, &command, |next| {
                    assert!(serial.try_lock().is_err(), "writer owns transaction gate");
                    *disk.lock().unwrap() = next.to_text();
                    writes.lock().unwrap().push(next.clone());
                    true
                }, |next| {
                    assert!(serial.try_lock().is_err(), "no next command may overtake this event");
                    // A publisher can re-read prefs, as publish_chat does: no deadlock.
                    assert_eq!(*current.try_lock().expect("state mutex released before publish"), *next);
                    assert_eq!(Prefs::from_text(Some(&disk.lock().unwrap())), *next);
                    events.lock().unwrap().push(next.clone());
                }).unwrap();
            });
        }
        start.wait();
    });
    let final_view = transact(&serial, &current, &Command::View,
        |_| panic!("view must not persist"), |_| panic!("view must not emit")).unwrap();
    assert!(final_view.sound);
    assert_eq!(final_view.display_name.as_deref(), Some("Ana"));
    assert_eq!(Prefs::from_text(Some(&disk.lock().unwrap())), final_view);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(*events, *writes.lock().unwrap(), "events retain commit order");
    assert_eq!(events.last(), Some(&final_view));
}

#[test]
fn concurrent_failed_name_save_does_not_erase_sound_or_publish_requested_name() {
    use std::sync::{Barrier, Mutex};
    let original = Prefs { display_name: Some("Ana".into()), ..Prefs::default() };
    let current = Mutex::new(original.clone());
    let serial = Mutex::new(());
    let disk = Mutex::new(original.to_text());
    let events = Mutex::new(Vec::new());
    let attempts = Mutex::new(0);
    let start = Barrier::new(3);
    std::thread::scope(|scope| {
        for (payload, fail) in [(json!({"action":"sound_on"}), false),
                               (json!({"action":"set_display_name","display_name":"Other"}), true)] {
            let command = parse_command(&payload).unwrap();
            let (current, serial, disk, events, attempts, start) = (&current, &serial, &disk, &events, &attempts, &start);
            scope.spawn(move || {
                start.wait();
                let result = transact(serial, current, &command, |next| {
                    *attempts.lock().unwrap() += 1;
                    if fail { return false; }
                    *disk.lock().unwrap() = next.to_text();
                    true
                }, |next| { events.lock().unwrap().push(next.clone()); });
                assert_eq!(result.is_err(), fail);
            });
        }
        start.wait();
    });
    let final_view = transact(&serial, &current, &Command::View,
        |_| panic!("view must not persist"), |_| panic!("view must not emit")).unwrap();
    assert!(final_view.sound);
    assert_eq!(final_view.display_name.as_deref(), Some("Ana"));
    assert_eq!(Prefs::from_text(Some(&disk.lock().unwrap())), final_view);
    assert_eq!(*attempts.lock().unwrap(), 2);
    assert_eq!(*events.lock().unwrap(), vec![final_view]);
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

// Public parser/transaction tests with serialized in-memory disk callbacks, not Tauri IPC.
// Real filesystem helper checks live in the isolated integration evidence harness.
#[test]
fn integration_name_sound_color_reload_and_clear_preserve_independent_fields() {
    use std::sync::Mutex;
    let serial = Mutex::new(());
    let current = Mutex::new(Prefs::default());
    let disk = Mutex::new(None::<String>);
    let events = Mutex::new(Vec::new());
    for (index, payload) in [
        json!({"action":"set_display_name","display_name":"Ana"}),
        json!({"action":"sound_on"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"purple"}),
        json!({"action":"set_avatar_color","identity":"esp-orphan","color":"mint"}),
        json!({"action":"clear_avatar_color","identity":"abito"}),
    ].into_iter().enumerate() {
        let command = parse_command(&payload).expect("combined command must be accepted");
        let response = transact(&serial, &current, &command, |next| {
            *disk.lock().unwrap() = Some(next.to_text()); true
        }, |next| {
            assert!(serial.try_lock().is_err());
            assert_eq!(*current.try_lock().expect("publication releases state lock"), *next);
            assert_eq!(Prefs::from_text(disk.lock().unwrap().as_deref()), *next);
            events.lock().unwrap().push(next.to_text());
        }).unwrap();
        let reload = Prefs::from_text(disk.lock().unwrap().as_deref());
        assert_eq!(response, reload);
        let wire: Value = serde_json::from_str(&reload.to_text()).unwrap();
        assert_eq!(wire["display_name"], "Ana");
        assert_eq!(wire["sound"], index > 0);
        if (2..4).contains(&index) { assert_eq!(wire["avatar_colors"]["abito"], "purple"); }
        if index >= 3 { assert_eq!(wire["avatar_colors"]["esp-orphan"], "mint"); }
        if index == 4 { assert!(wire["avatar_colors"].get("abito").is_none()); }
        assert_eq!(events.lock().unwrap().len(), index + 1);
    }
}

#[test]
fn integration_concurrent_three_fields_and_failed_color_preserve_commit_snapshots() {
    use std::sync::{Barrier, Mutex};
    for fail_color in [false, true] {
        let serial = Mutex::new(());
        let current = Mutex::new(Prefs::default());
        let disk = Mutex::new(Prefs::default().to_text());
        let writes = Mutex::new(Vec::new());
        let events = Mutex::new(Vec::new());
        let attempts = Mutex::new(0);
        let barrier = Barrier::new(4);
        std::thread::scope(|scope| {
            for payload in [json!({"action":"set_display_name","display_name":"Ana"}), json!({"action":"sound_on"}),
                json!({"action":"set_avatar_color","identity":"abito","color":"purple"})] {
                let fail = fail_color && payload["action"] == "set_avatar_color";
                let (serial, current, disk, writes, events, attempts, barrier) = (&serial, &current, &disk, &writes, &events, &attempts, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    let command = parse_command(&payload).expect("combined command accepted");
                    let reply = transact(serial, current, &command, |next| {
                        *attempts.lock().unwrap() += 1;
                        if fail { return false; }
                        *disk.lock().unwrap() = next.to_text();
                        writes.lock().unwrap().push(next.to_text()); true
                    }, |next| {
                        assert!(serial.try_lock().is_err());
                        assert_eq!(*current.try_lock().unwrap(), *next);
                        assert_eq!(*disk.lock().unwrap(), next.to_text());
                        events.lock().unwrap().push(next.to_text());
                    });
                    assert_eq!(reply.is_err(), fail);
                    if let Ok(reply) = reply { assert!(events.lock().unwrap().contains(&reply.to_text())); }
                });
            }
            barrier.wait();
        });
        let wire: Value = serde_json::from_str(&disk.lock().unwrap()).unwrap();
        assert_eq!(wire["display_name"], "Ana"); assert_eq!(wire["sound"], true);
        if fail_color { assert!(wire.get("avatar_colors").is_none()); }
        else { assert_eq!(wire["avatar_colors"]["abito"], "purple"); }
        assert_eq!(*attempts.lock().unwrap(), 3);
        assert_eq!(*writes.lock().unwrap(), *events.lock().unwrap());
        assert_eq!(events.lock().unwrap().len(), if fail_color { 2 } else { 3 });
        assert_eq!(current.lock().unwrap().to_text(), *disk.lock().unwrap());
    }
}

#[test]
fn integration_invalid_failed_view_and_noop_have_no_mutation_or_events() {
    use std::sync::Mutex;
    let original = Prefs::from_text(Some(r#"{"v":1,"sound":true,"display_name":"Ana","avatar_colors":{"abito":"purple","esp-orphan":"mint"}}"#));
    let wire: Value = serde_json::from_str(&original.to_text()).unwrap();
    assert_eq!(wire["avatar_colors"]["abito"], "purple");
    let serial = Mutex::new(()); let current = Mutex::new(original.clone());
    let mut attempts = 0;
    for payload in [json!({"action":"view"}),json!({"action":"sound_on"}),json!({"action":"set_display_name","display_name":"Ana"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"purple"}),json!({"action":"clear_avatar_color","identity":"absent"})] {
        let command = parse_command(&payload).unwrap();
        let reply = transact(&serial, &current, &command, |_| { attempts += 1; false }, |_| panic!("noop event")).unwrap();
        assert_eq!(reply, original); assert_eq!(*current.lock().unwrap(), original);
    }
    assert_eq!(attempts, 0);
    for payload in [json!({"action":"set_display_name","display_name":"Other"}),json!({"action":"sound_off"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"blue"}),json!({"action":"clear_avatar_color","identity":"abito"})] {
        let command = parse_command(&payload).unwrap();
        assert_eq!(transact(&serial, &current, &command, |_| { attempts += 1; false }, |_| panic!("failed event")), Err(CommandError));
        assert_eq!(*current.lock().unwrap(), original);
    }
    assert_eq!(attempts, 4);
    for payload in [json!({"action":"set_avatar_color","identity":"pi","color":"blue"}),json!({"action":"clear_avatar_color","identity":"__proto__"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"bad"}),json!({"action":"set_display_name","display_name":"A\nB"})] {
        assert_eq!(parse_command(&payload), Err(CommandError));
        assert_eq!(*current.lock().unwrap(), original); assert_eq!(attempts, 4);
    }
}

mod avatar_donor {
use super::super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn colors(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

const KEY: &str = "avatar_colors";

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
    let with_colors = Prefs { sound: true, avatar_colors: colors(&[("abito", "purple")]), ..Prefs::default() };
    for p in [Prefs { sound: true, ..Default::default() }, Prefs { sound: false, ..Default::default() }, with_colors] {
        assert_eq!(Prefs::from_text(Some(&p.to_text())), p);
        assert!(!p.to_text().contains('\n'));
    }
}

// ---- #384: the optional, validated avatar-colour preference --------------------------------

#[test]
fn an_old_v1_file_without_colours_still_reads_and_keeps_its_sound() {
    let old = Prefs::from_text(Some(r#"{"v":1,"sound":true}"#));
    assert!(old.sound);
    assert!(old.avatar_colors.is_empty());
    // Writing back a file nobody customised must not grow the new key: the bytes stay what
    // they were, and the old reader (which only looks at `sound`) still reads it.
    let text = old.to_text();
    assert!(!text.contains(KEY), "{text}");
    assert!(text.contains(r#""v":1"#), "{text}");
    assert!(text.contains(r#""sound":true"#), "{text}");
}

#[test]
fn a_colour_choice_round_trips_and_the_file_stays_v1_and_one_line() {
    let p = Prefs { sound: true, avatar_colors: colors(&[("abito", "purple"), ("sub-abito-uno", "mint")]), ..Prefs::default() };
    let text = p.to_text();
    assert!(!text.contains('\n'));
    assert!(text.contains(r#""v":1"#));
    assert_eq!(Prefs::from_text(Some(&text)), p);
    assert_eq!(Prefs::from_text(Some(&text)).avatar_colors["abito"], "purple");
    assert_eq!(Prefs::from_text(Some(&text)).avatar_colors["sub-abito-uno"], "mint");
}

#[test]
fn a_damaged_colour_map_never_costs_the_sound_preference() {
    for bad in [
        r#"{"v":1,"sound":true,"avatar_colors":{"abito":"chartreuse"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"abito":"Blue"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"abito":3}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"abito":null}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"abito":""}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"Abito":"blue"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"__proto__":"blue"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"constructor":"blue"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":"blue"}}"#,
        r#"{"v":1,"sound":true,"avatar_colors":[]}"#,
        r#"{"v":1,"sound":true,"avatar_colors":"blue"}"#,
        r#"{"v":1,"sound":true,"avatar_colors":null}"#,
    ] {
        let p = Prefs::from_text(Some(bad));
        assert!(p.sound, "{bad}: sound must survive a damaged colour map");
        assert!(p.avatar_colors.is_empty(), "{bad}: nothing valid to keep");
    }
    // valid and invalid together: only the valid survive, `sound` untouched
    let mixed = Prefs::from_text(Some(
        r#"{"v":1,"sound":false,"avatar_colors":{"abito":"orange","tool":"nope","Bad-Id":"blue","codex":"blue"}}"#,
    ));
    assert!(!mixed.sound);
    assert_eq!(mixed.avatar_colors, colors(&[("abito", "orange")]), "only a well-formed pair is kept");
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
    assert_eq!(parse_command(&json!({"action":"set_avatar_color","identity":"abito","color":"blue"})),
        Ok(Command::SetAvatarColor { identity: "abito".into(), color: "blue".into() }));
    assert_eq!(parse_command(&json!({"action":"clear_avatar_color","identity":"abito"})),
        Ok(Command::ClearAvatarColor { identity: "abito".into() }));
    for id in ["abito", "sub-abito-uno", "sub_abito.dos", "s", &"a".repeat(32)] {
        assert!(parse_command(&json!({"action":"clear_avatar_color","identity":id})).is_ok(), "{id}");
    }
    for c in COLORS {
        assert!(parse_command(&json!({"action":"set_avatar_color","identity":"abito","color":c})).is_ok(), "{c}");
    }
    for bad in [
        json!({"action":"set_avatar_color","identity":"abito"}),
        json!({"action":"set_avatar_color","color":"blue"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"blue","x":1}),
        json!({"action":"set_avatar_color","identity":"abito","color":"blue","identity2":"abito"}),
        json!({"action":"set_avatar_color","identity":"Abito","color":"blue"}),
        json!({"action":"set_avatar_color","identity":"","color":"blue"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"chartreuse"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"Green"}),
        json!({"action":"set_avatar_color","identity":"__proto__","color":"blue"}),
        json!({"action":"set_avatar_color","identity":"constructor","color":"blue"}),
        json!({"action":"set_avatar_color","identity":1,"color":"blue"}),
        json!({"action":"set_avatar_color","identity":&"a".repeat(33),"color":"blue"}),
        json!({"action":"clear_avatar_color"}),
        json!({"action":"clear_avatar_color","identity":"__proto__"}),
        json!({"action":"clear_avatar_color","identity":"Abito"}),
        json!({"action":"clear_avatar_color","identity":"abito","x":1}),
        json!({"action":"clear_avatar_color","identity":true}),
    ] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad}");
    }
}

#[test]
fn an_invalid_change_never_produces_or_mutates_a_value() {
    let current = Prefs { sound: true, avatar_colors: colors(&[("abito", "green")]), ..Prefs::default() };
    for bad in [
        Command::SetAvatarColor { identity: "Abito".into(), color: "blue".into() },
        Command::SetAvatarColor { identity: "abito".into(), color: "chartreuse".into() },
        Command::SetAvatarColor { identity: "__proto__".into(), color: "blue".into() },
        Command::ClearAvatarColor { identity: "constructor".into() },
    ] {
        assert_eq!(apply(&current, &bad), Err(CommandError), "{bad:?}");
    }
    assert_eq!(current, Prefs { sound: true, avatar_colors: colors(&[("abito", "green")]), ..Prefs::default() }, "apply never mutates in place");
}

#[test]
fn a_change_keeps_every_other_preference_and_view_changes_nothing() {
    let current = Prefs { sound: true, avatar_colors: colors(&[("sub-abito-uno", "mint")]), ..Prefs::default() };
    let set = apply(&current, &Command::SetAvatarColor { identity: "abito".into(), color: "purple".into() }).unwrap();
    assert!(set.sound, "a colour choice never flips the sound switch");
    assert_eq!(set.avatar_colors, colors(&[("abito", "purple"), ("sub-abito-uno", "mint")]));
    let off = apply(&set, &Command::SoundOff).unwrap();
    assert!(!off.sound);
    assert_eq!(off.avatar_colors, set.avatar_colors, "the sound switch never drops a colour");
    let cleared = apply(&set, &Command::ClearAvatarColor { identity: "abito".into() }).unwrap();
    assert_eq!(cleared.avatar_colors, colors(&[("sub-abito-uno", "mint")]));
    // clearing something that was never set is a no-op, not an error
    let again = apply(&cleared, &Command::ClearAvatarColor { identity: "abito".into() }).unwrap();
    assert_eq!(again, cleared);
    assert_eq!(apply(&current, &Command::View), Ok(current.clone()));
}

#[test]
fn a_failed_save_keeps_the_old_preferences_and_is_reported_as_a_failure() {
    let current = Prefs { sound: false, avatar_colors: colors(&[("abito", "green")]), ..Prefs::default() };
    let change = Command::SetAvatarColor { identity: "abito".into(), color: "purple".into() };
    let next = apply(&current, &change).unwrap();
    // the write is attempted with the NEW value (so a successful write and a failed one differ)...
    let mut seen = None;
    let failed = update(&current, &change, |p| { seen = Some(p.clone()); false });
    assert_eq!(seen, Some(next.clone()));
    assert_eq!(failed, Err(CommandError), "a failed write must never read as success");
    // ...and when it fails the caller keeps the OLD value: memory never runs ahead of disk
    assert_eq!(current.avatar_colors["abito"], "green");
    assert_eq!(current.to_text(), Prefs { sound: false, avatar_colors: colors(&[("abito", "green")]), ..Prefs::default() }.to_text());
    // a successful write returns the new value
    assert_eq!(update(&current, &change, |_| true), Ok(next));
    // reading (`view`) writes nothing at all
    let mut wrote = false;
    assert_eq!(update(&current, &Command::View, |_| { wrote = true; true }), Ok(current.clone()));
    assert!(!wrote, "a view must not touch the disk");
    // a no-op change writes nothing either
    let mut wrote = false;
    assert_eq!(update(&current, &Command::ClearAvatarColor { identity: "nunca-configurado".into() }, |_| { wrote = true; true }), Ok(current.clone()));
    assert!(!wrote);
}

}

#[test]
fn f055_volume_public_transaction_boundaries_and_failure() {
    use std::sync::Mutex;
    let original = Prefs::from_text(Some(r#"{"v":1,"sound":true,"display_name":"Ana","avatar_colors":{"orphan":"blue"}}"#));
    let state = Mutex::new(original.clone()); let serial = Mutex::new(());
    let disk = Mutex::new(original.to_text()); let events = Mutex::new(Vec::new());
    for gain in [0.0, 0.2, 0.12] {
        let command = parse_command(&json!({"action":"set_sound_gain","gain":gain})).expect("public volume command");
        let next = transact(&serial, &state, &command, |p| { *disk.lock().unwrap() = p.to_text(); true }, |p| events.lock().unwrap().push(p.to_text())).unwrap();
        let value: Value = serde_json::from_str(&next.to_text()).unwrap();
        assert_eq!(value["gain"], gain); assert!(next.sound);
        assert_eq!(next.display_name.as_deref(), Some("Ana")); assert_eq!(next.avatar_colors["orphan"], "blue");
        assert_eq!(Prefs::from_text(Some(&disk.lock().unwrap())), next);
        transact(&serial, &state, &command, |_| panic!("no-op write"), |_| panic!("no-op event")).unwrap();
    }
    assert_eq!(events.lock().unwrap().len(), 3);
    let before = state.lock().unwrap().clone(); let bytes = disk.lock().unwrap().clone();
    for payload in [json!({"action":"set_sound_gain","gain":-0.01}),json!({"action":"set_sound_gain","gain":0.21}),json!({"action":"set_sound_gain","gain":null}),json!({"action":"set_sound_gain","gain":"0.1"}),json!({"action":"set_sound_gain","gain":0.1,"extra":true}),json!({"action":"set_sound_gain"})] {
        assert_eq!(parse_command(&payload), Err(CommandError));
    }
    let command = parse_command(&json!({"action":"set_sound_gain","gain":0})).unwrap();
    assert_eq!(transact(&serial, &state, &command, |_| false, |_| panic!("failed event")), Err(CommandError));
    assert_eq!(*state.lock().unwrap(), before); assert_eq!(*disk.lock().unwrap(), bytes); assert_eq!(events.lock().unwrap().len(), 3);
}

#[test]
fn f055_gain_defaults_direct_validation_and_concurrent_existing_writers() {
    use std::sync::{Barrier, Mutex};
    assert_eq!(Prefs::default().gain(), 0.12);
    assert!(serde_json::from_str::<Value>(&Prefs::default().to_text()).unwrap().get("gain").is_none());
    for gain in [json!(-0.01),json!(0.21),json!(null),json!("0.1")] {
        let p = Prefs::from_text(Some(&json!({"v":1,"sound":true,"gain":gain}).to_string()));
        assert_eq!(p.gain(), 0.12); assert!(p.sound);
    }
    for gain in [f64::NAN,f64::INFINITY,f64::NEG_INFINITY,-0.01,0.21] {
        assert_eq!(apply(&Prefs::default(), &Command::SetSoundGain(gain)), Err(CommandError));
    }
    let original = Prefs::from_text(Some(r#"{"v":1,"sound":false,"avatar_colors":{"orphan":"mint"}}"#));
    let state = Mutex::new(original.clone()); let serial = Mutex::new(());
    let bytes = Mutex::new(original.to_text()); let writes = Mutex::new(Vec::new()); let events = Mutex::new(Vec::new());
    let barrier = Barrier::new(5);
    std::thread::scope(|scope| {
        for payload in [json!({"action":"set_sound_gain","gain":0.2}),json!({"action":"sound_on"}),json!({"action":"set_display_name","display_name":"Ana"}),json!({"action":"set_avatar_color","identity":"abito","color":"purple"})] {
            let command = parse_command(&payload).unwrap();
            let (state,serial,bytes,writes,events,barrier) = (&state,&serial,&bytes,&writes,&events,&barrier);
            scope.spawn(move || {
                barrier.wait();
                transact(serial,state,&command,|p| {
                    assert!(serial.try_lock().is_err());
                    *bytes.lock().unwrap()=p.to_text(); writes.lock().unwrap().push(p.to_text()); true
                },|p| {
                    assert!(serial.try_lock().is_err());
                    assert_eq!(*state.try_lock().unwrap(),*p);
                    assert_eq!(*bytes.lock().unwrap(),p.to_text()); events.lock().unwrap().push(p.to_text());
                }).unwrap();
            });
        }
        barrier.wait();
    });
    let final_view = transact(&serial,&state,&Command::View,|_| panic!("view write"),|_| panic!("view event")).unwrap();
    assert_eq!(final_view.gain(),0.2); assert!(final_view.sound); assert_eq!(final_view.display_name.as_deref(),Some("Ana"));
    assert_eq!(final_view.avatar_colors["orphan"],"mint"); assert_eq!(final_view.avatar_colors["abito"],"purple");
    assert_eq!(Prefs::from_text(Some(&bytes.lock().unwrap())),final_view);
    assert_eq!(events.lock().unwrap().len(),4); assert_eq!(*events.lock().unwrap(),*writes.lock().unwrap());
}

#[test]
fn theme_defaults_to_system_and_an_absent_field_never_rewrites_an_old_file() {
    use std::sync::Mutex;
    // The default is «follow the system», and a file nobody changed carries no theme key.
    assert_eq!(Prefs::default().theme(), Theme::System);
    for text in [None, Some(r#"{"v":1,"sound":true}"#), Some("{}"), Some("not json"),
                 Some(r#"{"v":1,"sound":true,"theme":42}"#), Some(r#"{"v":1,"sound":true,"theme":"chartreuse}"#),
                 Some(r#"{"v":1,"sound":true,"theme":null}"#)] {
        let p = Prefs::from_text(text);
        assert_eq!(p.theme(), Theme::System, "{text:?} must read as system");
        let encoded: Value = serde_json::from_str(&p.to_text()).unwrap();
        assert!(encoded.get("theme").is_none(), "{text:?} must not gain a theme key");
        assert_eq!(Prefs::from_text(Some(&p.to_text())), p);
    }
    // An explicit choice round-trips; an untouched v1 file is re-emitted byte for byte.
    // The serializer orders keys (the failure of asserting a hand-written order is why
    // this asserts the bytes it ACTUALLY emits), and any input order re-encodes to them
    // without ever gaining a theme key: order-independent content equality on top.
    let canonical = r#"{"sound":true,"v":1}"#;
    assert_eq!(Prefs::from_text(Some(canonical)).to_text(), canonical, "an untouched file keeps its bytes");
    for plain in [canonical, r#"{"v":1,"sound":true}"#] {
        let p = Prefs::from_text(Some(plain));
        let encoded = p.to_text();
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), serde_json::from_str::<Value>(plain).unwrap(),
            "same content regardless of input key order");
        assert!(!encoded.contains("\"theme\""), "an untouched file never gains a theme key: {encoded}");
    }
    for mode in THEMES {
        let p = Prefs { theme: Theme::parse(mode), ..Prefs::default() };
        let value: Value = serde_json::from_str(&p.to_text()).unwrap();
        assert_eq!(value["theme"], mode);
        assert_eq!(Prefs::from_text(Some(&p.to_text())).theme(), p.theme());
    }
    // The closed shape is enforced on write as well as on read.
    let bad = Prefs { theme: None, ..Prefs::default() };
    assert_eq!(bad.theme().as_str(), "system");
    assert_eq!(Theme::parse("System"), None);
    assert_eq!(Theme::parse("SYSTEM"), None);
    assert_eq!(Theme::parse(""), None);
    let _ = Mutex::new(()); // (no disk needed here: to_text/from_text are the persistence seam)
}

#[test]
fn set_theme_is_a_closed_command_and_rejects_leave_state_and_counters_unchanged() {
    use std::sync::Mutex;
    let mut current = Prefs { sound: true, theme: Some(Theme::Dark), ..Prefs::default() };
    let mut writes = 0;
    for value in [json!(null), json!(42), json!({}), json!("blue"), json!("System"), json!("DARK"), json!("")] {
        let before = current.clone();
        let command = parse_command(&json!({"action":"set_theme", "theme":value}));
        assert_eq!(command, Err(CommandError), "{value} is outside the closed enum");
        if let Ok(command) = command {
            let _ = update(&current, &command, |_| { writes += 1; true });
        }
        assert_eq!(current, before, "a refused value never touches the state");
        assert_eq!(writes, 0, "a refused value never touches the disk");
    }
    for bad in [json!({"action":"set_theme"}), json!({"action":"set_theme","theme":"dark","x":1}),
                json!({"action":"set_theme","mode":"dark"}), json!({"action":"view","theme":"dark"})] {
        assert_eq!(parse_command(&bad), Err(CommandError), "{bad} is not a valid command shape");
    }
    let command = parse_command(&json!({"action":"set_theme","theme":"light"})).unwrap();
    assert_eq!(command, Command::SetTheme(Theme::Light));
    current = update(&current, &command, |_| { writes += 1; true }).unwrap();
    assert_eq!(current.theme(), Theme::Light);
    assert!(current.sound, "the other fields are retained");
    assert_eq!(writes, 1);
    assert_eq!(Prefs::from_text(Some(&current.to_text())).theme(), Theme::Light);
}

#[test]
fn theme_transact_persists_before_publish_and_a_failed_save_publishes_nothing() {
    use std::sync::Mutex;
    let state = Mutex::new(Prefs::default());
    let serial = Mutex::new(());
    let disk = Mutex::new(Prefs::default().to_text());
    let events = Mutex::new(Vec::new());
    let command = parse_command(&json!({"action":"set_theme","theme":"dark"})).unwrap();
    let next = transact(&serial, &state, &command,
        |p| { *disk.lock().unwrap() = p.to_text(); true },
        |p| events.lock().unwrap().push(p.theme())).unwrap();
    assert_eq!(next.theme(), Theme::Dark);
    assert_eq!(*events.lock().unwrap(), vec![Theme::Dark]);
    assert!(disk.lock().unwrap().contains("\"theme\":\"dark\""));
    // A failed save installs nothing and publishes nothing: the visible state stays.
    let before = state.lock().unwrap().clone();
    let bytes = disk.lock().unwrap().clone();
    let light = parse_command(&json!({"action":"set_theme","theme":"light"})).unwrap();
    assert_eq!(transact(&serial, &state, &light, |_| false, |_| panic!("failed event")), Err(CommandError));
    assert_eq!(*state.lock().unwrap(), before);
    assert_eq!(*disk.lock().unwrap(), bytes);
    assert_eq!(events.lock().unwrap().len(), 1);
    // View (idempotent) writes nothing and publishes nothing.
    transact(&serial, &state, &Command::View, |_| panic!("view write"), |_| panic!("view event")).unwrap();
    assert_eq!(events.lock().unwrap().len(), 1);
    // Re-selecting the mode that is already stored changes nothing.
    transact(&serial, &state, &command, |_| panic!("no-op write"), |_| panic!("no-op event")).unwrap();
    assert_eq!(events.lock().unwrap().len(), 1);
    // A LEGITIMATE second write (dark -> system) persists first, then publishes exactly once more.
    let system = parse_command(&json!({"action":"set_theme","theme":"system"})).unwrap();
    transact(&serial, &state, &system,
        |p| { *disk.lock().unwrap() = p.to_text(); true },
        |p| events.lock().unwrap().push(p.theme())).unwrap();
    assert_eq!(state.lock().unwrap().theme(), Theme::System);
    assert!(disk.lock().unwrap().contains("\"theme\":\"system\""));
    assert_eq!(*events.lock().unwrap(), vec![Theme::Dark, Theme::System]);
    // A value the parser refuses never reaches the transaction: no state, disk or event moves.
    let refused = disk.lock().unwrap().clone();
    assert_eq!(parse_command(&json!({"action":"set_theme","theme":"sepia"})), Err(CommandError));
    assert_eq!(state.lock().unwrap().theme(), Theme::System);
    assert_eq!(*disk.lock().unwrap(), refused);
    assert_eq!(events.lock().unwrap().len(), 2);
}
