//! #306 host: the three closed IPC commands of the settings panel.
//!
//! - `agent_action`   → the island agent client (accounts, sign-in, connectors list);
//! - `prefs_action`   → sound, explicit optional display name, avatar colors and the
//!   system/light/dark theme (#380) (`prefs.json` v1);
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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// #390 GD027: how long a `restart` waits for the fresh daemon to answer `ready`.
/// The engine's own boot timeout is 60 s (desktop-daemon/src/runtime.cjs), so this
/// bound lets the daemon reach its own verdict first; past it the answer is honestly
/// `ready:false`, never a success. Polling is cheap (a missing session.json fails in
/// one stat) and bounded — no unbounded wait anywhere.
const RESTART_WAIT: Duration = Duration::from_secs(62);
const RESTART_POLL: Duration = Duration::from_millis(200);

pub struct SettingsHost {
    // #315: the tray derives its connection state from this slot's view
    // (try_lock only — never a blocking read inside publish).
    pub(crate) agent: Mutex<Option<AgentConn>>,
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
    json!({"sound": p.sound, "gain": p.gain(), "displayName": p.display_name, "avatarColors": p.avatar_colors,
        "mainPill": p.main_pill(), "declaredPills": p.declared_pills(),
        "pillColors": p.pill_colors,
        "theme": p.theme().as_str(),
        "chosenModels": p.chosen_models,
        "autoCloseSeconds": p.auto_close_seconds(), "openOnHover": p.open_on_hover(),
        "settingsWindow": p.settings_window_on(),
        "customBlobs": p.custom_blobs_view()})
}

/// Only the already loaded, explicitly selected local preference reaches chat.
pub fn display_name(host: &SettingsHost) -> Option<String> {
    host.prefs.lock().expect("prefs lock").display_name.clone()
}

/// #366 F093: the effective Ajustes placement, read by the settings window host
/// (the field is private to this module; the projection and this accessor are
/// the only readers outside `prefs.rs`).
pub fn settings_window_on(host: &SettingsHost) -> bool {
    host.prefs.lock().expect("prefs lock").settings_window_on()
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
/// set_display_name, set/clear_avatar_color, set_main_pill, toggle_declared_pill and
/// set_theme (system|light|dark). Pill actions take exactly action + id; selection never
/// installs or connects anything. The theme is #380's optional closed field.
#[tauri::command]
pub async fn prefs_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = prefs::parse_command(&payload).map_err(|_| err("invalid_schema"))?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let mut attempted_write = false;
    let next = prefs::transact(
        &state.settings.prefs_serial,
        &state.settings.prefs,
        &command,
        |p| { attempted_write = true; persist_prefs(&app, p) },
        |snapshot| {
            // Snapshot belongs to this commit. The transaction gate still holds,
            // but the state mutex is free so publish_chat may re-read the name.
            let _ = app.emit("prefs:state", view_prefs(snapshot));
            if matches!(command, Command::SetDisplayName(_)) {
                crate::chathost::publish_chat(&app);
            }
        },
    ).map_err(|_| {
        // Stateful refusal (main toggle / fifth addition) happens inside the
        // existing serial gate before persistence; a disk failure is different.
        let refused = !attempted_write && matches!(command, Command::SetMainPill(_) | Command::ToggleDeclaredPill(_));
        err(if refused { "invalid_schema" } else { "save_failed" })
    })?;
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

/// #408 — `settings_view`: the page tells Rust that Ajustes opened (`{"open":true}`) or closed. Rust owns
/// the size (geometry::settings_visible, clamped to the work area) and restores the previous chat
/// rectangle on close; the page never sends a number. Same sender gate and rate limiter as the others.
#[tauri::command]
pub async fn settings_view(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let open = parse_settings_view(&payload).ok_or_else(|| err("invalid_schema"))?;
    crate::chathost::switch_settings(&app, &state, open);
    Ok(json!({"open": open}))
}

/// The closed payload of `daemon_action` (#390 GD027): exactly `{"action":"status"|"restart"}`.
pub(crate) fn parse_daemon_action(payload: &Value) -> Option<&'static str> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("action")?.as_str()? {
        "status" => Some("status"),
        "restart" => Some("restart"),
        _ => None,
    }
}

/// The truth of the daemon is the CONNECTION: lazily create the client (like
/// `agent_action view`), connect when it is not connected, and — when `wait` is
/// given — keep trying until it answers `ready`, OUR OWN child dies, or the bound
/// expires. Holds the agent slot (the same rule as `agent_action`): the state
/// callback only emits, it never re-locks. Returns `(connection, own_child_gone)`
/// for the restart verdict; the page only ever sees `{action, ready, connection, outcome}`.
pub(crate) fn daemon_connect(
    handle: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    wait: Option<Duration>,
    watch: Option<&abito_island::daemonhost::HostSlot>,
) -> (String, bool) {
    let mut guard = state.settings.agent.lock().expect("agent lock");
    let emitter = handle.clone();
    let conn = guard.get_or_insert_with(|| {
        AgentConn::new(move |view| {
            let _ = emitter.emit("agent:state", view);
        })
    });
    let connected = |c: &AgentConn| c.view().get("connection").and_then(Value::as_str) == Some("connected");
    let deadline = wait.map(|w| Instant::now() + w);
    let mut own_gone = false;
    loop {
        // Try the connection FIRST: a stale `connected` must be refreshed honestly.
        if !connected(conn) {
            conn.connect(root);
        }
        if connected(conn) {
            break;
        }
        // A watched child that died without serving must not burn the whole bound.
        if watch.is_some_and(|w| w.pid().is_none()) {
            own_gone = true;
            break;
        }
        match deadline {
            Some(end) if Instant::now() < end => std::thread::sleep(RESTART_POLL),
            _ => break,
        }
    }
    let view = conn.view();
    let connection = view.get("connection").and_then(Value::as_str).unwrap_or("no_daemon").to_string();
    (connection, own_gone)
}

/// The pid in `<root>/runtime/session.json`, read ONLY to compare it with our own
/// child inside Rust (#390 fix). It never crosses to the page.
fn session_pid(root: &std::path::Path) -> Option<u32> {
    let text = std::fs::read_to_string(abito_island::agentconn::session_path(root)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("pid")?.as_u64()?.try_into().ok()
}

/// #390 fix — the closed verdict of a `restart`, decided ONLY from our own child:
/// `restarted` (our child serves the session it published), `refused` (our child never
/// spawned, GD029 rejected it and it died, or the session belongs to someone else — a
/// foreign motor we never touch), `timeout` (our child was still booting at the bound).
/// Never a pid.
pub(crate) fn restart_outcome(own: Option<u32>, session_pid: Option<u32>, own_alive: bool, connected: bool) -> &'static str {
    let Some(own) = own else { return "refused" };
    if connected {
        return if session_pid == Some(own) { "restarted" } else { "refused" };
    }
    if !own_alive {
        return "refused";
    }
    "timeout"
}

/// The restart answer: exactly `{action, ready, connection, outcome}` — no token, no pid, no path.
pub(crate) fn restart_response(action: &str, connection: &str, outcome: &'static str) -> Value {
    json!({ "action": action, "ready": connection == "connected", "connection": connection, "outcome": outcome })
}

/// #390 GD027 — the closed daemon lifecycle command behind the Ajustes button.
/// `status` reports the current state once (the fast path, unchanged). `restart` drops
/// the old client, stops the app-owned host child (bounded TERM/KILL/reap in
/// `daemonhost`), spawns it again and answers the CLOSED `outcome` — `restarted` |
/// `refused` | `timeout` — decided from our own child's pid vs `session.json`, never
/// exposed. `{action, ready, connection, outcome}`: no token, no pid, no path.
#[tauri::command]
pub async fn daemon_action(app: AppHandle, webview: tauri::Webview, state: State<'_, AppState>, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let action = parse_daemon_action(&payload).ok_or_else(|| err("invalid_schema"))?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let root = island_root(std::env::var("ABITO_ISLAND_DIR").ok().as_deref(), std::env::var("HOME").ok().as_deref())
            .ok_or_else(|| err("no_island_root"))?;
        if action == "restart" {
            // The old client (and its reader) go BEFORE its daemon; the fresh one below
            // starts from `no_daemon`, never from a stale `connected`.
            let old = state.settings.agent.lock().expect("agent lock").take();
            drop(old);
            // Bounded stop (daemonhost Drop: TERM group, KILL, reap) then a fresh spawn.
            let slot = handle.state::<abito_island::daemonhost::HostSlot>();
            slot.stop();
            slot.start();
            let own = slot.pid();
            let (connection, own_gone) = daemon_connect(&handle, &state, &root, Some(RESTART_WAIT), Some(&*slot));
            let connected = connection == "connected";
            let own_alive = !own_gone && slot.pid().is_some();
            let outcome = restart_outcome(own, session_pid(&root), own_alive, connected);
            return Ok(restart_response(action, &connection, outcome));
        }
        // status: the fast path — one honest attempt, same shape as before
        let (connection, _) = daemon_connect(&handle, &state, &root, None, None);
        Ok(json!({ "action": action, "ready": connection == "connected", "connection": connection }))
    })
    .await
    .map_err(|_| err("daemon_aborted"))?
}

/// The closed payload: exactly `{"open": <bool>}`.
pub(crate) fn parse_settings_view(payload: &Value) -> Option<bool> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    obj.get("open")?.as_bool()
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.settings.agent.lock().expect("agent lock").take();
    if let Some(c) = conn {
        c.close();
    }
}

#[cfg(test)]
mod settings_view_tests {
    use super::parse_daemon_action;
    use super::parse_settings_view;
    use super::restart_outcome;
    use super::restart_response;
    use super::view_prefs;
    use serde_json::json;

    #[test]
    fn the_settings_view_payload_is_exactly_one_boolean() {
        assert_eq!(parse_settings_view(&json!({"open": true})), Some(true));
        assert_eq!(parse_settings_view(&json!({"open": false})), Some(false));
        for bad in [json!({}), json!({"open": 1}), json!({"open": "true"}), json!({"open": true, "w": 900}), json!(true), json!(null), json!({"width": 900})] {
            assert_eq!(parse_settings_view(&bad), None, "{bad}");
        }
    }

    /// #390 fix: the verdict comes from OUR OWN child — a closed vocabulary, never a pid.
    #[test]
    fn restart_outcome_is_a_closed_vocabulary_from_the_own_child_verdict() {
        // the coordinator's fake: our child never spawned and nobody answers → refused (ready false)
        assert_eq!(restart_outcome(None, None, false, false), "refused");
        // no child of ours, but a foreign daemon answers session.json
        assert_eq!(restart_outcome(None, Some(1234), false, true), "refused");
        // our own child published the session and serves it
        assert_eq!(restart_outcome(Some(100), Some(100), true, true), "restarted");
        // connected, but the session belongs to someone else (ours never published)
        assert_eq!(restart_outcome(Some(100), Some(200), true, true), "refused");
        // our spawn was rejected (GD029) and the child died without serving
        assert_eq!(restart_outcome(Some(100), Some(200), false, false), "refused");
        assert_eq!(restart_outcome(Some(100), None, false, false), "refused");
        // still booting when the bound expired: honestly a timeout
        assert_eq!(restart_outcome(Some(100), None, true, false), "timeout");
        assert_eq!(restart_outcome(Some(100), Some(100), true, false), "timeout");
        for verdict in [
            restart_outcome(None, None, false, false),
            restart_outcome(Some(100), Some(100), true, true),
            restart_outcome(Some(100), None, true, false),
        ] {
            assert!(matches!(verdict, "restarted" | "refused" | "timeout"), "{verdict}");
        }
    }

    /// #390 fix: the restart answer carries exactly its four keys — no token, pid or path.
    #[test]
    fn restart_response_never_carries_a_token_pid_or_path() {
        let text = serde_json::to_string(&restart_response("restart", "connected", "restarted")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["action", "connection", "outcome", "ready"]);
        assert_eq!(value["ready"], json!(true));
        let late = restart_response("restart", "no_daemon", "timeout");
        assert_eq!(late["ready"], json!(false));
        assert_eq!(late["outcome"], json!("timeout"));
        for banned in ["token", "pid", "endpoint", "procStart", "/home/", "/proc/"] {
            assert!(!text.contains(banned), "{banned} leaked: {text}");
        }
    }

    /// #414: the chosen models of the connected providers reach the WebView only as the
    /// validated typed pref; nothing chosen projects as null, like every optional field.
    #[test]
    fn f414_the_webview_projection_carries_the_chosen_models() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let prefs = Prefs::from_text(Some(r#"{"v":1,"chosen_models":{"anthropic":["claude-sonnet-4-5"]}}"#));
        let view = view_prefs(&prefs);
        assert_eq!(view["chosenModels"], json!({"anthropic":["claude-sonnet-4-5"]}));
        assert_eq!(view_prefs(&Prefs::default())["chosenModels"], json!(null), "nothing chosen is null, like the other optional fields");
        // a round trip through the closed command keeps the projection
        let cmd = parse_command(&json!({"action":"set_chosen_models","provider":"openai","models":["gpt-5.2"]})).unwrap();
        let next = update(&prefs, &cmd, |_| true).unwrap();
        assert_eq!(view_prefs(&next)["chosenModels"], json!({"anthropic":["claude-sonnet-4-5"],"openai":["gpt-5.2"]}));
    }

    /// #366 F093: the projection carries the Ajustes placement choice — the
    /// in-island default (false) when no key is stored, the choice when present,
    /// and the default again when a hostile stored value was dropped at load.
    #[test]
    fn f093_the_webview_projection_carries_the_settings_window_choice() {
        use abito_island::prefs::Prefs;
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(defaults["settingsWindow"], json!(false), "absent reads as the in-island default");
        let saved = Prefs::from_text(Some(r#"{"v":1,"settings_window":true}"#));
        assert_eq!(view_prefs(&saved)["settingsWindow"], json!(true));
        let hostile = Prefs::from_text(Some(r#"{"v":1,"settings_window":"yes"}"#));
        assert_eq!(view_prefs(&hostile)["settingsWindow"], json!(false), "a dropped value reads as the default");
        // the established projection shapes are untouched
        assert_eq!(defaults["autoCloseSeconds"], json!(15));
        assert_eq!(defaults["theme"], json!("system"));
    }

    /// #346 F033: `pillColors` is the same projection shape as `avatarColors` — already
    /// validated colour names only, and a cleared pill simply has no key.
    #[test]
    fn f033_the_webview_projection_carries_validated_pill_colours_and_a_clear_drops_the_key() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let prefs = Prefs::from_text(Some(r#"{"v":1,"pill_colors":{"agent_amp":"mint"}}"#));
        let view = view_prefs(&prefs);
        assert_eq!(view["pillColors"], json!({"agent_amp":"mint"}), "same shape as avatarColors");
        assert_eq!(view["avatarColors"], json!({}), "the established field keeps its shape");
        let cleared = update(&prefs,
            &parse_command(&json!({"action":"clear_pill_color","id":"agent_amp"})).unwrap(), |_| true).unwrap();
        assert_eq!(view_prefs(&cleared)["pillColors"], json!({}), "a cleared pill projects no colour");
        // A hostile stored value is already dropped at load, so it never reaches the projection.
        let hostile = Prefs::from_text(Some(r#"{"v":1,"pill_colors":{"agent_amp":"<img src=x>"}}"#));
        assert_eq!(view_prefs(&hostile)["pillColors"], json!({}));
    }

    /// #415 WU2: created blobs reach the WebView only as validated name + palette
    /// colour entries; nothing created projects as null, like every optional field.
    #[test]
    fn f415_the_webview_projection_carries_created_blobs_or_null() {
        use abito_island::prefs::{parse_command, update, Prefs};
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(defaults["customBlobs"], json!(null), "nothing created projects as null");
        let prefs = Prefs::from_text(Some(
            r#"{"v":1,"custom_blobs":[{"name":"Abito GitHub","color":"green"},{"name":"Abito correo"}]}"#,
        ));
        let view = view_prefs(&prefs);
        assert_eq!(view["customBlobs"], json!([
            {"name":"Abito GitHub","color":"green"},
            {"name":"Abito correo","color":null},
        ]));
        // a round trip through the closed create command keeps the projection
        let cmd = parse_command(&json!({"action":"create_blob","name":"Abito Reviewer"})).unwrap();
        let next = update(&prefs, &cmd, |_| true).unwrap();
        let view = view_prefs(&next);
        assert_eq!(view["customBlobs"].as_array().unwrap().len(), 3);
        // a hostile stored file never reaches the projection
        let hostile = Prefs::from_text(Some(r#"{"v":1,"custom_blobs":[{"name":42},"junk"]}"#));
        assert_eq!(view_prefs(&hostile)["customBlobs"], json!(null));
    }

    /// #390 GD027: `daemon_action` is closed — exactly {"action":"status"|"restart"}.
    #[test]
    fn daemon_action_is_a_closed_two_action_payload() {
        assert_eq!(parse_daemon_action(&json!({"action": "status"})), Some("status"));
        assert_eq!(parse_daemon_action(&json!({"action": "restart"})), Some("restart"));
        for bad in [
            json!({}),
            json!({"action": "nope"}),
            json!({"action": "status", "extra": 1}),
            json!({"action": 1}),
            json!("restart"),
            json!(null),
            json!({"Action": "restart"}),
        ] {
            assert_eq!(parse_daemon_action(&bad), None, "{bad}");
        }
    }

    /// #336 T1b-a (L15): the projection carries the EFFECTIVE interaction
    /// values — the defaults (15 seconds / hover off) without any stored key,
    /// saved values when present, and the defaults again when a hostile file
    /// value was dropped at load. The established fields keep their shapes.
    #[test]
    fn f003_the_webview_projection_carries_the_effective_interaction_values() {
        use abito_island::prefs::Prefs;
        let defaults = view_prefs(&Prefs::default());
        assert_eq!(defaults["autoCloseSeconds"], json!(15));
        assert_eq!(defaults["openOnHover"], json!(false));
        let saved = Prefs::from_text(Some(r#"{"v":1,"auto_close_seconds":45,"open_on_hover":true}"#));
        let view = view_prefs(&saved);
        assert_eq!(view["autoCloseSeconds"], json!(45));
        assert_eq!(view["openOnHover"], json!(true));
        let hostile = Prefs::from_text(Some(r#"{"v":1,"auto_close_seconds":999,"open_on_hover":"yes"}"#));
        let view = view_prefs(&hostile);
        assert_eq!(view["autoCloseSeconds"], json!(15), "dropped values read as defaults");
        assert_eq!(view["openOnHover"], json!(false), "dropped values read as defaults");
        // the established projection shapes are untouched
        assert_eq!(view["pillColors"], json!({}));
        assert_eq!(view["theme"], json!("system"));
        assert_eq!(view["sound"], json!(false));
    }
}
