//! Work-area resolution: X11 `_NET_WORKAREA` (excludes panels/docks) intersected
//! with the monitor the window currently sits on, with graceful fallbacks.
//!
//! Tauri's `Monitor` under GNOME/XWayland can report a degenerate (0x0) rect
//! for an not-yet-mapped window, so a valid `_NET_WORKAREA` wins whenever the
//! monitor geometry is unusable; both raw values are exposed for the read-back
//! probe. Under pure Wayland neither value exists — see README.

use crate::geometry::{self, Rect};
use std::sync::{Mutex, OnceLock};
use tauri::WebviewWindow;

pub struct WorkArea {
    pub rect: Rect,
    pub source: &'static str,
    /// Raw `_NET_WORKAREA` from the X11 root window, if present.
    pub x11: Option<Rect>,
    /// Raw monitor geometry reported by Tauri, if usable.
    pub monitor: Option<Rect>,
}

fn valid(r: Rect) -> bool {
    r.w > 0 && r.h > 0
}

/// Read `_NET_WORKAREA` from the root window (first 4 CARDINALs: x, y, w, h).
fn x11_net_workarea() -> Option<Rect> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::AtomEnum;
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let atom = conn.intern_atom(false, b"_NET_WORKAREA").ok()?.reply().ok()?;
    let reply = conn
        .get_property(false, screen.root, atom.atom, AtomEnum::CARDINAL, 0, 4)
        .ok()?
        .reply()
        .ok()?;
    let mut vals = reply.value32()?;
    let x = vals.next()? as i32;
    let y = vals.next()? as i32;
    let w = vals.next()? as i32;
    let h = vals.next()? as i32;
    let rect = Rect { x, y, w, h };
    valid(rect).then_some(rect)
}

fn monitor_rect(win: &WebviewWindow) -> Option<Rect> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    let pos = monitor.position();
    let size = monitor.size();
    let rect = Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    valid(rect).then_some(rect)
}

/// Raw, read-only X11 ground truth for our own top-level window: client
/// geometry in root coordinates, `_GTK_FRAME_EXTENTS` (invisible CSD insets)
/// and whether `_NET_WM_STATE_ABOVE` is actually set at the WM level. This
/// disambiguates Tauri's getters from what X11/mutter really applied.
#[derive(Debug, Clone)]
pub struct X11Window {
    pub id: u32,
    /// Window origin in root coordinates (sign-corrected).
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub border: i32,
    pub frame_extents: Option<[i32; 4]>, // left, right, top, bottom
    pub wm_state_above: Option<bool>,
    pub wm_class: Option<String>,
}

fn get_string_property(
    conn: &x11rb::rust_connection::RustConnection,
    window: x11rb::protocol::xproto::Window,
    atom: x11rb::protocol::xproto::Atom,
) -> Option<String> {
    use x11rb::protocol::xproto::ConnectionExt;
    let reply = conn
        .get_property(false, window, atom, x11rb::protocol::xproto::AtomEnum::STRING, 0, 256)
        .ok()?
        .reply()
        .ok()?;
    let bytes: Vec<u8> = reply.value8()?.collect();
    Some(String::from_utf8_lossy(&bytes).trim_matches('\0').to_string())
}

/// One top-level client window as the scan saw it (identity facts only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: u32,
    /// `_NET_WM_PID`, when the client set it.
    pub pid: Option<u32>,
    /// `_NET_WM_NAME` (UTF-8), falling back to `WM_NAME`.
    pub title: Option<String>,
}

/// Why our own window could not be identified. Every variant is reported
/// (probe line / stderr) — the caller never falls back to a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnWindowError {
    /// No X server / EWMH client list readable.
    NoX11,
    /// No listed window carries our pid.
    NotFound,
    /// A window titled like ours has no `_NET_WM_PID`: we cannot prove it
    /// is ours, so we refuse instead of matching by title alone.
    PidMissing,
    /// Several of OUR windows, none with the expected title.
    Ambiguous,
}

impl OwnWindowError {
    pub fn as_str(self) -> &'static str {
        match self {
            OwnWindowError::NoX11 => "no_x11_client_list",
            OwnWindowError::NotFound => "own_window_not_found",
            OwnWindowError::PidMissing => "net_wm_pid_missing",
            OwnWindowError::Ambiguous => "own_window_ambiguous",
        }
    }
}

/// Identity criterion for "our window" (FIX-B, spec lane 4aa7c63):
/// 1. PRIMARY: `_NET_WM_PID` equals this process id. A title is not an
///    identity — any other client can set its title to "Abito".
/// 2. SECONDARY: among our own windows, the one titled `title` wins; a single
///    own window is ours even untitled; several untitled → `Ambiguous`.
/// 3. No own window, but a window with our title and NO `_NET_WM_PID` →
///    `PidMissing` (fail visibly, never guess); otherwise `NotFound`.
///
/// Pure: unit-tested without an X server.
pub fn pick_own_window(list: &[Candidate], pid: u32, title: &str) -> Result<u32, OwnWindowError> {
    let own: Vec<&Candidate> = list.iter().filter(|c| c.pid == Some(pid)).collect();
    if let Some(c) = own.iter().find(|c| c.title.as_deref() == Some(title)) {
        return Ok(c.id);
    }
    match own.as_slice() {
        [only] => return Ok(only.id),
        [] => {}
        _ => return Err(OwnWindowError::Ambiguous),
    }
    if list
        .iter()
        .any(|c| c.pid.is_none() && c.title.as_deref() == Some(title))
    {
        return Err(OwnWindowError::PidMissing);
    }
    Err(OwnWindowError::NotFound)
}

/// Find OUR window (read-only; never modifies any window) by
/// [`pick_own_window`] over the EWMH client list, and report its raw X11
/// state. The title is only the secondary condition.
pub fn x11_find_own_window(title: &str) -> Result<X11Window, OwnWindowError> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::AtomEnum;
    use x11rb::protocol::xproto::ConnectionExt;
    let no_x = |_| OwnWindowError::NoX11;
    let (conn, screen_num) = x11rb::connect(None).map_err(|_| OwnWindowError::NoX11)?;
    let screen = &conn.setup().roots[screen_num];
    let atom = |name: &[u8]| -> Result<u32, OwnWindowError> {
        Ok(conn
            .intern_atom(false, name)
            .map_err(|_| OwnWindowError::NoX11)?
            .reply()
            .map_err(|_| OwnWindowError::NoX11)?
            .atom)
    };
    // Prefer the stacking list, fall back to _NET_CLIENT_LIST.
    let windows: Vec<u32> = [b"_NET_CLIENT_LIST_STACKING".as_ref(), b"_NET_CLIENT_LIST".as_ref()]
        .into_iter()
        .find_map(|name| {
            let list = conn.intern_atom(false, name).ok()?.reply().ok()?;
            // Type is WINDOW (atom 33), not ATOM (4): filter with
            // AnyPropertyType or X returns an empty reply on type mismatch.
            let reply = conn
                .get_property(false, screen.root, list.atom, AtomEnum::ANY, 0, 512)
                .ok()?
                .reply()
                .ok()?;
            let v: Vec<u32> = reply.value32()?.collect();
            (!v.is_empty()).then_some(v)
        })
        .ok_or(OwnWindowError::NoX11)?;
    let net_wm_name = atom(b"_NET_WM_NAME")?;
    let net_wm_pid = atom(b"_NET_WM_PID")?;
    let utf8_string = atom(b"UTF8_STRING")?;
    let wm_name = atom(b"WM_NAME")?;
    let wm_class = atom(b"WM_CLASS")?;
    let gtk_ext = atom(b"_GTK_FRAME_EXTENTS")?;
    let net_state = atom(b"_NET_WM_STATE")?;
    let state_above = atom(b"_NET_WM_STATE_ABOVE")?;
    let candidates: Vec<Candidate> = windows
        .iter()
        .map(|&wid| {
            let pid = conn
                .get_property(false, wid, net_wm_pid, AtomEnum::CARDINAL, 0, 1)
                .ok()
                .and_then(|r| r.reply().ok())
                .and_then(|r| r.value32()?.next());
            // _NET_WM_NAME (UTF8) first, plain WM_NAME as fallback.
            let title = conn
                .get_property(false, wid, net_wm_name, utf8_string, 0, 256)
                .ok()
                .and_then(|r| r.reply().ok())
                .and_then(|r| {
                    let bytes: Vec<u8> = r.value8()?.collect();
                    (!bytes.is_empty())
                        .then(|| String::from_utf8_lossy(&bytes).trim_matches('\0').to_string())
                })
                .or_else(|| get_string_property(&conn, wid, wm_name));
            Candidate { id: wid, pid, title }
        })
        .collect();
    let wid = pick_own_window(&candidates, std::process::id(), title)?;
    let geom = conn.get_geometry(wid).map_err(no_x)?.reply().map_err(|_| OwnWindowError::NoX11)?;
    let tr = conn
        .translate_coordinates(screen.root, wid, 0, 0)
        .map_err(no_x)?
        .reply()
        .map_err(|_| OwnWindowError::NoX11)?;
    let extents = conn
        .get_property(false, wid, gtk_ext, AtomEnum::CARDINAL, 0, 4)
        .ok()
        .and_then(|r| r.reply().ok())
        .and_then(|r| {
            let v: Vec<u32> = r.value32()?.collect();
            (v.len() == 4).then(|| [v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32])
        });
    let above = conn
        .get_property(false, wid, net_state, AtomEnum::ATOM, 0, 64)
        .ok()
        .and_then(|r| r.reply().ok())
        .and_then(|r| r.value32().map(|mut it| it.any(|a| a == state_above)));
    Ok(X11Window {
        id: wid,
        // translate_coordinates(root -> wid, 0, 0) reports the root origin
        // in window coordinates, i.e. the negated window origin.
        x: -(tr.dst_x as i32),
        y: -(tr.dst_y as i32),
        w: geom.width as i32,
        h: geom.height as i32,
        border: geom.border_width as i32,
        frame_extents: extents,
        wm_state_above: above,
        wm_class: get_string_property(&conn, wid, wm_class),
    })
}

/// Cached X id of our window: after the first scan every origin read costs
/// only two round trips (translate + connection setup).
static CACHED_WID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

fn x11_origin_by_id(wid: u32) -> Option<(i32, i32)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    let tr = conn
        .translate_coordinates(screen.root, wid, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    Some((-(tr.dst_x as i32), -(tr.dst_y as i32)))
}

/// True window origin in root coordinates, straight from the X server.
///
/// Needed because Tauri 2.12.1's `outer_position` getter under this
/// XWayland/GTK stack reports the correct X but a Y offset by a constant
/// (observed: requested 32, getter -5, X server 32). Setters are accurate;
/// only the getter drifts, so the drag math reads the X server directly.
/// Returns `None` before the window is mapped; callers fall back to Tauri.
pub fn x11_window_origin() -> Option<(i32, i32)> {
    let cache = CACHED_WID.get_or_init(|| Mutex::new(None));
    if let Some(wid) = *cache.lock().expect("wid cache lock") {
        if let Some(origin) = x11_origin_by_id(wid) {
            return Some(origin);
        }
        *cache.lock().expect("wid cache lock") = None; // stale id: rescan
    }
    let win = match x11_find_own_window("Abito") {
        Ok(win) => win,
        Err(error) => {
            // Visible, once per distinct reason: the caller falls back to
            // Tauri's getter — never to another client's window.
            static LAST: OnceLock<Mutex<Option<OwnWindowError>>> = OnceLock::new();
            let last = LAST.get_or_init(|| Mutex::new(None));
            let mut seen = last.lock().expect("own window error lock");
            if *seen != Some(error) {
                eprintln!("x11 own window: {} (pid {})", error.as_str(), std::process::id());
                *seen = Some(error);
            }
            return None;
        }
    };
    *cache.lock().expect("wid cache lock") = Some(win.id);
    Some((win.x, win.y))
}

/// Best available work area for the window's monitor, plus a label describing
/// where the value came from (printed by the read-back probe).
pub fn current(win: &WebviewWindow) -> WorkArea {
    let x11 = x11_net_workarea();
    let mon = monitor_rect(win);
    let (rect, source) = match (x11, mon) {
        (Some(x), Some(m)) => match geometry::intersect(x, m) {
            Some(i) => (i, "x11:_NET_WORKAREA intersect monitor"),
            // Both claim to be valid but disagree: the window lives on the
            // monitor, so clamp within it rather than across the whole desktop.
            None => (m, "monitor (X11 work area disjoint from monitor)"),
        },
        // Monitor unusable (e.g. 0x0 before the window is mapped under
        // XWayland): the EWMH work area is the honest value.
        (Some(x), None) => (x, "x11:_NET_WORKAREA (monitor geometry unusable)"),
        (None, Some(m)) => (m, "monitor geometry (no _NET_WORKAREA)"),
        (None, None) => (
            Rect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            },
            "fallback 1920x1080 (no monitor, no X11)",
        ),
    };
    WorkArea {
        rect,
        source,
        x11,
        monitor: mon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: u32, pid: Option<u32>, title: &str) -> Candidate {
        Candidate { id, pid, title: Some(title.to_string()) }
    }

    #[test]
    fn our_window_is_the_one_with_our_pid_and_our_title() {
        let list = [cand(1, Some(999), "Abito"), cand(2, Some(42), "Abito")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Ok(2));
    }

    #[test]
    fn a_foreign_window_titled_abito_is_never_taken_for_ours() {
        // another process opens a window titled exactly "Abito"
        let list = [cand(7, Some(999), "Abito")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Err(OwnWindowError::NotFound));
    }

    #[test]
    fn a_window_without_net_wm_pid_fails_visibly_instead_of_guessing() {
        let list = [cand(7, None, "Abito")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Err(OwnWindowError::PidMissing));
        // even when a pid-less window is listed first, a proven own one wins
        let list = [cand(7, None, "Abito"), cand(8, Some(42), "Abito")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Ok(8));
    }

    #[test]
    fn title_is_secondary_among_our_own_windows() {
        // our process may own helper windows; prefer the titled one
        let list = [cand(3, Some(42), "helper"), cand(4, Some(42), "Abito")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Ok(4));
        // exactly one own top-level window: it is ours even untitled
        let list = [cand(5, Some(42), "")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Ok(5));
        // several own windows, none titled: ambiguous, refuse
        let list = [cand(5, Some(42), "a"), cand(6, Some(42), "b")];
        assert_eq!(pick_own_window(&list, 42, "Abito"), Err(OwnWindowError::Ambiguous));
    }

    #[test]
    fn empty_list_is_not_found() {
        assert_eq!(pick_own_window(&[], 42, "Abito"), Err(OwnWindowError::NotFound));
    }
}
