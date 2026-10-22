use super::*;

const HOME: &str = "/home/alvaro";
const USER: &str = "alvaro";
fn r(t: &str) -> String { redact(t, HOME, USER) }

#[test]
fn redacts_known_secret_prefixes() {
    for secret in ["sk-ant-api03-AbCdEfGhIjKlMnOpQrSt", "sk-proj1234567890abcdef", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0abcdefghij", "xoxb-1234-5678-abcdefg", "AKIAIOSFODNN7EXAMPLE", "AIzaSyA-abcdefghijklmnopqrstuv",
        "ya29.a0AfH6SMBxxxxxxxxxxxx", "hf_abcdefghijklmnopqrstu", "re_AbCdEfGh12345678", "npm_abcdefghijklmnopqrstuvwx",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123"] {
        let out = r(&format!("failed with key {secret} while loading"));
        assert!(!out.contains(secret), "leaked {secret}: {out}");
        assert!(out.contains("<secret>"), "{out}");
        assert!(out.starts_with("failed with key ") && out.ends_with(" while loading"), "{out}");
    }
}

#[test]
fn redacts_bearer_and_key_value_secrets_but_keeps_the_key_name() {
    let out = r("Authorization: Bearer abc.def-ghi");
    assert!(!out.contains("abc.def-ghi") && out.contains("Authorization"), "{out}");
    let out = r(r#"{"api_key":"hunter2hunter2","model":"x"}"#);
    assert!(!out.contains("hunter2") && out.contains("api_key") && out.contains(r#""model":"x""#), "{out}");
    let out = r("password=swordfish token: abcd1234 secret = \"zzz\" other=fine");
    assert!(!out.contains("swordfish") && !out.contains("abcd1234") && !out.contains("zzz"), "{out}");
    assert!(out.contains("other=fine"), "{out}");
}

#[test]
fn high_entropy_strings_are_redacted_but_plain_words_paths_and_short_hashes_stay() {
    let blob = "Zk3Jf9QxL2mV8pTrWb6YcNd4HsGa7UeX1oIq5KvB";
    let out = r(&format!("odd {blob} value"));
    assert!(!out.contains(blob) && out.contains("<secret>"), "{out}");
    let keep = "panicked at src/voicehost.rs:120:9 fingerprint=3fa9c01b7d2e internationalization-configuration-management";
    assert_eq!(r(keep), keep);
}

#[test]
fn redacts_oauth_codes_and_url_credentials() {
    let out = r("callback http://127.0.0.1:8080/cb?code=4%2F0AbCdEf&state=xyz123&scope=mail more");
    assert!(!out.contains("4%2F0AbCdEf") && !out.contains("xyz123"), "{out}");
    assert!(out.contains("scope=mail") && out.contains("<ip>:8080/cb"), "{out}");
    let out = r("fetch https://user:pw0rd@example.test/x?access_token=aaa&id_token=bbb ok");
    assert!(!out.contains("pw0rd") && !out.contains("aaa") && !out.contains("bbb"), "{out}");
}

#[test]
fn home_path_becomes_tilde_and_other_users_homes_too() {
    assert_eq!(r("open /home/alvaro/Apps/x/y.rs failed"), "open ~/Apps/x/y.rs failed");
    assert_eq!(r("open /home/maria/f and /Users/Bob/g and C:\\Users\\Eve\\h"), "open ~/f and ~/g and ~\\h");
    assert_eq!(r("home=/home/alvaro"), "home=~");
}

#[test]
fn user_name_is_replaced_as_a_whole_word_case_insensitively() {
    let out = r("user Alvaro logged in as alvaro; alvarogds stays? no: ALVARO");
    assert!(!out.to_lowercase().contains("alvaro;") && !out.contains("Alvaro") && !out.contains("ALVARO"), "{out}");
    assert!(out.contains("<user>"), "{out}");
    assert_eq!(r("nombre alvarado"), "nombre alvarado");
    assert_eq!(redact("nothing here", HOME, ""), "nothing here"); // an empty user name must not match everywhere
}

#[test]
fn emails_are_redacted() {
    let out = r("sent to alice.b+tag@mail.example.com and Bob@Corp.io today");
    assert_eq!(out, "sent to <email> and <email> today");
}

#[test]
fn conversation_content_never_reaches_the_report_log() {
    let lines = vec![
        "INFO daemon started".to_owned(),
        "chat: user said: my diagnosis is private".to_owned(),
        "DEBUG transcript=hola abito escribí a mi madre".to_owned(),
        "WARN prompt: dime algo".to_owned(),
        "ERROR conversation 42 failed to load".to_owned(),
        "ERROR voice model load failed".to_owned(),
    ];
    let kept = safe_log_lines(&lines, HOME, USER, 50);
    assert_eq!(kept, vec!["INFO daemon started", "ERROR voice model load failed"]);
}

#[test]
fn log_tail_is_capped_to_the_last_n_lines_and_long_lines_are_cut() {
    let lines: Vec<String> = (0..80).map(|i| format!("line {i}")).collect();
    let kept = safe_log_lines(&lines, HOME, USER, 50);
    assert_eq!(kept.len(), 50);
    assert_eq!(kept[0], "line 30");
    assert_eq!(kept[49], "line 79");
    let long = vec!["x ".repeat(400)];
    assert!(safe_log_lines(&long, HOME, USER, 50)[0].chars().count() <= 301);
}

#[test]
fn fingerprint_is_stable_and_ignores_volatile_parts() {
    let a = fingerprint("island", "voice-load", "failed to load /home/alvaro/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234");
    let b = fingerprint("island", "voice-load", "failed to load /home/maria/m/x.onnx after 87 ms (pid 9) at 0x55aa00ff");
    assert_eq!(a, b);
    assert_eq!(a.len(), 12);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, fingerprint("daemon", "voice-load", "failed to load /home/alvaro/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234"));
    assert_ne!(a, fingerprint("island", "agent-down", "failed to load /home/alvaro/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234"));
    assert_ne!(a, fingerprint("island", "voice-load", "a different error entirely"));
}

fn record() -> FailureRecord {
    FailureRecord { at_secs: 1_700_000_000, process: "island".into(), step: "voice-load".into(),
        message: "load failed for /home/alvaro/models/x.onnx key=sk-ant-api03-AbCdEfGhIjKlMnOpQrSt".into(),
        version: "0.2.0".into(), os: "Ubuntu 24.04".into(), session: "wayland".into() }
}

#[test]
fn report_has_every_s2_field_and_is_redacted() {
    let rep = build_report(&record(), &["INFO ok".to_owned(), "ERROR in /home/alvaro/x".to_owned()], HOME, USER);
    for needle in ["0.2.0", "Ubuntu 24.04", "wayland", "island", "voice-load", "load failed for ~/models/x.onnx", &fingerprint_of(&record()), "INFO ok", "ERROR in ~/x"] {
        assert!(rep.body.contains(needle), "missing {needle}: {}", rep.body);
    }
    assert!(!rep.body.contains("sk-ant") && !rep.body.contains("alvaro"), "{}", rep.body);
    assert!(rep.title.contains("island") && rep.title.contains(&fingerprint_of(&record())), "{}", rep.title);
    assert!(!rep.title.contains("alvaro") && rep.title.len() <= 120);
}

#[test]
fn issue_url_is_encoded_targets_the_public_repo_and_carries_labels() {
    let IssueUrl::Url(u) = issue_url("[crash] a b", "line1\nüñ & = ? #x") else { panic!("short text must fit") };
    assert!(u.starts_with("https://github.com/Alvarogds04/abito-island/issues/new?title="), "{u}");
    assert!(u.contains("title=%5Bcrash%5D%20a%20b") && u.contains("&body=line1%0A%C3%BC%C3%B1%20%26%20%3D%20%3F%20%23x"), "{u}");
    assert!(u.ends_with("&labels=bug%2Cauto-report"), "{u}");
    assert!(u.is_ascii());
}

#[test]
fn too_long_text_is_not_sent_in_the_url() {
    assert_eq!(issue_url("t", &"a".repeat(MAX_URL_LEN)), IssueUrl::TooLong);
    let IssueUrl::Url(u) = issue_url("t", &"a".repeat(1000)) else { panic!() };
    assert!(u.len() <= MAX_URL_LEN);
    // multibyte text expands 6x when encoded: the cap is on the ENCODED length
    assert_eq!(issue_url("t", &"ü".repeat(MAX_URL_LEN / 4)), IssueUrl::TooLong);
}

#[test]
fn search_url_points_at_the_repo_issue_search_with_the_fingerprint() {
    assert_eq!(search_url("3fa9c01b7d2e"), "https://github.com/Alvarogds04/abito-island/issues?q=is%3Aissue%203fa9c01b7d2e");
    assert!(!search_url("a b&c").contains("a b&c"));
}

#[test]
fn records_round_trip_through_the_local_store_and_dedupe_by_fingerprint() {
    let dir = std::env::temp_dir().join(format!("abito-failure-{}-{}", std::process::id(), line!()));
    let _ = std::fs::remove_dir_all(&dir);
    assert!(load_all(&dir).is_empty());
    let rec = record();
    store(&dir, &rec).unwrap();
    store(&dir, &rec).unwrap();
    let all = load_all(&dir);
    assert_eq!(all.len(), 1, "the same fingerprint is one failure, repeated");
    assert_eq!(all[0].record, rec);
    assert_eq!(all[0].count, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_corrupt_store_is_ignored_not_fatal() {
    let dir = std::env::temp_dir().join(format!("abito-failure-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(STORE_FILE), "not json\n{\"x\":1}\n").unwrap();
    assert!(load_all(&dir).is_empty());
    store(&dir, &record()).unwrap();
    assert_eq!(load_all(&dir).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn multibyte_text_next_to_path_like_prefixes_never_panics() {
    assert_eq!(r("describí acá qué pasó: C:\\Users\\Eve\\ñ y ñandú"), "describí acá qué pasó: ~\\ñ y ñandú");
    assert_eq!(r("é:ü ü"), "é:ü ü");
}

#[test]
fn note_writes_a_redacted_local_record_without_network() {
    let dir = std::env::temp_dir().join(format!("abito-failure-{}-{}", std::process::id(), line!()));
    let _ = std::fs::remove_dir_all(&dir);
    note(&dir, "daemon", "daemon-down", "exited: password=hunter22 at /home/zz/x");
    let all = load_all(&dir);
    assert_eq!(all.len(), 1);
    assert_eq!((all[0].record.process.as_str(), all[0].record.step.as_str()), ("daemon", "daemon-down"));
    assert!(!all[0].record.message.contains("hunter22"), "{}", all[0].record.message);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn each_listed_prefix_is_redacted_on_its_own() {
    for secret in ["ghp_0123456789abcdefghijABCDEFGHIJ", "gho_0123456789abcdefghijABCDEFGHIJ", "github_pat_11AAAAAAA0abcdefghijklmnop_QRSTUV",
        "glpat-abcdefghij0123456789", "xoxb-111111111111-222222222222-abcdefABCDEF", "AIzaSyD-abcdefghijklmnopqrstuvwxyz01234"] {
        for wrap in ["{}", "token {} end", "\"{}\"", "({})", "x={}", "{}."] {
            let text = wrap.replace("{}", secret);
            let out = r(&text);
            assert!(!out.contains(&secret[..12]), "leaked {secret} in {text:?}: {out}");
        }
    }
}

#[test]
fn ipv4_addresses_are_redacted_including_private_and_tailnet_ranges() {
    for ip in ["8.8.8.8", "192.168.1.20", "10.0.0.5", "172.16.4.9", "100.64.0.1", "100.97.187.82", "127.0.0.1"] {
        assert_eq!(r(&format!("connect to {ip}:1725 failed")), "connect to <ip>:1725 failed", "{ip}");
        assert_eq!(r(&format!("http://{ip}/x")), "http://<ip>/x", "{ip}");
    }
    assert_eq!(r("Abito 0.2.0 build 1.2.3 at 12:34:56"), "Abito 0.2.0 build 1.2.3 at 12:34:56", "versions and times stay");
}

#[test]
fn ipv6_addresses_are_redacted_but_rust_paths_and_times_stay() {
    for ip in ["::1", "fe80::1ff:fe23:4567:890a", "2001:db8::8a2e:370:7334", "2001:0db8:0000:0000:0000:ff00:0042:8329", "fd7a:115c:a1e0::1", "::ffff:192.168.1.1"] {
        assert_eq!(r(&format!("bind {ip} refused")), "bind <ip> refused", "{ip}");
        assert_eq!(r(&format!("http://[{ip}]:80/")), "http://[<ip>]:80/", "{ip}");
    }
    let keep = "panicked in std::io::Error and core::fmt::Display at 12:34:56 deadbeef::cafe_fn";
    assert_eq!(r(keep), keep);
}

#[test]
fn tailnet_and_local_hostnames_are_redacted() {
    for host in ["alvaro-pc.tail1234.ts.net", "ubuntu.local", "nas.lan", "db.internal", "router.home.arpa", "Mi-PC.TS.NET"] {
        assert_eq!(r(&format!("resolve {host} failed")), "resolve <host> failed", "{host}");
        assert_eq!(r(&format!("https://{host}:8443/api")), "https://<host>:8443/api", "{host}");
    }
    assert_eq!(r("see github.com and example.org"), "see github.com and example.org");
}

#[test]
fn the_machines_own_hostname_is_redacted() {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_owned();
    if host.len() < 3 || host == "localhost" { return; } // nothing distinctive to hide on this machine
    let out = r(&format!("host {host} unreachable, also {}", host.to_uppercase()));
    assert!(!out.to_lowercase().contains(&host.to_lowercase()), "{out}");
    assert!(out.contains("<host>"), "{out}");
}

fn env() -> Env { Env { version: "0.2.0".into(), os: "Ubuntu".into(), session: "x11".into(), home: HOME.into(), user: USER.into() } }

#[test]
fn panic_info_becomes_a_record_with_location_and_kind_and_no_network() {
    let rec = record_from_panic("island", "index out of bounds: the len is 3 but the index is 5", Some(("src/voicehost.rs", 12)), &env(), 5);
    assert_eq!((rec.step.as_str(), rec.at_secs, rec.version.as_str()), ("panic", 5, "0.2.0"));
    assert!(rec.message.contains("index out of bounds") && rec.message.contains("src/voicehost.rs:12"), "{}", rec.message);
}

#[test]
fn a_panic_message_with_chat_text_never_reaches_the_record() {
    for payload in [
        "called `Result::unwrap()` on an `Err` value: ParseError(\"dime algo sobre mi madre y mi diagnóstico\")",
        "called `Option::expect()` failed: hola abito escribí a mi madre",
        "conversation 42: el usuario dijo que quiere ayuda con su divorcio",
        "something odd: hola abito, mandale un mail a mi jefe",
        "Error: 'dime la clave de mi banco'",
    ] {
        let rec = record_from_panic("island", payload, Some(("src/chat.rs", 7)), &env(), 1);
        for leaked in ["madre", "diagnóstico", "divorcio", "jefe", "banco", "dijo", "escribí"] {
            assert!(!rec.message.contains(leaked), "leaked {leaked} from {payload:?}: {}", rec.message);
        }
        assert!(rec.message.contains("src/chat.rs:7"), "the location is kept: {}", rec.message);
    }
}

#[test]
fn free_form_messages_are_withheld_when_they_look_like_conversation_and_capped_otherwise() {
    let rec = record_failure("island", "x", "chat: user said: my diagnosis is private", &env(), 1);
    assert!(!rec.message.contains("diagnosis"), "{}", rec.message);
    let long = record_failure("island", "x", &"e".repeat(5000), &env(), 1);
    assert!(long.message.chars().count() <= MESSAGE_MAX + 1, "{}", long.message.len());
    let multi = record_failure("island", "x", "first line\nsecond line with stuff", &env(), 1);
    assert_eq!(multi.message, "first line");
}

#[test]
fn process_and_step_are_closed_tokens() {
    let rec = record_failure("is land/../", "step with spaces <b>", "m", &env(), 1);
    assert_eq!((rec.process.as_str(), rec.step.as_str()), ("unknown", "unknown"));
    let ok = record_failure("daemon", "agent-no-answer", "m", &env(), 1);
    assert_eq!((ok.process.as_str(), ok.step.as_str()), ("daemon", "agent-no-answer"));
}

#[test]
fn the_report_caps_a_stored_message_even_if_an_older_record_has_chat_in_it() {
    let mut rec = record();
    rec.message = "conversation 9: user said hello about my mother".into();
    let rep = build_report(&rec, &[], HOME, USER);
    assert!(!rep.body.contains("mother"), "{}", rep.body);
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("abito-failure-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn every_field_and_the_whole_record_are_bounded() {
    let big = "ñ".repeat(10_000);
    let e = Env { version: big.clone(), os: big.clone(), session: big.clone(), home: HOME.into(), user: USER.into() };
    let rec = record_failure(&big, &big, &big, &e, 1);
    let line = serde_json::to_string(&rec).unwrap();
    assert!(line.len() <= RECORD_MAX_BYTES, "{} bytes", line.len());
    for f in [&rec.version, &rec.os, &rec.session] { assert!(f.chars().count() <= FIELD_MAX + 1); }
    // a record that is still too big (built by hand) is refused, never written
    let dir = tmpdir("big");
    let mut hand = rec.clone();
    hand.message = "x".repeat(RECORD_MAX_BYTES * 2);
    assert!(store(&dir, &hand).is_err());
    assert!(load_all(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn store_tightens_the_modes_of_an_existing_dir_and_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmpdir("modes");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(dir.join(STORE_FILE), "").unwrap();
    std::fs::set_permissions(dir.join(STORE_FILE), std::fs::Permissions::from_mode(0o644)).unwrap();
    store(&dir, &record()).unwrap();
    let mode = |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(dir.clone()), 0o700);
    assert_eq!(mode(dir.join(STORE_FILE)), 0o600);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_permission_error_is_reported_not_swallowed() {
    // a path whose parent is a FILE cannot become a directory; and a store we cannot chmod must not be written silently
    let dir = tmpdir("perm");
    std::fs::create_dir_all(&dir).unwrap();
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    assert!(store(&blocker.join("sub"), &record()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_short_home_never_eats_the_start_of_a_longer_path() {
    assert_eq!(redact("/home/alvaro/x /home/a/y", "/home/a", ""), "~/x ~/y");
    assert_eq!(redact("home=/home/a", "/home/a", ""), "home=~");
    assert_eq!(redact("/home/ab/z", "/home/a", ""), "~/z", "another user's home is still hidden by the generic rule");
}
