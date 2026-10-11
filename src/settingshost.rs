//! #306 host: the three closed IPC commands of the settings panel.
//!
//! - `agent_action`   → the island agent client (accounts, sign-in, connectors list);
//! - `prefs_action`   → the sound switch (`prefs.json`);
//! - `hotkey_action`  → lives in `hotkeyhost.rs` (#305), reused as is.
//!
//! Every command validates the sender (the main webview only), takes the same shared
//! rate limiter as chat/models/questions and speaks a closed schema. The agent's
//! per-launch token and socket path never cross to the WebView (`agentclient`).
use crate::{now_ms, AppState};
use abito_island::agentconn::{island_root, AgentConn};
use abito_island::bridge::{self, BridgeError};
use abito_island::prefs::{self, Command, Prefs};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct SettingsHost {
    agent: Mutex<Option<AgentConn>>,
    prefs: Mutex<Prefs>,
}

impl Default for SettingsHost {
    fn default() -> Self {
        SettingsHost { agent: Mutex::new(None), prefs: Mutex::new(Prefs::default()) }
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar el cambio de ajustes.".into() }
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(prefs::FILE))
}

fn load_prefs(app: &AppHandle) -> Prefs {
    Prefs::from_text(prefs_path(app).and_then(|p| std::fs::read_to_string(p).ok()).as_deref())
}

fn persist_prefs(app: &AppHandle, p: &Prefs) {
    let Some(path) = prefs_path(app) else { return };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!(".{}.{}", prefs::FILE, std::process::id()));
    let ok = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)
        .and_then(|mut f| f.write_all(p.to_text().as_bytes()))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if ok.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Startup: load the prefs. The agent connection is made lazily, when the human opens Settings.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.settings.prefs.lock().expect("prefs lock") = load_prefs(app);
}

fn view_prefs(host: &SettingsHost) -> Value {
    json!({"sound": host.prefs.lock().expect("prefs lock").sound})
}

/// Closed command set of the preferences (`view` / `sound_on` / `sound_off`).
#[tauri::command]
pub async fn prefs_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        Command::View => {}
        Command::SoundOn | Command::SoundOff => {
            let next = Prefs { sound: command == Command::SoundOn };
            *state.settings.prefs.lock().expect("prefs lock") = next;
            persist_prefs(&app, &next);
            let _ = app.emit("prefs:state", view_prefs(&state.settings));
        }
    }
    Ok(view_prefs(&state.settings))
}

/// The island agent: `view` (connects on first use), and the closed command set of
/// `agentclient::parse_ui_command`. API keys only ever travel as `auth_reply` values.
#[tauri::command]
pub async fn agent_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let handle = app.clone();
    // the socket work and the first connect never block the WebView thread
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut guard = state.settings.agent.lock().expect("agent lock");
        let conn = guard.get_or_insert_with(|| {
            let emitter = handle.clone();
            // The view is handed in: this callback fires while `agent_action` holds the slot, so it must
            // not lock it again (it did, once, and the first open of the panel hung forever).
            AgentConn::new(move |view| {
                let _ = emitter.emit("agent:state", view);
            })
        });
        let is_view_or_refresh = payload.get("action").and_then(Value::as_str).is_some_and(|a| a == "view" || a == "refresh");
        let connected = conn.view().get("connection").and_then(Value::as_str) == Some("connected");
        if !connected && is_view_or_refresh {
            let root = island_root(std::env::var("ABITO_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref());
            match root {
                Some(root) => conn.connect(&root),
                None => return Err(err("no_island_root")),
            }
        }
        conn.command(&payload).map_err(|_| err("agent_unavailable"))
    })
    .await
    .map_err(|_| err("agent_aborted"))?
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.settings.agent.lock().expect("agent lock").take();
    if let Some(c) = conn {
        c.close();
    }
}
