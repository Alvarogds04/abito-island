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

/// #366 F093: commands that act on the MAIN island window (drag, desktop verbs)
/// are for the island webview only. The settings window runs the same page, so
/// these refuse any label that is not exactly `main` (exact, case-sensitive).
pub(crate) fn main_window_only(label: &str) -> Result<(), BridgeError> {
    if label == "main" {
        Ok(())
    } else {
        Err(BridgeError::denied("wrong window label"))
    }
}

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
    use super::{main_window_only, opens_own_window, parse_settings_window_action, SETTINGS_LABEL};
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

    /// #366 F093: island-window commands refuse every label but the exact `main`.
    #[test]
    fn f093_main_window_commands_refuse_the_settings_label() {
        assert!(main_window_only("main").is_ok());
        for label in ["settings", "Main", "main2", "main ", "", "Settings"] {
            let e = main_window_only(label).expect_err(label);
            assert_eq!(e.code, "denied", "{label:?}");
        }
    }

    /// #366 F093 source contract: each command acting on the MAIN island window
    /// calls the label gate before touching anything.
    #[test]
    fn f093_the_four_island_commands_check_the_label_first() {
        let src = include_str!("main.rs");
        for name in ["fn drag_press(", "fn drag_move(", "fn drag_release(", "async fn desktop_action("] {
            let at = src.find(name).unwrap_or_else(|| panic!("{name} missing"));
            let body = &src[at..];
            let end = body.find("\n}\n").unwrap_or(body.len());
            let head: String = body[..end].lines().take(8).collect::<Vec<_>>().join("\n");
            assert!(head.contains("main_window_only(webview.label())"), "{name} must gate on the label first:\n{head}");
        }
    }

    /// #366 F093: the commands reachable from the `settings` label are pinned EXACTLY. Every
    /// other Tauri command must call `main_window_only` near its top, so a future command can
    /// never silently become reachable from the settings window.
    #[test]
    fn f093_the_commands_reachable_from_settings_are_pinned_exactly() {
        const REACHABLE: [&str; 7] = [
            "agent_action", "daemon_action", "hotkey_action", "models_action",
            "prefs_action", "settings_window_action", "specialists_action",
        ];
        let needle = concat!("#[tauri", "::command]");
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut ungated = std::collections::BTreeSet::new();
        let mut all = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(dir).expect("src dir") {
            let path = entry.expect("entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") { continue; }
            let text = std::fs::read_to_string(&path).expect("read");
            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim() != needle { continue; }
                let Some(off) = lines[i + 1..].iter().position(|l| l.contains("fn ")) else { continue };
                let decl = lines[i + 1 + off];
                let fname = decl.split("fn ").nth(1).and_then(|r| r.split('(').next()).unwrap_or("").trim().to_string();
                let window = lines[i + 1..(i + 16).min(lines.len())].join("\n");
                all.insert(fname.clone());
                if !window.contains("main_window_only(") { ungated.insert(fname); }
            }
        }
        let want: std::collections::BTreeSet<String> = REACHABLE.iter().map(|s| s.to_string()).collect();
        assert_eq!(ungated, want, "commands reachable from the settings label changed");
        assert!(all.len() >= 20, "the scan must see every command, saw {all:?}");
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
