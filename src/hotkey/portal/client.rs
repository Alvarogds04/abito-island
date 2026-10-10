//! The D-Bus half of the portal backend: `CreateSession` → `BindShortcuts` →
//! listen for `Activated`. Blocking `zbus`, its own thread, never panics.
//!
//! The OS shows a permission dialog on the first `BindShortcuts`: the human must
//! accept ONCE. Until the Response arrives the status is `PermissionPending`; a
//! declined dialog is `PermissionDenied` (visible, and the caller falls back).
use super::{is_our_activation, outcome_of_response, request_path, token, Outcome, PortalState, ShortcutSignal, SHORTCUT_ID};
use crate::hotkey::{Combo, Status};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
/// How long the human gets to answer the OS dialog before we stop waiting.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(120);

const S_PENDING: u8 = 1;
const S_ACTIVE: u8 = 2;
const S_DENIED: u8 = 3;
const S_UNSUPPORTED: u8 = 4;

pub struct PortalGrabber {
    status: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Is the portal reachable and does it implement GlobalShortcuts? (No permission asked.)
pub fn probe(bus_address: Option<&str>) -> PortalState {
    let Ok(conn) = connect(bus_address) else { return PortalState::Unavailable };
    let Ok(proxy) = Proxy::new(&conn, DEST, PATH, IFACE) else { return PortalState::Unavailable };
    match proxy.get_property::<u32>("version") {
        Ok(v) if v >= 1 => PortalState::Available,
        _ => PortalState::Unavailable,
    }
}

fn connect(bus_address: Option<&str>) -> zbus::Result<Connection> {
    match bus_address {
        Some(addr) => zbus::blocking::connection::Builder::address(addr)?.build(),
        None => Connection::session(),
    }
}

fn call_request(conn: &Connection, proxy: &Proxy<'_>, method: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType), handle_token: &str, deadline: Instant, stop: &AtomicBool) -> Option<(u32, HashMap<String, OwnedValue>)> {
    let unique = conn.unique_name()?.to_string();
    let expected = request_path(&unique, handle_token);
    // subscribe BEFORE calling, or a fast Response is lost
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST_IFACE).ok()?
        .member("Response").ok()?
        .path(expected.clone()).ok()?
        .build();
    let mut it = MessageIterator::for_match_rule(rule, conn, Some(8)).ok()?;
    let reply: OwnedObjectPath = proxy.call(method, body).ok()?;
    // portals older than 0.9 may return a different path than the predicted one; the match rule
    // above uses the predicted (documented) path, so an unexpected handle is treated as a failure
    if reply.as_str() != expected {
        return None;
    }
    loop {
        if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return None;
        }
        match it.next() {
            Some(Ok(msg)) => {
                if let Ok((code, results)) = msg.body().deserialize::<(u32, HashMap<String, OwnedValue>)>() {
                    return Some((code, results));
                }
            }
            _ => return None,
        }
    }
}

impl PortalGrabber {
    /// Create the session, bind our shortcut (the OS asks the human once) and listen.
    /// `bus_address` None = the user's session bus; Some(addr) = a private bus (tests).
    pub fn start(bus_address: Option<&str>, combo: Combo, on_press: impl Fn() + Send + 'static) -> PortalGrabber {
        let status = Arc::new(AtomicU8::new(S_PENDING));
        let stop = Arc::new(AtomicBool::new(false));
        let (t_status, t_stop) = (status.clone(), stop.clone());
        let addr = bus_address.map(str::to_owned);
        let thread = std::thread::spawn(move || {
            let fail = |s: u8| t_status.store(s, Ordering::SeqCst);
            let Ok(conn) = connect(addr.as_deref()) else { return fail(S_UNSUPPORTED) };
            let Ok(proxy) = Proxy::new(&conn, DEST, PATH, IFACE) else { return fail(S_UNSUPPORTED) };
            let deadline = Instant::now() + PERMISSION_WAIT;

            // 1) CreateSession
            let (req_tok, sess_tok) = (token("req"), token("sess"));
            let mut options: HashMap<&str, Value<'_>> = HashMap::new();
            options.insert("handle_token", Value::from(req_tok.as_str()));
            options.insert("session_handle_token", Value::from(sess_tok.as_str()));
            let Some((code, results)) = call_request(&conn, &proxy, "CreateSession", &(options,), &req_tok, deadline, &t_stop) else { return fail(S_UNSUPPORTED) };
            if outcome_of_response(code) != Outcome::Granted {
                return fail(if outcome_of_response(code) == Outcome::Denied { S_DENIED } else { S_UNSUPPORTED });
            }
            let session: String = match results.get("session_handle").and_then(|v| <String>::try_from(v.try_clone().ok()?).ok()) {
                Some(s) => s,
                None => return fail(S_UNSUPPORTED),
            };
            let Ok(session_path) = ObjectPath::try_from(session.as_str()) else { return fail(S_UNSUPPORTED) };

            // subscribe to Activated BEFORE binding so no press is lost
            let act_rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface(IFACE).ok()
                .and_then(|b| b.member("Activated").ok())
                .map(|b| b.build());
            let Some(act_rule) = act_rule else { return fail(S_UNSUPPORTED) };
            let Ok(activations) = MessageIterator::for_match_rule(act_rule, &conn, Some(16)) else { return fail(S_UNSUPPORTED) };

            // 2) BindShortcuts: THIS is where the OS dialog appears (accept once)
            let bind_tok = token("bind");
            let mut shortcut: HashMap<&str, Value<'_>> = HashMap::new();
            shortcut.insert("description", Value::from("Mostrar u ocultar la isla de Abito"));
            shortcut.insert("preferred_trigger", Value::from(combo.portal_trigger()));
            let mut bind_opts: HashMap<&str, Value<'_>> = HashMap::new();
            bind_opts.insert("handle_token", Value::from(bind_tok.as_str()));
            let shortcuts = vec![(SHORTCUT_ID, shortcut)];
            t_status.store(S_PENDING, Ordering::SeqCst);
            let Some((code, _)) = call_request(&conn, &proxy, "BindShortcuts", &(&session_path, shortcuts, "", bind_opts), &bind_tok, deadline, &t_stop) else { return fail(S_UNSUPPORTED) };
            match outcome_of_response(code) {
                Outcome::Granted => t_status.store(S_ACTIVE, Ordering::SeqCst),
                Outcome::Denied => return fail(S_DENIED),
                Outcome::Failed => return fail(S_UNSUPPORTED),
            }

            // 3) listen
            for msg in activations {
                if t_stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(msg) = msg else { break };
                if let Ok((_session, id, _ts, _opts)) = msg.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() {
                    if is_our_activation(&ShortcutSignal { shortcut_id: id, activated: true }) {
                        on_press();
                    }
                }
            }
        });
        PortalGrabber { status, stop, thread: Some(thread) }
    }

    pub fn status(&self) -> Status {
        match self.status.load(Ordering::SeqCst) {
            S_PENDING => Status::PermissionPending,
            S_ACTIVE => Status::Active,
            S_DENIED => Status::PermissionDenied,
            _ => Status::Unsupported,
        }
    }

    /// Stop listening. The D-Bus thread may be parked in a blocking read, so it is
    /// detached after the flag is set (it ends with the process or the next signal).
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take();
    }
}

impl Drop for PortalGrabber {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
