//! F099 — closed, gated focus of an already-running terminal / agent session
//! window / editor. F100 (launch Claude Desktop) joins this module as its
//! sibling command. The
//! target comes from a CLOSED enum (`terminal` | `session` | `editor`): the
//! payload never carries a command, a path or a window id, so a caller can
//! only ask for a class of window the allowlists below already accept. When
//! the target is absent or the desktop cannot do it, the answer is a public
//! Spanish reason and NOTHING changes — never a false success.
//!
//! Gate order mirrors `desktop::open_web_url` exactly: sender → payload
//! validation → rate limiter → effect, so a rejected call spends no rate
//! budget and reaches no injected effect.
//!
//! Target semantics (documented interpretation, coordinator-approved):
//! - `terminal` — a window whose WM_CLASS matches the closed terminal
//!   allowlist,
//! - `session` — an AGENT SESSION window: a terminal-class window whose
//!   title carries the standalone agent runtime tokens (`pi`, `herdr`),
//! - `editor` — a window whose WM_CLASS matches the closed editor allowlist
//!   (editors win even when a title mentions the agent).
//!
//! Resolution reads `_NET_CLIENT_LIST_STACKING` + `WM_CLASS` +
//! `_NET_WM_NAME` over the existing x11rb dependency (wmctrl/xdotool-FREE)
//! and focuses the TOPMOST match with the EWMH `_NET_ACTIVE_WINDOW` client
//! message (`set_input_focus` fallback). No process is spawned with a
//! caller-influenced argument, ever.
use crate::bridge::{BridgeError, RateLimiter};
use serde_json::Value;

#[cfg(test)]
#[path = "focushost_tests.rs"]
mod tests;

/// Public Spanish reasons. Safe to show: they name the failure, never a
/// path, a command or an internal.
pub const ERR_INVALID_TARGET: &str = "Objetivo inválido: elegí terminal, session o editor.";
pub const PLATFORM_FOCUS_REASON: &str =
    "Este escritorio no permite enfocar ventanas de otros programas ahora.";

/// Closed WM_CLASS allowlists (lowercase, boundary-exact: the entry matches
/// the class/instance itself or the class/instance with `-`/`_`/`.` right
/// after — never a blanket substring). On GNOME/Wayland these only see
/// XWayland windows; a native-Wayland terminal is honestly "not found",
/// never guessed.
pub const TERMINAL_CLASSES: &[&str] = &[
    "gnome-terminal",
    "org.gnome.terminal",
    "org.gnome.console",
    "kgx",
    "konsole",
    "xterm",
    "alacritty",
    "kitty",
    "foot",
    "wezterm",
    "tilix",
    "terminator",
    "urxvt",
    "rxvt",
    "xfce4-terminal",
    "mate-terminal",
    "lxterminal",
    "qterminal",
];

pub const EDITOR_CLASSES: &[&str] = &[
    "code",
    "code-oss",
    "vscode",
    "org.gnome.texteditor",
    "gedit",
    "gvim",
    "neovide",
    "sublime_text",
    "zed",
    "cursor",
    "jetbrains-idea",
    "idea",
];

/// Standalone title tokens that mark an agent-session terminal (`pi`,
/// `herdr`): token match after splitting the title on non-alphanumerics, so
/// `pip install` is NOT a session window.
pub const AGENT_SESSION_MARKERS: &[&str] = &["pi", "herdr"];

/// The closed target enum: every accepted string, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Terminal,
    Session,
    Editor,
}

impl Target {
    pub fn parse(raw: &str) -> Option<Target> {
        match raw {
            "terminal" => Some(Target::Terminal),
            "session" => Some(Target::Session),
            "editor" => Some(Target::Editor),
            _ => None,
        }
    }
}

/// One candidate window as the pure seam sees it (no X types, unit-testable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub instance: String,
    pub class: String,
    pub title: String,
}

/// Per-target honest "absent" reason, in Spanish, safe to show.
pub fn no_window_reason(target: Target) -> String {
    match target {
        Target::Terminal => "No encontré una ventana de terminal abierta.".to_string(),
        Target::Session => "No encontré una ventana de sesión de agente abierta.".to_string(),
        Target::Editor => "No encontré una ventana de editor abierta.".to_string(),
    }
}

/// Closed allowlist rule: entry equals the (lowercased) name, or the name
/// continues the entry with a `-`/`_`/`.` boundary (`gnome-terminal-server`
/// matches `gnome-terminal`; `codesign` does NOT match `code`).
pub fn matches_allowlist(class: &str, allowlist: &[&str]) -> bool {
    let lower = class.to_lowercase();
    allowlist.iter().any(|entry| {
        lower == *entry
            || lower.starts_with(&format!("{entry}-"))
            || lower.starts_with(&format!("{entry}_"))
            || lower.starts_with(&format!("{entry}."))
    })
}

fn session_marker_present(title: &str) -> bool {
    title
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| AGENT_SESSION_MARKERS.contains(&token))
}

/// Which target is this window, if any? Editors first, then terminal classes
/// split into session (title token) and plain terminal; everything else is
/// None. The session marker never promotes a non-terminal window.
pub fn classify_window(w: &WindowInfo) -> Option<Target> {
    if matches_allowlist(&w.class, EDITOR_CLASSES) || matches_allowlist(&w.instance, EDITOR_CLASSES) {
        return Some(Target::Editor);
    }
    if matches_allowlist(&w.class, TERMINAL_CLASSES) || matches_allowlist(&w.instance, TERMINAL_CLASSES) {
        if session_marker_present(&w.title) {
            return Some(Target::Session);
        }
        return Some(Target::Terminal);
    }
    None
}

/// The TOPMOST matching window in stacking order (the list arrives stacked,
/// top last), or None when no window matches. A plain `terminal` ask accepts
/// ANY terminal-class window (an agent-session terminal is still a
/// terminal); `session` only accepts the agent-session-marked ones.
pub fn pick_window_index(target: Target, windows: &[WindowInfo]) -> Option<usize> {
    windows.iter().rposition(|w| classify_window(w).is_some_and(|c| match target {
        Target::Terminal => matches!(c, Target::Terminal | Target::Session),
        Target::Session => c == Target::Session,
        Target::Editor => c == Target::Editor,
    }))
}

/// The honest focus decision over a collected window list: no candidate →
/// the per-target Spanish reason (connect ok but no matching window); a
/// failed activation → the platform reason. The activate closure receives
/// only the chosen INDEX — never a caller-controlled id.
pub fn focus_from_windows<F>(target: Target, windows: &[WindowInfo], activate: F) -> Result<(), String>
where
    F: FnOnce(usize) -> bool,
{
    match pick_window_index(target, windows) {
        None => Err(no_window_reason(target)),
        Some(idx) => {
            if activate(idx) {
                Ok(())
            } else {
                Err(PLATFORM_FOCUS_REASON.to_string())
            }
        }
    }
}

fn validated_target(payload: &Value) -> Result<Target, BridgeError> {
    let map = payload
        .as_object()
        .ok_or_else(|| BridgeError::denied(ERR_INVALID_TARGET))?;
    if map.len() != 1 {
        return Err(BridgeError::denied(ERR_INVALID_TARGET));
    }
    let raw = map
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::denied(ERR_INVALID_TARGET))?;
    Target::parse(raw).ok_or_else(|| BridgeError::denied(ERR_INVALID_TARGET))
}

/// The F099 command body: sender gate, closed-target validation, rate gate,
/// THEN the injected focus effect. An invalid call never consumes rate
/// budget and never reaches the effect.
pub fn focus_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    focus: F,
) -> Result<(), BridgeError>
where
    F: FnOnce(Target) -> Result<(), String>,
{
    crate::bridge::sender_ok(label, origin)?;
    let target = validated_target(payload)?;
    rate.check(now)?;
    focus(target).map_err(|reason| BridgeError::denied(&reason))
}

// ---------------------------------------------------------------------------
// Linux effect layer: real X11 resolution, honest elsewhere.
// ---------------------------------------------------------------------------

/// The platform entry the command calls. On Linux this goes through X11
/// (XWayland included); any other platform is an honest stub — the reason is
/// Spanish and nothing is attempted.
pub fn focus_running_window(target: Target) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        focus_on_display(None, target)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = target;
        Err(PLATFORM_FOCUS_REASON.to_string())
    }
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::{focus_from_windows, WindowInfo, PLATFORM_FOCUS_REASON, Target};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt,
        EventMask, InputFocus};
    use x11rb::rust_connection::RustConnection;
    use x11rb::CURRENT_TIME;

    /// Connect without ever panicking (a wedged X server must not kill the
    /// island); same catch_unwind discipline as `hotkey::x11`.
    fn connect(display: Option<&str>) -> Option<(RustConnection, usize)> {
        let owned = display.map(str::to_owned);
        std::panic::catch_unwind(move || RustConnection::connect(owned.as_deref())).ok()?.ok()
    }

    fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
        conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
    }

    /// `_NET_CLIENT_LIST_STACKING`, stacked with the topmost window LAST.
    fn client_windows(conn: &RustConnection, root: u32) -> Vec<u32> {
        let Some(atom) = intern(conn, b"_NET_CLIENT_LIST_STACKING") else { return Vec::new() };
        conn.get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|reply| reply.value32().map(|it| it.collect()).unwrap_or_default())
            .unwrap_or_default()
    }

    /// `WM_CLASS` → (instance, class); lossy, empty on refusal.
    fn wm_class(conn: &RustConnection, window: u32) -> (String, String) {
        conn.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|reply| {
                let mut parts = reply.value.split(|b| *b == 0);
                (
                    String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned(),
                    String::from_utf8_lossy(parts.next().unwrap_or(&[])).into_owned(),
                )
            })
            .unwrap_or_default()
    }

    /// `_NET_WM_NAME` (UTF-8) falling back to `WM_NAME`; empty when absent.
    fn name_prop(conn: &RustConnection, window: u32, ty: u32) -> Option<String> {
        conn.get_property(false, window, ty, ty, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.value).into_owned())
    }

    fn wm_name(conn: &RustConnection, window: u32) -> String {
        if let Some(utf8) = intern(conn, b"UTF8_STRING") {
            if let Some(name) = name_prop(conn, window, utf8) {
                return name;
            }
        }
        name_prop(conn, window, AtomEnum::STRING.into()).unwrap_or_default()
    }

    /// EWMH `_NET_ACTIVE_WINDOW` client message (source indication 2 =
    /// application), `set_input_focus` as the fallback. Best effort, never
    /// panics.
    fn activate(conn: &RustConnection, root: u32, window: u32) -> bool {
        let Some(atom) = intern(conn, b"_NET_ACTIVE_WINDOW") else { return false };
        let event = ClientMessageEvent::new(32, window, atom, ClientMessageData::from([2u32, 0, 0, 0, 0]));
        let sent = conn
            .send_event(
                false,
                root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )
            .ok()
            .and_then(|c| c.check().ok())
            .is_some();
        if sent {
            return true;
        }
        conn.set_input_focus(InputFocus::POINTER_ROOT, window, CURRENT_TIME)
            .ok()
            .and_then(|c| c.check().ok())
            .is_some()
    }

    fn collect_windows(conn: &RustConnection, root: u32) -> Vec<(u32, WindowInfo)> {
        client_windows(conn, root)
            .into_iter()
            .map(|id| {
                let (instance, class) = wm_class(conn, id);
                let title = wm_name(conn, id);
                (id, WindowInfo { instance, class, title })
            })
            .collect()
    }

    /// Resolve `target` among the running windows and activate the topmost
    /// match through the SAME honest decision the unit tests cover
    /// (`focus_from_windows`). Connect failure and activation failure are
    /// BOTH the platform reason; an absent target is the per-target Spanish
    /// reason; nothing else ever happens.
    pub(super) fn focus_on_display(display: Option<&str>, target: Target) -> Result<(), String> {
        let Some((conn, screen)) = connect(display) else {
            return Err(PLATFORM_FOCUS_REASON.to_string());
        };
        let root = conn.setup().roots[screen].root;
        let list = collect_windows(&conn, root);
        let infos: Vec<WindowInfo> = list.iter().map(|(_, info)| info.clone()).collect();
        focus_from_windows(target, &infos, |idx| activate(&conn, root, list[idx].0))
    }
}

#[cfg(target_os = "linux")]
fn focus_on_display(display: Option<&str>, target: Target) -> Result<(), String> {
    x11::focus_on_display(display, target)
}

// ---------------------------------------------------------------------------
// F100 — closed, gated launch of Claude Desktop.
// ---------------------------------------------------------------------------

/// Public Spanish reasons for the launch. Safe to show: they name the
/// failure, never a path, a command or an internal.
pub const ERR_INVALID_LAUNCH: &str = "Este comando no acepta parámetros.";
pub const CLAUDE_NOT_INSTALLED_REASON: &str =
    "Claude Desktop no está instalado en esta máquina.";
pub const LAUNCH_FAILED_REASON: &str = "No pude abrir Claude Desktop.";
pub const PLATFORM_LAUNCH_REASON: &str =
    "Esta plataforma no permite abrir Claude Desktop.";

/// The CLOSED desktop-entry names probed, in preference order. A caller can
/// never name an entry, a file or a command: the probe only ever looks for
/// these strings, and the only argument the launcher receives is a path the
/// probe itself resolved.
pub const CLAUDE_DESKTOP_ENTRIES: &[&str] =
    &["claude.desktop", "claude-code.desktop", "Claude.desktop"];

/// The CLOSED set of XDG application directories probed, in order.
pub fn xdg_application_dirs() -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{home}/.local/share"));
    vec![
        std::path::PathBuf::from(data_home).join("applications"),
        std::path::PathBuf::from(&home).join(".local/share/applications"),
        std::path::PathBuf::from("/usr/local/share/applications"),
        std::path::PathBuf::from("/usr/share/applications"),
    ]
}

/// The closed probe: the FIRST directory (in the given order) holding a FILE
/// named exactly like a closed entry (entry order inside the directory) wins;
/// anything else — including unrelated files like `evil.desktop` — is
/// invisible. `None` means "not installed", never a guess.
pub fn find_desktop_entry(
    dirs: &[std::path::PathBuf],
    entries: &[&str],
) -> Option<std::path::PathBuf> {
    dirs.iter()
        .flat_map(|dir| entries.iter().map(move |entry| dir.join(entry)))
        .find(|candidate| candidate.is_file())
}

/// The honest launch decision over a probed entry: absent → the Spanish
/// not-installed reason with NO launch attempt; a failed launch → the launch
/// reason. The launch closure receives only the probe-resolved PATH — never
/// a caller-controlled value.
pub fn launch_from_probe<F>(entry: Option<std::path::PathBuf>, launch: F) -> Result<(), String>
where
    F: FnOnce(std::path::PathBuf) -> bool,
{
    match entry {
        None => Err(CLAUDE_NOT_INSTALLED_REASON.to_string()),
        Some(path) => {
            if launch(path) {
                Ok(())
            } else {
                Err(LAUNCH_FAILED_REASON.to_string())
            }
        }
    }
}

fn validated_empty_payload(payload: &Value) -> Result<(), BridgeError> {
    let empty = payload.is_null() || payload.as_object().is_some_and(|map| map.is_empty());
    if empty {
        Ok(())
    } else {
        Err(BridgeError::denied(ERR_INVALID_LAUNCH))
    }
}

/// The F100 command body: sender gate, closed-payload validation (the
/// command takes NO parameters: `null` or `{}` only), rate gate, THEN the
/// injected launch effect. A rejected call never consumes rate budget and
/// never reaches the effect.
pub fn launch_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    launch: F,
) -> Result<(), BridgeError>
where
    F: FnOnce() -> Result<(), String>,
{
    crate::bridge::sender_ok(label, origin)?;
    validated_empty_payload(payload)?;
    rate.check(now)?;
    launch().map_err(|reason| BridgeError::denied(&reason))
}

/// The platform entry the command calls. On Linux this probes the closed
/// desktop entries and hands the resolved path to `gio launch` (no shell, no
/// caller-influenced argument, stdio detached); any other platform is an
/// honest stub — the reason is Spanish and nothing is attempted.
pub fn launch_claude_app() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let dirs = xdg_application_dirs();
        launch_from_probe(find_desktop_entry(&dirs, CLAUDE_DESKTOP_ENTRIES), launch_desktop_entry)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(PLATFORM_LAUNCH_REASON.to_string())
    }
}

/// `gio launch <path>` over the probe-resolved entry. No shell, no caller
/// argument; best effort, never panics.
#[cfg(target_os = "linux")]
fn launch_desktop_entry(path: std::path::PathBuf) -> bool {
    std::process::Command::new("gio")
        .arg("launch")
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
