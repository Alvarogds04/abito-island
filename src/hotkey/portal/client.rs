//! The D-Bus half of the portal backend: `CreateSession` → `BindShortcuts` →
//! listen for `Activated`. Blocking `zbus`, its own thread, never panics.
//!
//! The OS shows a permission dialog on the first `BindShortcuts`: the human must
//! accept ONCE. Until the Response arrives the status is `PermissionPending`; a
//! declined dialog is `PermissionDenied` (visible, and the caller falls back).
use super::{is_our_activation_for, outcome_of_response, request_path, token, Outcome, PortalState, ShortcutSignal, SHORTCUT_ID};
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
/// `org.freedesktop.host.portal.Registry`: how an app that is NOT sandboxed tells the portal its app id.
const REGISTRY_IFACE: &str = "org.freedesktop.host.portal.Registry";
/// The id of Abito's installed `.desktop` (`com.abitog.AbitoTauri.desktop`, the tauri identifier).
const APP_ID: &str = "com.abitog.AbitoTauri";

/// GNOME's portal refuses a `GlobalShortcuts.CreateSession` from a connection with no app id ("An app id is
/// required"), and a process started from a `.desktop` file is not given one. Without this the session was
/// refused, the shortcut fell back to the limited X11 grab (blind while another app has the focus on Wayland)
/// and the human's global shortcut never worked. Best effort: an older portal without the Registry, an id the
/// portal already knows (Flatpak, systemd scope) or a `.desktop` it cannot find all answer an error, and none of
/// those is a reason to give up the session: it is attempted exactly as before.
fn register_app_id(conn: &Connection) {
    if let Ok(registry) = Proxy::new(conn, DEST, PATH, REGISTRY_IFACE) {
        let options: HashMap<&str, Value<'_>> = HashMap::new();
        let _: zbus::Result<()> = registry.call("Register", &(APP_ID, options));
    }
}
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

/// How long startup may wait for the portal to say it exists.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Is the portal reachable and does it implement GlobalShortcuts? (No permission asked.)
pub fn probe(bus_address: Option<&str>) -> PortalState {
    probe_with_timeout(bus_address, PROBE_TIMEOUT)
}

/// Same, with a hard cap: the D-Bus call runs on its own thread and the caller returns at
/// the cap with `Unavailable` (a portal that answers `version` in 40 s must not freeze the
/// island at startup; the X11 grab covers the shortcut meanwhile).
pub fn probe_with_timeout(bus_address: Option<&str>, cap: Duration) -> PortalState {
    let (tx, rx) = std::sync::mpsc::channel();
    let addr = bus_address.map(str::to_owned);
    std::thread::spawn(move || {
        let state = (|| {
            let conn = connect(addr.as_deref()).ok()?;
            let proxy = Proxy::new(&conn, DEST, PATH, IFACE).ok()?;
            proxy.get_property::<u32>("version").ok().filter(|v| *v >= 1).map(|_| PortalState::Available)
        })()
        .unwrap_or(PortalState::Unavailable);
        let _ = tx.send(state);
    });
    rx.recv_timeout(cap).unwrap_or(PortalState::Unavailable)
}

/// The unique name that currently owns `org.freedesktop.portal.Desktop`: the ONLY sender
/// whose `Activated` signals we believe.
fn portal_owner(conn: &Connection) -> Option<String> {
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).ok()?;
    let name = zbus::names::BusName::try_from(DEST).ok()?;
    dbus.get_name_owner(name).ok().map(|o| o.to_string())
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
        Self::start_with_id(bus_address, combo, SHORTCUT_ID, on_press)
    }

    /// Each binding owns a connection and a uniquely-tokened portal session.
    pub fn start_with_id(bus_address: Option<&str>, combo: Combo, id: &str, on_press: impl Fn() + Send + 'static) -> PortalGrabber {
        let id = id.to_owned();
        let status = Arc::new(AtomicU8::new(S_PENDING));
        let stop = Arc::new(AtomicBool::new(false));
        let (t_status, t_stop) = (status.clone(), stop.clone());
        let addr = bus_address.map(str::to_owned);
        let thread = std::thread::spawn(move || {
            let fail = |s: u8| t_status.store(s, Ordering::SeqCst);
            let Ok(conn) = connect(addr.as_deref()) else { return fail(S_UNSUPPORTED) };
            register_app_id(&conn);
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
            shortcut.insert("description", Value::from(if id == "toggle-desktop-character" { "Enviar Abito al escritorio o traerlo a casa" } else { "Mostrar u ocultar la isla de Abito" }));
            shortcut.insert("preferred_trigger", Value::from(combo.portal_trigger()));
            let mut bind_opts: HashMap<&str, Value<'_>> = HashMap::new();
            bind_opts.insert("handle_token", Value::from(bind_tok.as_str()));
            let shortcuts = vec![(id.as_str(), shortcut)];
            t_status.store(S_PENDING, Ordering::SeqCst);
            let Some((code, _)) = call_request(&conn, &proxy, "BindShortcuts", &(&session_path, shortcuts, "", bind_opts), &bind_tok, deadline, &t_stop) else { return fail(S_UNSUPPORTED) };
            match outcome_of_response(code) {
                Outcome::Granted => t_status.store(S_ACTIVE, Ordering::SeqCst),
                Outcome::Denied => return fail(S_DENIED),
                Outcome::Failed => return fail(S_UNSUPPORTED),
            }

            // 3) listen. An activation counts only if it comes from the portal's own bus name
            // AND names OUR session (another app's session, an impostor on the bus, or the
            // session of a previous bind must never toggle the island).
            let owner = portal_owner(&conn);
            for msg in activations {
                if t_stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(msg) = msg else { break };
                let sender = msg.header().sender().map(|s| s.to_string());
                if owner.is_none() || sender != owner {
                    continue;
                }
                if let Ok((sig_session, sig_id, _ts, _opts)) = msg.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() {
                    if sig_session.as_str() == session_path.as_str() && is_our_activation_for(&ShortcutSignal { shortcut_id: sig_id, activated: true }, &id) {
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
