//! QP.2 slice 1: negotiation plumbing only, NOT a question round trip.
//! A validated opt-in deliberately closes without questions_ready until the
//! lifecycle exists. Fake owner-only UDS peers; no app, Pi or provider process.
use abito_island::{protocol, transport::{self, Transport, TransportOptions}};
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::{fs::DirBuilderExt, net::UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const UNSUPPORTED: &str = "capability_not_implemented_yet";
static NEXT: AtomicU64 = AtomicU64::new(1);
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
struct Fixture {
    transport: Arc<Transport>, root: PathBuf, project: String,
    changes: Arc<AtomicU64>, observed: Arc<Mutex<Vec<Value>>>,
}
impl Fixture {
    fn new() -> Self { Self::with_callback_close(false) }
    fn with_callback_close(close_from_callback: bool) -> Self {
        // Short leaves respect sockaddr_un in this long worktree. Exclusive
        // creation isolates simultaneous runs without touching other fixtures.
        let seed = now().wrapping_add(u64::from(std::process::id()));
        let root = (0..256).find_map(|_| {
            let n = seed.wrapping_add(NEXT.fetch_add(1, Ordering::Relaxed)) % 256;
            let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("q{n:02x}"));
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => Some(path),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => None,
                Err(e) => panic!("private fixture: {e}"),
            }
        }).expect("free private fixture leaf");
        let project = protocol::project_id("question-receiver-test");
        let holder: Arc<Mutex<Option<Weak<Transport>>>> = Arc::new(Mutex::new(None));
        let changes = Arc::new(AtomicU64::new(0));
        let observed = Arc::new(Mutex::new(Vec::new()));
        let callback_holder = holder.clone();
        let callback_changes = changes.clone();
        let callback_observed = observed.clone();
        let options = TransportOptions::new(&root, &project).idle_ms(90_000).on_question_change(move || {
            let weak = callback_holder.lock().unwrap().clone();
            // Reentrant snapshot proves the transport released its lock.
            if let Some(transport) = weak.and_then(|weak| weak.upgrade()) {
                let snapshot = serde_json::to_value(transport.question_snapshot()).unwrap();
                callback_observed.lock().unwrap().push(snapshot);
                if close_from_callback { transport.close().unwrap(); }
            }
            callback_changes.fetch_add(1, Ordering::SeqCst);
        });
        let transport = Arc::new(transport::create_transport(options).unwrap());
        *holder.lock().unwrap() = Some(Arc::downgrade(&transport));
        Self { transport, root, project, changes, observed }
    }
    fn base(&self, kind: &str, session: &str) -> Value {
        json!({"v":1,"type":kind,"project":self.project,"sessionId":session,"at":now()})
    }
    fn opt_in(&self, session: &str) -> Value {
        let mut v = self.base("questions_hello", session);
        v["questionVersion"] = json!(1); v
    }
    fn connect(&self) -> UnixStream {
        let mut s = UnixStream::connect(self.transport.endpoint()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        send(&mut s, &self.base("hello", "session-1"));
        assert_eq!(line(&mut s), protocol::READY_LINE);
        s
    }
    fn snapshot(&self) -> Value { serde_json::to_value(self.transport.question_snapshot()).unwrap() }
    fn expect_unsupported(&self) {
        wait(|| self.changes.load(Ordering::SeqCst) >= 1);
        assert_eq!(self.snapshot()["notice"], UNSUPPORTED);
        assert_eq!(self.observed.lock().unwrap().last().unwrap()["notice"], UNSUPPORTED);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.transport.close().unwrap();
        let result = std::fs::remove_dir(&self.root);
        if !std::thread::panicking() { result.unwrap(); }
    }
}
fn send(s: &mut UnixStream, v: &Value) { s.write_all(format!("{v}\n").as_bytes()).unwrap(); }
fn line(s: &mut UnixStream) -> Vec<u8> {
    let mut out = Vec::new(); let mut b = [0];
    loop {
        match s.read(&mut b) {
            Ok(1) => { out.push(b[0]); if b[0] == b'\n' { return out; } }
            Ok(0) => return out,
            other => panic!("read line: {other:?}"),
        }
    }
}
fn quiet(s: &mut UnixStream) {
    s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let mut b = [0]; let e = s.read(&mut b).expect_err("no extra bytes and no EOF");
    assert!(matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut));
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
}
fn closed(s: &mut UnixStream) { assert!(line(s).is_empty(), "must close immediately without capability bytes"); }
fn wait(mut f: impl FnMut() -> bool) {
    let end = Instant::now()+Duration::from_secs(3);
    while !f() { assert!(Instant::now()<end, "state deadline"); std::thread::sleep(Duration::from_millis(10)); }
}

#[test]
fn legacy_ready_has_no_unsolicited_capability() {
    let f = Fixture::new(); let mut s = f.connect(); quiet(&mut s);
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
    assert!(f.snapshot()["notice"].is_null());
    assert_eq!(f.changes.load(Ordering::SeqCst), 0);
}
#[test]
fn validated_opt_in_deliberately_has_no_ready_and_reports_local_reason() {
    let f = Fixture::new(); let mut s = f.connect();
    let start = Instant::now(); send(&mut s, &f.opt_in("session-1")); closed(&mut s);
    assert!(start.elapsed() < Duration::from_secs(2), "not an idle/network timeout");
    f.expect_unsupported();
    // The bounded local reason survives disconnect and an ordinary legacy
    // reconnect, rather than being overwritten by a generic teardown notice.
    let mut legacy = f.connect(); quiet(&mut legacy);
    assert_eq!(f.snapshot()["notice"], UNSUPPORTED);
}
#[test]
fn fragmented_opt_in_exact4096_is_validated_but_not_advertised() {
    let f = Fixture::new(); let mut s = f.connect();
    let hello = f.opt_in("session-1").to_string();
    let body = format!("{hello}{}\n", " ".repeat(4096-hello.len()));
    for chunk in body.as_bytes().chunks(113) { s.write_all(chunk).unwrap(); }
    closed(&mut s); f.expect_unsupported();
}
#[test]
fn opt_in_scope_version_schema_duplicates_utf8_and4097_fail_closed() {
    let f = Fixture::new();
    for mode in 0..8 {
        let mut s = f.connect(); let mut hello = f.opt_in("session-1");
        match mode {
            0 => hello["sessionId"] = json!("other"),
            1 => hello["project"] = json!("f".repeat(64)),
            2 => hello["questionVersion"] = json!(2),
            3 => hello["source"] = json!("human"),
            4 => hello["at"] = json!(now()+30_000),
            _ => {},
        }
        let raw = hello.to_string();
        let bytes = match mode {
            5 => format!("{raw}{}\n", " ".repeat(4097-raw.len())).into_bytes(),
            6 => format!("{}\n", raw.replacen('{', "{\"v\":1,", 1)).into_bytes(),
            7 => vec![0xff, b'\n'],
            _ => format!("{raw}\n").into_bytes(),
        };
        s.write_all(&bytes).unwrap(); closed(&mut s);
        assert!(f.snapshot()["notice"].is_null());
    }
    assert_eq!(f.changes.load(Ordering::SeqCst), 0);
}
#[test]
fn opt_in_before_v1_identity_is_rejected_without_capability_reason() {
    let f = Fixture::new(); let mut s = UnixStream::connect(f.transport.endpoint()).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    send(&mut s, &f.opt_in("session-1")); closed(&mut s);
    assert!(f.snapshot()["notice"].is_null());
}
#[test]
fn unsolicited_question_never_starts_lifecycle_or_retains_text() {
    let f = Fixture::new(); let mut s = f.connect();
    let mut q = f.base("question", "session-1");
    q["questionVersion"] = json!(1); q["id"] = json!("12345678-1234-4abc-8abc-123456789abc");
    q["kind"] = json!("question"); q["text"] = json!("synthetic body must not be retained");
    q["options"] = json!([]); q["allowFreeText"] = json!(true); q["expiresAt"] = json!(now()+30_000);
    send(&mut s, &q); closed(&mut s);
    assert!(f.snapshot()["notice"].is_null());
    assert!(!f.snapshot().to_string().contains("synthetic body"));
    assert_eq!(f.changes.load(Ordering::SeqCst), 0);
}
#[test]
fn legacy_limits_and_schema_remain_after_identification() {
    let f = Fixture::new(); let mut s = f.connect();
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
    let raw = f.base("heartbeat", "session-1").to_string();
    s.write_all(format!("{raw}{}\n", " ".repeat(512-raw.len())).as_bytes()).unwrap(); quiet(&mut s);
    s.write_all(format!("{raw}{}\n", " ".repeat(513-raw.len())).as_bytes()).unwrap(); closed(&mut s);
    let mut s = f.connect(); let mut v = f.base("settled", "session-1");
    v["id"] = json!("event-1"); v["questionVersion"] = json!(1); send(&mut s, &v); closed(&mut s);
    assert!(f.snapshot()["notice"].is_null());
}
#[test]
fn opt_in_also_obeys_original120_frame_quota_before_decode() {
    let f = Fixture::new(); let mut s = f.connect();
    // hello + 119 heartbeats = 120. Allow each small batch to be consumed so
    // the tighter 4096-byte legacy batch gate is not the reason for closure.
    for i in 0..119 {
        send(&mut s, &f.base("heartbeat", "session-1"));
        if i % 10 == 9 { quiet(&mut s); }
    }
    quiet(&mut s); send(&mut s, &f.opt_in("session-1")); closed(&mut s);
    assert!(f.snapshot()["notice"].is_null(), "quota rejects before capability validation");
    assert_eq!(f.changes.load(Ordering::SeqCst), 0);
}
#[test]
fn capability_reason_callback_can_close_without_self_join() {
    let f = Fixture::with_callback_close(true); let mut s = f.connect();
    send(&mut s, &f.opt_in("session-1")); closed(&mut s);
    f.expect_unsupported(); wait(|| !f.transport.endpoint().exists());
}
