use super::*;
use crate::speech::ModelState;
fn prefs() -> Value { serde_json::to_value(Prefs::default()).unwrap() }
fn models(state: ModelState) -> ModelsStatus { ModelsStatus { parakeet: state, download_mb: 670 } }
#[test]
fn dictation_closed_actions_and_key_mapping() {
    for (name, expected) in [("status", Command::Status), ("download_model", Command::Download),
        ("remove_model", Command::Remove), ("hands_free", Command::Key(flow::KeyEvent::HandsFree)),
        ("finish", Command::Key(flow::KeyEvent::Finish)), ("cancel", Command::Key(flow::KeyEvent::Cancel))] {
        assert_eq!(parse_command(&json!({"action":name}), &[]), Some(expected));
        assert!(parse_command(&json!({"action":name,"extra":0}), &[]).is_none());
    }
    for bad in [json!(null), json!([]), json!({}), json!({"action":1}), json!({"action":"other"})] {
        assert!(parse_command(&bad, &[]).is_none());
    }
}
#[test]
fn dictation_prefs_are_exact_and_device_names_injected() {
    let parse = |p| parse_command(&json!({"action":"set_prefs","prefs":p}), &["Mic".into()]);
    assert_eq!(parse(prefs()), Some(Command::SetPrefs(Prefs::default())));
    for days in [0,7,30,365,-1] { let mut p=prefs(); p["keepDays"]=json!(days); assert!(parse(p).is_some()); }
    for (field, values) in [("key", vec![json!("right_ctrl"),json!("right_alt"),json!("right_shift"),json!("left_ctrl_super")]),
        ("edge", vec![json!("bottom"),json!("left"),json!("right")]),
        ("defaultStyle", vec![json!("verbatim"),json!("natural"),json!("polished")]),
        ("mic", vec![json!(""),json!("Mic")])] {
        for value in values { let mut p=prefs(); p[field]=value; assert!(parse(p).is_some()); }
    }
    for (field, value) in [("key",json!("bad")),("edge",json!("top")),("defaultStyle",json!("bad")),
        ("keepDays",json!(90)),("keepDays",json!(1)),("keepDays",json!(30.5)),("cleanup",json!(true)),
        ("mic",json!("missing")),("mic",json!("x".repeat(201))),("enabled",json!(1)),("extra",json!(0)),("cleanup",json!("false")),
        ("mic",json!(null)),("edge",json!(null)),("key",json!(null)),("defaultStyle",json!(null)),
        ("keepDays",json!("30")),("keepDays",json!(-2))] {
        let mut p=prefs(); p[field]=value; assert!(parse(p).is_none(), "{field}");
    }
    for bad in [json!(null), json!([]), json!("prefs")] { assert!(parse(bad).is_none()); }
    let mut unknown = prefs(); unknown.as_object_mut().unwrap().remove("key"); unknown["other"] = json!("right_ctrl");
    assert!(parse(unknown).is_none());
    for field in prefs().as_object().unwrap().keys() {
        let mut p=prefs(); p.as_object_mut().unwrap().remove(field); assert!(parse(p).is_none());
    }
    assert!(parse_command(&json!({"action":"set_prefs","prefs":prefs(),"extra":0}), &[]).is_none());
}
#[test]
fn dictation_status_shape_and_key_states() {
    let mut p=Prefs::default();
    let v=status_json(&p, models(ModelState::Missing), KeyStatus::Denied, vec![]);
    assert_eq!(v, json!({"prefs":{"enabled":false,"key":"right_ctrl","edge":"bottom","mic":"",
        "keepDays":30,"cleanup":false,"defaultStyle":"natural","summaryEngine":"off","openAtLaunch":false,
        "voice":false,"voiceOutput":"off","voiceGender":"female"},"models":{"parakeet":{"state":"missing"},
        "downloadMb":670},"keys":"ok","hasClaudeKey":false,"mics":[],"platform":"linux","autostarted":false}));
    p.enabled=true;
    for (key, name) in [(KeyStatus::Active,"ok"),(KeyStatus::Pending,"pending"),(KeyStatus::Denied,"denied"),(KeyStatus::Unsupported,"unsupported")] {
        let v=status_json(&p, models(ModelState::Ready), key, vec![InputDevice{name:"Mic".into(),default:true}]);
        assert_eq!(v["keys"], name); assert_eq!(v["mics"],json!([{"name":"Mic","default":true}]));
    }
}
#[test]
fn dictation_events_pin_names_and_payloads() {
    use flow::{Phase::*, Note::*, Update};
    for (phase, name) in [(Idle,"idle"),(Listening,"listening"),(Locked,"locked"),(Thinking,"thinking"),(Copied,"copied"),(Failed,"failed")] {
        assert_eq!(event(Update::Phase(phase)), ("dictation:phase",json!({"phase":name})));
    }
    for (note, name) in [(NeedModel,"needModel"),(NoMicrophone,"noMicrophone"),(ClipboardRefused,"clipboardRefused")] {
        assert_eq!(event(Update::Note(note)), ("dictation:note",json!({"note":name})));
    }
    assert_eq!(event(Update::Bands([0.5;9])), ("dictation:bands",json!({"bands":vec![0.5;9]})));
    for (state, expected) in [(ModelState::Missing,json!({"state":"missing"})),
        (ModelState::Ready,json!({"state":"ready"})),
        (ModelState::Downloading{fraction:0.5},json!({"state":"downloading","fraction":0.5})),
        (ModelState::Failed{error:"failed".into()},json!({"state":"failed","error":"failed"}))] {
        assert_eq!(models_event(models(state)), ("dictation:models",json!({"parakeet":expected,"downloadMb":670})));
    }
}
#[test]
fn dictation_lifecycle_starts_and_drops_only_on_transitions() {
    use std::{rc::Rc, cell::Cell};
    struct Fake(Rc<Cell<usize>>);
    impl Drop for Fake { fn drop(&mut self) { self.0.set(self.0.get()+1); } }
    let starts=Cell::new(0); let stops=Rc::new(Cell::new(0));
    let start=|| { starts.set(starts.get()+1); Fake(stops.clone()) };
    let mut e=Engine { running:None };
    for enabled in [false,true,true,false,false,true] { e.set_enabled(enabled, start); }
    assert_eq!(starts.get(),2); assert_eq!(stops.get(),1);
    drop(e); assert_eq!(stops.get(),2);
}
#[test]
fn dictation_plan_never_asks_the_host_to_start_or_stop_under_its_lock() {
    // The planner only DECIDES while the host lock is held; starting (portal, thread, model preload)
    // and stopping (a join that waits for a transcription) happen outside it, on what the plan returns.
    let mut e: Engine<u8> = Engine { running: None };
    assert!(matches!(e.plan(false, false), Plan::Keep), "off and nothing running: nothing to do");
    assert!(matches!(e.plan(true, false), Plan::Start), "enabled and idle: the caller starts it outside the lock");
    assert!(matches!(e.plan(true, true), Plan::Keep), "a start already in flight is never doubled");
    assert!(e.install(7, true).is_none(), "installed while still wanted");
    assert!(matches!(e.plan(true, false), Plan::Keep), "already running: same-state write does not restart");
    assert!(matches!(e.plan(false, false), Plan::Stop(7)), "disabling hands the running value out, to be dropped outside the lock");
    assert!(e.running.is_none());
    assert_eq!(e.install(9, false), Some(9), "a start that is no longer wanted comes back to be dropped, not installed");
    assert!(e.running.is_none());
    assert!(matches!(e.plan(false, true), Plan::Keep), "disabling during a start: nothing running to stop yet");
}
