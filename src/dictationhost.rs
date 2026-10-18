//! One gated command; shared store and engine live for the application lifetime.
use crate::{now_ms, AppState};
use abito_island::{bridge::{self, BridgeError}, dictation_cmd::{self as cmd, Command, Engine}, flow, speech};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Running {
    dict: flow::Dictation,
    key: flow::portal::HoldKey,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.dict.stop();
    }
}
pub struct Host {
    store: Arc<Mutex<flow::store::Store>>,
    engine: Engine<Running>,
}
impl Host {
    fn load() -> Self {
        Self { store: Arc::new(Mutex::new(flow::store::Store::load())), engine: Engine { running: None } }
    }
    fn sync(&mut self, app: &AppHandle) {
        let enabled = self.store.lock().expect("dictation store").prefs.enabled;
        let store = self.store.clone();
        let app = app.clone();
        self.engine.set_enabled(enabled, move || {
            if speech::is_ready() { speech::preload(); }
            let notify = Arc::new(move |update| {
                let (name, payload) = cmd::event(update);
                let _ = app.emit(name, payload);
            });
            let dict = flow::Dictation::start(store, flow::System, notify);
            let key = flow::portal::listen(dict.sender(), "Mantén pulsada la tecla para dictar", "CTRL+ALT+v");
            Running { dict, key }
        });
    }
}
pub fn start(app: &AppHandle) {
    let mut host = Host::load();
    host.sync(app);
    app.manage(Mutex::new(host));
}
fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de dictado.".into() }
}

#[tauri::command]
pub async fn dictation_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    tauri::async_runtime::spawn_blocking(move || {
        // Enumeration does not open a capture stream. Only status/pref validation need it.
        let devices = if payload["action"] == "set_prefs" { speech::audio::input_devices() } else { vec![] };
        let names = devices.into_iter().map(|d| d.name).collect::<Vec<_>>();
        let command = cmd::parse_command(&payload, &names).ok_or_else(|| err("invalid_schema"))?;
        let slot = app.state::<Mutex<Host>>();
        let mut host = slot.lock().expect("dictation host");
        match command {
            Command::Status => {
                let key = host.engine.running.as_ref().map(|r| r.key.status()).unwrap_or(flow::portal::KeyStatus::Active);
                let prefs = host.store.lock().expect("dictation store").prefs.clone();
                Ok(cmd::status_json(&prefs, speech::status(), key, speech::audio::input_devices()))
            }
            Command::SetPrefs(prefs) => {
                {
                    let mut store = host.store.lock().expect("dictation store");
                    store.prefs = prefs.clone();
                    store.save_prefs();
                }
                host.sync(&app);
                Ok(json!(prefs))
            }
            Command::Download => {
                let app = app.clone();
                speech::download(move |models| {
                    let (name, payload) = cmd::models_event(models);
                    let _ = app.emit(name, payload);
                });
                Ok(json!(speech::status()))
            }
            Command::Remove => {
                speech::remove(); // also unloads the recognizer
                Ok(json!(speech::status()))
            }
            Command::Key(event) => {
                if let Some(running) = &host.engine.running {
                    running.dict.send(event);
                    Ok(json!({"ok":true}))
                } else { Ok(json!({"ok":false})) }
            }
        }
    }).await.map_err(|_| err("unavailable"))?
}
