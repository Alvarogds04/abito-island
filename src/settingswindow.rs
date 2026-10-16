//! #366 F093 host: Ajustes in its own window (opt-in).
//!
//! ONE closed command, `settings_window_action`, with exactly
//! `{"action":"open"|"close"}`. The typed pref (`prefs.json`
//! `settings_window`, T1) is the only chooser: `open` creates (or shows) the
//! window ONLY when the human opted in, and answers `{"open":false}`
//! otherwise so the page falls back to the in-island panel (#408 default).
//! Any failure is an error the page also falls back from — the island
//! default is never lost.
//!
//! The window is created by RUST ONLY: the label and the SAME page URL
//! (`index.html`, the same closed allowlist entry the island uses) never
//! come from the page. The window shares the main sender gate (extended to
//! the exact `settings` label, approved narrowly) and the shared rate
//! limiter. No secret, token or path crosses to the WebView here.

use crate::AppState;
use abito_island::bridge::{self, BridgeError};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// The exact window label the sender gate admits for the settings window.
/// The gate is exact-string (approved): no other label shares the bridge.
pub const SETTINGS_LABEL: &str = "settings";

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo abrir Ajustes en su ventana.".into() }
}

/// The closed payload: exactly `{"action":"open"}` or `{"action":"close"}` —
/// no URL, no label, no size: the window's identity is Rust's decision.
pub(crate) fn parse_settings_window_action(payload: &Value) -> Option<&'static str> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("action")?.as_str()? {
        "open" => Some("open"),
        "close" => Some("close"),
        _ => None,
    }
}

/// #366 F093: the typed pref is the ONLY chooser (pure, testable). Only the
/// human's explicit opt-in opens the own window; absent/`false` keeps the
/// in-island default (#408) and the answer tells the page to fall back.
pub(crate) fn opens_own_window(pref: Option<bool>) -> bool {
    pref == Some(true)
}

/// The window, created or shown by Rust only. A repeat `open` shows and
/// focuses the existing window instead of building a second one. The URL is
/// the SAME page as the island (the closed `index.html` entry); the window is
/// decorated, resizable and NOT always-on-top — it is a normal window.
fn open_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        win.show()?;
        let _ = win.unminimize();
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App(std::path::PathBuf::from("index.html")),
    )
    .title("Ajustes")
    .inner_size(760.0, 560.0)
    .min_inner_size(420.0, 360.0)
    .resizable(true)
    .build()
    .map(|_| ())
}

#[tauri::command]
pub async fn settings_window_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    // Same sender gate (main island or the settings window itself) and the
    // same shared rate limiter as every other closed command.
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(crate::now_ms())?;
    let action = parse_settings_window_action(&payload).ok_or_else(|| err("invalid_schema"))?;
    match action {
        "open" => {
            let pref = crate::settingshost::settings_window_on(&state.settings);
            if !opens_own_window(Some(pref)) {
                // The typed pref chose in-island: an honest answer, never an error.
                return Ok(json!({"action": "open", "open": false}));
            }
            open_window(&app).map_err(|e| {
                eprintln!("settings window open failed: {e}");
                err("window_failed")
            })?;
            Ok(json!({"action": "open", "open": true}))
        }
        // Closing asks the window to close; the ordinary CloseRequested path
        // (allowed for this label only) does the rest. A missing window is fine.
        _ => {
            if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
                let _ = win.close();
            }
            Ok(json!({"action": "close", "open": false}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{opens_own_window, parse_settings_window_action, SETTINGS_LABEL};
    use serde_json::json;

    /// #366 F093: the command payload is closed — exactly the two actions.
    #[test]
    fn f093_the_settings_window_command_is_exactly_open_or_close() {
        assert_eq!(parse_settings_window_action(&json!({"action": "open"})), Some("open"));
        assert_eq!(parse_settings_window_action(&json!({"action": "close"})), Some("close"));
        for bad in [
            json!({}),
            json!({"action": "focus"}),
            json!({"action": "open", "url": "https://evil.example/"}),
            json!({"action": "open", "label": "settings"}),
            json!({"action": 1}),
            json!("open"),
            json!(null),
            json!({"Action": "open"}),
            json!({"action": "open", "w": 900}),
        ] {
            assert_eq!(parse_settings_window_action(&bad), None, "{bad} must be refused");
        }
    }

    /// #366 F093: only the human's explicit opt-in opens the own window.
    #[test]
    fn f093_only_the_explicit_opt_in_opens_the_own_window() {
        assert!(opens_own_window(Some(true)));
        assert!(!opens_own_window(Some(false)), "false is the in-island default (#408)");
        assert!(!opens_own_window(None), "absent is the in-island default");
    }

    /// #366 F093: the label is the exact one the (narrowly extended) sender
    /// gate admits; it is a constant here so the gate and the window can
    /// never drift apart.
    #[test]
    fn f093_the_label_is_the_exact_string_the_gate_admits() {
        assert_eq!(SETTINGS_LABEL, "settings");
    }
}
