//! #306 host: the three closed IPC commands of the settings panel.
//!
//! - `agent_action`   → the island agent client (accounts, sign-in, connectors list);
//! - `prefs_action`   → sound, explicit optional display name and avatar colors (`prefs.json` v1);
//! - `hotkey_action`  → lives in `hotkeyhost.rs` (#305), reused as is.
//!
//! Every command validates the sender (the main webview only), takes the same shared
//! rate limiter as chat/models/questions and speaks a closed schema. The agent's
//! per-launch token and socket path never cross to the WebView (`agentclient`).
use crate::{now_ms, AppState};
use abito_island::agentconn::{island_root, AgentConn};
use abito_island::agentclient::{is_account_action, AccountStore};
use abito_island::bridge::{self, BridgeError};
use abito_island::prefs::{self, Command, Prefs};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct SettingsHost {
    agent: Mutex<Option<AgentConn>>,
    // Retained through disk commit and masked publication; never forwarded to the daemon.
    accounts: Mutex<Option<AccountStore>>,
    prefs: Mutex<Prefs>,
    prefs_serial: Mutex<()>, // commands retain this gate through publication
}

impl Default for SettingsHost {
    fn default() -> Self {
        SettingsHost { agent: Mutex::new(None), accounts: Mutex::new(None), prefs: Mutex::new(Prefs::default()), prefs_serial: Mutex::new(()) }
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

fn persist_prefs(app: &AppHandle, p: &Prefs) -> bool {
    let Some(path) = prefs_path(app) else { return false };
    let Some(dir) = path.parent() else { return false };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!(".{}.{}", prefs::FILE, std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let ok = options.open(&tmp)
        .and_then(|mut f| f.write_all(p.to_text().as_bytes()))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if ok.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    ok.is_ok()
}

/// Startup: load the prefs. The agent connection is made lazily, when the human opens Settings.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _serial = state.settings.prefs_serial.lock().expect("prefs transaction lock");
    *state.settings.prefs.lock().expect("prefs lock") = load_prefs(app);
    *state.settings.accounts.lock().expect("accounts lock") = app.path().app_config_dir().ok()
        .and_then(|dir| AccountStore::load(dir.join("accounts.json")).ok());
}

fn view_prefs(p: &Prefs) -> Value {
    json!({"sound": p.sound, "gain": p.gain(), "displayName": p.display_name, "avatarColors": p.avatar_colors})
}

/// Only the already loaded, explicitly selected local preference reaches chat.
pub fn display_name(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").display_name.clone()
}

/// #264 (GD049): the position the human last dragged the island to, read for the
/// FIRST geometry decision of a launch (before the window is placed) and for the
/// post-load pin. Read-only; the WebView never receives it.
pub fn saved_position(app: &AppHandle) -> Option<(i32, i32)> {
    let state = app.state::<AppState>();
    // the guard must drop before `state`: a tail expression would hold the borrow
    let position = state.settings.prefs.lock().expect("prefs lock").position;
    position
}

/// #264: commit the origin a drag release decided, through the SAME `prefs::transact`
/// gate, file and atomic writer as every other preference — so a settings change
/// after a drag can never drop this, and this write can never drop a settings change.
/// No publication: the position is not part of the settings view the WebView reads.
/// Failure leaves the previous position in memory (and on disk) for this launch.
pub fn save_position(app: &AppHandle, x: i32, y: i32) -> bool {
    let state = app.state::<AppState>();
    prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &prefs::Command::SetPosition(x, y),
        |p| persist_prefs(app, p),
        |_| {},
    ).is_ok()
}

/// Closed preference commands: view, sound_on/off, set_sound_gain (0..=0.2),
/// set_display_name, set/clear_avatar_color. Gain shares persistence and publication.
#[tauri::command]
pub async fn prefs_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let next = prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &command,
        |p| persist_prefs(&app, p),
        |snapshot| {
            // Snapshot belongs to this commit. The transaction gate still holds,
            // but the state mutex is free so publish_chat may re-read the name.
            let _ = app.emit("prefs:state", view_prefs(snapshot));
            if matches!(command, Command::SetDisplayName(_)) {
                crate::chathost::publish_chat(&app);
            }
        },
    ).map_err(|_| err("save_failed"))?;
    Ok(view_prefs(&next))
}

/// The island agent: `view` (connects on first use), and the closed command set of
/// `agentclient::parse_ui_command`. Abito account commands are committed locally before
/// any daemon connection; snapshots expose credential presence only.
#[tauri::command]
pub async fn agent_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    AccountStore::guard(webview.label(), &url, &mut state.chat_rate.lock().expect("chat rate lock"), now_ms())?;
    let handle = app.clone();
    // the socket work and the first connect never block the WebView thread
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        if is_account_action(&payload) {
            let mut accounts = state.settings.accounts.lock().expect("accounts lock");
            let store = accounts.as_mut().ok_or_else(|| err("account_store_unavailable"))?;
            let saved = store.command(&payload, |snapshot| {
                let _ = handle.emit("agent:state", json!({"ownedAccounts":snapshot}));
            })?;
            return Ok(json!({"ownedAccounts":saved}));
        }
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
            if let Some(reason) = handle.state::<abito_island::daemonhost::HostSlot>().failure() {
                conn.startup_failed(reason);
                return Ok(conn.view());
            }
            let root = island_root(std::env::var("ABITO_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref());
            match root {
                Some(root) => conn.connect(&root),
                None => return Err(err("no_island_root")),
            }
        }
        let mut view = conn.command(&payload).map_err(|_| err("agent_unavailable"))?;
        view["ownedAccounts"] = state.settings.accounts.lock().expect("accounts lock")
            .as_ref().map(AccountStore::view).unwrap_or(Value::Null);
        Ok(view)
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
