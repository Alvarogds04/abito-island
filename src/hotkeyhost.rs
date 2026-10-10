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
use abito_island::hotkey::{
    self, idle_status, session_kind, toggle_decision, x11::GrabEvent, x11::Grabber, Command, HotkeyConfig, ToggleDecision, View,
};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE: &str = "hotkey.json";

#[derive(Default)]
pub struct HotkeyHost {
    config: Mutex<HotkeyConfig>,
    grabber: Mutex<Option<Grabber>>,
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

fn load(app: &AppHandle) -> HotkeyConfig {
    let text = config_path(app).and_then(|p| std::fs::read_to_string(p).ok());
    HotkeyConfig::from_text(text.as_deref())
}

fn persist(app: &AppHandle, cfg: &HotkeyConfig) {
    let Some(path) = config_path(app) else { return };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // temp + rename: an interrupted write never leaves a half config behind
        let tmp = dir.join(format!(".{FILE}.{}", std::process::id()));
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .and_then(|mut f| f.write_all(cfg.to_text().as_bytes()))
            .and_then(|_| std::fs::rename(&tmp, &path));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Marshal a press to the main thread exactly like the X11 listener does (window
/// work belongs there); the probe uses this same entry point.
pub(crate) fn press_on_main(app: &AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || on_press(&inner));
}

/// What pressing the hotkey does, on the main thread.
fn on_press(app: &AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
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

fn view_of(host: &HotkeyHost) -> View {
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    let status = match host.grabber.lock().expect("hotkey grabber lock").as_ref() {
        Some(g) => g.status(),
        None => idle_status(&cfg),
    };
    let session = session_kind(std::env::var("XDG_SESSION_TYPE").ok().as_deref(), std::env::var("WAYLAND_DISPLAY").ok().as_deref());
    View { combo: cfg.combo.to_string(), enabled: cfg.enabled, status, limited: session.limited() }
}

fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit("hotkey:state", view_of(&state.hotkey));
}

/// (Re)grab according to the current config. The old grab is released first so
/// a rebind never leaves two; a taken combo is REPORTED, never retried silently.
fn rebind(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = &state.hotkey;
    if let Some(old) = host.grabber.lock().expect("hotkey grabber lock").take() {
        old.stop();
    }
    let cfg = host.config.lock().expect("hotkey config lock").clone();
    if cfg.enabled {
        let handle = app.clone();
        let grabber = Grabber::start(None, cfg.combo, move |GrabEvent::Pressed| press_on_main(&handle));
        *host.grabber.lock().expect("hotkey grabber lock") = Some(grabber);
    }
    publish(app);
}

/// Startup: load the persisted config and grab it (probe/test runs stay out of
/// the human's keyboard unless they ask for it).
pub fn start(app: &AppHandle) {
    #[cfg(any(debug_assertions, feature = "probe"))]
    if crate::probe_requested() && std::env::var_os("ABITO_PROBE_HOTKEY").is_none() {
        return;
    }
    let state = app.state::<AppState>();
    *state.hotkey.config.lock().expect("hotkey config lock") = load(app);
    rebind(app);
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let taken = state.hotkey.grabber.lock().expect("hotkey grabber lock").take();
    if let Some(g) = taken {
        g.stop();
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
    let command = hotkey::parse_command(&payload).map_err(|e| err(e.code()))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        Command::View => {}
        Command::Enable | Command::Disable | Command::Reset | Command::Set(_) => {
            let next = {
                let mut cfg = state.hotkey.config.lock().expect("hotkey config lock");
                match command {
                    Command::Enable => cfg.enabled = true,
                    Command::Disable => cfg.enabled = false,
                    Command::Reset => *cfg = HotkeyConfig::default(),
                    Command::Set(combo) => {
                        cfg.combo = combo;
                        cfg.enabled = true;
                    }
                    Command::View => {}
                }
                cfg.clone()
            };
            persist(&app, &next);
            rebind(&app);
        }
    }
    Ok(json!(view_of(&state.hotkey)))
}

