//! #489 host: the `integration_action` command and the `integration:update` island event.
//!
//! Adapted from Coucou windows/src-tauri/src/integrations.rs @71b773f, Copyright (c) 2026 Louis
//! Raillé, MIT (the timers and the emit; the pollers live in `abito_island::integrations`).
//! One thread per service wakes on Coucou's cadence and does NOTHING unless the human declared
//! that pill (main or declared) and saved its key: no declared pill, no request. The last update
//! of each service is cached so the card opens with data. The island window only.
use abito_island::bridge::{self, BridgeError};
use abito_island::integrations::{self as integ, Command, Http, NetError, Response, Seen, Update};
use abito_island::secrets::Keychain;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::AppState;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 1024 * 1024;

fn cache() -> &'static Mutex<HashMap<&'static str, Update>> {
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Update>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn seen() -> &'static Seen {
    static SEEN: OnceLock<Seen> = OnceLock::new();
    SEEN.get_or_init(Seen::default)
}

/// Real HTTP: https only (the loopback-http n8n is the one exception the poller itself
/// validated), no redirects, 10 s, body capped at 1 MiB, no cookies. Linux only for now.
struct Net;

#[cfg(target_os = "linux")]
impl Http for Net {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, NetError> {
        send(url, headers, None)
    }
    fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<Response, NetError> {
        send(url, headers, Some(body))
    }
}

#[cfg(target_os = "linux")]
fn send(url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, NetError> {
    {
        use std::str::FromStr;
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| NetError("client".into()))?;
        let mut request = match body {
            Some(b) => client.post(url).body(b.to_string()),
            None => client.get(url),
        };
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_str(name).map_err(|_| NetError("header".into()))?;
            let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| NetError("header".into()))?;
            request = request.header(name, value);
        }
        tauri::async_runtime::block_on(async move {
            let mut response = request.send().await.map_err(|_| NetError("request".into()))?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| NetError("body".into()))? {
                if body.len() + chunk.len() > MAX_BODY {
                    return Err(NetError("too large".into()));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Response { status, body: String::from_utf8_lossy(&body).into_owned() })
        })
    }
}

#[cfg(not(target_os = "linux"))]
impl Http for Net {
    fn get(&self, _: &str, _: &[(&str, &str)]) -> Result<Response, NetError> {
        Err(NetError("unsupported".into()))
    }
    fn post_json(&self, _: &str, _: &[(&str, &str)], _: &str) -> Result<Response, NetError> {
        Err(NetError("unsupported".into()))
    }
}

fn is_declared(app: &AppHandle, id: &str) -> bool {
    crate::settingshost::pill_declared(&app.state::<AppState>().settings, id)
}

/// Polls one service when it is declared; caches and emits what it says.
fn run_poll(app: &AppHandle, id: &'static str) {
    if !is_declared(app, id) {
        seen().forget(id.trim_start_matches("integration_"));
        cache().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        return;
    }
    if let Some(update) = integ::poll(id, &Net, &Keychain, seen()) {
        cache().lock().unwrap_or_else(|e| e.into_inner()).insert(id, update.clone());
        let _ = app.emit_to("main", integ::UPDATE_EVENT, update);
    }
}

/// Starts one timer thread per poller (Coucou's first-run delay and interval).
pub fn start(app: &AppHandle) {
    for (id, delay, every) in integ::POLLERS {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(delay));
            loop {
                run_poll(&app, id);
                std::thread::sleep(Duration::from_secs(every));
            }
        });
    }
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo consultar la integración.".into() }
}

/// `{action:"view"}` → `{updates:{<id>:Update}}` (cached, declared services only);
/// `{action:"refresh", id}` polls that service now, then answers like `view`.
#[tauri::command]
pub async fn integration_action(app: AppHandle, webview: Webview, payload: Value) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = integ::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Command::Refresh(id) = command {
            run_poll(&app, id);
        }
        let map = cache().lock().unwrap_or_else(|e| e.into_inner());
        let updates: serde_json::Map<String, Value> = map
            .iter()
            .filter(|(id, _)| is_declared(&app, id))
            .map(|(id, u)| (id.to_string(), serde_json::to_value(u).unwrap_or(Value::Null)))
            .collect();
        json!({ "updates": updates })
    })
    .await
    .map_err(|_| err("unavailable"))
}
