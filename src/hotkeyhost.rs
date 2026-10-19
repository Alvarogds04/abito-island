//! #305 host: wires the pure hotkey model and the X11 grabber to the island.
//!
//! The press comes from the X server, NOT from the webview: it never reaches the
//! renderer IPC and never answers an approval/question. Showing/hiding only
//! flips the window through the island's own `restore` / `Hide` verb, so the
//! Pi socket, the chat conversation, the models listing and the approval lane
//! keep running while the island is hidden (hide = `window.hide()`, nothing else).
use crate::{dispatch_verb, now_ms, questionhost, restore, AppState, QUITTING};
use abito_island::bridge::{self, Action, BridgeError};
use abito_island::desktop::IslandState;
use abito_island::hotkey::portal::{self, client::PortalGrabber, Backend, PortalState};
use abito_island::hotkey::{backend_limited, backend_name,
    self, idle_status, session_kind, toggle_decision, x11::GrabEvent, x11::Grabber, Command, HotkeyConfig, Target, ToggleDecision, View,
};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const TARGETS: [Target; 2] = [Target::ToggleIsland, Target::DesktopToggle];

fn other(target: Target) -> Target {
    match target { Target::ToggleIsland => Target::DesktopToggle, Target::DesktopToggle => Target::ToggleIsland }
}

/// The live grab(s). `Portal` carries the limited X11 grab IN PARALLEL while the OS
/// dialog is open (an unanswered dialog must never leave the shortcut without a
/// route); the watcher drops it once the portal really holds the shortcut, or
/// promotes it when the human declines / the portal fails.
enum Held {
    X11 { grab: Grabber, backend: Backend, portal_note: Option<hotkey::Status> },
    Portal { portal: PortalGrabber, x11: Option<Grabber> },
}
impl Held {
    fn status(&self) -> hotkey::Status {
        match self {
            Held::X11 { grab, .. } => grab.status(),
            // while the dialog is pending, say so (the human has something to do): the
            // parallel X11 grab already answers the shortcut meanwhile
            Held::Portal { portal, .. } => portal.status(),
        }
    }
    fn backend(&self) -> Backend {
        match self {
            Held::X11 { backend, .. } => *backend,
            Held::Portal { .. } => Backend::Portal,
        }
    }
    fn portal_note(&self) -> Option<hotkey::Status> {
        match self {
            Held::X11 { portal_note, .. } => *portal_note,
            Held::Portal { .. } => None,
        }
    }
    fn stop(self) {
        match self {
            Held::X11 { grab, .. } => grab.stop(),
            Held::Portal { portal, x11 } => {
                portal.stop();
                if let Some(g) = x11 {
                    g.stop();
                }
            }
        }
    }
}

#[derive(Default)]
struct Slot {
    config: Mutex<HotkeyConfig>,
    grabber: Mutex<Option<Held>>,
    /// #467: Ajustes is recording a combination (see `hotkey::SuspendGate`).
    suspend: Mutex<hotkey::SuspendGate>,
}

pub struct HotkeyHost {
    island: Slot,
    desktop: Slot,
    // Serialize cross-slot mutations: two concurrent sets must not both pass the clash check.
    mutation: Mutex<()>,
}
impl Default for HotkeyHost {
    fn default() -> Self {
        Self { island: Slot::default(), desktop: Slot { config: Mutex::new(HotkeyConfig::default_for(Target::DesktopToggle)), ..Slot::default() }, mutation: Mutex::new(()) }
    }
}
impl HotkeyHost {
    fn slot(&self, target: Target) -> &Slot {
        match target { Target::ToggleIsland => &self.island, Target::DesktopToggle => &self.desktop }
    }
}

fn config_path(app: &AppHandle, target: Target) -> Option<std::path::PathBuf> {
    let file = match target { Target::ToggleIsland => "hotkey.json", Target::DesktopToggle => "hotkey-desktop.json" };
    app.path().app_config_dir().ok().map(|d| d.join(file))
}

fn load(app: &AppHandle, target: Target) -> HotkeyConfig {
    let text = config_path(app, target).and_then(|p| std::fs::read_to_string(p).ok());
    HotkeyConfig::from_text_for(text.as_deref(), target)
}

fn persist(app: &AppHandle, target: Target, cfg: &HotkeyConfig) {
    let Some(path) = config_path(app, target) else { return };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    // temp + rename, private to the owner where the OS has mode bits: an
    // interrupted write never leaves a half config behind. The seam keeps this
    // live on every target — the bare `#[cfg(unix)]` block it replaces had no
    // other arm, so a Windows build silently never saved the binding.
    let _ = crate::platform::fs::write_private_atomic(&path, cfg.to_text().as_bytes());
}

/// Marshal a press to the main thread exactly like the X11 listener does (window
/// work belongs there); the probe uses this same entry point.
pub(crate) fn press_on_main(app: &AppHandle) {
    press_target_on_main(app, Target::ToggleIsland);
}

fn press_target_on_main(app: &AppHandle, target: Target) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if target == Target::ToggleIsland { on_press(&inner); return; }
        static DESKTOP_PRESS_GATE: Mutex<hotkey::PressGate> = Mutex::new(hotkey::PressGate::new_const());
        if !QUITTING.load(Ordering::SeqCst) && DESKTOP_PRESS_GATE.lock().map(|mut g| g.accept(crate::now_ms() as u64)).unwrap_or(false) {
            let _ = inner.emit_to("main", "desktop-character-toggle", ());
        }
    });
}

/// One gate for BOTH backends: the same physical press reported by the portal and by the X11 grab toggles once.
static PRESS_GATE: std::sync::Mutex<hotkey::PressGate> = std::sync::Mutex::new(hotkey::PressGate::new_const());

/// What pressing the hotkey does, on the main thread.
fn on_press(app: &AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    if !PRESS_GATE.lock().map(|mut g| g.accept(crate::now_ms() as u64)).unwrap_or(true) {
        return; // the other backend already reported this very press
    }
    let state = app.state::<AppState>();
    let hidden = *state.phase.lock().expect("phase lock") == IslandState::Hidden;
    let pending = questionhost::with_pending(&state, |pending| pending);
    match toggle_decision(hidden, pending) {
        ToggleDecision::Show => {
            // The human is typing somewhere else: remember who has the keyboard, show
            // the island (restore never asks for focus) and, if the window manager
            // focused the new map anyway, hand the keyboard straight back.
            let before = hotkey::x11::active_window(None);
            restore(app);
            let win = crate::main_window(app);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let focused = win.is_focused().unwrap_or(false);
                if hotkey::focus_after_show(focused, false) == hotkey::FocusAction::GiveBack {
                    if let Some(previous) = before {
                        let _ = hotkey::x11::give_focus_back(None, previous);
                    }
                }
                drop(app);
            });
        }
        ToggleDecision::Hide => {
            let _ = dispatch_verb(app, &state, Action::Hide, None);
        }
        ToggleDecision::Ignore => {}
    }
}

fn session() -> hotkey::Session {
    session_kind(std::env::var("XDG_SESSION_TYPE").ok().as_deref(), std::env::var("WAYLAND_DISPLAY").ok().as_deref())
}

fn view_of(host: &Slot) -> View {
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    let held = host.grabber.lock().expect("hotkey grabber lock");
    let (status, backend, portal_note) = match held.as_ref() {
        Some(h) => (h.status(), h.backend(), h.portal_note()),
        None => (idle_status(&cfg), portal::choose_backend(session(), PortalState::Unavailable), None),
    };
    View { combo: cfg.combo.to_string(), enabled: cfg.enabled, status, limited: backend_limited(backend), backend: backend_name(backend), portal_note }
}

fn publish(app: &AppHandle, target: Target) {
    let state = app.state::<AppState>();
    let event = match target { Target::ToggleIsland => "hotkey:state", Target::DesktopToggle => "hotkey-desktop:state" };
    let _ = app.emit(event, view_of(state.hotkey.slot(target)));
}

/// One decision, two backends. On Wayland the XDG portal is primary (the OS asks the
/// human once); when it is missing, unsupported by the compositor, or the human
/// declines, the X11 grab takes over and the chip says «Atajo limitado».
fn grab(app: &AppHandle, target: Target, combo: hotkey::Combo) -> Held {
    let sess = session();
    // The probe is time-boxed (a slow portal must not freeze startup) and runs off the
    // caller's critical path: an `Unavailable` just means the X11 grab holds the shortcut.
    let portal_state = if sess == hotkey::Session::Wayland { portal::client::probe(None) } else { PortalState::Unavailable };
    let backend = portal::choose_backend(sess, portal_state);
    let x11_handle = app.clone();
    let x11 = || Grabber::start(None, combo, move |GrabEvent::Pressed| press_target_on_main(&x11_handle, target));
    if backend == Backend::Portal {
        let handle = app.clone();
        let id = match target { Target::ToggleIsland => portal::SHORTCUT_ID, Target::DesktopToggle => "toggle-desktop-character" };
        let portal = PortalGrabber::start_with_id(None, combo, id, move || press_target_on_main(&handle, target));
        // the limited X11 grab runs meanwhile: no route is ever missing while the OS dialog is open
        let held = Held::Portal { portal, x11: Some(x11()) };
        watch_portal(app.clone(), target);
        return held;
    }
    Held::X11 { grab: x11(), backend, portal_note: None }
}

/// While the portal route is the holder, watch it: when the human declines the OS
/// dialog (or the portal gives up) the shortcut moves to the X11 grab so it is
/// never left without any route, and the chip keeps saying why («Atajo limitado»
/// / «Atajo sin permiso»). Ends as soon as the holder changes.
fn watch_portal(app: AppHandle, target: Target) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(400));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = app.state::<AppState>();
        let mut held = state.hotkey.slot(target).grabber.lock().expect("hotkey grabber lock");
        let plan = match held.as_ref() {
            Some(Held::Portal { portal, .. }) => portal::plan_for(portal.status()),
            _ => return, // the holder changed (rebind/disable/quit): this watcher is done
        };
        match plan {
            portal::PortalPlan::KeepBoth => {
                drop(held);
                publish(&app, target);
            }
            portal::PortalPlan::DropX11 => {
                // the portal holds the shortcut now: release the fallback so one press cannot toggle twice
                if let Some(Held::Portal { x11, .. }) = held.as_mut() {
                    if let Some(g) = x11.take() {
                        g.stop();
                    }
                }
                drop(held);
                publish(&app, target);
                return;
            }
            portal::PortalPlan::PromoteX11 { reason } => {
                // the human declined / the portal failed: the parallel X11 grab becomes the route and
                // the reason is KEPT so the chip can still explain it after this moment
                let old = held.take();
                if let Some(Held::Portal { portal, x11 }) = old {
                    portal.stop();
                    let grab = x11.unwrap_or_else(|| {
                        let combo = state.hotkey.slot(target).config.lock().expect("hotkey config lock").combo;
                        let handle = app.clone();
                        Grabber::start(None, combo, move |GrabEvent::Pressed| press_target_on_main(&handle, target))
                    });
                    *held = Some(Held::X11 { grab, backend: Backend::X11 { limited: session() == hotkey::Session::Wayland }, portal_note: Some(reason) });
                }
                drop(held);
                publish(&app, target);
                return;
            }
        }
    });
}

/// (Re)grab according to the current config. The old grab is released first so
/// a rebind never leaves two; a taken combo is REPORTED, never retried silently.
fn rebind(app: &AppHandle, target: Target) {
    let state = app.state::<AppState>();
    let host = state.hotkey.slot(target);
    // A new binding (or startup) ends any suspension: the recorder is done with the keys.
    host.suspend.lock().expect("hotkey suspend lock").resume();
    if let Some(old) = host.grabber.lock().expect("hotkey grabber lock").take() {
        old.stop();
    }
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    if cfg.enabled {
        *host.grabber.lock().expect("hotkey grabber lock") = Some(grab(app, target, cfg.combo));
    }
    publish(app, target);
}

/// Take the grab back after a suspension, per the stored config (no config change).
fn regrab(app: &AppHandle, target: Target) {
    let state = app.state::<AppState>();
    let host = state.hotkey.slot(target);
    let _mutation = state.hotkey.mutation.lock().expect("hotkey mutation lock");
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    let mut slot = host.grabber.lock().expect("hotkey grabber lock");
    if cfg.enabled && slot.is_none() {
        *slot = Some(grab(app, target, cfg.combo));
    }
    drop(slot);
    publish(app, target);
}

/// Startup: load the persisted config and grab it (probe/test runs stay out of
/// the human's keyboard unless they ask for it).
pub fn start(app: &AppHandle) {
    #[cfg(any(debug_assertions, feature = "probe"))]
    if crate::probe_requested() && std::env::var_os("ABITO_PROBE_HOTKEY").is_none() {
        return;
    }
    let state = app.state::<AppState>();
    let _mutation = state.hotkey.mutation.lock().expect("hotkey mutation lock");
    let island = load(app, Target::ToggleIsland);
    let mut desktop = load(app, Target::DesktopToggle);
    // A legacy island config may already use Ctrl+Alt+D. Keep it, but never grab it twice.
    if hotkey::check_combo_available(desktop.combo, &island).is_err() {
        desktop.enabled = false;
    }
    *state.hotkey.island.config.lock().expect("hotkey config lock") = island;
    *state.hotkey.desktop.config.lock().expect("hotkey config lock") = desktop;
    for target in TARGETS { rebind(app, target); }
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    for target in TARGETS {
        let taken = state.hotkey.slot(target).grabber.lock().expect("hotkey grabber lock").take();
        if let Some(g) = taken { g.stop(); }
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo cambiar el atajo.".into() }
}

/// Settings IPC (the #308 panel calls it): closed schema, sender gate, shared rate.
#[tauri::command]
pub async fn hotkey_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let (target, command) = hotkey::parse_targeted(&payload).map_err(|e| err(e.code()))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let host = state.hotkey.slot(target);
    match command {
        Command::View => {}
        Command::Suspend => {
            let _mutation = state.hotkey.mutation.lock().expect("hotkey mutation lock");
            let token = host.suspend.lock().expect("hotkey suspend lock").suspend();
            let taken = host.grabber.lock().expect("hotkey grabber lock").take();
            if let Some(held) = taken {
                held.stop();
            }
            publish(&app, target);
            // Never leave the shortcut off if the recorder does not report back.
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(hotkey::SUSPEND_MAX_MS));
                let expired = handle.state::<AppState>().hotkey.slot(target).suspend.lock().expect("hotkey suspend lock").expire(token);
                if expired {
                    regrab(&handle, target);
                }
            });
        }
        Command::Resume => {
            let was = host.suspend.lock().expect("hotkey suspend lock").resume();
            if was {
                regrab(&app, target);
            }
        }
        Command::Enable | Command::Disable | Command::Reset | Command::Set(_) => {
            let _mutation = state.hotkey.mutation.lock().expect("hotkey mutation lock");
            let next = {
                let mut cfg = host.config.lock().expect("hotkey config lock").clone();
                match command {
                    Command::Enable => cfg.enabled = true,
                    Command::Disable => cfg.enabled = false,
                    Command::Reset => cfg = HotkeyConfig::default_for(target),
                    Command::Set(combo) => {
                        cfg.combo = combo;
                        cfg.enabled = true;
                    }
                    Command::View | Command::Suspend | Command::Resume => {}
                }
                if command != Command::Disable {
                    hotkey::check_combo_available(cfg.combo, &state.hotkey.slot(other(target)).config.lock().expect("hotkey config lock"))
                        .map_err(|e| err(e.code()))?;
                }
                *host.config.lock().expect("hotkey config lock") = cfg.clone();
                cfg
            };
            persist(&app, target, &next);
            rebind(&app, target);
        }
    }
    Ok(json!(view_of(host)))
}

