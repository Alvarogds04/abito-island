//! Closed dictation contract; no device access or Tauri dependencies.
use crate::flow::{self, portal::KeyStatus, store::Prefs};
use crate::speech::{audio::InputDevice, ModelsStatus};
use serde_json::{json, Value};

#[derive(Debug, PartialEq)]
pub enum Command {
    Status,
    SetPrefs(Prefs),
    Download,
    Remove,
    Key(flow::KeyEvent),
}

pub fn parse_command(payload: &Value, devices: &[String]) -> Option<Command> {
    let o = payload.as_object()?;
    match o.get("action")?.as_str()? {
        "status" if o.len() == 1 => Some(Command::Status),
        "download_model" if o.len() == 1 => Some(Command::Download),
        "remove_model" if o.len() == 1 => Some(Command::Remove),
        "hands_free" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::HandsFree)),
        "finish" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::Finish)),
        "cancel" if o.len() == 1 => Some(Command::Key(flow::KeyEvent::Cancel)),
        "set_prefs" if o.len() == 2 => {
            let value = o.get("prefs")?;
            let p = value.as_object()?;
            let keys = ["enabled", "key", "edge", "mic", "keepDays", "cleanup", "defaultStyle"];
            if p.len() != keys.len() || !keys.iter().all(|k| p.contains_key(*k)) {
                return None;
            }
            let prefs: Prefs = serde_json::from_value(value.clone()).ok()?;
            if prefs.cleanup || ![0, 7, 30, 365, -1].contains(&prefs.keep_days)
                || prefs.mic.len() > 200
                || (!prefs.mic.is_empty() && !devices.contains(&prefs.mic))
            {
                return None;
            }
            Some(Command::SetPrefs(prefs))
        }
        _ => None,
    }
}

pub fn status_json(prefs: &Prefs, models: ModelsStatus, key: KeyStatus, mics: Vec<InputDevice>) -> Value {
    let mut p = serde_json::to_value(prefs).expect("serializable prefs");
    for (k, v) in [("summaryEngine", json!("off")), ("openAtLaunch", json!(false)),
        ("voice", json!(false)), ("voiceOutput", json!("off")), ("voiceGender", json!("female"))] {
        p[k] = v;
    }
    let keys = if !prefs.enabled { "ok" } else { match key {
        KeyStatus::Active => "ok", KeyStatus::Pending => "pending",
        KeyStatus::Denied => "denied", KeyStatus::Unsupported => "unsupported",
    }};
    json!({"prefs":p,"models":models,"keys":keys,"hasClaudeKey":false,
        "mics":mics,"platform":"linux","autostarted":false})
}

pub fn event(update: flow::Update) -> (&'static str, Value) {
    use flow::{Note, Phase, Update};
    match update {
        Update::Phase(p) => ("dictation:phase", json!({"phase":match p {
            Phase::Idle => "idle", Phase::Listening => "listening", Phase::Locked => "locked",
            Phase::Thinking => "thinking", Phase::Copied => "copied", Phase::Failed => "failed",
        }})),
        Update::Bands(bands) => ("dictation:bands", json!({"bands":bands})),
        Update::Note(n) => ("dictation:note", json!({"note":match n {
            Note::NeedModel => "needModel", Note::NoMicrophone => "noMicrophone",
            Note::ClipboardRefused => "clipboardRefused",
        }})),
    }
}

pub fn models_event(models: ModelsStatus) -> (&'static str, Value) {
    ("dictation:models", json!(models))
}

/// Owns the running resources: same-state writes never restart; disabling drops them.
pub struct Engine<T> {
    pub running: Option<T>,
}
impl<T> Engine<T> {
    pub fn set_enabled(&mut self, enabled: bool, start: impl FnOnce() -> T) {
        if enabled && self.running.is_none() {
            self.running = Some(start());
        } else if !enabled {
            self.running.take();
        }
    }
}

/// What the caller must do after a decision taken under the host lock.
pub enum Plan<T> {
    Keep,
    /// Build the running resources OUTSIDE the lock, then `install` them.
    Start,
    /// Drop this OUTSIDE the lock: stopping joins the engine thread, which may be mid-transcription.
    Stop(T),
}
impl<T> Engine<T> {
    /// Decides only; never starts or stops anything itself, so it is safe under a mutex.
    /// `starting` is true while another caller is already building the resources.
    pub fn plan(&mut self, enabled: bool, starting: bool) -> Plan<T> {
        if !enabled {
            return self.running.take().map_or(Plan::Keep, Plan::Stop);
        }
        if self.running.is_none() && !starting { Plan::Start } else { Plan::Keep }
    }
    /// Stores freshly built resources if they are still wanted; otherwise gives them back to be dropped.
    pub fn install(&mut self, running: T, still_wanted: bool) -> Option<T> {
        if still_wanted && self.running.is_none() {
            self.running = Some(running);
            None
        } else {
            Some(running)
        }
    }
}

#[cfg(test)]
#[path = "dictation_cmd_tests.rs"]
mod tests;
