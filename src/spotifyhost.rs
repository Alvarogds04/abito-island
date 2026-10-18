//! #470 host: the `spotify_action` command and the `spotify:state` island event.
//!
//! One closed command (see `abito_island::spotify::parse_command`). `view` starts the MPRIS
//! listener and answers the current state; `stop` ends it; the rest drive Spotify. State is
//! pushed with `app.emit("spotify:state", …)` whenever Spotify's player moves. Linux only: other
//! platforms answer `unsupported` (the pill is offered on Linux only).
use abito_island::bridge::{self, BridgeError};
use abito_island::spotify::{self, Action};
use serde_json::{json, Value};
use tauri::{AppHandle, Webview};

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo controlar Spotify.".into() }
}

#[cfg(target_os = "linux")]
fn client(app: &AppHandle) -> &'static spotify::Client {
    use tauri::Emitter;
    static CLIENT: std::sync::OnceLock<spotify::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let app = app.clone();
        spotify::Client::new(None, move |state| {
            let _ = app.emit(spotify::STATE_EVENT, state);
        })
    })
}

/// `{"action": …}` closed set: view, stop, play_pause, next, previous, seek, shuffle, repeat,
/// volume. Answers `{ok, state}`; `ok` is false when Spotify is not running or refused.
#[tauri::command]
pub async fn spotify_action(app: AppHandle, webview: Webview, payload: Value) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let action = spotify::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    run(app, action).await
}

#[cfg(target_os = "linux")]
async fn run(app: AppHandle, action: Action) -> Result<Value, BridgeError> {
    // the D-Bus calls never block the WebView thread
    tauri::async_runtime::spawn_blocking(move || {
        let client = client(&app);
        let ok = match action {
            Action::View => {
                client.start();
                true
            }
            Action::Stop => {
                client.stop();
                true
            }
            control => client.control(control),
        };
        let state = if matches!(action, Action::View) { client.refresh().unwrap_or_else(|| client.state()) } else { client.state() };
        json!({ "ok": ok, "state": state })
    })
    .await
    .map_err(|_| err("unavailable"))
}

#[cfg(not(target_os = "linux"))]
async fn run(_app: AppHandle, _action: Action) -> Result<Value, BridgeError> {
    Err(err("unsupported"))
}
