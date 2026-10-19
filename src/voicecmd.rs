//! «OK Abito» settings contract: closed command parser, persisted preferences and
//! the wake-phrase splitter. No device access, no Tauri dependencies.
//!
//! Adapted from Coucou NotchBuddy Voice/{VoiceSettings,WakePhrase}.swift @71b773f,
//! Copyright (c) 2026 Louis Raillé, MIT.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    #[default]
    System,
    ElevenLabs,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Gender {
    #[default]
    Female,
    Male,
}

/// Off by default, exactly as in Coucou.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VoicePrefs {
    pub enabled: bool,
    pub output: Output,
    pub gender: Gender,
    /// 0..=100 wake-word sensitivity: higher hears «OK Abito» more easily (and mishears more).
    pub sensitivity: u8,
}

impl Default for VoicePrefs {
    fn default() -> Self {
        Self { enabled: false, output: Output::System, gender: Gender::Female, sensitivity: 50 }
    }
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Status,
    SetPrefs(VoicePrefs),
    Download,
    Remove,
}

pub fn parse_command(payload: &Value) -> Option<Command> {
    let o = payload.as_object()?;
    match o.get("action")?.as_str()? {
        "status" if o.len() == 1 => Some(Command::Status),
        "download_model" if o.len() == 1 => Some(Command::Download),
        "remove_model" if o.len() == 1 => Some(Command::Remove),
        "set_prefs" if o.len() == 2 => {
            let p = o.get("prefs")?.as_object()?;
            if p.len() != 4 || !["enabled", "output", "gender", "sensitivity"].iter().all(|k| p.contains_key(*k)) {
                return None;
            }
            p.get("enabled")?.as_bool()?;
            // An integer, clamped to 0..=100 (a negative or fractional value is rejected).
            let n = p.get("sensitivity")?.as_u64()?;
            let mut prefs: VoicePrefs = serde_json::from_value(Value::Object(
                p.iter().filter(|(k, _)| k.as_str() != "sensitivity").map(|(k, v)| (k.clone(), v.clone())).collect(),
            )).ok()?;
            prefs.sensitivity = n.min(100) as u8;
            Some(Command::SetPrefs(prefs))
        }
        _ => None,
    }
}

pub fn prefs_dir() -> PathBuf {
    crate::speech::data_dir().join("Voice")
}

pub fn load_prefs_in(dir: &Path) -> VoicePrefs {
    std::fs::read_to_string(dir.join("voice.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_prefs_in(dir: &Path, prefs: &VoicePrefs) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(prefs).map_err(std::io::Error::other)?;
    let tmp = dir.join("voice.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join("voice.json"))
}

fn norm(word: &str) -> String {
    word.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>().replace("okay", "ok")
}

/// Finds «ok abito» / «hey abito» (STT variants included) at a word boundary and returns
/// what follows the LAST occurrence, in its original casing. None when it is absent.
pub fn split_wake(raw: &str) -> Option<String> {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let normed: Vec<String> = words.iter().map(|w| norm(w)).collect();
    let is_name = |w: &str| matches!(w, "abito" | "abbito" | "avito" | "abeto");
    let mut end = None;
    let mut i = 0;
    while i + 1 < normed.len() {
        if matches!(normed[i].as_str(), "ok" | "hey" | "oye") && is_name(&normed[i + 1]) {
            end = Some(i + 2);
            i += 2;
        } else {
            i += 1;
        }
    }
    let end = end?;
    let tail = words[end..].join(" ");
    Some(tail.trim_start_matches(|c: char| !c.is_alphanumeric()).to_string())
}

#[cfg(test)]
#[path = "voicecmd_tests.rs"]
mod tests;
