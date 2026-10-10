//! Opt-in integration with the external REAL Node producer, not a Pi/UI e2e.
//! Default runs deliberately ignore these tests; --ignored requires the source
//! directory and Node and fails loudly if either is unavailable (no fallback).
mod common;
use abito_island::{protocol, transport::{self, Transport, TransportOptions}};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Fixture {
    receiver: Transport, leaf: common::fixture_leaf::Leaf, runtime: PathBuf, cwd: PathBuf, project: String,
    connections: Arc<AtomicU32>, notices: Arc<AtomicU32>,
}
impl Fixture {
    fn new() -> Self { Self::with_native_clock(None) }
    fn with_native_clock(clock: Option<Arc<AtomicU64>>) -> Self {
        let source = PathBuf::from(std::env::var("ABITO_PI_PRODUCER_DIR")
            .expect("opt-in test requires ABITO_PI_PRODUCER_DIR; no fake producer fallback"));
        assert!(source.is_absolute() && source.is_dir(), "explicit producer directory required");
        for name in ["adapter.cjs", "questions.cjs"] { assert!(source.join(name).is_file(), "real producer source required"); }
        // Exclusive, self-cleaning short leaf (N7): removed on drop, reclaimed when abandoned.
        let leaf = common::fixture_leaf::Leaf::alloc(&PathBuf::from(env!("CARGO_TARGET_TMPDIR")), "n");
        let runtime = leaf.path().to_path_buf();
        let cwd = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let project = protocol::project_id(cwd.to_str().unwrap());
        let connections = Arc::new(AtomicU32::new(0)); let notices = Arc::new(AtomicU32::new(0));
        let c = connections.clone(); let n = notices.clone();
        let options = TransportOptions::new(&runtime, &project)
            .on_connections(move |count| { c.store(count, Ordering::SeqCst); })
            .on_notice(move |_| { n.fetch_add(1, Ordering::SeqCst); });
        let options = match clock { Some(clock) => options.native_resize_clock(move || clock.load(Ordering::SeqCst)), None => options };
        let receiver = transport::create_transport(options).unwrap();
        Self { receiver, leaf, runtime, cwd, project, connections, notices }
    }
    fn start(&self, mode: &str) -> Harness {
        let child = Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/pi-question-producer.cjs"))
            .arg(self.receiver.endpoint()).arg(&self.runtime).arg(&self.cwd).arg(mode)
            .current_dir(&self.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().expect("opt-in test requires Node; no skip or fake fallback");
        Harness::new(child)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.receiver.close().unwrap();
        // Only socket fixtures were created: anything but the leaf's own owner
        // marker left behind fails the test rather than being silently deleted.
        let leftovers: Vec<_> = std::fs::read_dir(&self.runtime).map(|d| d.flatten().map(|e| e.file_name()).filter(|n| n != ".owner").collect()).unwrap_or_default();
        if !std::thread::panicking() { assert!(leftovers.is_empty(), "fixture leaf not clean after close: {leftovers:?}"); }
        let _ = &self.leaf; // removed when the field drops
    }
}
struct Harness { child: Child, lines: mpsc::Receiver<String> }
impl Harness {
    fn new(mut child: Child) -> Self {
        let stdout = child.stdout.take().unwrap(); let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).take(16384).lines() {
                let Ok(line) = line else { break; };
                if send.send(line).is_err() { break; }
            }
        });
        Self { child, lines }
    }
    fn next(&self) -> Value {
        let line = self.lines.recv_timeout(Duration::from_secs(10)).expect("bounded Node protocol result");
        assert!(!line.contains("QP2_PRIVATE_QUESTION_CANARY"), "never log question text");
        serde_json::from_str(&line).expect("metadata/result JSON only")
    }
    fn finish(&mut self) {
        self.child.stdin.take().unwrap().write_all(b"finish\n").unwrap();
        let end = Instant::now()+Duration::from_secs(3);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() { break status; }
            assert!(Instant::now()<end, "Node must exit after test control finish");
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stderr = String::new();
        self.child.stderr.take().unwrap().take(8192).read_to_string(&mut stderr).unwrap();
        assert!(status.success(), "Node exit: {status}; diagnostic: {stderr}");
        assert!(stderr.is_empty(), "producer must not log private payloads");
        assert!(self.lines.recv_timeout(Duration::from_millis(100)).is_err(), "no extra transcript output");
    }
}
impl Drop for Harness {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let end = Instant::now()+Duration::from_secs(3);
    while !condition() { assert!(Instant::now()<end, "receiver state deadline"); std::thread::sleep(Duration::from_millis(10)); }
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_question_host_answer_and_ack() {
    let f = Fixture::new(); let mut node = f.start("questions");
    let started = node.next();
    assert_eq!(started["phase"], "question_pending", "producer status: {}", started["status"]);
    assert_eq!(started["project"], f.project); assert_eq!(started["sessionId"], "qp-real-session");
    assert_eq!(started["received"], json!(["{\"v\":1,\"type\":\"ready\"}\n", "{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1}\n"]));
    let id = started["id"].as_str().unwrap().to_string();
    wait(|| f.receiver.question_snapshot().pending.as_ref().is_some_and(|q| q.id == id));
    let view = f.receiver.question_snapshot();
    assert_eq!(view.pending.as_ref().unwrap().options[1].label, "Second");
    assert!(!serde_json::to_string(&view).unwrap().contains("opaque-real"), "host view never exposes tokens");
    // Callable Rust host API only: this is NOT a trusted WebView click.
    f.receiver.answer(&id, 1).unwrap();
    let completed = node.next();
    assert_eq!(completed["result"], json!({"status":"answered","id":id,
        "answer":{"type":"option","value":"opaque-real-B"}}));
    assert_eq!(completed["ack"], json!({"id":id,"status":"answered"}));
    assert_eq!(completed["diagnostics"], json!([{"id":id,"reason":"answered"}]));
    let types: Vec<_> = completed["types"].as_array().unwrap().iter()
        .filter(|t| **t != json!("heartbeat")).cloned().collect();
    assert_eq!(types, vec![json!("hello"), json!("questions_hello"), json!("question"), json!("question_resolved")]);
    wait(|| {
        let view = f.receiver.question_snapshot();
        view.pending.is_none() && view.deliveries.is_empty()
            && view.notice == Some(transport::QuestionOutcome::Answered) && view.ready_connections == 1
    });
    assert_eq!(f.connections.load(Ordering::SeqCst), 1, "ACK must clear receipt before disconnect");
    assert!(f.receiver.answer(&id, 1).is_err(), "ACK does not resurrect answerability");
    assert!(!serde_json::to_string(&f.receiver.question_snapshot()).unwrap().contains("QP2_PRIVATE_QUESTION_CANARY"));
    node.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_level2_native_busy_and_degraded_reach_tool_result_and_copy() {
    for (mode, code, time) in [("native-busy","native_transition_busy",0),
                               ("native-degraded","native_transition_degraded",2000)] {
        let clock = Arc::new(AtomicU64::new(0)); let f = Fixture::with_native_clock(Some(clock.clone()));
        assert!(f.receiver.compact_resize(7, (304,44), || true, || None, |_| {}));
        clock.store(time, Ordering::SeqCst);
        let mut node = f.start(mode); let started = node.next();
        assert_eq!(started["phase"], "question_pending", "no capability downgrade: {}", started["status"]);
        assert_eq!(started["received"], json!(["{\"v\":1,\"type\":\"ready\"}\n",
            "{\"v\":1,\"type\":\"questions_ready\",\"questionVersion\":1,\"busyReason\":1}\n"]));
        let hello: Value = serde_json::from_str(started["questionsHello"].as_str().unwrap()).unwrap();
        assert_eq!(hello["busyReason"], 1); assert_eq!(hello["questionVersion"], 1);
        assert_eq!(hello.as_object().unwrap().len(), 7);
        let id = started["id"].as_str().unwrap(); let completed = node.next();
        assert_eq!(completed["result"], json!({"status":"busy","id":id,"reasonCode":code}));
        let copy = completed["copy"].as_str().unwrap();
        assert!(copy.contains(code) && copy.contains("No human answer") && copy.contains("normal chat"));
        assert!(completed["ack"].is_null());
        let types: Vec<_> = completed["types"].as_array().unwrap().iter().filter(|t| **t != json!("heartbeat")).cloned().collect();
        assert_eq!(types, json!(["hello","questions_hello","question"]).as_array().unwrap().clone());
        let view = f.receiver.question_snapshot();
        assert!(view.pending.is_none() && view.deliveries.is_empty()); assert_eq!(view.ready_connections, 1);
        assert!(!serde_json::to_string(&view).unwrap().contains("QP2_PRIVATE_QUESTION_CANARY"));
        node.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
    }
}

#[test]
#[ignore = "requires ABITO_PI_PRODUCER_DIR and Node"]
fn real_producer_default_flag_off_exact_v1_and_unavailable() {
    let f = Fixture::new(); let mut node = f.start("legacy"); let report = node.next();
    assert_eq!(report["result"], json!({"status":"unavailable"}));
    assert_eq!(report["project"], f.project); assert_eq!(report["sessionId"], "qp-real-session");
    assert_eq!(report["received"], json!(["{\"v\":1,\"type\":\"ready\"}\n"]));
    assert_eq!(report["diagnostics"], json!([]));
    for kind in ["hello", "heartbeat", "settled"] {
        let raw = report["legacy"][kind].as_str().unwrap(); let frame: Value = serde_json::from_str(raw).unwrap();
        let suffix = if kind == "settled" {
            let id = frame["id"].as_str().unwrap(); assert!(protocol::token(id)); format!(",\"id\":\"{id}\"")
        } else { String::new() };
        let expected = format!("{{\"v\":1,\"type\":\"{kind}\",\"project\":\"{}\",\"sessionId\":\"qp-real-session\",\"at\":{}{suffix}}}\n", f.project, frame["at"].as_u64().unwrap());
        assert_eq!(raw, expected, "unchanged v1 fields, order and newline");
        assert!(raw.len()-1 <= 512);
    }
    wait(|| f.connections.load(Ordering::SeqCst) == 1 && f.notices.load(Ordering::SeqCst) == 1);
    let view = f.receiver.question_snapshot();
    assert_eq!(view.ready_connections, 0); assert!(view.pending.is_none() && view.deliveries.is_empty());
    assert!(!serde_json::to_string(&view).unwrap().contains("opaque-real"));
    node.finish(); wait(|| f.connections.load(Ordering::SeqCst) == 0);
}
