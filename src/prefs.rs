//! Non-secret island preferences, stored as v1. Missing or invalid fields use
//! their own defaults: sound OFF, no display name, no color overrides and the
//! system theme (#380). Names are explicit input,
//! never obtained from accounts, the OS, or another profile.
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;

pub const FILE: &str = "prefs.json";
pub const DISPLAY_NAME_MAX: usize = 80;

/// The colours a human may store for an identity (#384). `green` is the principal's DEFAULT,
/// not a prohibition: Ajustes may keep it or choose another one for any identity.
pub const COLORS: [&str; 5] = ["green", "blue", "mint", "orange", "purple"];

/// The optional colour map. It is absent from a file nobody customised, so an untouched
/// `prefs.json` keeps exactly the bytes it had before #384.
const AVATAR_COLORS: &str = "avatar_colors";

/// The optional theme mode key (#380). Absent = `system`, and absence is preserved.
const THEME: &str = "theme";

/// #380: the closed theme mode. `System` is the DEFAULT and is also what an absent
/// `theme` field means, so a file nobody changed never grows the key.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

/// The stored theme mode: an explicit choice, or nothing at all (= system).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// Closed enum: only the three known modes parse, everything else is refused.
    pub fn parse(value: &str) -> Option<Theme> {
        match value {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }
}

/// Identities are the same closed slug shape the frontend enforces (avatar-colors.js
/// `IDENTITY`): bounded, lowercase, no path or control characters.
const MAX_IDENTITY: usize = 32;

/// The connector/provider identities (avatar-colors.js `PROVIDERS`, settings-view.js
/// `AGENT_IDS`, notify-view.js `KNOWN_AGENTS`). They are NOT sub-Abitos, so the store refuses
/// to hold a colour for one: keeping a preference the panel would never apply would be a
/// silent lie in the file.
const PROVIDERS: [&str; 4] = ["claude-code", "codex", "opencode", "pi"];

/// Keys that must never travel from a preferences file into a plain object's prototype.
const RESERVED: [&str; 3] = ["__proto__", "prototype", "constructor"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Prefs {
    pub sound: bool,
    /// Optional v1 gain; absence retains the engine default without rewriting old files.
    pub gain: Option<f64>,
    pub display_name: Option<String>,
    /// Canonical identity -> validated color. Orphan keys are retained, not cleaned up.
    pub avatar_colors: BTreeMap<String, String>,
    /// #380 optional theme mode. `None` means the default (`system`) and is never written,
    /// so an untouched or unknown-valued file keeps the bytes it had.
    pub theme: Option<Theme>,
}

fn validated_name(value: &str) -> Result<Option<String>, CommandError> {
    if value.chars().count() > DISPLAY_NAME_MAX || value.chars().any(char::is_control) {
        return Err(CommandError);
    }
    let name = value.trim();
    Ok((!name.is_empty()).then(|| name.to_owned()))
}

/// The closed identity shape (avatar-colors.js `IDENTITY`): one leading lowercase letter or
/// digit, then letters, digits, `.`, `_` or `-`, at most 32 characters, never a prototype key
/// and never a provider/CLI slug.
fn valid_identity(identity: &str) -> bool {
    if identity.is_empty()
        || identity.len() > MAX_IDENTITY
        || RESERVED.contains(&identity)
        || PROVIDERS.contains(&identity)
    {
        return false;
    }
    let mut bytes = identity.bytes();
    let Some(first) = bytes.next() else { return false };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-')
}

/// The stored colours that survive validation. Everything else is dropped, and nothing here can
/// panic on a hostile or damaged preferences file.
fn colors_from(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (identity, color) in map {
        let Some(color) = color.as_str() else { continue };
        if valid_identity(identity) && COLORS.contains(&color) {
            out.insert(identity.clone(), color.to_string());
        }
    }
    out
}

impl Prefs {
    pub fn gain(&self) -> f64 { self.gain.filter(|n| valid_gain(*n)).unwrap_or(0.12) }

    /// The effective mode: an absent or unreadable field is `system`.
    pub fn theme(&self) -> Theme { self.theme.unwrap_or_default() }

    pub fn from_text(text: Option<&str>) -> Prefs {
        let v = text.and_then(|t| serde_json::from_str::<Value>(t).ok());
        let Some(v) = v else { return Prefs::default() };
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Prefs::default();
        }
        Prefs {
            sound: v.get("sound").and_then(Value::as_bool).unwrap_or(false),
            gain: v.get("gain").and_then(Value::as_f64).filter(|n| valid_gain(*n)),
            avatar_colors: colors_from(v.get(AVATAR_COLORS)),
            display_name: v.get("display_name").and_then(Value::as_str)
                .and_then(|name| validated_name(name).ok()).flatten(),
            theme: v.get(THEME).and_then(Value::as_str).and_then(Theme::parse),
        }
    }

    pub fn to_text(&self) -> String {
        let mut v = json!({"v": 1, "sound": self.sound});
        if let Some(gain) = self.gain.filter(|n| valid_gain(*n)) {
            v["gain"] = json!(gain);
        }
        if let Some(name) = &self.display_name {
            v["display_name"] = json!(name);
        }
        if !self.avatar_colors.is_empty() {
            v[AVATAR_COLORS] = json!(self.avatar_colors);
        }
        if let Some(theme) = self.theme {
            v[THEME] = json!(theme.as_str());
        }
        v.to_string()
    }
}

fn valid_gain(n: f64) -> bool { n.is_finite() && (0.0..=0.2).contains(&n) }

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    View,
    SoundOn,
    SoundOff,
    SetSoundGain(f64),
    SetDisplayName(String),
    SetAvatarColor { identity: String, color: String },
    ClearAvatarColor { identity: String },
    SetTheme(Theme),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// Closed schema: existing actions take one key; set_display_name takes exactly
/// action + display_name (string, <=80 scalars, no controls). Blank clears it.
/// set_avatar_color takes exactly action + identity + color; clear_avatar_color
/// takes exactly action + identity; set_theme takes exactly action + theme with
/// one of the three closed modes. All writers retain the other optional fields.
pub fn parse_command(payload: &Value) -> Result<Command, CommandError> {
    let map = payload.as_object().ok_or(CommandError)?;
    match map.get("action").and_then(Value::as_str) {
        Some("view") if map.len() == 1 => Ok(Command::View),
        Some("sound_on") if map.len() == 1 => Ok(Command::SoundOn),
        Some("sound_off") if map.len() == 1 => Ok(Command::SoundOff),
        Some("set_sound_gain") if map.len() == 2 => {
            let gain = map.get("gain").and_then(Value::as_f64).ok_or(CommandError)?;
            if !valid_gain(gain) { return Err(CommandError); }
            Ok(Command::SetSoundGain(gain))
        }
        Some("set_display_name") if map.len() == 2 => {
            let name = map.get("display_name").and_then(Value::as_str).ok_or(CommandError)?;
            validated_name(name)?;
            Ok(Command::SetDisplayName(name.to_owned()))
        }
        Some("set_avatar_color") if map.len() == 3 => {
            let identity = map.get("identity").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_identity(identity) || !COLORS.contains(&color) {
                return Err(CommandError);
            }
            Ok(Command::SetAvatarColor { identity: identity.to_string(), color: color.to_string() })
        }
        Some("clear_avatar_color") if map.len() == 2 => {
            let identity = map.get("identity").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_identity(identity) {
                return Err(CommandError);
            }
            Ok(Command::ClearAvatarColor { identity: identity.to_string() })
        }
        Some("set_theme") if map.len() == 2 => {
            let theme = map.get("theme").and_then(Value::as_str).ok_or(CommandError)?;
            Ok(Command::SetTheme(Theme::parse(theme).ok_or(CommandError)?))
        }
        _ => Err(CommandError),
    }
}

/// Change only the selected field. Validate direct callers as well as IPC input.
pub fn apply(current: &Prefs, command: &Command) -> Result<Prefs, CommandError> {
    let mut next = current.clone();
    match command {
        Command::View => {}
        Command::SoundOn => next.sound = true,
        Command::SoundOff => next.sound = false,
        Command::SetSoundGain(gain) => {
            if !valid_gain(*gain) { return Err(CommandError); }
            next.gain = Some(*gain);
        }
        Command::SetDisplayName(name) => next.display_name = validated_name(name)?,
        Command::SetAvatarColor { identity, color } => {
            if !valid_identity(identity) || !COLORS.contains(&color.as_str()) {
                return Err(CommandError);
            }
            next.avatar_colors.insert(identity.clone(), color.clone());
        }
        Command::ClearAvatarColor { identity } => {
            if !valid_identity(identity) { return Err(CommandError); }
            next.avatar_colors.remove(identity);
        }
        Command::SetTheme(theme) => next.theme = Some(*theme),
    }
    Ok(next)
}

/// Persistence precedes publication. The caller retains current on error and
/// installs the returned value only on success. View/idempotent writes skip disk.
pub fn update(current: &Prefs, command: &Command, persist: impl FnOnce(&Prefs) -> bool) -> Result<Prefs, CommandError> {
    let next = apply(current, command)?;
    if next != *current && !persist(&next) {
        return Err(CommandError);
    }
    Ok(next)
}

/// Serialize a whole preference command, including its publication. Every writer
/// must share the same gate and state mutex. The callback runs with the state
/// mutex released (chat may re-read it), but with the gate held: another command
/// cannot commit or publish ahead of this snapshot. Callbacks must not re-enter
/// transact. Failed persistence never installs state or invokes publish.
pub fn transact(
    serial: &std::sync::Mutex<()>,
    current: &std::sync::Mutex<Prefs>,
    command: &Command,
    persist: impl FnOnce(&Prefs) -> bool,
    publish: impl FnOnce(&Prefs),
) -> Result<Prefs, CommandError> {
    let _serial = serial.lock().expect("prefs transaction lock");
    let (next, changed) = {
        let mut current = current.lock().expect("prefs lock");
        let next = update(&current, command, persist)?;
        let changed = next != *current;
        *current = next.clone();
        (next, changed)
    };
    if changed {
        publish(&next);
    }
    Ok(next)
}
