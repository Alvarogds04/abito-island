//! #305b: the portal client against a FAKE xdg-desktop-portal on a PRIVATE session
//! bus (`dbus-daemon`, its own socket). The human's bus and keyboard are never used.
//! The fake follows the documented Request/Response protocol, including the OS
//! permission dialog (accept / decline / never answered).
use abito_island::hotkey::{portal::client::{probe, PortalGrabber}, portal::{PortalState, SHORTCUT_ID}, Combo, Status};
use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use zbus::blocking::{connection, Connection};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

struct Bus { child: Child, address: String, _dir: std::path::PathBuf }
impl Bus {
    fn start() -> Bus {
        static N: AtomicU32 = AtomicU32::new(0);
        // a SHORT private dir: sockaddr_un caps a socket path at 107 bytes and this worktree's path is long
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME")).join(format!(".abus{}-{}", std::process::id() % 100000, N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let sock = dir.join("s");
        let address = format!("unix:path={}", sock.display());
        let child = Command::new("dbus-daemon").args(["--session", "--nofork", &format!("--address={address}"), "--nopidfile"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("dbus-daemon is required (no skip, no fake)");
        for _ in 0..100 { if sock.exists() { break; } std::thread::sleep(Duration::from_millis(30)); }
        Bus { child, address, _dir: dir }
    }
}
impl Drop for Bus { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self._dir); } }

#[derive(Clone, Copy, PartialEq)]
enum Dialog { Accept, Decline, Silent, FailCreate }

struct FakePortal { dialog: Dialog, binds: Arc<std::sync::Mutex<Vec<(String, String)>>>, conn: std::sync::OnceLock<Connection> }

#[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
impl FakePortal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 { 1 }

    fn create_session(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, options: HashMap<String, OwnedValue>) -> OwnedObjectPath {
        if let Some(sender) = hdr.sender() { *LAST_SENDER.lock().unwrap() = sender.as_str().trim_start_matches(':').replace('.', "_"); }
        let token: String = options.get("handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let sess_tok: String = options.get("session_handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let conn = self.conn.get().unwrap().clone();
        let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", sender_of_last_call(), token);
        let session = format!("/org/freedesktop/portal/desktop/session/{}/{}", sender_of_last_call(), sess_tok);
        let dialog = self.dialog;
        let p2 = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let code = if dialog == Dialog::FailCreate { 2u32 } else { 0 };
            let mut results: HashMap<&str, Value<'_>> = HashMap::new();
            results.insert("session_handle", Value::from(session.as_str()));
            let _ = conn.emit_signal(None::<&str>, ObjectPath::try_from(p2.as_str()).unwrap(), "org.freedesktop.portal.Request", "Response", &(code, results));
        });
        OwnedObjectPath::try_from(path).unwrap()
    }

    fn bind_shortcuts(&self, #[zbus(header)] hdr: zbus::message::Header<'_>, session: ObjectPath<'_>, shortcuts: Vec<(String, HashMap<String, OwnedValue>)>, _parent: String, options: HashMap<String, OwnedValue>) -> OwnedObjectPath {
        if let Some(sender) = hdr.sender() { *LAST_SENDER.lock().unwrap() = sender.as_str().trim_start_matches(':').replace('.', "_"); }
        let token: String = options.get("handle_token").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap();
        let (id, props) = &shortcuts[0];
        let trigger: String = props.get("preferred_trigger").and_then(|v| String::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
        self.binds.lock().unwrap().push((id.clone(), trigger));
        let conn = self.conn.get().unwrap().clone();
        let path = format!("/org/freedesktop/portal/desktop/request/{}/{}", sender_of_last_call(), token);
        let dialog = self.dialog;
        let p2 = path.clone();
        let session = session.to_string();
        std::thread::spawn(move || {
            // the OS permission dialog: the human takes a moment
            std::thread::sleep(Duration::from_millis(250));
            let code = match dialog { Dialog::Accept => 0u32, Dialog::Decline => 1, Dialog::Silent => return, Dialog::FailCreate => 2 };
            let results: HashMap<&str, Value<'_>> = HashMap::new();
            let _ = conn.emit_signal(None::<&str>, ObjectPath::try_from(p2.as_str()).unwrap(), "org.freedesktop.portal.Request", "Response", &(code, results));
            if code == 0 { ACTIVE_SESSION.lock().unwrap().replace(session); }
        });
        OwnedObjectPath::try_from(path).unwrap()
    }
}

static ACTIVE_SESSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static LAST_SENDER: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
fn sender_of_last_call() -> String { LAST_SENDER.lock().unwrap().clone() }

fn serve(bus: &Bus, dialog: Dialog) -> (Connection, Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    let binds = Arc::new(std::sync::Mutex::new(Vec::new()));
    let portal = FakePortal { dialog, binds: binds.clone(), conn: std::sync::OnceLock::new() };
    let conn = connection::Builder::address(bus.address.as_str()).unwrap().name("org.freedesktop.portal.Desktop").unwrap()
        .serve_at("/org/freedesktop/portal/desktop", portal).unwrap().build().unwrap();
    let iface = conn.object_server().interface::<_, FakePortal>("/org/freedesktop/portal/desktop").unwrap();
    let _ = iface.get().conn.set(conn.clone());
    (conn, binds)
}

/// Fire `Activated` for `id` the way the portal does.
fn activate(conn: &Connection, id: &str) {
    let session = ACTIVE_SESSION.lock().unwrap().clone().expect("a bound session");
    let opts: HashMap<&str, Value<'_>> = HashMap::new();
    conn.emit_signal(None::<&str>, "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", "Activated",
        &(ObjectPath::try_from(session.as_str()).unwrap(), id, 12345u64, opts)).unwrap();
}

#[test]
fn probe_distinguishes_an_available_portal_from_a_missing_one() {
    let bus = Bus::start();
    assert_eq!(probe(Some(&bus.address)), PortalState::Unavailable, "no portal on the bus yet");
    let _srv = serve(&bus, Dialog::Accept);
    assert_eq!(probe(Some(&bus.address)), PortalState::Available);
    assert_eq!(probe(Some("unix:path=/nonexistent/bus")), PortalState::Unavailable, "no bus at all is a quiet Unavailable");
}

fn wait_status(g: &PortalGrabber, want: Status, ms: u64) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end { if g.status() == want { return true; } std::thread::sleep(Duration::from_millis(20)); }
    false
}
fn start(bus: &Bus, combo: &str) -> (PortalGrabber, mpsc::Receiver<()>) {
    let (tx, rx) = mpsc::channel();
    let g = PortalGrabber::start(Some(&bus.address), Combo::parse(combo).unwrap(), move || { let _ = tx.send(()); });
    (g, rx)
}

#[test]
fn accepting_the_os_dialog_binds_our_shortcut_and_activation_toggles_once() {
    let bus = Bus::start();
    let (srv_conn, binds) = serve(&bus, Dialog::Accept);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::PermissionPending, 1500) || g.status() == Status::Active, "the OS dialog is open: tell the human");
    assert!(wait_status(&g, Status::Active, 3000), "accepted once → active; got {:?}", g.status());
    assert_eq!(binds.lock().unwrap().as_slice(), &[(SHORTCUT_ID.to_string(), "CTRL+ALT+a".to_string())], "the configured combo is what the portal is asked for");
    activate(&srv_conn, SHORTCUT_ID);
    rx.recv_timeout(Duration::from_secs(3)).expect("our activation reaches the island");
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    activate(&srv_conn, "someone-else");
    assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "another app's shortcut never toggles the island");
    g.stop();
}

#[test]
fn declining_the_os_dialog_is_reported_not_hidden() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Decline);
    let (g, rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::PermissionDenied, 3000), "got {:?}", g.status());
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    g.stop();
}

#[test]
fn a_dialog_nobody_answers_stays_pending_and_never_pretends_to_be_active() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::Silent);
    let (g, _rx) = start(&bus, "Ctrl+Alt+A");
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(g.status(), Status::PermissionPending);
    g.stop();
}

#[test]
fn a_portal_that_fails_session_creation_is_unsupported() {
    let bus = Bus::start();
    let _srv = serve(&bus, Dialog::FailCreate);
    let (g, _rx) = start(&bus, "Ctrl+Alt+A");
    assert!(wait_status(&g, Status::Unsupported, 3000), "got {:?}", g.status());
    g.stop();
}

#[test]
fn no_bus_means_unsupported_without_panicking() {
    let g = PortalGrabber::start(Some("unix:path=/nonexistent/bus"), Combo::default_combo(), || {});
    assert!(wait_status(&g, Status::Unsupported, 3000), "got {:?}", g.status());
    g.stop();
}

/// READ-ONLY check against the human's REAL session bus: is the portal there and does it
/// speak GlobalShortcuts? It asks for NO permission (no CreateSession/BindShortcuts), so
/// the OS dialog never opens. Skipped (loudly) when there is no session bus at all.
#[test]
fn the_real_session_portal_is_probed_read_only() {
    let state = probe(None);
    eprintln!("real session portal GlobalShortcuts: {state:?}");
    assert!(matches!(state, PortalState::Available | PortalState::Unavailable));
}
