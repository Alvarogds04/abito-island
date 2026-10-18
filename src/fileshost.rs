//! #467 T11 host: the one closed "open in apps" command, `open_action`
//! (`{action: vscode | vscode_file | n8n, path?}`; see `files`).
//!
//! Main window only, on purpose: the callers are the island's "Open terminal" and the diff
//! card's ↗. Ajustes has no reason to launch an editor, so the F093 pin keeps it out.
use crate::{now_ms, AppState};
use abito_island::bridge::BridgeError;
use abito_island::files::{self, OpenRequest};
use abito_island::secrets::Keychain;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn open_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    // Gate, validate and spend the rate budget here; the effect (spawn / keychain D-Bus)
    // runs off the WebView thread.
    let mut request = None;
    {
        let mut rate = state.rate.lock().expect("rate lock");
        files::open_command(webview.label(), &origin, &payload, &mut rate, now_ms(), |r| {
            request = Some(r);
            Ok(true)
        })?;
    }
    let request = request.expect("validated request");
    let opened = tauri::async_runtime::spawn_blocking(move || match request {
        OpenRequest::N8n => files::open_n8n(&Keychain),
        editor => Ok(files::open_in_editor(&editor)),
    })
    .await
    .map_err(|_| BridgeError::denied("open aborted"))?
    .map_err(|reason| BridgeError::denied(&reason))?;
    Ok(serde_json::json!({ "opened": opened }))
}
