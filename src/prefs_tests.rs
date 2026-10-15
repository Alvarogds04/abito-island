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
