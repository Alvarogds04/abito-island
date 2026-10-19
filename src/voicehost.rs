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
use abito_island::voicespeak::{self, Engine, Voices};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::{json, Value};
use std::io::Write;
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

/// Real sound. The system voice is `spd-say`; ElevenLabs is the user's own key, asked only
/// when they chose it, with raw PCM played through `aplay`. Never used by tests.
struct RealVoices;

impl Voices for RealVoices {
    fn system(&self, text: &str, lang: voiceintent::Lang, gender: voicecmd::Gender) -> bool {
        std::process::Command::new("spd-say")
            .args(voicespeak::spd_args(text, lang, gender))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn eleven(&self, text: &str, gender: voicecmd::Gender) -> bool {
        use abito_island::secrets::{Keychain, SecretStore};
        let Some(key) = Keychain.read(voicespeak::KEY_NAME).ok().flatten().filter(|k| !k.is_empty()) else { return false };
        let run = async {
            let client = reqwest::Client::builder()
                .https_only(true)
                .timeout(std::time::Duration::from_secs(8))
                .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok()?;
            let list = client.get("https://api.elevenlabs.io/v1/voices").header("xi-api-key", &key).send().await.ok()?;
            if !list.status().is_success() {
                return None;
            }
            let voices: Value = serde_json::from_str(&list.text().await.ok()?).ok()?;
            let (id, _) = voicespeak::pick_voice(&voices, gender)?;
            let (url, body) = voicespeak::tts_request(&id, text);
            let r = client.post(url).header("xi-api-key", &key).header("content-type", "application/json").body(body).send().await.ok()?;
            if !r.status().is_success() {
                return None;
            }
            r.bytes().await.ok().filter(|b| !b.is_empty())
        };
        let audio = tokio::runtime::Builder::new_current_thread().enable_all().build().ok().and_then(|rt| rt.block_on(run));
        let Some(audio) = audio else { return false };
        let Ok(mut child) = std::process::Command::new("aplay")
            .args(voicespeak::PLAY_RAW_ARGS)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&audio);
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    }
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

fn slot_prefs(app: &AppHandle) -> VoicePrefs {
    app.state::<Mutex<Host>>().lock().expect("voice host").prefs
}

fn err(code: &str) -> BridgeError {
    BridgeError { code: code.into(), message: "No se pudo completar la acción de voz.".into() }
}

fn start_listener(app: &AppHandle, sensitivity: u8) -> Result<Listener, String> {
    let spotter = kws::SherpaSpotter::load(voicecmd::threshold_for(sensitivity)).ok_or("the wake-word model could not be loaded")?;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    // The microphone is ignored while Abito speaks, so it never hears itself.
    let speaking = Arc::new(AtomicBool::new(false));
    let gate = speaking.clone();
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
                            let prefs = slot_prefs(&handle);
                            let engine = {
                                use abito_island::secrets::{Keychain, SecretStore};
                                let has_key = Keychain.read(voicespeak::KEY_NAME).ok().flatten().is_some_and(|k| !k.is_empty());
                                voicespeak::engine_for(prefs.output, has_key)
                            };
                            if engine != Engine::None {
                                speaking.store(true, Ordering::Relaxed);
                                voicespeak::speak(&RealVoices, &reply.message, reply.lang, prefs.gender, engine);
                                // A short gap, then drop what the room echoed while it talked.
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                while rx.try_recv().is_ok() {}
                                speaking.store(false, Ordering::Relaxed);
                            }
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
        if !gate.load(Ordering::Relaxed) {
            let _ = tx.send(s.to_vec());
        }
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
