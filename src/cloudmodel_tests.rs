use super::*;
use crate::localmodel::DEFAULT_DEADLINES;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Credentials { refreshes: AtomicUsize, oauth: bool }
impl CredentialSource for Credentials {
    fn credential(&self, _: &ProfileRef) -> Result<Credential, crate::provider_oauth::OauthError> { Ok(Credential::new("secret-key".into(), self.oauth, Some("account".into()))) }
    fn refresh(&self, _: &ProfileRef, _: &str) -> Result<Credential, crate::provider_oauth::OauthError> { self.refreshes.fetch_add(1, Ordering::SeqCst); Ok(Credential::new("rotated-key".into(), true, Some("account".into()))) }
}
fn server(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let addr = listener.local_addr().unwrap();
    let thread = std::thread::spawn(move || {
        let mut requests = vec![];
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut raw = vec![]; let mut buf = [0; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap(); assert!(n > 0); raw.extend_from_slice(&buf[..n]);
                if let Some(p) = raw.windows(4).position(|b| b == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..p]);
                    let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap_or(0);
                    if raw.len() >= p + 4 + len { break; }
                }
            }
            requests.push(String::from_utf8(raw).unwrap());
            write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    }); (format!("http://{addr}"), thread)
}
fn target(kind: Kind, base: &str) -> CloudTarget {
    CloudTarget { kind, profile: ProfileRef { profile_id: "test".into(), revision: 1, lane_id: "conversation".into() }, model: "test-model".into(), base_url: base.into(), max_output: 100 }
}
fn openai() -> String { "data: {\"choices\":[{\"delta\":{\"content\":\"hola\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n".into() }
#[test]
fn all_three_protocols_stream_done() {
    for (kind, body, path) in [
        (Kind::OpenAiChat, openai(), "/chat/completions"),
        (Kind::AnthropicMessages, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hola\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n".into(), "/messages"),
        (Kind::CodexResponses, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hola\"}\n\ndata: {\"type\":\"response.completed\"}\n\n".into(), "/responses"),
    ] {
        let (url, thread) = server(vec![(200, body)]); let t = target(kind, &url);
        let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: true }; let mut items = vec![];
        let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |i| items.push(i.clone()));
        assert_eq!(result, Ended::Finished(Finish::Stop));
        assert!(items.contains(&StreamItem::Content("hola".into()))); assert!(items.contains(&StreamItem::Done));
        let request = thread.join().unwrap().remove(0);
        assert!(request.lines().next().unwrap().contains(path));
        if kind == Kind::AnthropicMessages { assert!(request.contains(CLAUDE_OAUTH_SYSTEM)); assert!(request.contains("oauth-2025-04-20")); }
        if kind == Kind::CodexResponses { assert!(request.contains("chatgpt-account-id: account")); }
    }
}
#[test]
fn refresh_once_and_second_401_is_safe() {
    for second in [200, 401] {
        let (url, thread) = server(vec![(401, "sensitive vendor body".into()), (second, openai())]);
        let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: true };
        let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
        assert_eq!(creds.refreshes.load(Ordering::SeqCst), 1);
        if second == 200 { assert_eq!(result, Ended::Finished(Finish::Stop)); } else { assert!(matches!(&result, Ended::Failed(e) if e.safe_message.contains("Vuelve a iniciar sesión"))); }
        assert!(!format!("{result:?}").contains("secret-key")); assert!(!format!("{result:?}").contains("sensitive"));
        let requests = thread.join().unwrap(); assert!(requests[1].contains("Bearer rotated-key"));
    }
}
#[test]
fn in_flight_cancel_and_idle_deadline_close_connection() {
    for do_cancel in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = vec![]; let mut b = [0; 4096];
            loop {
                let n = stream.read(&mut b).unwrap(); assert!(n > 0); request.extend_from_slice(&b[..n]);
                if let Some(p) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..p]);
                    let len: usize = head.lines().find_map(|s| s.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().unwrap())).unwrap();
                    if request.len() >= p + 4 + len { break; }
                }
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            if do_cancel { write!(stream, "data: {{\"choices\":[{{\"delta\":{{\"content\":\"first\"}}}}]}}\n\n").unwrap(); }
            match stream.read(&mut b) { Ok(0) | Err(_) => {}, Ok(_) => panic!("unexpected retry") }
        });
        let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false }; let cancel = Cancel::new();
        let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], Deadlines { connect_ms: 1000, idle_ms: 100, total_ms: 2000 }, &cancel, &mut |i| { if matches!(i, StreamItem::Content(_)) { cancel.cancel(); } });
        if do_cancel { assert_eq!(result, Ended::Cancelled); } else { assert!(matches!(result, Ended::Failed(_))); }
        thread.join().unwrap();
    }
}
#[test]
fn decoder_fragmentation_caps_and_output_bound() {
    let text = "data: {\"choices\":[{\"delta\":{\"content\":\"¡sí!\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    let mut decoder = Decoder::default(); let mut items = vec![];
    for b in text.as_bytes() { items.extend(decoder.push(&[*b], Kind::OpenAiChat).unwrap()); }
    assert_eq!(items, vec![StreamItem::Content("¡sí!".into()), StreamItem::Done]);
    assert!(Decoder::default().push(&vec![b'x'; SSE_MAX_LINE + 1], Kind::OpenAiChat).is_err());
    let mut decoder = Decoder::default();
    for _ in 0..SSE_MAX_LINE / 8 { if decoder.push(b"data: x\n", Kind::OpenAiChat).is_err() { break; } }
    assert!(decoder.push(&vec![b'x'; SSE_MAX_LINE], Kind::OpenAiChat).is_err());
    let (url, thread) = server(vec![(200, openai())]); let mut t = target(Kind::OpenAiChat, &url); t.max_output = 1;
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false }; let mut output = String::new();
    let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |i| { if let StreamItem::Content(s) = i { output.push_str(s); } });
    assert_eq!(output, "hola"); assert_eq!(result, Ended::Finished(Finish::Stop)); thread.join().unwrap();
    let (url, thread) = server(vec![(200, openai().replace("hola", "longer"))]); t.base_url = url;
    let result = stream_chat_test(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert_eq!(result, Ended::Finished(Finish::Length)); thread.join().unwrap();
    let t = target(Kind::OpenAiChat, "http://127.0.0.1:1");
    assert!(matches!(stream_chat(&t, &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {}), Ended::Failed(_)));
    assert!(!format!("{:?}", target(Kind::OpenAiChat, "https://example.com/?Authorization=secret-key")).contains("secret-key"));
}
#[test]
fn credential_resolution_observes_cancellation_budget() {
    struct Waiting;
    impl CredentialSource for Waiting {
        fn credential(&self, _: &ProfileRef) -> Result<Credential, OauthError> { panic!("controlled seam required") }
        fn refresh(&self, _: &ProfileRef, _: &str) -> Result<Credential, OauthError> { unreachable!() }
        fn credential_controlled(&self, _: &ProfileRef, cancel: &Cancel, deadline: std::time::Instant) -> Result<Credential, OauthError> {
            while !cancel.is_cancelled() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(1)); }
            Err(OauthError::Transport)
        }
    }
    let cancel = Cancel::new();
    std::thread::scope(|s| {
        s.spawn(|| { std::thread::sleep(Duration::from_millis(20)); cancel.cancel(); });
        let result = stream_chat_test(&target(Kind::OpenAiChat, "http://127.0.0.1:1"), &Waiting, &[], DEFAULT_DEADLINES, &cancel, &mut |_| {});
        assert_eq!(result, Ended::Cancelled);
    });
}
#[test]
fn keychain_oauth_adapter_refreshes_outside_streaming_runtime() {
    use crate::provider_oauth::{TokenHttp, TokenReply};
    use crate::secrets::{SecretStore, StoreError};
    struct Memory(std::sync::Mutex<Option<String>>);
    impl SecretStore for Memory {
        fn read(&self, _: &str) -> Result<Option<String>, StoreError> { Ok(self.0.lock().unwrap().clone()) }
        fn write(&self, _: &str, v: &str) -> Result<(), StoreError> { *self.0.lock().unwrap() = Some(v.into()); Ok(()) }
        fn delete(&self, _: &str) -> Result<(), StoreError> { *self.0.lock().unwrap() = None; Ok(()) }
    }
    struct Tokens;
    impl TokenHttp for Tokens {
        fn post(&self, _: &str, _: &[(String,String)]) -> Result<TokenReply, OauthError> {
            assert!(tokio::runtime::Handle::try_current().is_err(), "sync OAuth must not nest runtimes");
            Ok(TokenReply { status: 200, body: br#"{"access_token":"rotated-key","refresh_token":"rotated-refresh","expires_in":3600,"token_type":"Bearer"}"#.to_vec() })
        }
    }
    let store = Memory(std::sync::Mutex::new(Some(r#"{"refresh_token":"refresh-secret","access_token":"secret-key","expires_at":3600,"account_id":null}"#.into())));
    let clock = || 100; let oauth = OAuth::new(&store, &Tokens, &clock);
    let resolve = |_: &ProfileRef| Ok(CredentialRef::Oauth(Provider::Chatgpt));
    let source = KeychainCredentials { store: &store, oauth: &oauth, resolve: &resolve, clock: &clock };
    let (url, thread) = server(vec![(401, String::new()), (200, openai())]);
    let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &source, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert_eq!(result, Ended::Finished(Finish::Stop));
    assert!(thread.join().unwrap()[1].contains("Bearer rotated-key"));
    assert!(store.read("chatgpt-oauth").unwrap().unwrap().contains("rotated-refresh"));
}
#[test]
fn malformed_and_cancel_are_safe() {
    let creds = Credentials { refreshes: AtomicUsize::new(0), oauth: false };
    let (url, thread) = server(vec![(200, "data: bad-secret\n\n".into())]);
    let result = stream_chat_test(&target(Kind::OpenAiChat, &url), &creds, &[], DEFAULT_DEADLINES, &Cancel::new(), &mut |_| {});
    assert!(matches!(result, Ended::Failed(_))); assert!(!format!("{result:?}").contains("bad-secret")); thread.join().unwrap();
    let cancel = Cancel::new(); cancel.cancel();
    assert_eq!(stream_chat_test(&target(Kind::OpenAiChat, "http://127.0.0.1:1"), &creds, &[], DEFAULT_DEADLINES, &cancel, &mut |_| {}), Ended::Cancelled);
    assert!(!format!("{:?}", creds.credential(&target(Kind::OpenAiChat, "").profile).unwrap()).contains("secret-key"));
}
