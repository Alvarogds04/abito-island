use super::*;
use crate::secrets::{SecretStore, StoreError};
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

#[derive(Default)]
struct Fake {
    map: RefCell<BTreeMap<String, String>>,
    down: bool,
}
impl Fake {
    fn with(pairs: &[(&str, &str)]) -> Self {
        let f = Fake::default();
        for (k, v) in pairs {
            f.map.borrow_mut().insert((*k).into(), (*v).into());
        }
        f
    }
}
impl SecretStore for Fake {
    fn read(&self, key: &str) -> Result<Option<String>, StoreError> {
        if self.down {
            return Err(StoreError::Unavailable);
        }
        Ok(self.map.borrow().get(key).cloned())
    }
    fn write(&self, _: &str, _: &str) -> Result<(), StoreError> {
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<(), StoreError> {
        Ok(())
    }
}

/// One-shot local HTTP server: answers `status`, hands the raw request to the test.
fn fake_resend(status: u16) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/emails", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = s.read(&mut chunk).unwrap();
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(at) = text.find("\r\n\r\n") {
                let len = text[..at]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                    .unwrap_or(0);
                if buf.len() >= at + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
        tx.send(String::from_utf8_lossy(&buf).to_string()).unwrap();
    });
    (url, rx)
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

fn good() -> Value {
    json!({"action":"send","to":"ana@example.com","subject":"Hola","body":"Texto"})
}

#[test]
fn the_send_payload_is_closed() {
    let d = parse_mail(&good()).unwrap();
    assert_eq!((d.to.as_str(), d.subject.as_str(), d.body.as_str()), ("ana@example.com", "Hola", "Texto"));
    let mut extra = good();
    extra["cc"] = json!("x@y.com");
    for bad in [
        json!(null),
        json!("send"),
        json!({"action":"inbox"}),
        extra,
        json!({"action":"send","to":"ana","subject":"s","body":"b"}),
        json!({"action":"send","to":"a@b.com, c@d.com","subject":"s","body":"b"}),
        json!({"action":"send","to":"a@b.com\n","subject":"s","body":"b"}),
        json!({"action":"send","to":"a@b.com","subject":"a\nb","body":"b"}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"a\u{0}b"}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":5}),
        json!({"action":"send","to":"a@b.com","subject":"x".repeat(121),"body":"b"}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"x".repeat(4001)}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"b","attachment":{"name":"f","data":"***"}}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"b","attachment":{"name":"f","data":""}}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"b","attachment":{"name":"f","data":"QQ==","path":"/etc/passwd"}}),
        json!({"action":"send","to":"a@b.com","subject":"s","body":"b","attachment":"/etc/passwd"}),
    ] {
        assert!(parse_mail(&bad).is_err(), "{bad}");
    }
}

#[test]
fn like_notchbuddy_an_empty_subject_and_body_still_send() {
    let d = parse_mail(&json!({"action":"send","to":" ana@example.com ","subject":"","body":""})).unwrap();
    assert_eq!(d.to, "ana@example.com");
    assert_eq!(d.subject, "File");
    let w = parse_mail(&json!({"action":"send","to":"a@b.com","subject":"","body":"x","attachment":{"name":"../fo/o.txt","data":"QQ=="}})).unwrap();
    assert_eq!(w.subject, "o.txt", "the file name stands in for the subject");
    let body = resend_body("Abito <me@x.com>", &d);
    assert_eq!(body["text"], " ", "Resend refuses an empty text");
}

#[test]
fn resend_body_has_the_notchbuddy_shape() {
    let d = parse_mail(&json!({"action":"send","to":"a@b.com","subject":"S","body":"B","attachment":{"name":"r.txt","data":"QQ=="}})).unwrap();
    assert_eq!(
        resend_body("me@x.com", &d),
        json!({"from":"me@x.com","to":["a@b.com"],"subject":"S","text":"B","attachments":[{"filename":"r.txt","content":"QQ=="}]})
    );
}

#[test]
fn resend_send_posts_with_the_bearer_key_and_never_follows_redirects() {
    let (url, rx) = fake_resend(200);
    let d = parse_mail(&good()).unwrap();
    run(send_resend(&url, "re_secret", "me@x.com", &d)).unwrap();
    let raw = rx.recv().unwrap();
    assert!(raw.starts_with("POST /emails HTTP/1.1"), "{raw}");
    assert!(raw.to_ascii_lowercase().contains("authorization: bearer re_secret"));
    assert!(raw.to_ascii_lowercase().contains("content-type: application/json"));
    assert!(raw.contains("\"to\":[\"ana@example.com\"]"));
    let (url, _rx) = fake_resend(302);
    assert_eq!(run(send_resend(&url, "k", "me@x.com", &d)), Err(MailError::Rejected));
}

#[test]
fn only_200_and_201_count_as_sent() {
    let d = parse_mail(&good()).unwrap();
    for (status, ok) in [(200, true), (201, true), (202, false), (400, false), (401, false), (422, false), (500, false)] {
        let (url, _rx) = fake_resend(status);
        assert_eq!(run(send_resend(&url, "k", "f@x.com", &d)).is_ok(), ok, "{status}");
    }
    assert_eq!(run(send_resend("http://127.0.0.1:1/emails", "k", "f@x.com", &d)), Err(MailError::Network));
}

#[test]
fn the_answer_depends_on_what_is_configured_and_never_carries_the_key() {
    let d = parse_mail(&good()).unwrap();
    let none = Fake::default();
    assert_eq!(run(send_answer(&none, "http://127.0.0.1:1/x", &d)), json!({"ok":false,"reason":"not_configured"}));
    let key_only = Fake::with(&[("resend-api-key", "re_secret")]);
    assert_eq!(run(send_answer(&key_only, "http://127.0.0.1:1/x", &d)), json!({"ok":false,"reason":"no_sender"}));
    let down = Fake { down: true, ..Fake::default() };
    assert_eq!(run(send_answer(&down, "http://127.0.0.1:1/x", &d)), json!({"ok":false,"reason":"keychain_unavailable"}));
    let full = Fake::with(&[("resend-api-key", "re_secret"), ("resend-from", "Abito <me@x.com>")]);
    let (url, rx) = fake_resend(200);
    assert_eq!(run(send_answer(&full, &url, &d)), json!({"ok":true}));
    assert!(rx.recv().unwrap().contains("\"from\":\"Abito <me@x.com>\""));
    let (url, _rx) = fake_resend(401);
    let a = run(send_answer(&full, &url, &d));
    assert_eq!(a, json!({"ok":false,"reason":"rejected"}));
    assert!(!a.to_string().contains("re_secret"));
}

// ---- SMTP (lettre) against a local fake server --------------------------------------------

/// Minimal SMTP server: EHLO (advertises AUTH PLAIN), AUTH, MAIL, RCPT, DATA, QUIT.
/// `reject_auth` answers 535. Hands back the whole transcript client→server.
fn fake_smtp(reject_auth: bool) -> (u16, mpsc::Receiver<String>) {
    use std::io::{BufRead, BufReader};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (s, _) = listener.accept().unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        let mut log = String::new();
        write!(w, "220 fake ESMTP\r\n").unwrap();
        let mut in_data = false;
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            log.push_str(&line);
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    write!(w, "250 queued\r\n").unwrap();
                }
                continue;
            }
            let up = line.to_ascii_uppercase();
            if up.starts_with("EHLO") || up.starts_with("HELO") {
                write!(w, "250-fake\r\n250 AUTH PLAIN LOGIN\r\n").unwrap();
            } else if up.starts_with("AUTH PLAIN") {
                if reject_auth { write!(w, "535 bad credentials\r\n").unwrap(); } else { write!(w, "235 ok\r\n").unwrap(); }
            } else if up.starts_with("AUTH LOGIN") {
                write!(w, "334 VXNlcm5hbWU6\r\n").unwrap();
            } else if up.starts_with("DATA") {
                in_data = true;
                write!(w, "354 go\r\n").unwrap();
            } else if up.starts_with("QUIT") {
                write!(w, "221 bye\r\n").unwrap();
                break;
            } else {
                write!(w, "250 ok\r\n").unwrap();
            }
        }
        tx.send(log).unwrap();
    });
    (port, rx)
}

fn smtp_cfg(port: u16) -> SmtpConfig {
    SmtpConfig { host: "127.0.0.1".into(), port, user: "me@x.com".into(), password: "pw-secret".into(), from: "Abito <me@x.com>".into() }
}

#[test]
fn smtp_delivers_the_message_with_auth() {
    let (port, rx) = fake_smtp(false);
    let d = parse_mail(&json!({"action":"send","to":"ana@example.com","subject":"Hólá","body":"Texto","attachment":{"name":"r.txt","data":"QQ=="}})).unwrap();
    run(send_smtp(&smtp_cfg(port), Security::Plain, &d)).unwrap();
    let log = rx.recv().unwrap();
    assert!(log.contains("AUTH PLAIN"), "{log}");
    assert!(log.contains("MAIL FROM:<me@x.com>"), "{log}");
    assert!(log.contains("RCPT TO:<ana@example.com>"), "{log}");
    assert!(log.contains("Subject: =?utf-8?"), "non-ASCII subjects are encoded: {log}");
    assert!(log.contains("multipart/mixed") && log.contains("filename=\"r.txt\""), "{log}");
}

#[test]
fn smtp_without_attachment_is_a_plain_message_and_an_empty_body_is_a_space() {
    let (port, rx) = fake_smtp(false);
    let d = parse_mail(&json!({"action":"send","to":"a@b.com","subject":"S","body":""})).unwrap();
    run(send_smtp(&smtp_cfg(port), Security::Plain, &d)).unwrap();
    let log = rx.recv().unwrap();
    assert!(!log.contains("multipart"), "{log}");
}

#[test]
fn smtp_bad_credentials_are_rejected_and_a_dead_server_is_a_network_error() {
    let (port, _rx) = fake_smtp(true);
    let d = parse_mail(&good()).unwrap();
    assert_eq!(run(send_smtp(&smtp_cfg(port), Security::Plain, &d)), Err(MailError::Rejected));
    assert_eq!(run(send_smtp(&smtp_cfg(1), Security::Plain, &d)), Err(MailError::Network));
}

#[test]
fn production_security_is_always_tls() {
    let mut c = smtp_cfg(465);
    assert_eq!(c.security(), Security::Implicit);
    for p in [587, 25, 2525] {
        c.port = p;
        assert_eq!(c.security(), Security::StartTls, "{p}");
    }
}

#[test]
fn smtp_host_parsing_is_strict() {
    assert_eq!(parse_host("smtp.Example.com"), Some(("smtp.example.com".into(), 587)));
    assert_eq!(parse_host(" smtp.example.com:465 "), Some(("smtp.example.com".into(), 465)));
    for bad in ["", ":25", "a b", "a..b", "-a.com", "a.com:0", "a.com:99999", "a.com:x", "http://a.com", "a.com/x", "a_b.com", "a.com:25:26"] {
        assert_eq!(parse_host(bad), None, "{bad:?}");
    }
}

#[test]
fn routing_prefers_resend_then_smtp_then_explains_what_is_missing() {
    let smtp = [("smtp-host", "mail.x.com:465"), ("smtp-user", "me@x.com"), ("smtp-password", "pw")];
    assert!(matches!(route(&Fake::with(&[("resend-api-key", "k"), ("resend-from", "f@x.com")])), Ok(Route::Resend { .. })));
    let both: Vec<_> = smtp.iter().copied().chain([("resend-api-key", "k"), ("resend-from", "f@x.com")]).collect();
    assert!(matches!(route(&Fake::with(&both)), Ok(Route::Resend { .. })), "Resend wins like NotchBuddy");
    match route(&Fake::with(&smtp)) {
        Ok(Route::Smtp(c)) => assert_eq!((c.host.as_str(), c.port, c.from.as_str()), ("mail.x.com", 465, "me@x.com"), "from defaults to the user"),
        other => panic!("{other:?}"),
    }
    let with_key: Vec<_> = smtp.iter().copied().chain([("resend-api-key", "k")]).collect();
    assert!(matches!(route(&Fake::with(&with_key)), Ok(Route::Smtp(_))), "an incomplete Resend yields to a complete SMTP account");
    assert_eq!(route(&Fake::with(&[("resend-api-key", "k")])).unwrap_err(), json!({"ok":false,"reason":"no_sender"}));
    assert_eq!(route(&Fake::with(&[("smtp-host", "mail.x.com")])).unwrap_err(), json!({"ok":false,"reason":"not_configured"}));
    let bad_host = [("smtp-host", "http://x"), ("smtp-user", "me@x.com"), ("smtp-password", "pw")];
    assert_eq!(route(&Fake::with(&bad_host)).unwrap_err(), json!({"ok":false,"reason":"smtp_config"}));
    let bad_from = [("smtp-host", "mail.x.com"), ("smtp-user", "login-name"), ("smtp-password", "pw")];
    assert_eq!(route(&Fake::with(&bad_from)).unwrap_err(), json!({"ok":false,"reason":"smtp_config"}), "a login that is not an address needs smtp-from");
    let ok_from: Vec<_> = bad_from.iter().copied().chain([("smtp-from", "Abito <me@x.com>")]).collect();
    assert!(route(&Fake::with(&ok_from)).is_ok());
}

#[test]
fn the_smtp_password_never_shows_in_debug_or_answers() {
    assert!(!format!("{:?}", smtp_cfg(25)).contains("pw-secret"));
    let (port, _rx) = fake_smtp(true);
    let d = parse_mail(&good()).unwrap();
    let a = outcome(run(send_smtp(&smtp_cfg(port), Security::Plain, &d)));
    assert!(!a.to_string().contains("pw-secret"));
}
