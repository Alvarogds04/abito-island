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
use abito_island::prefs::Command as PrefsCommand;
use abito_island::voicecmd::{self, Command, VoicePrefs};
use abito_island::voiceintent::{self, Effect, Hands, MusicOp, Outcome, Session, World};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Runs voice effects against the real app. Every effect is one of the closed
/// `voiceintent::Effect` values; URLs are https and built by the planner.
struct AppHands {
    app: AppHandle,
}

impl Hands for AppHands {
    fn world(&self) -> World {
        let p = crate::settingshost::voice_prefs_snapshot(&self.app);
        let (running, playing, volume, now) = music_state(&self.app);
        World { main: p.main_pill().to_string(), active: p.declared_pills(), music_running: running, playing, volume, now_playing: now }
    }

    fn apply(&self, effect: &Effect) -> bool {
        match effect {
            Effect::Music(op) => music_control(&self.app, op),
            Effect::TogglePill(id) => crate::settingshost::voice_prefs_command(&self.app, &PrefsCommand::ToggleDeclaredPill(id.clone())).is_some(),
            Effect::SetMainPill(id) => crate::settingshost::voice_prefs_command(&self.app, &PrefsCommand::SetMainPill(id.clone())).is_some(),
            Effect::OpenUrl(url) => url.starts_with("https://") && spawn_detached("xdg-open", Some(url)),
            Effect::OpenApp(bin) => spawn_detached(bin, None),
            Effect::AskChat(text) => self.app.emit("voice-ask", json!({ "text": text })).is_ok(),
        }
    }
}

fn spawn_detached(program: &str, arg: Option<&str>) -> bool {
    let mut c = std::process::Command::new(program);
    if let Some(a) = arg {
        c.arg(a);
    }
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match c.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn music_state(app: &AppHandle) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    let s = crate::spotifyhost::state_of(app);
    (s.0, s.1, s.2, s.3)
}
#[cfg(not(target_os = "linux"))]
fn music_state(_app: &AppHandle) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    (false, false, 50, None)
}

fn music_control(app: &AppHandle, op: &MusicOp) -> bool {
    let action = match op {
        MusicOp::PlayPause => abito_island::spotify::Action::PlayPause,
        MusicOp::Next => abito_island::spotify::Action::Next,
        MusicOp::Previous => abito_island::spotify::Action::Previous,
        MusicOp::Volume(v) => abito_island::spotify::Action::Volume(*v),
    };
    crate::spotifyhost::control(app, action)
}

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

fn start_listener(app: &AppHandle, sensitivity: u8) -> Result<Listener, String> {
    let spotter = kws::SherpaSpotter::load(voicecmd::threshold_for(sensitivity)).ok_or("the wake-word model could not be loaded")?;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let handle = app.clone();
    let thread = std::thread::Builder::new()
        .name("abito-wake".into())
        .spawn(move || {
            let mut wake = kws::WakeLoop::new(spotter);
            let hands = AppHands { app: handle.clone() };
            let mut session = Session::default();
            while let Ok(chunk) = rx.recv() {
                for event in wake.feed(&chunk) {
                    match event {
                        kws::LoopEvent::Wake => {
                            let _ = handle.emit("voice-wake", json!({}));
                        }
                        kws::LoopEvent::Timeout => {
                            session.timeout();
                            let _ = handle.emit("voice-timeout", json!({}));
                        }
                        kws::LoopEvent::Command(samples) => {
                            let text = speech::transcribe(&samples).unwrap_or_default();
                            let text = voicecmd::split_wake(&text).unwrap_or(text);
                            let text = text.trim().to_string();
                            let _ = handle.emit("voice-command", json!({ "text": text }));
                            if text.is_empty() {
                                session.timeout();
                                continue;
                            }
                            let reply = session.handle(&text, &hands);
                            let outcome = match &reply.outcome {
                                Outcome::Success => "success",
                                Outcome::Failure => "failure",
                                Outcome::Question(_) => "question",
                            };
                            let _ = handle.emit("voice-result", json!({ "outcome": outcome, "message": reply.message, "lang": if reply.lang == voiceintent::Lang::En { "en" } else { "es" } }));
                            if reply.rearm {
                                wake.arm_command();
                            }
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
        let sens = slot.lock().expect("voice host").prefs.sensitivity;
        let result = start_listener(app, sens);
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
            let old = {
                let slot = app.state::<Mutex<Host>>();
                let mut h = slot.lock().expect("voice host");
                let changed = h.prefs.sensitivity != prefs.sensitivity;
                h.prefs = prefs;
                // The threshold is fixed when the spotter loads: reopen with the new one.
                if changed { h.listener.take() } else { None }
            };
            drop(old);
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
