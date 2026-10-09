//! QP.2: owner-only fake producers, real private UDS, no app or model.
use abito_island::{protocol, question, transport::{self, Transport, TransportOptions}};
use serde_json::{json, Value};
use std::io::{Read, Write, ErrorKind};
use std::os::unix::{fs::DirBuilderExt, net::UnixStream};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak, Barrier};

const ID: &str = "12345678-1234-4abc-8abc-123456789abc";
const OTHER: &str = "12345678-1234-4abc-9abc-123456789abd";
static NEXT: AtomicU64 = AtomicU64::new(1);
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }
struct Fixture { transport: Arc<Transport>, root: PathBuf, project: String, changes: Arc<AtomicU64> }
impl Fixture {
    fn new() -> Self { Self::with_callback_close(false) }
    fn with_callback_close(close_from_callback: bool) -> Self {
        // Three-byte leaves keep sockaddr_un within 107 bytes in this long
        // worktree. Exclusive creation also isolates simultaneous test runs;
        // existing fixtures are never reused or removed.
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
        let callback_holder = holder.clone(); let callback_changes = changes.clone();
        let options = TransportOptions::new(&root, &project).idle_ms(90_000).on_question_change(move || {
            callback_changes.fetch_add(1, Ordering::SeqCst);
            let weak = callback_holder.lock().unwrap().clone();
            // Reentrant read proves the question mutex was dropped before the
            // observer runs. Weak avoids making the receiver own itself.
            if let Some(transport) = weak.and_then(|weak| weak.upgrade()) {
                if close_from_callback { transport.close().unwrap(); }
                let _ = transport.question_snapshot();
            }
        });
        let transport = Arc::new(transport::create_transport(options).unwrap());
        *holder.lock().unwrap() = Some(Arc::downgrade(&transport));
        Self { transport, root, project, changes }
    }
    fn base(&self, kind: &str, session: &str) -> Value {
        json!({"v":1,"type":kind,"project":self.project,"sessionId":session,"at":now()})
    }
    fn qp(&self, kind: &str, session: &str, id: &str) -> Value {
        let mut v = self.base(kind, session); v["questionVersion"] = json!(1);
        if kind != "questions_hello" { v["id"] = json!(id); }
        v
    }
    fn question(&self, session: &str, id: &str) -> Value {
        let mut v = self.qp("question", session, id);
        v["kind"] = json!("question"); v["text"] = json!("Private question");
        v["options"] = json!([{"value":"opaque-A","label":"First","description":"One"}, {"value":"opaque-B","label":"Second","description":"Two"}]);
        v["allowFreeText"] = json!(true); v["expiresAt"] = json!(now()+30_000); v
    }
    fn connect(&self, session: &str, opt_in: bool) -> UnixStream {
        let mut s = UnixStream::connect(self.transport.endpoint()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        send(&mut s, &self.base("hello", session));
        assert_eq!(line(&mut s), protocol::READY_LINE);
        if opt_in {
            send(&mut s, &self.qp("questions_hello", session, ID));
            assert_eq!(line(&mut s), question::QUESTIONS_READY_LINE);
        }
        s
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
    loop { match s.read(&mut b) { Ok(1) => { out.push(b[0]); if b[0] == b'\n' { return out; } }, Ok(0) => return out, other => panic!("read line: {other:?}") } }
}
fn quiet(s: &mut UnixStream) {
    s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    let mut b = [0]; let e = s.read(&mut b).expect_err("no extra bytes and no EOF");
    assert!(matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut));
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
}
fn closed(s: &mut UnixStream) { assert!(line(s).is_empty(), "must fail closed without reply"); }
fn wait(mut f: impl FnMut() -> bool) {
    let end = Instant::now()+Duration::from_secs(3);
    while !f() { assert!(Instant::now()<end, "state deadline"); std::thread::sleep(Duration::from_millis(10)); }
}

#[test]
fn legacy_ready_has_no_unsolicited_capability() {
    let f = Fixture::new(); let mut s = f.connect("session-1", false); quiet(&mut s);
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
}
#[test]
fn question_opt_in_body_can_be_exact4096() {
    let f = Fixture::new(); let mut s = f.connect("session-1", false);
    let hello = f.qp("questions_hello", "session-1", ID).to_string();
    let body = format!("{hello}{}\n", " ".repeat(4096-hello.len()));
    for chunk in body.as_bytes().chunks(113) { s.write_all(chunk).unwrap(); }
    assert_eq!(line(&mut s), question::QUESTIONS_READY_LINE);
}

#[test]
fn scoped_opt_in_is_exact_and_only_once() {
    let f = Fixture::new(); let mut s = f.connect("session-1", true); quiet(&mut s);
    send(&mut s, &f.qp("questions_hello", "session-1", ID)); closed(&mut s);
}

fn pending(f: &Fixture, id: &str) {
    wait(|| f.transport.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
}
fn reply(s: &mut UnixStream) -> Value { serde_json::from_slice(&line(s)).unwrap() }
#[test]
fn fragmented_exact4096_question_and_original_socket_answer_once() {
    let f = Fixture::new(); let mut a = f.connect("same-session", true);
    let mut b = f.connect("same-session", true);
    let q = f.question("same-session", ID).to_string();
    let body = format!("{q}{}\n", " ".repeat(4096-q.len()));
    for chunk in body.as_bytes().chunks(113) { a.write_all(chunk).unwrap(); }
    pending(&f, ID);
    let view = f.transport.question_snapshot();
    assert_eq!(view.pending.unwrap().options[1].label, "Second");
    assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("opaque-"));
    assert!(f.transport.answer(OTHER, 1).is_err());
    assert!(f.transport.answer(ID, 9).is_err());
    f.transport.answer(ID, 1).unwrap();
    let v = reply(&mut a);
    assert_eq!(v["id"], ID); assert_eq!(v["source"], "human");
    assert_eq!(v["answer"], json!({"type":"option","value":"opaque-B"}));
    quiet(&mut b);
    assert!(f.transport.answer(ID, 0).is_err());
    let view = f.transport.question_snapshot();
    assert!(view.pending.is_none()); assert_eq!(view.deliveries.len(), 1);
    assert_eq!(serde_json::to_value(&view.deliveries[0]).unwrap()["state"], "sent");
}
#[test]
fn busy_is_global_same_connection_same_session_and_other_session() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let mut b = f.connect("session-1", true); let mut c = f.connect("session-2", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    for (s, session) in [(&mut a,"session-1"), (&mut b,"session-1"), (&mut c,"session-2")] {
        let mut q = f.question(session, OTHER); q["text"] = json!("second private content");
        send(s, &q); let v = reply(s);
        assert_eq!(v["reason"], "busy"); assert_eq!(v["source"], "system");
        assert_eq!(v["id"], OTHER); assert_eq!(v["sessionId"], session);
        assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Busy));
        assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("second private content"));
        pending(&f, ID);
    }
}
#[test]
fn missing_opt_in_scope_uuid_extras_and_oversize_fail_closed() {
    let f = Fixture::new();
    let mut old = f.connect("session-1", false);
    send(&mut old, &f.question("session-1", ID)); closed(&mut old);
    for mode in 0..6 {
        let mut s = f.connect("session-1", true); let mut q = f.question("session-1", ID);
        match mode {
            0 => q["sessionId"] = json!("other"),
            1 => q["project"] = json!("f".repeat(64)),
            2 => q["id"] = json!("wrong-uuid"),
            3 => q["source"] = json!("human"),
            4 => q["questionVersion"] = json!(2),
            _ => {},
        }
        if mode == 5 {
            let raw = q.to_string(); s.write_all(format!("{raw}{}\n", " ".repeat(4097-raw.len())).as_bytes()).unwrap();
        } else { send(&mut s, &q); }
        closed(&mut s); assert!(f.transport.question_snapshot().pending.is_none());
    }
    let mut s = f.connect("session-1", false);
    send(&mut s, &f.qp("questions_hello", "other", ID)); closed(&mut s);
}
#[test]
fn legacy_limits_and_schema_remain_after_opt_in() {
    let f = Fixture::new(); let mut s = f.connect("session-1", true);
    send(&mut s, &f.base("heartbeat", "session-1")); quiet(&mut s);
    let raw = f.base("heartbeat", "session-1").to_string();
    s.write_all(format!("{raw}{}\n", " ".repeat(513-raw.len())).as_bytes()).unwrap(); closed(&mut s);
    let mut s = f.connect("session-1", true); let mut v = f.base("settled", "session-1");
    v["id"] = json!("event-1"); v["questionVersion"] = json!(1); send(&mut s, &v); closed(&mut s);
}
#[test]
fn human_decline_ack_correlation_and_new_pending_survives_old_ack() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut ack = f.qp("question_resolved", "session-1", ID); ack["status"] = json!("human_cancelled");
    send(&mut a, &ack); quiet(&mut a); pending(&f, ID); // unsolicited ACK cannot consume pending
    f.transport.decline(ID).unwrap(); let v = reply(&mut a);
    assert_eq!(v["type"], "question_closed"); assert_eq!(v["source"], "human"); assert_eq!(v["reason"], "cancelled");
    assert!(v.get("answer").is_none()); assert!(f.transport.decline(ID).is_err());
    send(&mut b, &ack); quiet(&mut b); assert_eq!(f.transport.question_snapshot().deliveries.len(), 1);
    send(&mut b, &f.question("session-1", OTHER)); pending(&f, OTHER);
    send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER);
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::HumanCancelled));
}
#[test]
fn rejection_only_correct_sent_origin_never_resurrects() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID); f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    let mut rejected = f.qp("question_answer_rejected", "session-1", ID); rejected["reason"] = json!("invalid_answer");
    send(&mut b, &rejected); quiet(&mut b); assert_eq!(f.transport.question_snapshot().deliveries.len(), 1);
    send(&mut b, &f.question("session-1", OTHER)); pending(&f, OTHER);
    send(&mut a, &rejected); wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER);
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Rejected));
    assert!(f.transport.answer(ID, 0).is_err());
}
#[test]
fn cancel_and_disconnect_revoke_only_origin_pending_or_delivery() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("cancelled");
    send(&mut b, &cancel); quiet(&mut b); pending(&f, ID);
    send(&mut a, &cancel); wait(|| f.transport.question_snapshot().pending.is_none()); quiet(&mut a);
    send(&mut a, &f.question("session-1", OTHER)); pending(&f, OTHER); drop(b); pending(&f, OTHER);
    drop(a); wait(|| f.transport.question_snapshot().pending.is_none());
    let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID); f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    drop(a); wait(|| f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Disconnected));
}
#[test]
fn free_text_whole4096_and4097_rejected_before_write() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let overhead = json!({"v":1,"type":"answer","questionVersion":1,"project":f.project,"sessionId":"session-1","at":now(),"id":ID,"source":"human","answer":{"type":"text","text":""}}).to_string().len();
    let budget = 4096-overhead; let text = format!("{}{}", "🙂".repeat(budget/4), "a".repeat(budget%4));
    assert!(f.transport.answer_text(ID, format!("{text}a")).is_err()); quiet(&mut a); pending(&f, ID);
    f.transport.answer_text(ID, text.clone()).unwrap(); let bytes = line(&mut a); assert_eq!(bytes.len(), 4097);
    let v: Value = serde_json::from_slice(&bytes).unwrap(); assert_eq!(v["answer"]["text"], text);
    let mut ack = f.qp("question_resolved", "session-1", ID); ack["status"] = json!("answered"); send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Answered));
}
#[test]
fn unanswered_expiry_has_no_default_and_late_click_fails() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let deadline = f.transport.question_snapshot().pending.unwrap().expires_at;
    std::thread::sleep(Duration::from_millis(deadline.saturating_sub(now())+80));
    assert!(f.transport.question_snapshot().pending.is_none());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::Expired));
    assert!(f.transport.answer(ID, 0).is_err()); quiet(&mut a);
    assert!(!serde_json::to_string(&f.transport.question_snapshot()).unwrap().contains("Private question"));
}
#[test]
fn question_callback_can_close_receiver_without_joining_itself() {
    let f = Fixture::with_callback_close(true);
    let mut a = f.connect("session-1", true);
    closed(&mut a);
    wait(|| !f.transport.endpoint().exists());
    wait(|| f.transport.question_snapshot().ready_connections == 0);
}

#[test]
fn simultaneous_human_replies_are_consumed_once_and_callbacks_are_reentrant() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    wait(|| f.transport.question_snapshot().ready_connections == 1);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let barrier = Arc::new(Barrier::new(3));
    let first = f.transport.clone(); let second = f.transport.clone();
    let b1 = barrier.clone(); let b2 = barrier.clone();
    let t1 = std::thread::spawn(move || { b1.wait(); first.answer(ID, 0) });
    let t2 = std::thread::spawn(move || { b2.wait(); second.decline(ID) });
    barrier.wait(); let results = [t1.join().unwrap(), t2.join().unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    reply(&mut a); quiet(&mut a); assert!(f.transport.question_snapshot().pending.is_none());
    drop(a); wait(|| f.transport.question_snapshot().ready_connections == 0);
    assert!(f.changes.load(Ordering::SeqCst) >= 4); // ready, pending, sent, disconnect
}
#[test]
fn bounded_delivery_receipts_are_not_evicted_or_reused_before_ack() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let ids: Vec<_> = (0..9).map(|i| format!("12345678-1234-4abc-8abc-{i:012x}")).collect();
    for id in &ids[..8] {
        send(&mut a, &f.question("session-1", id)); pending(&f, id); f.transport.answer(id, 0).unwrap(); reply(&mut a);
    }
    assert_eq!(f.transport.question_snapshot().deliveries.len(), 8);
    for id in [&ids[8], &ids[0]] {
        send(&mut a, &f.question("session-1", id)); assert_eq!(reply(&mut a)["reason"], "busy");
    }
    assert!(f.transport.question_snapshot().pending.is_none());
    let mut ack = f.qp("question_resolved", "session-1", &ids[0]); ack["status"] = json!("human_cancelled");
    send(&mut a, &ack); quiet(&mut a); assert_eq!(f.transport.question_snapshot().deliveries.len(), 8);
    ack["status"] = json!("answered"); send(&mut a, &ack);
    wait(|| f.transport.question_snapshot().deliveries.len() == 7);
    send(&mut a, &f.question("session-1", &ids[8])); pending(&f, &ids[8]);
}
#[test]
fn scoped_cancel_removes_sent_but_never_other_pending_and_early_expiry_is_ignored() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true); let mut b = f.connect("session-2", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("expired");
    send(&mut a, &cancel); quiet(&mut a); pending(&f, ID);
    f.transport.answer(ID, 0).unwrap(); reply(&mut a);
    send(&mut b, &f.question("session-2", OTHER)); pending(&f, OTHER);
    cancel["reason"] = json!("cancelled"); send(&mut a, &cancel);
    wait(|| f.transport.question_snapshot().deliveries.is_empty()); pending(&f, OTHER); quiet(&mut a);
}
#[test]
fn question_frames_share_original_120_per_minute_quota() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    let mut cancel = f.qp("question_cancel", "session-1", ID); cancel["reason"] = json!("cancelled");
    // hello + questions_hello + 118 frames = 120. Each bounded write is
    // below both batch limits; the next complete frame is the rate failure.
    for _ in 0..118 { send(&mut a, &cancel); }
    quiet(&mut a); send(&mut a, &cancel); closed(&mut a);
}

#[test]
fn lost_ack_is_never_answerable_and_removed_at_original_deadline() {
    let f = Fixture::new(); let mut a = f.connect("session-1", true);
    send(&mut a, &f.question("session-1", ID)); pending(&f, ID);
    let deadline = f.transport.question_snapshot().pending.unwrap().expires_at;
    f.transport.answer(ID, 0).unwrap(); reply(&mut a); assert!(f.transport.answer(ID, 0).is_err());
    std::thread::sleep(Duration::from_millis(deadline.saturating_sub(now())+80));
    assert!(f.transport.question_snapshot().deliveries.is_empty());
    assert_eq!(f.transport.question_snapshot().notice, Some(transport::QuestionOutcome::AckLost)); quiet(&mut a);
}
