//! #306 — the small, non-secret preferences of the island that the settings panel
//! persists: the sound switch (the producer comes later; the setting is stored now) and
//! nothing else. Motion lives in `motion.json` (#304) and the shortcut in `hotkey.json`
//! (#305): ONE file per concern, each failing closed to its own default.
//!
//! `prefs.json` = `{"v":1,"sound":false}`. Absent, unreadable, corrupt, wrong version or a
//! non-boolean = the default: **sound OFF** (the island contract is silence until the
//! human opts in; docs/desktop-sound-catalog.md §2).
use serde_json::{json, Value};

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;

pub const FILE: &str = "prefs.json";

/// `Default` is derived on purpose: `bool::default()` is `false` = sound OFF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Prefs {
    pub sound: bool,
}

impl Prefs {
    pub fn from_text(text: Option<&str>) -> Prefs {
        let v = text.and_then(|t| serde_json::from_str::<Value>(t).ok());
        let Some(v) = v else { return Prefs::default() };
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Prefs::default();
        }
        Prefs { sound: v.get("sound").and_then(Value::as_bool).unwrap_or(false) }
    }

    pub fn to_text(&self) -> String {
        json!({"v": 1, "sound": self.sound}).to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    View,
    SoundOn,
    SoundOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// Exactly `{action:"view"|"sound_on"|"sound_off"}`; nothing else, no extra keys.
pub fn parse_command(payload: &Value) -> Result<Command, CommandError> {
    let map = payload.as_object().ok_or(CommandError)?;
    if map.len() != 1 {
        return Err(CommandError);
    }
    match map.get("action").and_then(Value::as_str) {
        Some("view") => Ok(Command::View),
        Some("sound_on") => Ok(Command::SoundOn),
        Some("sound_off") => Ok(Command::SoundOff),
        _ => Err(CommandError),
    }
}
