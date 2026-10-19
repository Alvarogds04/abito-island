//! #490 host: the closed `mail_action` command (see `mailcmd`). Main window only: the mail
//! card lives in the island. Same gate as `github_action` (known label + page URL, shared
//! rate limiter, closed schema). The keychain read is blocking D-Bus work and runs off the
//! WebView thread; the HTTPS send awaits on the async runtime.
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::mailcmd;
use abito_island::secrets::Keychain;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn mail_action(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &origin)?;
    let draft = mailcmd::parse_mail(&payload)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let creds = tauri::async_runtime::spawn_blocking(|| mailcmd::resend_credentials(&Keychain))
        .await
        .map_err(|_| BridgeError::denied("mail aborted"))?;
    Ok(match creds {
        Ok((key, from)) => mailcmd::outcome(mailcmd::send_resend(mailcmd::RESEND_URL, &key, &from, &draft).await),
        Err(answer) => answer,
    })
}
