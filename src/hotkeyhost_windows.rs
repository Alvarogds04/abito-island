//! Windows U1 hotkey host: configuration remains visible, but no global
//! shortcut backend is implemented on this platform yet.
use crate::AppState;
use abito_island::bridge::{self, BridgeError};
use abito_island::hotkey::{self, Command, HotkeyConfig, Status, View};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE: &str = "hotkey.json";

#[derive(Default)]
pub struct HotkeyHost {
    config: Mutex<HotkeyConfig>,
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn load(app: &AppHandle) -> HotkeyConfig {
    let text = config_path(app).and_then(|path| std::fs::read_to_string(path).ok());
    HotkeyConfig::from_text(text.as_deref())
}

fn persist(app: &AppHandle, config: &HotkeyConfig) {
    let Some(path) = config_path(app) else { return };
    let _ = crate::platform::fs::write_private_atomic(&path, config.to_text().as_bytes());
}

fn view_of(config: &HotkeyConfig) -> View {
    View {
        combo: config.combo.to_string(),
        enabled: config.enabled,
        status: if config.enabled { Status::Unsupported } else { Status::Disabled },
        limited: false,
        // Keep the existing backend field value used by the Unix idle path;
        // status=unsupported makes clear that no shortcut is actually held.
        backend: "x11",
        portal_note: None,
    }
}

fn publish(app: &AppHandle, host: &HotkeyHost) {
    let config = host.config.lock().expect("hotkey config lock");
    let _ = app.emit("hotkey:state", view_of(&config));
}

/// Startup loads configuration but registers no global shortcut on Windows U1.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.hotkey.config.lock().expect("hotkey config lock") = load(app);
    publish(app, &state.hotkey);
}

/// There is no native grab to release on this platform yet.
pub fn stop(_app: &AppHandle) {}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo cambiar el atajo.".into() }
}

/// Settings IPC remains available, while the returned status honestly reports
/// that Windows U1 has no global-shortcut backend.
#[tauri::command]
pub async fn hotkey_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = hotkey::parse_command(&payload).map_err(|error| err(error.code()))?;
    state.chat_rate.lock().expect("chat rate lock").check(crate::now_ms())?;
    if !matches!(command, Command::View) {
        let next = {
            let mut config = state.hotkey.config.lock().expect("hotkey config lock");
            match command {
                Command::Enable => config.enabled = true,
                Command::Disable => config.enabled = false,
                Command::Reset => *config = HotkeyConfig::default(),
                Command::Set(combo) => {
                    config.combo = combo;
                    config.enabled = true;
                }
                Command::View => {}
            }
            config.clone()
        };
        persist(&app, &next);
        publish(&app, &state.hotkey);
    }
    let config = state.hotkey.config.lock().expect("hotkey config lock");
    Ok(json!(view_of(&config)))
}

/// Probe-only simulated press: it exercises the UI action independently from
/// the unavailable OS shortcut backend.
#[cfg(any(debug_assertions, feature = "probe"))]
pub(crate) fn press_on_main(app: &AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if crate::QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        static PRESS_GATE: Mutex<hotkey::PressGate> =
            Mutex::new(hotkey::PressGate::new_const());
        if !PRESS_GATE
            .lock()
            .map(|mut gate| gate.accept(crate::now_ms() as u64))
            .unwrap_or(true)
        {
            return;
        }
        let state = inner.state::<AppState>();
        let hidden = *state.phase.lock().expect("phase lock") == abito_island::desktop::IslandState::Hidden;
        let pending = crate::questionhost::with_pending(&state, |pending| pending);
        match hotkey::toggle_decision(hidden, pending) {
            hotkey::ToggleDecision::Show => crate::restore(&inner),
            hotkey::ToggleDecision::Hide => {
                let _ = crate::dispatch_verb(&inner, &state, bridge::Action::Hide, None);
            }
            hotkey::ToggleDecision::Ignore => {}
        }
    });
}
