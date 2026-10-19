//! «OK Abito» host: the one closed `voice_action` command (status | set_prefs |
//! download_model | remove_model) and the wake loop. The microphone is only open
//! while the Voice switch is on AND the keyword model is installed.
//!
//! Adapted from Coucou NotchBuddy Voice/VoiceEngine.swift @71b773f, Copyright (c) 2026
//! Louis Raillé, MIT. Events for the island (the hook is wired by the island worker):
//! `voice-wake` {} when the phrase is heard, then `voice-command` {text} with what was
//! said after it (or `voice-timeout` {} when nothing was).
use crate::{now_ms, AppState};
use abito_island::bridge::{self, BridgeError};
use abito_island::speech::{self, audio, kws};
use abito_island::voicecmd::{self, Command, VoicePrefs};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct Listener {
    capture: Option<audio::Capture>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Listener {
    fn drop(&mut self) {
        // Closing the device drops the sender, which ends the worker.
        self.capture.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub struct Host {
    prefs: VoicePrefs,
    listener: Option<Listener>,
    last_error: Option<String>,
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de voz.".into() }
}

fn start_listener(app: &AppHandle) -> Result<Listener, String> {
    let spotter = kws::SherpaSpotter::load().ok_or("the wake-word model could not be loaded")?;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let handle = app.clone();
    let thread = std::thread::Builder::new()
        .name("abito-wake".into())
        .spawn(move || {
            let mut wake = kws::WakeLoop::new(spotter);
            while let Ok(chunk) = rx.recv() {
                for event in wake.feed(&chunk) {
                    match event {
                        kws::LoopEvent::Wake => {
                            let _ = handle.emit("voice-wake", json!({}));
                        }
                        kws::LoopEvent::Timeout => {
                            let _ = handle.emit("voice-timeout", json!({}));
                        }
                        kws::LoopEvent::Command(samples) => {
                            let text = speech::transcribe(&samples).unwrap_or_default();
                            let _ = handle.emit("voice-command", json!({ "text": text.trim() }));
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let capture = audio::Capture::start(audio::Source::Mic(None), move |s| {
        let _ = tx.send(s.to_vec());
    })?;
    Ok(Listener { capture: Some(capture), thread: Some(thread) })
}

/// Applies the preference and the model state: decide under the lock, open/close outside it.
fn sync(app: &AppHandle) {
    let slot = app.state::<Mutex<Host>>();
    let (want, running) = {
        let h = slot.lock().expect("voice host");
        (h.prefs.enabled && kws::KWS.is_present() && speech::is_ready(), h.listener.is_some())
    };
    if want && !running {
        let result = start_listener(app);
        let mut h = slot.lock().expect("voice host");
        match result {
            Ok(l) if h.prefs.enabled => {
                h.listener = Some(l);
                h.last_error = None;
            }
            Ok(l) => {
                drop(h);
                drop(l);
            }
            Err(e) => h.last_error = Some(e),
        }
    } else if !want && running {
        let old = slot.lock().expect("voice host").listener.take();
        std::thread::spawn(move || drop(old));
    }
}

pub fn start(app: &AppHandle) {
    app.manage(Mutex::new(Host { prefs: voicecmd::load_prefs_in(&voicecmd::prefs_dir()), listener: None, last_error: None }));
    let app = app.clone();
    std::thread::spawn(move || sync(&app));
}

fn status_json(app: &AppHandle) -> Value {
    let h = app.state::<Mutex<Host>>();
    let h = h.lock().expect("voice host");
    json!({
        "prefs": h.prefs,
        "kws": kws::status(),
        "downloadMb": kws::download_mb(),
        "parakeet": speech::status().parakeet,
        "listening": h.listener.is_some(),
        "error": h.last_error,
    })
}

#[tauri::command]
pub async fn voice_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    let command = voicecmd::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    tauri::async_runtime::spawn_blocking(move || match command {
        Command::Status => Ok(status_json(&app)),
        Command::SetPrefs(prefs) => {
            voicecmd::save_prefs_in(&voicecmd::prefs_dir(), &prefs).map_err(|_| err("save_failed"))?;
            app.state::<Mutex<Host>>().lock().expect("voice host").prefs = prefs;
            sync(&app);
            Ok(status_json(&app))
        }
        Command::Download => {
            let a = app.clone();
            kws::download(move |_| {
                let _ = a.emit("voice-model", status_json(&a));
                sync(&a);
            });
            Ok(status_json(&app))
        }
        Command::Remove => {
            let old = app.state::<Mutex<Host>>().lock().expect("voice host").listener.take();
            drop(old);
            kws::remove();
            Ok(status_json(&app))
        }
    })
    .await
    .map_err(|_| err("unavailable"))?
}
