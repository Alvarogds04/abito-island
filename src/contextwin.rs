//! Active-window context (#487, NotchBuddy feature 8).
//!
//! Adapted from Coucou NotchBuddy/Sources/App/WindowContextCapture.swift @71b773f,
//! Copyright (c) 2026 Louis Raillé, MIT. Rewritten for Linux: no browser URL in v1 (#483 S3).
//!
//! NotchBuddy attaches `Context — App: <app>, Window: <title>` to the FIRST chat message,
//! taken from the last app that was active before the island (`lastExternalApp`). The island
//! is itself the focused window when the chat opens, so the reader returns the most recent
//! window that is NOT Abito.
//!
//! Sources, best first:
//! 1. Abito's own GNOME Shell extension (`gnome-extension/abito-context@abito`) on the session
//!    bus: `org.abito.Context.GetRecentWindows() -> a(sss)` (app id, app name, title), most
//!    recent first.
//! 2. X11/EWMH (`_NET_CLIENT_LIST_STACKING`, topmost first) over the existing x11rb; on GNOME
//!    Wayland this only sees XWayland windows, never guessed.
//!
//! The reader is called ONLY when the user turned the setting on and the chat opened; nothing
//! is polled and nothing here takes an argument from the page.
use std::time::Duration;

/// A window as either source reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub app_id: String,
    pub app_name: String,
    pub title: String,
}

/// What the chat attaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWindow {
    pub app: String,
    pub title: String,
}

pub const BUS_NAME: &str = "org.abito.Context";
pub const OBJECT_PATH: &str = "/org/abito/Context";
pub const INTERFACE: &str = "org.abito.Context";
pub const METHOD: &str = "GetRecentWindows";
/// The extension answers from memory; anything slower is treated as absent.
pub const DBUS_DEADLINE: Duration = Duration::from_millis(800);

/// True for Abito's own windows (app id `com.abitog.AbitoTauri`, WM_CLASS, desktop file).
pub fn is_abito(c: &Candidate) -> bool {
    c.app_id.to_lowercase().contains("abito") || c.app_name.to_lowercase().contains("abito")
}

/// Most recent window that is not Abito and has an app name (NotchBuddy: `guard let appName`).
pub fn pick_external(recent: &[Candidate]) -> Option<ActiveWindow> {
    recent
        .iter()
        .find(|c| !is_abito(c) && !c.app_name.trim().is_empty())
        .map(|c| ActiveWindow { app: c.app_name.trim().to_string(), title: c.title.trim().to_string() })
}

/// The exact text NotchBuddy sends to the model (ClaudeService.swift: first message only).
pub fn format_context(w: &ActiveWindow) -> String {
    format!("Context — App: {}, Window: {}", w.app, w.title)
}

/// Build candidates from the extension's `a(sss)` reply.
pub fn from_reply(rows: Vec<(String, String, String)>) -> Vec<Candidate> {
    rows.into_iter().map(|(app_id, app_name, title)| Candidate { app_id, app_name, title }).collect()
}

/// Build candidates from X data: `(instance, class, title)` per window, TOPMOST LAST
/// (the EWMH stacking order); returned most recent first.
pub fn from_stacking(windows: Vec<(String, String, String)>) -> Vec<Candidate> {
    windows
        .into_iter()
        .rev()
        .map(|(instance, class, title)| {
            let app_name = if class.is_empty() { instance.clone() } else { class.clone() };
            Candidate { app_id: format!("{instance} {class}"), app_name, title }
        })
        .collect()
}

#[cfg(unix)]
pub mod dbus {
    use super::*;
    use zbus::blocking::{Connection, Proxy};

    fn connect(bus_address: Option<&str>) -> zbus::Result<Connection> {
        match bus_address {
            Some(addr) => zbus::blocking::connection::Builder::address(addr)?.build(),
            None => Connection::session(),
        }
    }

    fn ask(bus_address: Option<&str>) -> Option<Vec<Candidate>> {
        let conn = connect(bus_address).ok()?;
        // Only call a bus name somebody owns: never trigger activation of anything.
        let dbus = zbus::blocking::fdo::DBusProxy::new(&conn).ok()?;
        let name = zbus::names::BusName::try_from(BUS_NAME).ok()?;
        if !dbus.name_has_owner(name).ok()? {
            return None;
        }
        let proxy = Proxy::new(&conn, BUS_NAME, OBJECT_PATH, INTERFACE).ok()?;
        let rows: Vec<(String, String, String)> = proxy.call(METHOD, &()).ok()?;
        Some(from_reply(rows))
    }

    /// Recent windows from the extension; `None` when it is absent, slow or malformed.
    /// `bus_address` None = the user's session bus; Some(addr) = a private bus (tests).
    pub fn recent_windows(bus_address: Option<&str>) -> Option<Vec<Candidate>> {
        let addr = bus_address.map(str::to_owned);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(ask(addr.as_deref()));
        });
        rx.recv_timeout(DBUS_DEADLINE).ok().flatten()
    }
}

#[cfg(target_os = "linux")]
pub mod x11 {
    use super::*;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    use x11rb::rust_connection::RustConnection;

    fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
        conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
    }

    fn prop(conn: &RustConnection, window: u32, atom: u32, ty: u32) -> Vec<u8> {
        conn.get_property(false, window, atom, ty, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.value)
            .unwrap_or_default()
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    /// Windows of the display, most recent (topmost) first. `None` when X is unreachable.
    pub fn recent_windows(display: Option<&str>) -> Option<Vec<Candidate>> {
        let owned = display.map(str::to_owned);
        let (conn, screen) = std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref()))
            .ok()?
            .ok()?;
        let root = conn.setup().roots[screen].root;
        let list_atom = intern(&conn, b"_NET_CLIENT_LIST_STACKING")?;
        let ids: Vec<u32> = conn
            .get_property(false, root, list_atom, AtomEnum::WINDOW, 0, u32::MAX)
            .ok()?
            .reply()
            .ok()?
            .value32()
            .map(|it| it.collect())
            .unwrap_or_default();
        let utf8 = intern(&conn, b"UTF8_STRING")?;
        let net_name = intern(&conn, b"_NET_WM_NAME")?;
        let rows = ids
            .into_iter()
            .map(|id| {
                let class = prop(&conn, id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into());
                let mut parts = class.split(|b| *b == 0);
                let instance = text(parts.next().unwrap_or(&[]));
                let class = text(parts.next().unwrap_or(&[]));
                let mut title = prop(&conn, id, net_name, utf8);
                if title.is_empty() {
                    title = prop(&conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into());
                }
                (instance, class, text(&title))
            })
            .collect();
        Some(from_stacking(rows))
    }
}

/// The context to attach, or `None`. Extension first, X11 fallback.
#[cfg(target_os = "linux")]
pub fn capture(bus_address: Option<&str>, display: Option<&str>) -> Option<ActiveWindow> {
    if let Some(found) = dbus::recent_windows(bus_address).as_deref().and_then(pick_external) {
        return Some(found);
    }
    x11::recent_windows(display).as_deref().and_then(pick_external)
}

/// The chat's attach point (NotchBuddy `promptContext`): captured once when the chat opens and
/// nothing is held, attached to the FIRST message of a conversation and kept for that
/// conversation (the first message stays in `conversationMessages`). Pure state; the caller
/// supplies the read, so nothing here touches D-Bus or X11.
#[derive(Debug, Default)]
pub struct ChatContext {
    captured: Option<String>,
    attached: Option<(String, String)>, // (conversation id, text)
}

impl ChatContext {
    /// Chat opened. Switch off: forget everything and read NOTHING. On: read only if none held.
    pub fn on_chat_open(&mut self, enabled: bool, read: impl FnOnce() -> Option<ActiveWindow>) {
        if !enabled {
            self.captured = None;
            self.attached = None;
            return;
        }
        if self.captured.is_none() {
            self.captured = read().map(|w| format_context(&w));
        }
    }

    /// Text to add to the model's context for a turn of `conversation`; `first` = no message yet.
    pub fn for_turn(&mut self, enabled: bool, conversation: &str, first: bool) -> Option<String> {
        if !enabled {
            return None;
        }
        if first {
            if let Some(text) = &self.captured {
                self.attached = Some((conversation.to_string(), text.clone()));
            }
        }
        self.attached.as_ref().filter(|(id, _)| id == conversation).map(|(_, text)| text.clone())
    }
}

#[cfg(test)]
#[path = "contextwin_tests.rs"]
mod tests;
