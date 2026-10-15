//! Non-secret island preferences, stored as v1. Missing or invalid fields use
//! their own defaults: sound OFF, no display name, no color overrides, no remembered
//! island position and the system theme (#380). Names are explicit input,
//! never obtained from accounts, the OS, or another profile.
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;

pub const FILE: &str = "prefs.json";
pub const DISPLAY_NAME_MAX: usize = 80;

// #345 immutable catalog identities, shared contract with frontend/pill-catalog.js.
// Platform eligibility is declaration-only; it never means connected.
pub const MAIN_PILLS: [&str; 4] = ["integration_claude", "agent_cursor", "agent_antigravity", "agent_codex"];
pub const DEFAULT_MAIN_PILL: &str = "integration_claude";
pub const MAX_DECLARED_PILLS: usize = 4;
pub const DEFAULT_DECLARED_PILLS: [&str; 4] = ["integration_resend", "integration_n8n", "integration_vercel", "integration_github"];
pub const PILL_IDS: [&str; 25] = [
    "integration_claude", "agent_cursor", "agent_antigravity", "agent_codex",
    "agent_gemini", "agent_copilot", "agent_muse", "agent_opencode", "agent_amp",
    "agent_hermes", "agent_claude-desktop", "ai_anthropic", "ai_google", "ai_openai",
    "ai_ollama", "ai_lmstudio", "integration_resend", "integration_n8n",
    "integration_vercel", "integration_github", "integration_notion",
    "integration_calcom", "integration_stripe", "integration_music", "integration_spotify",
];
pub fn pill_offered(id: &str) -> bool {
    PILL_IDS.contains(&id) && id != "integration_music" &&
        (id != "agent_claude-desktop" || cfg!(target_os = "windows")) &&
        (id != "integration_spotify" || cfg!(target_os = "linux"))
}

/// The colours a human may store for an identity (#384). `green` is the principal's DEFAULT,
/// not a prohibition: Ajustes may keep it or choose another one for any identity.
pub const COLORS: [&str; 5] = ["green", "blue", "mint", "orange", "purple"];

/// The optional colour map. It is absent from a file nobody customised, so an untouched
/// `prefs.json` keeps exactly the bytes it had before #384.
const AVATAR_COLORS: &str = "avatar_colors";

/// #264 (GD049): the optional remembered island position (physical px). Absent from a
/// file nobody has dragged, so an untouched `prefs.json` keeps exactly the bytes it had
/// before #264 as well.
const POSITION: &str = "position";

/// A plausible virtual-desktop coordinate in physical px: no real monitor
/// arrangement reaches this, so a larger value is corrupt data, never a desktop.
const POSITION_LIMIT: u32 = 1_000_000;
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
    /// #264: the origin the human last dragged the island to, physical px. Written by
    /// the native drag path only (see [`Command::SetPosition`]), never from the WebView.
    pub position: Option<(i32, i32)>,
    /// Absent keys retain defaults without growing untouched v1 files.
    pub main_pill: Option<String>,
    pub declared_pills: Option<Vec<String>>,
    /// #346 F033: canonical pill id -> validated palette colour (one of COLORS).
    /// Unknown ids and non-palette values are dropped on load; empty is never written.
    pub pill_colors: BTreeMap<String, String>,
    /// #380 optional theme mode. `None` means the default (`system`) and is never written,
    /// so an untouched or unknown-valued file keeps the bytes it had.
    pub theme: Option<Theme>,
    /// #336 T1b-a: the configured inactivity delay in seconds (5..=120). `None` means
    /// the default 15 and is never written, so an untouched file keeps its bytes.
    pub auto_close_seconds: Option<u16>,
    /// #336 T1b-a: whether a trusted mouse entry may open the settled compact island.
    /// `None` means the default (off) and is never written.
    pub open_on_hover: Option<bool>,
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

/// `unsigned_abs` instead of `abs`: `i32::MIN.abs()` overflows, and a damaged file
/// must never panic the island.
fn valid_position(x: i32, y: i32) -> bool {
    x.unsigned_abs() <= POSITION_LIMIT && y.unsigned_abs() <= POSITION_LIMIT
}

/// The stored position, accepted only as a complete, bounded `{"x":..,"y":..}` pair —
/// a closed shape, like the IPC schema, so a padded, truncated or wrongly typed object
/// reads as *no position* (the default placement) instead of a guess.
fn position_from(value: Option<&Value>) -> Option<(i32, i32)> {
    let map = value?.as_object()?;
    if map.len() != 2 {
        return None;
    }
    let x = i32::try_from(map.get("x")?.as_i64()?).ok()?;
    let y = i32::try_from(map.get("y")?.as_i64()?).ok()?;
    valid_position(x, y).then_some((x, y))
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

/// #346: pill colours are stricter than the avatar map — only a real catalog id with a
/// palette name survives, so an unknown pill or an off-set colour reads as *no colour*
/// and never grows the stored catalogue (the `main_pill` reading rule, mirrored).
fn pill_colors_from(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (id, color) in map {
        let Some(color) = color.as_str() else { continue };
        if PILL_IDS.contains(&id.as_str()) && COLORS.contains(&color) {
            out.insert(id.clone(), color.to_string());
        }
    }
    out
}

impl Prefs {
    pub fn gain(&self) -> f64 { self.gain.filter(|n| valid_gain(*n)).unwrap_or(0.12) }

    pub fn main_pill(&self) -> &str {
        self.main_pill.as_deref().filter(|id| MAIN_PILLS.contains(id)).unwrap_or(DEFAULT_MAIN_PILL)
    }

    pub fn declared_pills(&self) -> Vec<String> {
        let defaults: Vec<String> = DEFAULT_DECLARED_PILLS.iter().map(|id| id.to_string()).collect();
        let mut clean = Vec::new();
        for id in self.declared_pills.as_ref().unwrap_or(&defaults) {
            if id != self.main_pill() && pill_offered(id) && !clean.contains(id) && clean.len() < MAX_DECLARED_PILLS {
                clean.push(id.clone());
            }
        }
        clean
    }

    fn valid_pill_choices(&self) -> bool {
        self.main_pill.as_deref().is_none_or(|id| MAIN_PILLS.contains(&id)) &&
            self.declared_pills.as_ref().is_none_or(|ids| *ids == self.declared_pills())
    }
    /// The effective mode: an absent or unreadable field is `system`.
    pub fn theme(&self) -> Theme { self.theme.unwrap_or_default() }

    /// #336: the effective delay — an absent or out-of-range stored value reads
    /// as the public contract's default of 15 seconds.
    pub fn auto_close_seconds(&self) -> u16 {
        self.auto_close_seconds.filter(|s| (5..=120).contains(s)).unwrap_or(15)
    }

    /// #336: the effective hover policy — absent means off.
    pub fn open_on_hover(&self) -> bool { self.open_on_hover.unwrap_or(false) }

    pub fn from_text(text: Option<&str>) -> Prefs {
        let v = text.and_then(|t| serde_json::from_str::<Value>(t).ok());
        let Some(v) = v else { return Prefs::default() };
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Prefs::default();
        }
        let mut prefs = Prefs {
            sound: v.get("sound").and_then(Value::as_bool).unwrap_or(false),
            gain: v.get("gain").and_then(Value::as_f64).filter(|n| valid_gain(*n)),
            avatar_colors: colors_from(v.get(AVATAR_COLORS)),
            display_name: v.get("display_name").and_then(Value::as_str)
                .and_then(|name| validated_name(name).ok()).flatten(),
            position: position_from(v.get(POSITION)),
            main_pill: v.get("main_pill").and_then(Value::as_str)
                .filter(|id| MAIN_PILLS.contains(id)).map(str::to_owned),
            declared_pills: v.get("declared_pills").and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
            pill_colors: pill_colors_from(v.get("pill_colors")),
            theme: v.get(THEME).and_then(Value::as_str).and_then(Theme::parse),
            auto_close_seconds: v.get("auto_close_seconds").and_then(Value::as_u64)
                .and_then(|s| u16::try_from(s).ok()).filter(|s| (5..=120).contains(s)),
            open_on_hover: v.get("open_on_hover").and_then(Value::as_bool),
        };
        if prefs.declared_pills.is_some() { prefs.declared_pills = Some(prefs.declared_pills()); }
        prefs
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
        if let Some((x, y)) = self.position.filter(|(x, y)| valid_position(*x, *y)) {
            v[POSITION] = json!({"x": x, "y": y});
        }
        if self.main_pill.is_some() { v["main_pill"] = json!(self.main_pill()); }
        if self.declared_pills.is_some() { v["declared_pills"] = json!(self.declared_pills()); }
        if !self.pill_colors.is_empty() { v["pill_colors"] = json!(self.pill_colors); }
        if let Some(theme) = self.theme {
            v[THEME] = json!(theme.as_str());
        }
        if let Some(seconds) = self.auto_close_seconds.filter(|s| (5..=120).contains(s)) {
            v["auto_close_seconds"] = json!(seconds);
        }
        if let Some(hover) = self.open_on_hover {
            v["open_on_hover"] = json!(hover);
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
    /// #264: the native drag path remembers where the island was released. Deliberately
    /// NOT produced by [`parse_command`]: the WebView can read neither the position nor
    /// the fact that one is stored.
    SetPosition(i32, i32),
    SetMainPill(String),
    ToggleDeclaredPill(String),
    /// #346 F033: colour of one offered pill, or its removal (palette name in, key out).
    SetPillColor { id: String, color: String },
    ClearPillColor(String),
    SetTheme(Theme),
    /// #336 T1b-a: the island's inactivity interaction as one exact closed
    /// shape — integer `auto_close_seconds` 5..=120 and `open_on_hover`.
    SetIslandInteraction { auto_close_seconds: u16, open_on_hover: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError;

/// Closed schema: existing actions take one key; set_display_name takes exactly
/// action + display_name (string, <=80 scalars, no controls). Blank clears it.
/// set_avatar_color takes exactly action + identity + color; clear_avatar_color
/// takes exactly action + identity. Pill choices take exactly action + id:
/// set_main_pill (workspace only), toggle_declared_pill (offered catalog only).
/// set_pill_color takes exactly action + id + color (a COLORS name, offered catalog only),
/// clear_pill_color exactly action + id (same gate).
/// apply checks main exclusion/capacity under the transaction gate. All writers
/// apply checks main exclusion/capacity under the transaction gate. set_theme takes exactly
/// action + theme with one of the three closed modes. All writers retain the other known
/// typed optional fields; unknown file keys are dropped.
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
        Some(action @ ("set_main_pill" | "toggle_declared_pill")) if map.len() == 2 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            if action == "set_main_pill" {
                if !MAIN_PILLS.contains(&id) { return Err(CommandError); }
                Ok(Command::SetMainPill(id.to_owned()))
            } else {
                if !pill_offered(id) { return Err(CommandError); }
                Ok(Command::ToggleDeclaredPill(id.to_owned()))
            }
        }
        Some("set_pill_color") if map.len() == 3 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !pill_offered(id) || !COLORS.contains(&color) {
                return Err(CommandError);
            }
            Ok(Command::SetPillColor { id: id.to_owned(), color: color.to_owned() })
        }
        Some("clear_pill_color") if map.len() == 2 => {
            let id = map.get("id").and_then(Value::as_str).ok_or(CommandError)?;
            if !pill_offered(id) {
                return Err(CommandError);
            }
            Ok(Command::ClearPillColor(id.to_owned()))
        }
        Some("set_theme") if map.len() == 2 => {
            let theme = map.get("theme").and_then(Value::as_str).ok_or(CommandError)?;
            Ok(Command::SetTheme(Theme::parse(theme).ok_or(CommandError)?))
        }
        // #336 T1b-a: exactly action + auto_close_seconds + open_on_hover.
        // `as_u64` already refuses floats, strings, null and negatives; the
        // inclusive 5..=120 range matches the public scheduler contract.
        Some("set_island_interaction") if map.len() == 3 => {
            let seconds = map.get("auto_close_seconds").and_then(Value::as_u64).ok_or(CommandError)?;
            if !(5..=120).contains(&seconds) {
                return Err(CommandError);
            }
            let hover = map.get("open_on_hover").and_then(Value::as_bool).ok_or(CommandError)?;
            Ok(Command::SetIslandInteraction { auto_close_seconds: seconds as u16, open_on_hover: hover })
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
        Command::SetPosition(x, y) => {
            if !valid_position(*x, *y) { return Err(CommandError); }
            next.position = Some((*x, *y));
        }
        Command::SetMainPill(id) => {
            if !current.valid_pill_choices() || !MAIN_PILLS.contains(&id.as_str()) { return Err(CommandError); }
            if id != current.main_pill() {
                next.main_pill = Some(id.clone());
                if current.declared_pills().contains(id) {
                    next.declared_pills = Some(current.declared_pills().into_iter().filter(|x| x != id).collect());
                }
            }
        }
        Command::ToggleDeclaredPill(id) => {
            if !current.valid_pill_choices() || !pill_offered(id) || id == current.main_pill() { return Err(CommandError); }
            let mut ids = current.declared_pills();
            if ids.contains(id) { ids.retain(|x| x != id); }
            else {
                if ids.len() >= MAX_DECLARED_PILLS { return Err(CommandError); }
                ids.push(id.clone());
            }
            next.declared_pills = Some(ids);
        }
        Command::SetTheme(theme) => next.theme = Some(*theme),
        Command::SetPillColor { id, color } => {
            if !pill_offered(id) || !COLORS.contains(&color.as_str()) {
                return Err(CommandError);
            }
            next.pill_colors.insert(id.clone(), color.clone());
        }
        Command::ClearPillColor(id) => {
            if !pill_offered(id) { return Err(CommandError); }
            next.pill_colors.remove(id);
        }
        // #336 T1b-a: both fields commit together under the same gate; the
        // range/type checks already ran at parse and run again here for
        // direct callers, exactly like every other typed command.
        Command::SetIslandInteraction { auto_close_seconds, open_on_hover } => {
            if !(5..=120).contains(auto_close_seconds) { return Err(CommandError); }
            next.auto_close_seconds = Some(*auto_close_seconds);
            next.open_on_hover = Some(*open_on_hover);
        }
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
