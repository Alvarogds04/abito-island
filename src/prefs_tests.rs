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

// ---- #264 / GD049: the remembered desktop position (optional v1 field) -----

#[test]
fn a_dragged_position_round_trips_as_an_optional_v1_field() {
    let saved = Prefs { position: Some((910, 1002)), ..Prefs::default() };
    let text = saved.to_text();
    assert!(!text.contains('\n'), "the file stays one line: {text}");
    let wire: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(wire["position"]["x"], 910);
    assert_eq!(wire["position"]["y"], 1002);
    assert_eq!(wire["v"], 1, "the file stays v1");
    assert_eq!(Prefs::from_text(Some(&text)), saved);
    // a position left of the origin (a monitor to the left) is a real position
    let west = Prefs { position: Some((-300, 40)), ..Prefs::default() };
    assert_eq!(Prefs::from_text(Some(&west.to_text())), west);
}

#[test]
fn the_position_is_native_only_and_never_reaches_the_webview_schema() {
    // parse_command is the WebView's closed schema; the position is written by
    // the native drag path only, so no payload can set or clear it.
    for payload in [
        json!({"action":"set_position","x":910,"y":1002}),
        json!({"action":"set_position"}),
        json!({"action":"clear_position"}),
        json!({"action":"position","x":910,"y":1002}),
        json!({"action":"set_position","x":910,"y":1002,"z":0}),
    ] {
        assert_eq!(parse_command(&payload), Err(CommandError), "{payload}");
    }
    // and the native command itself refuses a coordinate no desktop has
    let current = Prefs { position: Some((910, 1002)), ..Prefs::default() };
    for bad in [
        Command::SetPosition(2_000_000, 0),
        Command::SetPosition(0, -2_000_000),
        Command::SetPosition(i32::MAX, i32::MIN),
    ] {
        assert_eq!(apply(&current, &bad), Err(CommandError), "{bad:?}");
    }
    assert_eq!(current.position, Some((910, 1002)), "a rejected write never mutates state");
    let moved = apply(&current, &Command::SetPosition(100, 1002)).unwrap();
    assert_eq!(moved.position, Some((100, 1002)));
    assert_eq!(moved.sound, current.sound, "the position never touches another field");
}

#[test]
fn an_old_prefs_file_without_a_position_reads_and_writes_back_the_same_bytes() {
    // Regression: a file written before #264 keeps EXACTLY its bytes when this
    // build reads and rewrites it, and its every field still loads.
    let old = r#"{"avatar_colors":{"abito":"purple"},"display_name":"Ana","gain":0.12,"sound":true,"v":1}"#;
    let p = Prefs::from_text(Some(old));
    assert_eq!(p.position, None, "nobody has dragged the island yet");
    assert!(p.sound);
    assert_eq!(p.display_name.as_deref(), Some("Ana"));
    assert_eq!(p.gain(), 0.12);
    assert_eq!(p.avatar_colors["abito"], "purple");
    assert_eq!(p.to_text(), old, "the position key must not change an untouched file");
    // the same promise the #384 test pins for colours
    let minimal = Prefs::from_text(Some(r#"{"v":1,"sound":true}"#)).to_text();
    assert!(!minimal.contains("position"), "{minimal}");
    assert!(minimal.contains(r#""sound":true"#), "{minimal}");
}

#[test]
fn a_settings_change_after_a_drag_never_drops_the_saved_position() {
    use std::sync::Mutex;
    let serial = Mutex::new(());
    let state = Mutex::new(Prefs::default());
    let disk = Mutex::new(Prefs::default().to_text());
    // 1. the drag release commits its position through the SAME gate and file
    transact(&serial, &state, &Command::SetPosition(910, 1002), |p| { *disk.lock().unwrap() = p.to_text(); true }, |_| {}).unwrap();
    // 2. a later settings change must not erase it (lost-update regression)
    let rename = parse_command(&json!({"action":"set_display_name","display_name":"Ana"})).unwrap();
    transact(&serial, &state, &rename, |p| { *disk.lock().unwrap() = p.to_text(); true }, |_| {}).unwrap();
    let sound = parse_command(&json!({"action":"sound_on"})).unwrap();
    transact(&serial, &state, &sound, |p| { *disk.lock().unwrap() = p.to_text(); true }, |_| {}).unwrap();
    // 3. and a later drag overwrites only the position
    transact(&serial, &state, &Command::SetPosition(100, 32), |p| { *disk.lock().unwrap() = p.to_text(); true }, |_| {}).unwrap();
    let reloaded = Prefs::from_text(Some(&disk.lock().unwrap()));
    assert_eq!(reloaded.position, Some((100, 32)));
    assert_eq!(reloaded.display_name.as_deref(), Some("Ana"));
    assert!(reloaded.sound);
    assert_eq!(*state.lock().unwrap(), reloaded, "memory and disk agree after every commit");
    // a no-op release (same coordinates) writes nothing at all
    let bytes = disk.lock().unwrap().clone();
    transact(&serial, &state, &Command::SetPosition(100, 32), |_| panic!("no-op write"), |_| panic!("no-op event")).unwrap();
    assert_eq!(*disk.lock().unwrap(), bytes);
    // a rejected position never reaches the disk either
    assert_eq!(transact(&serial, &state, &Command::SetPosition(5_000_000, 0), |_| panic!("invalid write"), |_| panic!("invalid event")), Err(CommandError));
    assert_eq!(*disk.lock().unwrap(), bytes);
}

#[test]
fn a_damaged_position_never_panics_and_never_costs_the_other_preferences() {
    for bad in [
        r#"{"v":1,"sound":true,"position":42}"#,
        r#"{"v":1,"sound":true,"position":"910,1002"}"#,
        r#"{"v":1,"sound":true,"position":[]}"#,
        r#"{"v":1,"sound":true,"position":null}"#,
        r#"{"v":1,"sound":true,"position":{}}"#,
        r#"{"v":1,"sound":true,"position":{"x":910}}"#,
        r#"{"v":1,"sound":true,"position":{"y":1002}}"#,
        r#"{"v":1,"sound":true,"position":{"x":"910","y":1002}}"#,
        r#"{"v":1,"sound":true,"position":{"x":910.5,"y":1002}}"#,
        r#"{"v":1,"sound":true,"position":{"x":910,"y":1002.5}}"#,
        r#"{"v":1,"sound":true,"position":{"x":99999999999,"y":1002}}"#,
        r#"{"v":1,"sound":true,"position":{"x":-910,"y":-99999999999}}"#,
        r#"{"v":1,"sound":true,"position":{"x":99999999999,"y":99999999999}}"#,
        r#"{"v":1,"sound":true,"position":{"x":910,"y":1002,"z":0}}"#,
    ] {
        let p = Prefs::from_text(Some(bad));
        assert_eq!(p.position, None, "{bad}: a damaged position reads as no position");
        assert!(p.sound, "{bad}: the sound preference must survive");
        assert_eq!(p.display_name, None);
        assert!(p.avatar_colors.is_empty());
        // writing the surviving preferences back adds no position key
        assert!(!p.to_text().contains("position"), "{bad} -> {}", p.to_text());
    }
    // a truncated file is still just the defaults, never a panic
    assert_eq!(Prefs::from_text(Some(r#"{"v":1,"sound":true,"position":{"x":9"#)), Prefs::default());
    assert_eq!(Prefs::from_text(Some("\u{0}\u{1}")), Prefs::default());
    // only a complete, bounded pair survives
    let ok = Prefs::from_text(Some(r#"{"v":1,"sound":true,"position":{"x":-300,"y":40}}"#));
    assert_eq!(ok.position, Some((-300, 40)));
    assert!(ok.sound);
}

// #345: only public parse/load/update/transact interfaces, isolated storage callbacks.
#[test]
fn f032_optional_defaults_and_saved_normalization() {
    let old = Prefs::from_text(Some(r#"{"v":1,"sound":true,"future_unvalidated":{"secret":"not retained"}}"#));
    assert_eq!(old.to_text(), r#"{"sound":true,"v":1}"#);
    let raw = r#"{"v":1,"sound":true,"main_pill":"ai_google","declared_pills":["unknown","integration_claude","agent_gemini","agent_gemini","ai_google","agent_amp","integration_notion","integration_spotify",7,"integration_music","agent_claude-desktop"]}"#;
    let loaded = Prefs::from_text(Some(raw));
    let v: Value = serde_json::from_str(&loaded.to_text()).unwrap();
    assert_eq!(v["declared_pills"], json!(["agent_gemini","ai_google","agent_amp","integration_notion"]));
    assert!(loaded.sound);
    assert_eq!(Prefs::from_text(Some(&loaded.to_text())), loaded);
    for raw in [r#"{"v":1,"main_pill":"unknown","declared_pills":false}"#,
                r#"{"v":1,"main_pill":4,"declared_pills":"bad"}"#] {
        assert_eq!(Prefs::from_text(Some(raw)).to_text(), Prefs::default().to_text());
    }
    let empty = Prefs::from_text(Some(r#"{"v":1,"declared_pills":[]}"#));
    let v: Value = serde_json::from_str(&empty.to_text()).unwrap();
    assert_eq!(v["declared_pills"], json!([]));
}

#[test]
fn f032_main_and_toggle_public_transactions_preserve_legacy_fields() {
    use std::sync::Mutex;
    let original = Prefs::from_text(Some(r#"{"v":1,"sound":true,"gain":0.2,"display_name":"Ana","avatar_colors":{"orphan":"mint"},"declared_pills":["agent_cursor","ai_google"]}"#));
    let state = Mutex::new(original); let serial = Mutex::new(());
    let disk = Mutex::new(state.lock().unwrap().to_text()); let events = Mutex::new(Vec::new());
    let commands = [
        json!({"action":"set_main_pill","id":"agent_cursor"}),
        json!({"action":"toggle_declared_pill","id":"ai_google"}),
        json!({"action":"toggle_declared_pill","id":"agent_codex"}),
        json!({"action":"toggle_declared_pill","id":"ai_openai"}),
        json!({"action":"toggle_declared_pill","id":"integration_github"}),
        json!({"action":"toggle_declared_pill","id":"integration_notion"}),
    ];
    for payload in commands {
        let command = parse_command(&payload).expect("accepted public pill command");
        let next = transact(&serial,&state,&command,|p| { *disk.lock().unwrap()=p.to_text(); true },
            |p| { assert!(serial.try_lock().is_err()); assert_eq!(*state.try_lock().unwrap(),*p); events.lock().unwrap().push(p.to_text()); }).unwrap();
        assert!(next.sound); assert_eq!(next.gain(),0.2); assert_eq!(next.display_name.as_deref(),Some("Ana"));
        assert_eq!(next.avatar_colors["orphan"],"mint");
        assert_eq!(Prefs::from_text(Some(&disk.lock().unwrap())),next);
    }
    let v: Value = serde_json::from_str(&disk.lock().unwrap()).unwrap();
    assert_eq!(v["main_pill"],"agent_cursor");
    assert_eq!(v["declared_pills"],json!(["agent_codex","ai_openai","integration_github","integration_notion"]));
    assert_eq!(events.lock().unwrap().len(),6);
    let before = state.lock().unwrap().clone(); let bytes = disk.lock().unwrap().clone();
    for payload in [
        json!({"action":"toggle_declared_pill","id":"ai_google"}),
        json!({"action":"toggle_declared_pill","id":"agent_cursor"}),
    ] {
        let command = parse_command(&payload).unwrap();
        let mut writes=0; let mut published=0;
        assert_eq!(transact(&serial,&state,&command,|_| { writes+=1; true },|_| { published+=1; }),Err(CommandError));
        assert_eq!(writes,0); assert_eq!(published,0); assert_eq!(*state.lock().unwrap(),before); assert_eq!(*disk.lock().unwrap(),bytes);
    }
    let remove = parse_command(&json!({"action":"toggle_declared_pill","id":"agent_codex"})).unwrap();
    let mut writes=0; let mut published=0;
    assert_eq!(transact(&serial,&state,&remove,|_| { writes+=1; false },|_| { published+=1; }),Err(CommandError));
    assert_eq!(writes,1); assert_eq!(published,0); assert_eq!(*state.lock().unwrap(),before);
    let removed = transact(&serial,&state,&remove,|_| true,|_| {}).unwrap();
    let v: Value=serde_json::from_str(&removed.to_text()).unwrap();
    assert_eq!(v["declared_pills"],json!(["ai_openai","integration_github","integration_notion"]));
    let mut attempts=0;
    let main=parse_command(&json!({"action":"set_main_pill","id":"agent_cursor"})).unwrap();
    assert_eq!(transact(&serial,&state,&main,|_| {attempts+=1; false},|_| panic!("noop event")),Ok(removed));
    assert_eq!(attempts,0);
}

#[test]
fn f032_closed_ipc_refusal_keeps_state_bytes_and_counters() {
    let current=Prefs::from_text(Some(r#"{"v":1,"sound":true,"declared_pills":[]}"#));
    let bytes=current.to_text(); let mut writes=0; let mut published=0;
    for payload in [
        json!({"action":"set_main_pill","id":"ai_google"}),
        json!({"action":"set_main_pill","id":4}),json!({"action":"set_main_pill"}),
        json!({"action":"toggle_declared_pill","id":"unknown"}),
        json!({"action":"toggle_declared_pill","id":"integration_music"}),
        json!({"action":"toggle_declared_pill","id":null}),
        json!({"action":"toggle_declared_pill","id":["agent_amp","agent_amp"]}),
        json!({"action":"toggle_declared_pill","id":"agent_amp","declared_pills":["agent_amp","agent_amp"]}),
        json!({"action":"toggle_declared_pill","declared_pills":["agent_amp","ai_google","ai_openai","agent_codex","agent_gemini"]}),
    ] {
        assert_eq!(parse_command(&payload),Err(CommandError),"{payload}");
        if let Ok(command)=parse_command(&payload) {
            let serial=std::sync::Mutex::new(()); let state=std::sync::Mutex::new(current.clone());
            let _=transact(&serial,&state,&command,|_| {writes+=1;true},|_| {published+=1;});
        }
        assert_eq!(current.to_text(),bytes); assert_eq!(writes,0); assert_eq!(published,0);
    }
}

#[test]
fn f032_every_legacy_writer_keeps_typed_pill_choices_and_drops_unknown_json() {
    let current=Prefs::from_text(Some(r#"{"v":1,"sound":true,"gain":0.2,"display_name":"Ana","avatar_colors":{"abito":"purple","orphan":"mint"},"main_pill":"agent_codex","declared_pills":["ai_google"],"unvalidated_secret":"ignored"}"#));
    for payload in [
        json!({"action":"view"}),json!({"action":"sound_on"}),json!({"action":"sound_off"}),
        json!({"action":"set_sound_gain","gain":0.1}),json!({"action":"set_display_name","display_name":"Bea"}),
        json!({"action":"set_avatar_color","identity":"abito","color":"blue"}),
        json!({"action":"clear_avatar_color","identity":"abito"}),
    ] {
        let next=update(&current,&parse_command(&payload).unwrap(),|_| true).unwrap();
        let v:Value=serde_json::from_str(&next.to_text()).unwrap();
        assert_eq!(v["main_pill"],"agent_codex"); assert_eq!(v["declared_pills"],json!(["ai_google"]));
        assert!(v.get("unvalidated_secret").is_none()); assert_eq!(next.avatar_colors["orphan"],"mint");
    }
}

// #346 F033 — per-pill colours: the closed five-name palette is the ONLY colour vocabulary.
#[test]
fn f033_pill_colors_keep_the_closed_palette_and_never_destroy_the_catalogue() {
    let raw = r##"{"v":1,"sound":true,"gain":0.2,"display_name":"Ana","avatar_colors":{"abito":"mint"},"main_pill":"agent_codex","declared_pills":["ai_google"],"pill_colors":{"agent_amp":"mint","agent_cursor":"#ff0000","agent_muse":"MINT","integration_claude":"expression(alert(1))","integration_n8n":"<img src=x onerror=alert(1)>","ai_google":7,"unknown_pill":"blue","__proto__":"purple"},"future_unvalidated":{"secret":"not retained"}}"##;
    let loaded = Prefs::from_text(Some(raw));
    let v: Value = serde_json::from_str(&loaded.to_text()).unwrap();
    assert_eq!(v["pill_colors"], json!({"agent_amp":"mint"}), "only a catalog id carrying a palette name survives");
    assert_eq!(v["main_pill"], json!("agent_codex"));
    assert_eq!(v["declared_pills"], json!(["ai_google"]));
    assert_eq!(v["avatar_colors"], json!({"abito":"mint"}));
    assert!(loaded.sound);
    assert_eq!(Prefs::from_text(Some(&loaded.to_text())), loaded, "the kept entries round-trip");
    // Absent/unusable pill_colors never writes the key: «ausente/vacío nunca escribe».
    for text in [r#"{"v":1}"#, r#"{"v":1,"pill_colors":{}}"#, r#"{"v":1,"pill_colors":null}"#,
                 r#"{"v":1,"pill_colors":"green"}"#, r#"{"v":1,"pill_colors":["green"]}"#,
                 r#"{"v":1,"pill_colors":{"agent_amp":"nope"}}"#,
                 r#"{"v":1,"pill_colors":{"unknown_pill":"green"}}"#] {
        let out = Prefs::from_text(Some(text)).to_text();
        assert!(!out.contains("pill_colors"), "{text} → {out}");
    }
}

#[test]
fn f033_set_pill_color_is_exact_arity_and_only_touches_its_own_field() {
    let current = Prefs::from_text(Some(r#"{"v":1,"sound":true,"gain":0.2,"display_name":"Ana","avatar_colors":{"abito":"mint"},"main_pill":"agent_codex","declared_pills":["ai_google"],"pill_colors":{"agent_cursor":"blue"}}"#));
    let command = parse_command(&json!({"action":"set_pill_color","id":"agent_amp","color":"purple"}))
        .expect("closed three-key pill colour command accepted");
    let next = update(&current, &command, |_| true).expect("a palette colour applies");
    let written: Value = serde_json::from_str(&next.to_text()).unwrap();
    assert_eq!(written["pill_colors"], json!({"agent_amp":"purple","agent_cursor":"blue"}), "the new key lands beside the kept one");
    let mut before: Value = serde_json::from_str(&current.to_text()).unwrap();
    let mut after: Value = serde_json::from_str(&next.to_text()).unwrap();
    before.as_object_mut().unwrap().remove("pill_colors");
    after.as_object_mut().unwrap().remove("pill_colors");
    assert_eq!(before, after, "set_pill_color changes nothing but its own field");
    for bad in [
        json!({"action":"set_pill_color"}),
        json!({"action":"set_pill_color","id":"agent_amp"}),
        json!({"action":"set_pill_color","color":"purple"}),
        json!({"action":"set_pill_color","id":"agent_amp","color":"purple","extra":1}),
        json!({"action":"set_pill_color","id":"agent_amp","color":"#9fdb7f"}),
        json!({"action":"set_pill_color","id":"agent_amp","color":"MINT"}),
        json!({"action":"set_pill_color","id":"agent_amp","color":"rgb(0,255,0)"}),
        json!({"action":"set_pill_color","id":"agent_amp","color":"green;background:url(https://evil)"}),
        json!({"action":"set_pill_color","id":"agent_amp","color":""}),
        json!({"action":"set_pill_color","id":"agent_amp","color":null}),
        json!({"action":"set_pill_color","id":"agent_amp","color":7}),
        json!({"action":"set_pill_color","id":"integration_music","color":"purple"}),
        json!({"action":"set_pill_color","id":"unknown_pill","color":"purple"}),
        json!({"action":"set_pill_color","id":"__proto__","color":"purple"}),
        json!({"action":"set_pill_color","id":7,"color":"purple"}),
        json!({"action":"set_pill_color","id":["agent_amp"],"color":"purple"}),
    ] {
        assert!(parse_command(&bad).is_err(), "{bad}");
    }
}

#[test]
fn f033_clear_pill_color_is_exact_arity_and_only_removes_its_own_key() {
    let current = Prefs::from_text(Some(r#"{"v":1,"sound":true,"display_name":"Ana","avatar_colors":{"abito":"mint"},"main_pill":"agent_codex","declared_pills":["ai_google"],"pill_colors":{"agent_amp":"mint","agent_cursor":"blue"}}"#));
    let command = parse_command(&json!({"action":"clear_pill_color","id":"agent_amp"}))
        .expect("closed two-key pill colour clear accepted");
    let next = update(&current, &command, |_| true).expect("the key is removable");
    let v: Value = serde_json::from_str(&next.to_text()).unwrap();
    assert_eq!(v["pill_colors"], json!({"agent_cursor":"blue"}), "only that pill loses its colour");
    assert_eq!(next.declared_pills(), current.declared_pills());
    assert_eq!(next.main_pill(), current.main_pill());
    assert!(next.sound && next.display_name.is_some() && !next.avatar_colors.is_empty());
    let untouched = update(&current,
        &parse_command(&json!({"action":"clear_pill_color","id":"integration_n8n"})).unwrap(), |_| true).unwrap();
    let untouched_text: Value = serde_json::from_str(&untouched.to_text()).unwrap();
    assert_eq!(untouched_text["pill_colors"], json!({"agent_amp":"mint","agent_cursor":"blue"}), "clearing an absent colour changes nothing");
    for bad in [
        json!({"action":"clear_pill_color"}),
        json!({"action":"clear_pill_color","color":"blue"}),
        json!({"action":"clear_pill_color","id":"agent_amp","color":"blue"}),
        json!({"action":"clear_pill_color","id":"unknown_pill"}),
        json!({"action":"clear_pill_color","id":"integration_music"}),
        json!({"action":"clear_pill_color","id":7}),
        json!({"action":"clear_pill_color","id":null}),
        json!({"action":"clear_pill_color","id":["agent_amp"]}),
    ] {
        assert!(parse_command(&bad).is_err(), "{bad}");
    }
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

// ---- #414: the chosen models of the connected providers (Ajustes → Modelos) ------------------------------

mod chosen_models {
    use super::*;
    use serde_json::json;

    fn set(provider: &str, models: &[&str]) -> Command {
        Command::SetChosenModels { provider: provider.into(), models: models.iter().map(|m| m.to_string()).collect() }
    }

    #[test]
    fn the_choice_round_trips_as_an_optional_v1_field_and_untouched_files_keep_their_bytes() {
        let saved = Prefs { chosen_models: Some([("anthropic".to_string(), vec!["claude-sonnet-4-5".to_string(), "claude-opus-4-6".to_string()])].into()), ..Prefs::default() };
        let text = saved.to_text();
        assert!(!text.contains('\n'), "the file stays one line: {text}");
        assert_eq!(Prefs::from_text(Some(&text)), saved, "order is the page's, not sorted");
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["v"], 1, "the file stays v1");
        // A file nobody customised never grows the key.
        let minimal = Prefs::from_text(Some(r#"{"v":1,"sound":true}"#)).to_text();
        assert!(!minimal.contains("chosen_models"), "{minimal}");
    }

    #[test]
    fn the_command_schema_is_closed_and_exact() {
        for payload in [
            json!({"action":"set_chosen_models"}),
            json!({"action":"set_chosen_models","provider":"anthropic"}),
            json!({"action":"set_chosen_models","models":["claude-sonnet-4-5"]}),
            json!({"action":"set_chosen_models","provider":"anthropic","models":"x"}),
            json!({"action":"set_chosen_models","provider":"anthropic","models":[1]}),
            json!({"action":"set_chosen_models","provider":"anthropic","models":[],"extra":1}),
            json!({"action":"set_chosen_models","provider":"anthropic","models":["m"],"provider2":"x"}),
            json!({"action":"choose_models","provider":"anthropic","models":[]}),
            json!({"action":"set_chosen_models","provider":1,"models":[]}),
        ] {
            assert_eq!(parse_command(&payload), Err(CommandError), "{payload} is not a valid command shape");
        }
        let ok = parse_command(&json!({"action":"set_chosen_models","provider":"anthropic","models":["claude-sonnet-4-5"]})).unwrap();
        assert_eq!(ok, set("anthropic", &["claude-sonnet-4-5"]));
    }

    #[test]
    fn identifiers_are_a_closed_slug_shape_and_hosts_are_bounded() {
        // providers: the engine's strict_id shape (<=64, lowercase slug); model ids keep
        // their catalogue spelling, bounded, no whitespace or control characters.
        for provider in ["", "Anthropic", "ANTHROPIC", "with space", "slash/ed", "ünicode", "dot.", "a\nb", &"a".repeat(65)] {
            assert_eq!(apply(&Prefs::default(), &set(provider, &["m"])), Err(CommandError), "{provider:?}");
        }
        for model in ["", "with space", "tab\tid", "new\nline", "ünicode", &"m".repeat(201)] {
            assert_eq!(apply(&Prefs::default(), &set("anthropic", &[model])), Err(CommandError), "{model:?}");
        }
        // The model id keeps slashes and dots: several engines key theirs "vendor/model".
        let kept = apply(&Prefs::default(), &set("openrouter", &["Vendor/Model-2.0"])).unwrap();
        assert_eq!(kept.chosen_models.as_ref().unwrap()["openrouter"], vec!["Vendor/Model-2.0".to_string()]);
        // The provider slug admits exactly the engine's alphabet.
        let ok = apply(&Prefs::default(), &set("nan-gpt.local_2", &["m"])).unwrap();
        assert!(ok.chosen_models.as_ref().unwrap().contains_key("nan-gpt.local_2"));
    }

    #[test]
    fn the_store_is_bounded_and_deduplicates() {
        let many: Vec<String> = (0..65).map(|i| format!("m{i}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(apply(&Prefs::default(), &set("anthropic", &refs)), Err(CommandError), "65 models exceed the cap");
        let dup = apply(&Prefs::default(), &set("anthropic", &["m1", "m2", "m1"])).unwrap();
        assert_eq!(dup.chosen_models.as_ref().unwrap()["anthropic"], vec!["m1".to_string(), "m2".to_string()], "a repeated id is stored once");
        let many_providers: Vec<(String, Vec<String>)> = (0..33).map(|i| (format!("p{i}"), vec!["m".to_string()])).collect();
        let flooded = Prefs { chosen_models: Some(many_providers.into_iter().collect()), ..Prefs::default() };
        assert_eq!(flooded.chosen_models.as_ref().unwrap().len(), 33, "the raw struct keeps what it is given…");
        let reloaded = Prefs::from_text(Some(&flooded.to_text()));
        assert_eq!(reloaded.chosen_models.as_ref().map(|m| m.len()), Some(32), "…and load caps the map, dropping the rest one by one");
        // a single provider past the per-provider cap is dropped whole on load
        let fat = Prefs { chosen_models: Some([("anthropic".to_string(), many)].into()), ..Prefs::default() };
        assert_eq!(Prefs::from_text(Some(&fat.to_text())).chosen_models, None, "65 ids never become a stored choice");
    }

    #[test]
    fn a_hostile_or_damaged_file_never_costs_the_other_fields() {
        let old = r#"{"v":1,"sound":true,"gain":0.12,"chosen_models":{"anthropic":["claude-sonnet-4-5"],"BAD":["x"],"anthropic2":["", "ok" ]}}"#;
        let p = Prefs::from_text(Some(old));
        let map = p.chosen_models.as_ref().unwrap();
        assert_eq!(map.get("anthropic").map(Vec::as_slice), Some(&["claude-sonnet-4-5".to_string()][..]));
        assert!(!map.contains_key("BAD"), "an invalid provider key is dropped");
        assert_eq!(map.get("anthropic2").map(Vec::as_slice), Some(&["ok".to_string()][..]), "invalid ids drop one by one");
        assert!(p.sound && p.gain() == 0.12, "the established fields survive a damaged map");
        // An empty (fully dropped) map reads as absent and never re-writes the key.
        let damaged = r#"{"v":1,"sound":true,"chosen_models":{}}"#;
        let clean = Prefs::from_text(Some(damaged)).to_text();
        assert!(!clean.contains("chosen_models"), "{clean}");
        assert!(clean.contains(r#""sound":true"#));
        // A value the parser refuses never reaches the transaction: no state, disk or event moves.
    }

    #[test]
    fn replacing_and_clearing_one_provider_never_touches_another_and_the_command_round_trips() {
        let current = Prefs { chosen_models: Some([("anthropic".to_string(), vec!["a1".to_string(), "a2".to_string()]), ("openai".to_string(), vec!["gpt-5.2".to_string()])].into()), ..Prefs::default() };
        // A second set REPLACES that provider's list (the page sends the whole list).
        let replaced = apply(&current, &set("anthropic", &["a3"])).unwrap();
        assert_eq!(replaced.chosen_models.as_ref().unwrap()["anthropic"], vec!["a3".to_string()]);
        assert_eq!(replaced.chosen_models.as_ref().unwrap()["openai"], vec!["gpt-5.2".to_string()], "the other provider is untouched");
        // An empty list clears that provider; the last one gone drops the whole field.
        let cleared = apply(&current, &set("openai", &[])).unwrap();
        assert!(!cleared.chosen_models.as_ref().unwrap().contains_key("openai"));
        assert!(cleared.chosen_models.as_ref().unwrap().contains_key("anthropic"));
        let last = apply(&cleared, &set("anthropic", &[])).unwrap();
        assert_eq!(last.chosen_models, None, "an empty choice is absent, not an empty map");
        // The command path (not just apply) does the same, and the file round-trips.
        let cmd = parse_command(&json!({"action":"set_chosen_models","provider":"anthropic","models":["a3"]})).unwrap();
        let via_ipc = update(&current, &cmd, |_| true).unwrap();
        assert_eq!(via_ipc.chosen_models.as_ref().unwrap()["anthropic"], vec!["a3".to_string()]);
        assert_eq!(Prefs::from_text(Some(&via_ipc.to_text())), via_ipc);
    }

    #[test]
    fn transact_persists_before_publish_and_a_failed_save_publishes_nothing() {
        use std::sync::Mutex;
        let state = Mutex::new(Prefs::default());
        let serial = Mutex::new(());
        let disk = Mutex::new(Prefs::default().to_text());
        let events = Mutex::new(Vec::new());
        let command = set("anthropic", &["claude-sonnet-4-5"]);
        let next = transact(&serial, &state, &command,
            |p| { *disk.lock().unwrap() = p.to_text(); true },
            |p| events.lock().unwrap().push(p.chosen_models.clone())).unwrap();
        assert_eq!(next.chosen_models.as_ref().unwrap()["anthropic"], vec!["claude-sonnet-4-5".to_string()]);
        assert_eq!(events.lock().unwrap().len(), 1);
        assert!(disk.lock().unwrap().contains("\"chosen_models\""));
        // A failed save installs nothing and publishes nothing.
        let before = state.lock().unwrap().clone();
        let bytes = disk.lock().unwrap().clone();
        assert_eq!(transact(&serial, &state, &set("openai", &["gpt-5.2"]), |_| false, |_| panic!("failed event")), Err(CommandError));
        assert_eq!(*state.lock().unwrap(), before);
        assert_eq!(*disk.lock().unwrap(), bytes);
        // Clearing to nothing is a real change (publishes); clearing again is a no-op.
        transact(&serial, &state, &set("anthropic", &[]),
            |p| { *disk.lock().unwrap() = p.to_text(); true },
            |p| events.lock().unwrap().push(p.chosen_models.clone())).unwrap();
        assert_eq!(*events.lock().unwrap(), vec![next.chosen_models.clone(), None]);
        transact(&serial, &state, &set("anthropic", &[]), |_| panic!("no-op write"), |_| panic!("no-op event")).unwrap();
        assert_eq!(events.lock().unwrap().len(), 2);
        // An invalid command is refused before the transaction: nothing moves.
        let refused = disk.lock().unwrap().clone();
        assert_eq!(transact(&serial, &state, &set("Anthropic", &["m"]), |_| panic!("invalid write"), |_| panic!("invalid event")), Err(CommandError));
        assert_eq!(*disk.lock().unwrap(), refused);
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_projection_and_the_schema_do_not_leak_the_choice_into_other_fields() {
        // The other typed optional fields keep their round-trip through a file that also
        // carries a choice (the "all existing known fields survive" promise).
        let full = Prefs {
            sound: true,
            gain: Some(0.2),
            display_name: Some("Ana".into()),
            avatar_colors: [("abito".to_string(), "mint".to_string())].into(),
            position: Some((10, 20)),
            main_pill: Some("agent_codex".into()),
            declared_pills: Some(vec!["integration_github".into()]),
            pill_colors: [("agent_amp".to_string(), "mint".to_string())].into(),
            theme: Some(Theme::Dark),
            chosen_models: Some([("anthropic".to_string(), vec!["claude-sonnet-4-5".to_string()])].into()),
            auto_close_seconds: Some(30),
            open_on_hover: Some(true),
            custom_blobs: Some(vec![CustomBlob { name: "Abito GitHub".into(), color: Some("mint".into()) }]),
        };
        let text = full.to_text();
        let re = Prefs::from_text(Some(&text));
        assert_eq!(re, full);
        for key in ["sound", "gain", "display_name", "avatar_colors", "position", "main_pill", "declared_pills", "pill_colors", "theme", "chosen_models", "auto_close_seconds", "open_on_hover", "custom_blobs"] {
            assert!(serde_json::from_str::<Value>(&text).unwrap().as_object().unwrap().contains_key(key), "{key} survived");
        }
    }
}

/// #336 T1b-a (L15): `set_island_interaction` is an exact three-key closed
/// command — integer `auto_close_seconds` 5..=120 inclusive and boolean
/// `open_on_hover`, no coercion, no extra or camelCase keys. This is the
/// invalid-schema-before-rate/disk/publish boundary: `prefs_action` parses
/// before it takes the rate limiter.
#[test]
fn set_island_interaction_is_an_exact_closed_three_key_command() {
    let exact = json!({"action":"set_island_interaction","auto_close_seconds":15,"open_on_hover":false});
    assert!(parse_command(&exact).is_ok(), "the exact closed shape parses");
    for seconds in [json!(5), json!(120), json!(15)] {
        assert!(parse_command(&json!({"action":"set_island_interaction","auto_close_seconds":seconds,"open_on_hover":true})).is_ok(), "{seconds}");
    }
    for seconds in [json!(4), json!(121), json!(0), json!(-5), json!(15.5), json!("15"), json!(null), json!(true)] {
        assert!(parse_command(&json!({"action":"set_island_interaction","auto_close_seconds":seconds,"open_on_hover":false})).is_err(), "{seconds} must be refused");
    }
    for hover in [json!("true"), json!(1), json!(null), json!(1.0)] {
        assert!(parse_command(&json!({"action":"set_island_interaction","auto_close_seconds":15,"open_on_hover":hover})).is_err(), "{hover} must be refused");
    }
    for bad in [
        json!({"action":"set_island_interaction"}),
        json!({"action":"set_island_interaction","auto_close_seconds":15}),
        json!({"action":"set_island_interaction","open_on_hover":false}),
        json!({"action":"set_island_interaction","auto_close_seconds":15,"open_on_hover":false,"x":1}),
        json!({"action":"set_island_interaction","autoCloseSeconds":15,"openOnHover":false}),
        json!({"action":"set_island_interaction","seconds":15,"hover":false}),
        json!({"action":"set_island_interaction","auto_close_seconds":15,"open_on_hover":false,"auto_close_seconds2":10}),
    ] {
        assert!(parse_command(&bad).is_err(), "{bad} must be refused: exact keys only");
    }
    // the legacy closed commands keep their exact behaviour
    assert_eq!(parse_command(&json!({"action":"view"})), Ok(Command::View));
    assert_eq!(parse_command(&json!({"action":"set_theme","theme":"dark"})), Ok(Command::SetTheme(Theme::Dark)));
}

/// #336 T1b-a (L15): the typed pair persists through the same v1 file, gate
/// and atomic writer as every other preference — a changed pair must reach
/// disk before it installs, and the bytes must round-trip.
#[test]
fn set_island_interaction_persists_both_fields_and_round_trips() {
    let command = parse_command(&json!({"action":"set_island_interaction","auto_close_seconds":45,"open_on_hover":true})).unwrap();
    let mut persisted = false;
    let next = update(&Prefs::default(), &command, |_| { persisted = true; true }).unwrap();
    assert!(persisted, "a changed typed pair must reach disk");
    let value = serde_json::from_str::<Value>(&next.to_text()).expect("to_text is JSON");
    assert_eq!(value["auto_close_seconds"], json!(45));
    assert_eq!(value["open_on_hover"], json!(true));
    let reread = Prefs::from_text(Some(&next.to_text()));
    assert_eq!(reread, next, "the stored pair reads back exactly");
    assert_eq!(reread.to_text(), next.to_text(), "stable bytes across a reload");
    // a failed save never installs the new pair
    let refused = update(&Prefs::default(), &command, |_| false);
    assert!(refused.is_err(), "a failed save must be reported");
}

/// #336 T1b-a (L15): every one of the 8 known fields survives this writer,
/// the new pair is added, and unknown JSON keys are still dropped.
#[test]
fn set_island_interaction_keeps_every_known_field_and_drops_unknown_json() {
    let current = Prefs::from_text(Some(
        r#"{"v":1,"sound":true,"gain":0.2,"display_name":"Alvaro","avatar_colors":{"abito":"mint"},"main_pill":"agent_cursor","declared_pills":["integration_n8n"],"pill_colors":{"agent_amp":"purple"},"theme":"dark","stowaway":true}"#,
    ));
    assert!(current.sound, "fixture sanity");
    let command = parse_command(&json!({"action":"set_island_interaction","auto_close_seconds":5,"open_on_hover":false})).unwrap();
    let next = update(&current, &command, |_| true).unwrap();
    let value = serde_json::from_str::<Value>(&next.to_text()).expect("to_text is JSON");
    assert_eq!(value["sound"], json!(true));
    assert_eq!(value["gain"], json!(0.2));
    assert_eq!(value["display_name"], json!("Alvaro"));
    assert_eq!(value["avatar_colors"]["abito"], json!("mint"));
    assert_eq!(value["main_pill"], json!("agent_cursor"));
    assert_eq!(value["declared_pills"], json!(["integration_n8n"]));
    assert_eq!(value["pill_colors"]["agent_amp"], json!("purple"));
    assert_eq!(value["theme"], json!("dark"));
    assert_eq!(value["auto_close_seconds"], json!(5), "the new pair must be stored");
    assert_eq!(value["open_on_hover"], json!(false), "the new pair must be stored");
    assert!(value.get("stowaway").is_none(), "unknown JSON keys are dropped");
}

/// #336 T1b-a: the effective values behind the projection — an absent or
/// hostile pair reads as the public contract's 15 seconds / hover off, and an
/// untouched file never grows the keys.
#[test]
fn island_interaction_defaults_are_15_seconds_and_hover_off() {
    assert_eq!(Prefs::default().auto_close_seconds(), 15);
    assert!(!Prefs::default().open_on_hover());
    let valid = Prefs::from_text(Some(r#"{"v":1,"auto_close_seconds":5,"open_on_hover":true}"#));
    assert_eq!(valid.auto_close_seconds(), 5);
    assert!(valid.open_on_hover());
    let boundary = Prefs::from_text(Some(r#"{"v":1,"auto_close_seconds":120}"#));
    assert_eq!(boundary.auto_close_seconds(), 120);
    for text in [
        r#"{"v":1,"auto_close_seconds":4}"#, r#"{"v":1,"auto_close_seconds":121}"#,
        r#"{"v":1,"auto_close_seconds":"15"}"#, r#"{"v":1,"auto_close_seconds":15.5}"#,
        r#"{"v":1,"auto_close_seconds":-5}"#, r#"{"v":1,"auto_close_seconds":null}"#,
        r#"{"v":1,"open_on_hover":"true"}"#, r#"{"v":1,"open_on_hover":1}"#,
    ] {
        let p = Prefs::from_text(Some(text));
        assert_eq!(p.auto_close_seconds(), 15, "{text} falls back to the default");
        assert!(!p.open_on_hover(), "{text} falls back to the default");
        assert!(!p.to_text().contains("auto_close_seconds"), "{text} leaves no key behind");
        assert!(!p.to_text().contains("open_on_hover"), "{text} leaves no key behind");
    }
    let untouched = Prefs::from_text(Some(r#"{"v":1,"sound":true}"#));
    let encoded = untouched.to_text();
    // same precedent as the theme test: the serializer orders keys, so this
    // asserts the bytes it ACTUALLY emits plus content equality on input order
    assert_eq!(encoded, r#"{"sound":true,"v":1}"#, "an untouched file keeps its bytes");
    assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), json!({"v":1,"sound":true}),
        "no key gained regardless of input order");
}

/// #415 WU2: created blobs are a typed optional pref — `custom_blobs`, a list of
/// label + optional palette colour entries. Absent from a file nobody created a
/// blob in, so an untouched `prefs.json` keeps exactly the bytes it had.
#[test]
fn blobs_default_to_absent_and_an_untouched_file_keeps_its_bytes() {
    assert_eq!(Prefs::default().custom_blobs, None);
    for bad in [None, Some(""), Some("not json"), Some("{}"), Some(r#"{"v":2}"#)] {
        assert_eq!(Prefs::from_text(bad).custom_blobs, None, "{bad:?} reads as no blobs");
    }
    let untouched = Prefs::from_text(Some(r#"{"v":1,"sound":true}"#));
    assert_eq!(untouched.custom_blobs, None);
    assert_eq!(untouched.to_text(), r#"{"sound":true,"v":1}"#, "an untouched file keeps its bytes");
}

/// #415 WU2: the human's own examples create, persist and reload. «Abito GitHub»,
/// «Abito Reviewer» and «Abito correo» must all be accepted; the colour is the
/// closed #346 palette or nothing.
#[test]
fn create_blob_accepts_the_human_examples_and_round_trips() {
    let current = Prefs::default();
    let github = parse_command(&json!({"action":"create_blob","name":"Abito GitHub","color":"green"})).unwrap();
    let step1 = update(&current, &github, |_| true).unwrap();
    let reviewer = parse_command(&json!({"action":"create_blob","name":"Abito Reviewer"})).unwrap();
    let step2 = update(&step1, &reviewer, |_| true).unwrap();
    let correo = parse_command(&json!({"action":"create_blob","name":"Abito correo"})).unwrap();
    let step3 = update(&step2, &correo, |_| true).unwrap();
    let blobs = step3.custom_blobs.as_ref().unwrap();
    assert_eq!(blobs.len(), 3);
    assert_eq!(blobs[0].name, "Abito GitHub");
    assert_eq!(blobs[0].color.as_deref(), Some("green"));
    assert_eq!(blobs[1].name, "Abito Reviewer");
    assert_eq!(blobs[1].color, None, "no colour is a valid created blob");
    assert_eq!(blobs[2].name, "Abito correo");
    // the entries survive a full file round trip
    let reread = Prefs::from_text(Some(&step3.to_text()));
    assert_eq!(reread, step3, "created blobs read back exactly");
    assert_eq!(reread.to_text(), step3.to_text(), "stable bytes across a reload");
    // every other known field survives beside the new one
    let value: Value = serde_json::from_str(&step3.to_text()).unwrap();
    assert_eq!(value["sound"], json!(false));
    assert_eq!(value["custom_blobs"][0], json!({"name":"Abito GitHub","color":"green"}));
    assert_eq!(value["custom_blobs"][1], json!({"name":"Abito Reviewer"}));
}

/// #415 WU2: every refusal leaves the data and the counters unchanged —
/// duplicates (case-insensitive), the reserved principal name, overlong or
/// control-bearing names, an off-set colour and a wrong arity are CommandError.
#[test]
fn create_blob_refusals_leave_the_store_byte_identical() {
    let start = update(&Prefs::default(),
        &parse_command(&json!({"action":"create_blob","name":"Abito GitHub","color":"mint"})).unwrap(), |_| true).unwrap();
    let baseline = start.clone();
    // a refusal may come from the parse gate (untrimmed/oversized names) or from
    // apply (duplicates, the principal, the cap); either way nothing may change.
    let refused = |payload: Value| {
        match parse_command(&payload) {
            Err(CommandError) => {}
            Ok(command) => assert_eq!(update(&start, &command, |_| true), Err(CommandError), "{payload}"),
        }
    };
    refused(json!({"action":"create_blob","name":"abito github"})); // duplicate, case-insensitive
    refused(json!({"action":"create_blob","name":"  Abito GitHub  "})); // untrimmed names never parse
    refused(json!({"action":"create_blob","name":"Abito"})); // the main blob is not creatable
    refused(json!({"action":"create_blob","name":"ABITO"}));
    refused(json!({"action":"create_blob","name":""}));
    refused(json!({"action":"create_blob","name":"   "}));
    refused(json!({"action":"create_blob","name":"Abito\u{0007}"})); // control character
    refused(json!({"action":"create_blob","name":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})); // 41 chars
    refused(json!({"action":"create_blob","name":"Abito GitHub"})); // exact duplicate
    refused(json!({"action":"create_blob","name":"Abito correo","color":"teal"})); // off-set colour
    refused(json!({"action":"create_blob","name":"Abito correo","color":42}));
    refused(json!({"action":"create_blob","name":42}));
    refused(json!({"action":"create_blob","color":"green"}));
    refused(json!({"action":"create_blob","name":"Abito correo","color":"green","x":1}));
    refused(json!({"action":"create_blob"}));
    assert_eq!(start, baseline, "a refusal never moves the store");
    // the ninth blob is refused too: the pref must never outgrow its panel
    let mut grown = start;
    for name in ["B1", "B2", "B3", "B4", "B5", "B6", "B7"] {
        grown = update(&grown, &parse_command(&json!({"action":"create_blob","name":name})).unwrap(), |_| true).unwrap();
    }
    assert_eq!(grown.custom_blobs.as_ref().unwrap().len(), 8, "cap is eight");
    assert_eq!(update(&grown, &parse_command(&json!({"action":"create_blob","name":"B9"})).unwrap(), |_| true), Err(CommandError));
    assert_eq!(grown.custom_blobs.as_ref().unwrap().len(), 8, "the cap refusal adds nothing");
}

/// #415 WU2: deleting removes exactly the named entry; the main blob «Abito» can
/// never exist as a stored record, so it can never be deleted.
#[test]
fn delete_blob_removes_only_the_named_entry() {
    let start = update(&Prefs::default(),
        &parse_command(&json!({"action":"create_blob","name":"Abito GitHub","color":"mint"})).unwrap(), |_| true).unwrap();
    let start = update(&start,
        &parse_command(&json!({"action":"create_blob","name":"Abito correo"})).unwrap(), |_| true).unwrap();
    let after = update(&start, &parse_command(&json!({"action":"delete_blob","name":"Abito GitHub"})).unwrap(), |_| true).unwrap();
    let blobs = after.custom_blobs.as_ref().unwrap();
    assert_eq!(blobs.len(), 1);
    assert_eq!(blobs[0].name, "Abito correo");
    let reread = Prefs::from_text(Some(&after.to_text()));
    assert_eq!(reread, after, "the deletion round trips");
    // unknown names are refused and change nothing
    let baseline = after.clone();
    for bad in [
        json!({"action":"delete_blob","name":"Nunca existió"}),
        json!({"action":"delete_blob","name":"abito correo"}), // case-sensitive match: refused
        json!({"action":"delete_blob","name":"abito"}),
        json!({"action":"delete_blob"}),
        json!({"action":"delete_blob","name":42}),
        json!({"action":"delete_blob","name":"Abito correo","x":1}),
    ] {
        match parse_command(&bad) {
            Err(CommandError) => {}
            Ok(command) => assert_eq!(update(&after, &command, |_| true), Err(CommandError), "{bad}"),
        }
    }
    assert_eq!(after, baseline);
    // deleting the last entry leaves no key behind
    let empty = update(&after, &parse_command(&json!({"action":"delete_blob","name":"Abito correo"})).unwrap(), |_| true).unwrap();
    assert_eq!(empty.custom_blobs, None);
    assert!(!empty.to_text().contains("custom_blobs"), "an emptied list writes no key");
}

/// #415 WU2: a hostile stored `custom_blobs` drops its bad entries on load — a
/// non-object entry, a non-string name, a control name, an off-set colour — and
/// a list whose every entry was dropped reads as absent (no key written).
#[test]
fn hostile_stored_blobs_are_dropped_on_load() {
    let p = Prefs::from_text(Some(
        "{\"v\":1,\"custom_blobs\":[{\"name\":\"Abito GitHub\",\"color\":\"green\"},{\"name\":42},{\"name\":\"bad\\u0007\"},{\"name\":\"Ok\",\"color\":\"teal\"},\"junk\",{\"name\":\"Solo\"}]}",
    ));
    let blobs = p.custom_blobs.as_ref().unwrap();
    assert_eq!(blobs.len(), 3, "only the valid entries survive: the off-set colour drops, not the entry (the pill_colors reading rule)");
    assert_eq!(blobs[0].name, "Abito GitHub");
    assert_eq!(blobs[0].color.as_deref(), Some("green"));
    assert_eq!(blobs[1].name, "Ok");
    assert_eq!(blobs[1].color, None, "an off-set colour reads as no colour");
    assert_eq!(blobs[2].name, "Solo");
    let all_bad = Prefs::from_text(Some(r#"{"v":1,"custom_blobs":[{"name":1},"junk"]}"#));
    assert_eq!(all_bad.custom_blobs, None, "nothing valid reads as absent");
    assert!(!all_bad.to_text().contains("custom_blobs"), "no key is written back");
    for text in [
        r#"{"v":1,"custom_blobs":42}"#, r#"{"v":1,"custom_blobs":"x"}"#,
        r#"{"v":1,"custom_blobs":null}"#, r#"{"v":1,"custom_blobs":[{"name":"A"}],"sound":true}"#,
    ] {
        let p = Prefs::from_text(Some(text));
        let valid_count = p.custom_blobs.as_ref().map(|b| b.len()).unwrap_or(0);
        assert!(valid_count <= 1, "{text} must not panic");
    }
}
