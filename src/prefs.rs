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

/// #415 WU2: created blobs — label + optional palette colour entries the human
/// creates by hand (e.g. «Abito GitHub», «Abito Reviewer», «Abito correo»). A created
/// blob carries NO agent behaviour: it is a named, colourable, ordered entry only.
pub const MAX_CUSTOM_BLOBS: usize = 8;
pub const MAX_BLOB_NAME_CHARS: usize = 40;
const CUSTOM_BLOBS: &str = "custom_blobs";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomBlob {
    pub name: String,
    /// One of `COLORS`, or none (a colourless blob must stay reversible).
    pub color: Option<String>,
}

/// The closed blob-name shape: bounded plain text like every other human name —
/// trimmed, no controls, at most `MAX_BLOB_NAME_CHARS` scalars — and never the
/// principal's name: «Abito» itself is the main blob and cannot be created (so it
/// can never be deleted either).
fn valid_blob_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_BLOB_NAME_CHARS
        && name.trim() == name
        && !name.chars().any(char::is_control)
        && !name.eq_ignore_ascii_case("abito")
}

fn valid_blob_color(color: &Option<String>) -> bool {
    color.as_deref().is_none_or(|c| COLORS.contains(&c))
}

/// The stored blob entries that survive validation, deduplicated case-insensitively
/// (first wins) and capped. Everything else is dropped; nothing here can panic.
fn custom_blobs_from(value: Option<&Value>) -> Vec<CustomBlob> {
    let mut out: Vec<CustomBlob> = Vec::new();
    let Some(list) = value.and_then(Value::as_array) else { return out };
    for entry in list {
        let Some(map) = entry.as_object() else { continue };
        let (Some(name), color) = (map.get("name").and_then(Value::as_str), map.get("color").and_then(Value::as_str)) else { continue };
        if !valid_blob_name(name) || out.len() >= MAX_CUSTOM_BLOBS
            || out.iter().any(|b| b.name.eq_ignore_ascii_case(name)) {
            continue;
        }
        let color = color.filter(|c| COLORS.contains(c)).map(str::to_owned);
        out.push(CustomBlob { name: name.to_owned(), color });
    }
    out
}
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

/// #414: the chosen models of the connected providers (Ajustes → Modelos), per provider.
/// Absent from a file nobody customised, so an untouched `prefs.json` keeps exactly the
/// bytes it had.
const CHOSEN_MODELS: &str = "chosen_models";
/// The provider key is the engine's own strict_id shape; ids keep their catalogue spelling.
const MAX_PROVIDER_ID: usize = 64;
const MAX_MODEL_ID: usize = 200;
/// Bounds so the preference can never outgrow the panel that renders it.
const MAX_MODELS_PER_PROVIDER: usize = 64;
const MAX_PROVIDERS: usize = 32;

/// #389 (GD012): the monitor the human chose for the island (Ajustes → Panel), stored as
/// the platform's stable monitor name (see `workarea::monitor_key`). Absent = the island's
/// current monitor (the behaviour before #389), and absence is preserved. A stored key the
/// island cannot see right now is NOT dropped: the fallback happens at placement, so a
/// redocked laptop restores the choice; only a hostile shape is refused here.
const MONITOR: &str = "monitor";
pub const MAX_MONITOR_KEY: usize = 64;

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
    /// #414: per provider, the model ids the human chose in Ajustes → Modelos. `None`
    /// means nothing was chosen, and nothing is written for it.
    pub chosen_models: Option<BTreeMap<String, Vec<String>>>,
    /// #336 T1b-a: the configured inactivity delay in seconds (5..=120). `None` means
    /// the default 15 and is never written, so an untouched file keeps its bytes.
    pub auto_close_seconds: Option<u16>,
    /// #336 T1b-a: whether a trusted mouse entry may open the settled compact island.
    /// `None` means the default (off) and is never written.
    pub open_on_hover: Option<bool>,
    /// #415 WU2: the blobs the human created by hand (label + optional palette colour),
    /// in creation order. `None` means none, and nothing is written for it, so an
    /// untouched file keeps its bytes.
    pub custom_blobs: Option<Vec<CustomBlob>>,
    /// #389: the platform monitor name the island was pinned to (Ajustes → Panel).
    /// `None` means the default placement (the island's current monitor) and is never
    /// written, so an untouched file keeps its bytes.
    pub monitor: Option<String>,
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

/// The provider key of a chosen-models entry: the engine's own strict_id shape — bounded,
/// lowercase slug, never a prototype key.
fn valid_provider_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_PROVIDER_ID || RESERVED.contains(&id) {
        return false;
    }
    let bytes = id.as_bytes();
    // the last byte is alphanumeric too: a trailing separator ("dot.") is not a slug
    if !(bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit()) {
        return false;
    }
    let mut bytes = id.bytes();
    let Some(first) = bytes.next() else { return false };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// A model id keeps its catalogue spelling (several engines key theirs "vendor/model"),
/// bounded ASCII with no whitespace or control characters.
fn valid_model_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_MODEL_ID && id.trim() == id
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b':'))
}

/// The chosen-models entries that survive validation, deduplicated, one provider at a time.
/// A provider past the per-provider cap is dropped whole (a catalogue that big is not a
/// human choice); the map overall is capped by dropping the rest one by one.
fn chosen_models_from(value: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(map) = value.and_then(Value::as_object) else { return out };
    for (provider, models) in map {
        if !valid_provider_id(provider) || out.len() >= MAX_PROVIDERS {
            continue;
        }
        let Some(list) = models.as_array() else { continue };
        let mut clean: Vec<String> = Vec::new();
        for id in list {
            if let Some(id) = id.as_str() {
                if valid_model_id(id) && !clean.iter().any(|x| x == id) {
                    clean.push(id.to_string());
                }
            }
        }
        if clean.len() > MAX_MODELS_PER_PROVIDER {
            continue;
        }
        if !clean.is_empty() {
            out.insert(provider.clone(), clean);
        }
    }
    out
}

/// The stored monitor key is the platform monitor name verbatim: bounded, trimmed,
/// no control characters and never a prototype key. Unknown or disconnected names
/// still parse — the placement fallback owns "unknown" (`workarea::chosen_area`),
/// never the store; only hostile shapes are refused.
fn valid_monitor_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= MAX_MONITOR_KEY
        && key.trim() == key
        && !key.chars().any(char::is_control)
        && !RESERVED.contains(&key)
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
    /// #415 WU2: the WebView projection of the created blobs (validated names and
    /// palette names only); nothing created is null, like every optional field.
    pub fn custom_blobs_view(&self) -> Value {
        match &self.custom_blobs {
            Some(blobs) => Value::Array(blobs.iter().map(|b| json!({"name": b.name, "color": b.color})).collect()),
            None => Value::Null,
        }
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
            chosen_models: Some(chosen_models_from(v.get(CHOSEN_MODELS))),
            auto_close_seconds: v.get("auto_close_seconds").and_then(Value::as_u64)
                .and_then(|s| u16::try_from(s).ok()).filter(|s| (5..=120).contains(s)),
            open_on_hover: v.get("open_on_hover").and_then(Value::as_bool),
            custom_blobs: {
                let blobs = custom_blobs_from(v.get(CUSTOM_BLOBS));
                (!blobs.is_empty()).then_some(blobs)
            },
            monitor: v.get(MONITOR).and_then(Value::as_str)
                .filter(|key| valid_monitor_key(key)).map(str::to_owned),
        };
        if prefs.declared_pills.is_some() { prefs.declared_pills = Some(prefs.declared_pills()); }
        // A map whose every entry was dropped reads as absent: an untouched file keeps its bytes.
        if prefs.chosen_models.as_ref().is_some_and(|m| m.is_empty()) {
            prefs.chosen_models = None;
        }
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
        if let Some(map) = &self.chosen_models {
            if !map.is_empty() {
                v[CHOSEN_MODELS] = json!(map);
            }
        }
        if let Some(seconds) = self.auto_close_seconds.filter(|s| (5..=120).contains(s)) {
            v["auto_close_seconds"] = json!(seconds);
        }
        if let Some(hover) = self.open_on_hover {
            v["open_on_hover"] = json!(hover);
        }
        if let Some(blobs) = &self.custom_blobs {
            if !blobs.is_empty() {
                v[CUSTOM_BLOBS] = json!(blobs.iter().map(|b| match &b.color {
                    Some(color) => json!({"name": b.name, "color": color}),
                    None => json!({"name": b.name}),
                }).collect::<Vec<_>>());
            }
        }
        if let Some(monitor) = &self.monitor {
            v[MONITOR] = json!(monitor);
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
    /// #415 WU2: a created blob — label + optional palette colour, appended in
    /// creation order. The principal «Abito» is never creatable.
    CreateBlob { name: String, color: Option<String> },
    /// #415 WU2: removes exactly the named created blob; an unknown name is refused.
    DeleteBlob { name: String },
    /// #415 WU2: the closed-palette colour of one created blob, or its removal
    /// (empty string clears — a colourless blob must stay reversible).
    SetBlobColor { name: String, color: String },
    /// #414: the WHOLE list of one provider replaces what is stored; an empty list clears it.
    SetChosenModels { provider: String, models: Vec<String> },
    /// #336 T1b-a: the island's inactivity interaction as one exact closed
    /// shape — integer `auto_close_seconds` 5..=120 and `open_on_hover`.
    SetIslandInteraction { auto_close_seconds: u16, open_on_hover: bool },
    /// #389: the platform monitor name the island is pinned to (Ajustes → Panel).
    /// A choice is only ever one of the keys the island itself saw and offered;
    /// falling back when a stored key is no longer connected is placement's job.
    SetMonitor(String),
    /// #389: back to the default behaviour — the island's current monitor.
    ClearMonitor,
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
/// typed optional fields; unknown file keys are dropped. #415 WU2: create_blob takes
/// exactly action + name (+ optional color, a COLORS name), delete_blob exactly
/// action + name, set_blob_color exactly action + name + color (a COLORS name or "").
/// #389: set_monitor takes exactly action + monitor (a bounded platform monitor name),
/// clear_monitor exactly action.
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
        // #415 WU2: created blobs. The colour key is optional but must be a real
        // palette name when present; the name gate runs at parse AND at apply.
        Some("create_blob") if map.len() == 2 || map.len() == 3 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) {
                return Err(CommandError);
            }
            let color = if map.len() == 3 {
                let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
                if !COLORS.contains(&color) { return Err(CommandError); }
                Some(color.to_owned())
            } else { None };
            Ok(Command::CreateBlob { name: name.to_owned(), color })
        }
        Some("delete_blob") if map.len() == 2 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) {
                return Err(CommandError);
            }
            Ok(Command::DeleteBlob { name: name.to_owned() })
        }
        Some("set_blob_color") if map.len() == 3 => {
            let name = map.get("name").and_then(Value::as_str).ok_or(CommandError)?;
            let color = map.get("color").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_blob_name(name) || !(color.is_empty() || COLORS.contains(&color)) {
                return Err(CommandError);
            }
            Ok(Command::SetBlobColor { name: name.to_owned(), color: color.to_owned() })
        }
        Some("set_chosen_models") if map.len() == 3 => {
            let provider = map.get("provider").and_then(Value::as_str).ok_or(CommandError)?;
            let models = map.get("models").and_then(Value::as_array).ok_or(CommandError)?;
            if !valid_provider_id(provider) || models.len() > MAX_MODELS_PER_PROVIDER {
                return Err(CommandError);
            }
            let mut clean: Vec<String> = Vec::new();
            for id in models {
                let id = id.as_str().ok_or(CommandError)?;
                if !valid_model_id(id) {
                    return Err(CommandError);
                }
                if !clean.iter().any(|x| x == id) {
                    clean.push(id.to_string());
                }
            }
            Ok(Command::SetChosenModels { provider: provider.to_string(), models: clean })
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
        // #389: the chosen panel monitor. The value gate runs at parse AND at apply.
        Some("set_monitor") if map.len() == 2 => {
            let monitor = map.get("monitor").and_then(Value::as_str).ok_or(CommandError)?;
            if !valid_monitor_key(monitor) {
                return Err(CommandError);
            }
            Ok(Command::SetMonitor(monitor.to_owned()))
        }
        Some("clear_monitor") if map.len() == 1 => Ok(Command::ClearMonitor),
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
        Command::SetChosenModels { provider, models } => {
            if !valid_provider_id(provider) {
                return Err(CommandError);
            }
            // Deduplicate here too: apply is the direct-caller boundary as well as the
            // IPC one (parse_command already deduplicates for the wire).
            let mut clean: Vec<String> = Vec::new();
            for m in models {
                if !valid_model_id(m) {
                    return Err(CommandError);
                }
                if !clean.contains(m) {
                    clean.push(m.clone());
                }
            }
            if clean.len() > MAX_MODELS_PER_PROVIDER {
                return Err(CommandError);
            }
            let mut map = current.chosen_models.clone().unwrap_or_default();
            if clean.is_empty() {
                map.remove(provider);
            } else {
                map.insert(provider.clone(), clean);
            }
            next.chosen_models = if map.is_empty() { None } else { Some(map) };
        }
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
        // #415 WU2: created blobs. The name/colour gates ran at parse and run again
        // here for direct callers; a duplicate (case-insensitive), the principal's
        // name, a ninth blob and an unknown delete are refused without any change.
        Command::CreateBlob { name, color } => {
            if !valid_blob_name(name) || !valid_blob_color(color) { return Err(CommandError); }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            if blobs.len() >= MAX_CUSTOM_BLOBS || blobs.iter().any(|b| b.name.eq_ignore_ascii_case(name)) {
                return Err(CommandError);
            }
            blobs.push(CustomBlob { name: name.clone(), color: color.clone() });
            next.custom_blobs = Some(blobs);
        }
        Command::DeleteBlob { name } => {
            if !valid_blob_name(name) { return Err(CommandError); }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            let before = blobs.len();
            blobs.retain(|b| b.name != *name);
            if blobs.len() == before { return Err(CommandError); }
            next.custom_blobs = (!blobs.is_empty()).then_some(blobs);
        }
        Command::SetBlobColor { name, color } => {
            if !valid_blob_name(name) || !(color.is_empty() || COLORS.contains(&color.as_str())) {
                return Err(CommandError);
            }
            let mut blobs = current.custom_blobs.clone().unwrap_or_default();
            let Some(blob) = blobs.iter_mut().find(|b| b.name == *name) else { return Err(CommandError); };
            blob.color = (!color.is_empty()).then(|| color.clone());
            next.custom_blobs = Some(blobs);
        }
        // #389: the value gate ran at parse and runs again here for direct
        // callers; clearing always succeeds and never writes the key.
        Command::SetMonitor(monitor) => {
            if !valid_monitor_key(monitor) { return Err(CommandError); }
            next.monitor = Some(monitor.clone());
        }
        Command::ClearMonitor => next.monitor = None,
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
