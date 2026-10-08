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

/// Find our window by title (read-only; never modifies any window) and report
/// its raw X11 state.
pub fn x11_find_window_by_title(title: &str) -> Option<X11Window> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::AtomEnum;
    use x11rb::protocol::xproto::ConnectionExt;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let screen = &conn.setup().roots[screen_num];
    // Prefer the stacking list, fall back to _NET_CLIENT_LIST.
    let windows: Vec<u32> = [b"_NET_CLIENT_LIST_STACKING".as_ref(), b"_NET_CLIENT_LIST".as_ref()]
        .into_iter()
        .find_map(|name| {
            let list = conn.intern_atom(false, name).ok()?.reply().ok()?;
            // Type is WINDOW (atom 33), not ATOM (4): filter with
            // AnyPropertyType or X returns an empty reply on type mismatch.
            let reply = conn
                .get_property(
                    false,
                    screen.root,
                    list.atom,
                    AtomEnum::ANY,
                    0,
                    512,
                )
                .ok()?
                .reply()
                .ok()?;
            let v: Vec<u32> = reply.value32()?.collect();
            (!v.is_empty()).then_some(v)
        })
        .unwrap_or_default();
    let net_wm_name = conn.intern_atom(false, b"_NET_WM_NAME").ok()?.reply().ok()?;
    let utf8_string = conn.intern_atom(false, b"UTF8_STRING").ok()?.reply().ok()?;
    let wm_name = conn.intern_atom(false, b"WM_NAME").ok()?.reply().ok()?;
    let wm_class = conn.intern_atom(false, b"WM_CLASS").ok()?.reply().ok()?;
    let gtk_ext = conn
        .intern_atom(false, b"_GTK_FRAME_EXTENTS")
        .ok()?
        .reply()
        .ok()?;
    let net_state = conn
        .intern_atom(false, b"_NET_WM_STATE")
        .ok()?
        .reply()
        .ok()?;
    let state_above = conn
        .intern_atom(false, b"_NET_WM_STATE_ABOVE")
        .ok()?
        .reply()
        .ok()?;
    for wid in windows {
        // _NET_WM_NAME (UTF8) first, plain WM_NAME as fallback.
        let net = conn
            .get_property(false, wid, net_wm_name.atom, utf8_string.atom, 0, 256)
            .ok()
            .and_then(|r| r.reply().ok())
            .and_then(|r| {
                let bytes: Vec<u8> = r.value8()?.collect();
                Some(String::from_utf8_lossy(&bytes).trim_matches('\0').to_string())
            });
        let plain = get_string_property(&conn, wid, wm_name.atom);
        let class = get_string_property(&conn, wid, wm_class.atom).unwrap_or_default();
        let title_ok = net.as_deref() == Some(title) || plain.as_deref() == Some(title);
        // WM_CLASS raw bytes carry both res_name and res_class separated by NUL.
        let class_ok = class.contains("abito-island") || class.contains("AbitoTauri");
        if !title_ok && !class_ok {
            continue; // never abort the scan on a window we do not own
        }
        let geom = conn.get_geometry(wid).ok()?.reply().ok()?;
        let tr = conn
            .translate_coordinates(screen.root, wid, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        let extents = conn
            .get_property(false, wid, gtk_ext.atom, AtomEnum::CARDINAL, 0, 4)
            .ok()
            .and_then(|r| r.reply().ok())
            .and_then(|r| {
                let v: Vec<u32> = r.value32()?.collect();
                (v.len() == 4).then(|| [v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32])
            });
        let above = conn
            .get_property(false, wid, net_state.atom, AtomEnum::ATOM, 0, 64)
            .ok()
            .and_then(|r| r.reply().ok())
            .and_then(|r| {
                r.value32()
                    .map(|mut it| it.any(|a| a == state_above.atom))
            });
        let class = get_string_property(&conn, wid, wm_class.atom);
        return Some(X11Window {
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
            wm_class: class,
        });
    }
    None
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
    let win = x11_find_window_by_title("Abito")?;
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
