use super::*;
use serde_json::json;

// ---- session.json (the host handoff) -----------------------------------------------------
fn session(over: serde_json::Value) -> String {
    let mut v = json!({"protocol":"island-agent/1","endpoint":"/run/x/p-AbCdEf/s","token":"t0k3n","pid":4242,"procStart":"98765","startedAt":1700000000000u64});
    for (k, val) in over.as_object().unwrap() { v[k] = val.clone(); }
    v.to_string()
}

#[test]
fn session_file_is_parsed_strictly_and_fails_closed() {
    let ok = Session::parse(&session(json!({}))).unwrap();
    assert_eq!(ok.endpoint, "/run/x/p-AbCdEf/s");
    assert_eq!(ok.pid, 4242);
    for bad in [session(json!({"protocol":"island-agent/2"})), session(json!({"protocol":null})), session(json!({"token":""})),
                session(json!({"token":7})), session(json!({"endpoint":""})), session(json!({"endpoint":"relative/s"})),
                session(json!({"endpoint":"/run/x/../../etc/s"})), session(json!({"endpoint":"/run/x/p-AbCdEf/other"})),
                session(json!({"endpoint":"/run/x/p-AbCdEf/s\u{0}"})), session(json!({"pid":0})), session(json!({"pid":-3})),
                session(json!({"pid":"x"})), "".into(), "not json".into(), "[]".into(), "{}".into(), "null".into()] {
        assert!(Session::parse(&bad).is_err(), "must refuse {bad}");
    }
    // an oversized file is never parsed
    assert!(Session::parse(&"x".repeat(MAX_SESSION_BYTES + 1)).is_err());
}

#[test]
fn the_token_never_appears_in_debug_output_or_serialized_state() {
    let s = Session::parse(&session(json!({"token":"super-secret-token"}))).unwrap();
    assert!(!format!("{s:?}").contains("super-secret-token"), "Debug must redact the token");
    let st = ClientState::disconnected(Reason::NoDaemon);
    assert!(!serde_json::to_string(&st).unwrap().contains("token"));
}

// ---- handshake / frame codec ----------------------------------------------------------------
#[test]
fn hello_frame_is_exact() {
    let line = hello_line("t0k3n");
    assert_eq!(line, "{\"type\":\"hello\",\"protocol\":\"island-agent/1\",\"token\":\"t0k3n\"}\n");
}

#[test]
fn frames_are_split_on_lf_only_and_bounded() {
    let mut buf = FrameBuffer::default();
    assert_eq!(buf.push(b"{\"type\":\"a\"}\n{\"ty").unwrap().len(), 1);
    let rest = buf.push(b"pe\":\"b\"}\n").unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0]["type"], "b");
    // a CR is data, not a separator
    let mut b2 = FrameBuffer::default();
    assert!(b2.push(b"{\"type\":\"a\"}\r\n").unwrap().len() == 1);
    // a line without LF over the cap is a protocol error (never grows unbounded)
    let mut b3 = FrameBuffer::default();
    assert_eq!(b3.push(&vec![b'x'; MAX_FRAME_BYTES + 1]), Err(FrameError::TooLarge));
    // garbage JSON is an error, not a skip
    let mut b4 = FrameBuffer::default();
    assert_eq!(b4.push(b"not json\n"), Err(FrameError::Malformed));
    let mut b5 = FrameBuffer::default();
    assert_eq!(b5.push(b"[1,2]\n"), Err(FrameError::Malformed), "a frame is an object");
}

// ---- closed command set (what the UI may ask) -----------------------------------------------------
#[test]
fn ui_commands_are_a_closed_exact_set() {
    let ok = |v: serde_json::Value| parse_ui_command(&v).map(|c| c.line().trim_end().to_string());
    // `view` and `refresh` are local: view reads the state, refresh asks the daemon for the lists
    assert!(matches!(parse_ui_command(&json!({"action":"view"})), Ok(UiCommand::View)));
    assert!(matches!(parse_ui_command(&json!({"action":"refresh"})), Ok(UiCommand::Refresh)));
    assert_eq!(UiCommand::Refresh.refresh_lines().len(), 5);
    assert!(UiCommand::Refresh.refresh_lines().iter().any(|l| l == "{\"type\":\"providers_list\"}\n"));
    for (payload, wire) in [
        (json!({"action":"account_create","provider":"anthropic","label":"Personal"}), r#"{"type":"account_create","provider":"anthropic","label":"Personal"}"#),
        (json!({"action":"auth_start","accountId":"personal","method":"api_key"}), r#"{"type":"auth_start","accountId":"personal","method":"api_key"}"#),
        (json!({"action":"auth_cancel","flowId":"f-1"}), r#"{"type":"auth_cancel","flowId":"f-1"}"#),
        (json!({"action":"account_logout","accountId":"personal"}), r#"{"type":"account_logout","accountId":"personal"}"#),
        (json!({"action":"account_remove","accountId":"personal"}), r#"{"type":"account_remove","accountId":"personal"}"#),
        (json!({"action":"profile_select","id":"main"}), r#"{"type":"profile_select","id":"main"}"#),
        (json!({"action":"profile_deactivate"}), r#"{"type":"profile_deactivate"}"#),
        (json!({"action":"connectors_list"}), r#"{"type":"connectors_list"}"#),
        (json!({"action":"settings_get"}), r#"{"type":"settings_get"}"#),
    ] {
        assert_eq!(ok(payload.clone()).unwrap(), wire, "{payload}");
    }
}

#[test]
fn ui_commands_reject_everything_else() {
    for bad in [json!(null), json!([]), json!("x"), json!({}), json!({"action":1}), json!({"action":"send"}), json!({"action":"abort"}),
                json!({"action":"new_conversation"}), json!({"action":"ui_response"}), json!({"action":"settings_set","hotkey":"Ctrl+A"}),
                json!({"action":"local_account_create","label":"x","baseUrl":"http://127.0.0.1:1/v1","modelIds":["m"]}),
                json!({"action":"hello","token":"x"}), json!({"action":"auth_start","accountId":"a"}),
                json!({"action":"auth_start","accountId":"a","method":"password"}), json!({"action":"auth_start","accountId":"A B","method":"oauth"}),
                json!({"action":"account_create","provider":"p","label":""}), json!({"action":"account_create","provider":"p","label":"x\ny"}),
                json!({"action":"account_create","provider":"p","label":"x".repeat(81)}), json!({"action":"profile_select","id":"../x"}),
                json!({"action":"refresh","extra":1}), json!({"action":"connectors_list","also":true})] {
        assert!(parse_ui_command(&bad).is_err(), "must refuse {bad}");
    }
}

// ---- the secret path: ONLY auth_reply, never echoed ------------------------------------------------------
#[test]
fn auth_reply_carries_the_secret_to_the_daemon_and_nowhere_else() {
    let cmd = parse_ui_command(&json!({"action":"auth_reply","flowId":"f-1","promptId":"p-1","value":"sk-live-SECRET"})).unwrap();
    let line = cmd.line();
    assert_eq!(line, "{\"type\":\"auth_reply\",\"flowId\":\"f-1\",\"promptId\":\"p-1\",\"value\":\"sk-live-SECRET\"}\n");
    // the command's Debug (what a log line would print) never shows the value
    assert!(!format!("{cmd:?}").contains("sk-live-SECRET"), "Debug of a command must redact the secret value");
    // bounds: empty / control chars / oversized are refused before anything is sent
    for v in ["", &"x".repeat(MAX_REPLY_CHARS + 1)] {
        assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p","value":v})).is_err());
    }
    assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p","value":"a\u{0}b"})).is_err());
    assert!(parse_ui_command(&json!({"action":"auth_reply","flowId":"f","promptId":"p"})).is_err());
}

// ---- what the UI sees: allowlisted view, no token/endpoint/secret ---------------------------------------------
#[test]
fn view_state_never_carries_session_material() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"providers","providers":[{"id":"anthropic","name":"Anthropic","methods":["api_key","oauth"],"configured":false}]})).unwrap();
    st.apply(&json!({"type":"accounts","accounts":[{"accountId":"personal","label":"Personal","provider":"anthropic","authMethod":"api_key","configured":true}]})).unwrap();
    let text = serde_json::to_string(&st).unwrap();
    for forbidden in ["token", "endpoint", "baseUrl", "apiKey", "secret\":\"", "Authorization"] {
        assert!(!text.contains(forbidden), "view state leaked {forbidden}: {text}");
    }
    assert!(text.contains("Personal") && text.contains("anthropic"));
}

#[test]
fn auth_prompt_exposes_whether_it_is_secret_but_never_a_value() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"auth_started","flowId":"f-1"})).unwrap();
    st.apply(&json!({"type":"auth_prompt","flowId":"f-1","promptId":"p-1","accountId":"personal","kind":"input","message":"Pegá tu API key","secret":true})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["auth"]["prompt"]["secret"], json!(true));
    assert_eq!(v["auth"]["prompt"]["message"], json!("Pegá tu API key"));
    assert!(v["auth"]["prompt"].get("value").is_none());
    // done clears the prompt and keeps only the outcome
    st.apply(&json!({"type":"auth_done","flowId":"f-1","accountId":"personal","ok":true})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert!(v["auth"]["prompt"].is_null());
    assert_eq!(v["auth"]["last"]["ok"], json!(true));
}

#[test]
fn oauth_events_are_shown_but_only_as_links_to_open_not_as_executable_content() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"auth_started","flowId":"f-2"})).unwrap();
    st.apply(&json!({"type":"auth_event","flowId":"f-2","kind":"url","url":"https://example.com/device","userCode":"ABCD-1234","message":"Abrí el enlace"})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["auth"]["event"]["userCode"], json!("ABCD-1234"));
    assert_eq!(v["auth"]["event"]["url"], json!("https://example.com/device"));
    // a non-https url is dropped from the view (the UI would render it as a link)
    st.apply(&json!({"type":"auth_event","flowId":"f-2","kind":"url","url":"javascript:alert(1)"})).unwrap();
    assert!(serde_json::to_value(&st).unwrap()["auth"]["event"]["url"].is_null());
}

#[test]
fn unknown_or_malformed_server_frames_are_ignored_not_fatal_and_never_forwarded_raw() {
    let mut st = ClientState::connected();
    let before = serde_json::to_value(&st).unwrap();
    for junk in [json!({"type":"message_delta","text":"hi"}), json!({"type":"nope"}), json!({}), json!({"type":7}), json!({"type":"toast","level":"info","message":"x"})] {
        let _ = st.apply(&junk);
    }
    assert_eq!(serde_json::to_value(&st).unwrap(), before, "chat/other frames never alter the settings view");
}

#[test]
fn connectors_are_shown_as_unavailable_honestly_when_the_daemon_says_so() {
    let mut st = ClientState::connected();
    st.apply(&json!({"type":"error","code":"unavailable"})).unwrap_or(());
    st.note_connectors_error("unavailable");
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["connectors"]["state"], json!("unavailable"));
    st.apply(&json!({"type":"connectors","schema":"abito-connectors/view/1","catalog":[],"connectors":[
        {"id":"gmail","label":"Gmail","catalog_key":"gmail","mode":"read_only","enabled":true,"status":{"state":"connected"},"revision":3,"configured":true}]})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["connectors"]["state"], json!("ready"));
    assert_eq!(v["connectors"]["items"][0]["label"], json!("Gmail"));
    assert_eq!(v["connectors"]["items"][0]["status"], json!("connected"));
}

#[test]
fn disconnected_state_explains_why_with_a_closed_vocabulary() {
    for (r, text) in [(Reason::NoDaemon, "no_daemon"), (Reason::BadSession, "bad_session"), (Reason::Refused, "refused"), (Reason::Lost, "lost")] {
        assert_eq!(serde_json::to_value(ClientState::disconnected(r)).unwrap()["connection"], json!(text));
    }
    assert_eq!(serde_json::to_value(ClientState::connected()).unwrap()["connection"], json!("connected"));
}

// ---- the engine's refusals reach the panel (so it never announces success it did not get) ----
#[test]
fn a_command_error_from_the_engine_is_kept_as_a_closed_code_with_a_counter() {
    let mut st = ClientState::connected();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"], json!({"code": null, "n": 0}));
    for (n, code) in ["failed", "busy", "bad_request", "rate_limited"].iter().enumerate() {
        st.apply(&json!({"type":"error","code":code})).unwrap();
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["last_error"], json!({"code": code, "n": n + 1}), "{code}");
    }
    // the same code twice is still a NEW event: the counter is how the page tells them apart
    st.apply(&json!({"type":"error","code":"failed"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"]["n"], json!(5));
}

#[test]
fn an_unknown_or_hostile_error_code_never_reaches_the_page_as_text() {
    let mut st = ClientState::connected();
    for bad in [json!("<script>"), json!("a".repeat(500)), json!(7), json!(null), json!({"x":1})] {
        st.apply(&json!({"type":"error","code":bad})).unwrap();
    }
    st.apply(&json!({"type":"error"})).unwrap();
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["last_error"]["code"], json!("failed"), "anything outside the daemon's closed set reads as plain `failed`");
    let text = v["last_error"].to_string();
    assert!(!text.contains("script") && text.len() < 60, "{text}");
}

#[test]
fn a_connection_that_drops_starts_a_clean_error_slate() {
    let mut st = ClientState::disconnected(Reason::Lost);
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"], json!({"code": null, "n": 0}));
    st.apply(&json!({"type":"error","code":"unavailable"})).unwrap();
    assert_eq!(serde_json::to_value(&st).unwrap()["last_error"]["code"], json!("unavailable"));
}
