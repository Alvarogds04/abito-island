//! The X11 side of the hotkey: a dedicated connection that holds `XGrabKey`
//! on the root window and reports presses. Everything here is best effort and
//! never panics: a collision is `Status::Taken`, a missing server is
//! `Status::Unsupported`, and a failed attempt releases every grab it made.
use super::{lock_variants, Combo, Status};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, GrabMode, ModMask};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrabEvent {
    Pressed,
}

const S_ACTIVE: u8 = 1;
const S_TAKEN: u8 = 2;
const S_INVALID: u8 = 3;
const S_UNSUPPORTED: u8 = 4;

pub struct Grabber {
    status: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn keycode_for(conn: &RustConnection, keysym: u32) -> Option<u8> {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let map = conn.get_keyboard_mapping(min, max - min + 1).ok()?.reply().ok()?;
    let per = map.keysyms_per_keycode as usize;
    (min..=max).find(|k| map.keysyms[(*k - min) as usize * per..][..per].contains(&keysym))
}

/// Grab every Caps/Num variant. Returns false (after releasing what it took)
/// when any of them is held by another client.
fn grab_all(conn: &RustConnection, root: u32, code: u8, combo: &Combo) -> bool {
    let base = combo.x11_modifiers();
    let mut taken: Vec<u16> = Vec::new();
    for lock in lock_variants() {
        let mask = ModMask::from(base | lock);
        let ok = conn
            .grab_key(true, root, mask, code, GrabMode::ASYNC, GrabMode::ASYNC)
            .ok()
            .and_then(|c| c.check().ok())
            .is_some();
        if !ok {
            for done in taken {
                let _ = conn.ungrab_key(code, root, ModMask::from(base | done));
            }
            let _ = conn.flush();
            return false;
        }
        taken.push(lock);
    }
    true
}

impl Grabber {
    /// Connect, grab, and (when the grab succeeded) listen on a thread.
    /// `display` None = the process default.
    pub fn start(display: Option<&str>, combo: Combo, on_event: impl Fn(GrabEvent) + Send + 'static) -> Grabber {
        let status = Arc::new(AtomicU8::new(S_UNSUPPORTED));
        let stop = Arc::new(AtomicBool::new(false));
        if combo.validate().is_err() {
            status.store(S_INVALID, Ordering::SeqCst);
            return Grabber { status, stop, thread: None };
        }
        // x11rb panics on an absurd DISPLAY number (e.g. `:65530`): a malformed
        // environment must degrade to «unsupported», never take the app down.
        let owned = display.map(str::to_owned);
        let connected = std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref()));
        let Ok(Ok((conn, screen_num))) = connected else {
            return Grabber { status, stop, thread: None };
        };
        let root = conn.setup().roots[screen_num].root;
        let Some(code) = keycode_for(&conn, combo.keysym()) else {
            status.store(S_INVALID, Ordering::SeqCst);
            return Grabber { status, stop, thread: None };
        };
        if !grab_all(&conn, root, code, &combo) {
            status.store(S_TAKEN, Ordering::SeqCst);
            return Grabber { status, stop, thread: None };
        }
        status.store(S_ACTIVE, Ordering::SeqCst);
        let (t_stop, t_status) = (stop.clone(), status.clone());
        let thread = std::thread::spawn(move || {
            while !t_stop.load(Ordering::SeqCst) {
                match conn.poll_for_event() {
                    Ok(Some(Event::KeyPress(e))) if e.detail == code && combo.matches_state(u16::from(e.state)) => on_event(GrabEvent::Pressed),
                    Ok(Some(_)) => {}
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(15)),
                    Err(_) => {
                        t_status.store(S_UNSUPPORTED, Ordering::SeqCst); // the server went away
                        break;
                    }
                }
            }
            let base = combo.x11_modifiers();
            for lock in lock_variants() {
                let _ = conn.ungrab_key(code, root, ModMask::from(base | lock));
            }
            let _ = conn.flush();
        });
        Grabber { status, stop, thread: Some(thread) }
    }

    pub fn status(&self) -> Status {
        match self.status.load(Ordering::SeqCst) {
            S_ACTIVE => Status::Active,
            S_TAKEN => Status::Taken,
            S_INVALID => Status::Invalid,
            _ => Status::Unsupported,
        }
    }

    /// Release the grab (idempotent) and join the listener.
    pub fn stop(mut self) {
        self.shutdown();
    }
    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Grabber {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The window that has the keyboard (EWMH `_NET_ACTIVE_WINDOW`), or None when the
/// WM does not say. Read BEFORE the island is shown so focus can be handed back.
pub fn active_window(display: Option<&str>) -> Option<u32> {
    use x11rb::protocol::xproto::AtomEnum;
    let owned = display.map(str::to_owned);
    let (conn, screen_num) = std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref())).ok()?.ok()?;
    let root = conn.setup().roots[screen_num].root;
    let atom = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW").ok()?.reply().ok()?.atom;
    let reply = conn.get_property(false, root, atom, AtomEnum::WINDOW, 0, 1).ok()?.reply().ok()?;
    let first = reply.value32()?.next();
    first.filter(|w| *w != 0)
}

/// Give the keyboard back to `window` (best effort, never panics). Used only when
/// the WM focused the island on a hotkey show that nobody asked to be typed into.
pub fn give_focus_back(display: Option<&str>, window: u32) -> bool {
    use x11rb::protocol::xproto::InputFocus;
    let owned = display.map(str::to_owned);
    let Ok(Ok((conn, _))) = std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref())) else { return false };
    conn.set_input_focus(InputFocus::POINTER_ROOT, window, x11rb::CURRENT_TIME).ok().and_then(|c| c.check().ok()).is_some()
}
