//! #408 T8 — the click-scoped import of the human's Pi `nan` connection (option B).
//!
//! Exception to the daemon's «the user's own Pi credentials are never imported» rule, scoped to the
//! island HOST and to ONE explicit click («Usar la conexión de Pi»): it reads `models.json`
//! (providers.nan: baseUrl, api, model ids) and `auth.json` (key `nan`, type `api_key`) from the Pi
//! agent dir and copies them ONCE into Abito's own owner-only account store. There is no startup,
//! background or automatic read. `status` reads `models.json` only and returns just
//! `{exists, models}`; it never touches `auth.json`.
//!
//! Safety: Pi files must be regular, owned by this user, not symlinks and private (no group/other
//! bits); anything else is refused. The key lives in [`PiNan`] (Debug redacted) and goes straight
//! into the store; it is never logged, returned or sent to the WebView.
use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

pub const PROVIDER: &str = "nan";
const MAX_FILE: u64 = 1024 * 1024;
const MAX_MODELS: usize = 64;
const APIS: [&str; 4] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiError {
    /// No Pi dir/file, or no `nan` provider.
    Missing,
    /// A Pi file is a symlink, not a regular file, not ours, or readable by others.
    Unsafe,
    /// Present but unusable: no api_key credential for nan, no models, a bad shape.
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PiStatus {
    pub exists: bool,
    pub models: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiAction {
    Status,
    Import,
}

/// The closed `pi_connection` payload: exactly `{"action": "status" | "import"}`.
pub fn parse_action(payload: &Value) -> Option<PiAction> {
    let obj = payload.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("action")?.as_str()? {
        "status" => Some(PiAction::Status),
        "import" => Some(PiAction::Import),
        _ => None,
    }
}

/// `<home>/.pi/agent`; no HOME, no import.
pub fn default_dir(home: Option<&str>) -> Option<PathBuf> {
    home.filter(|h| !h.is_empty()).map(|h| Path::new(h).join(".pi").join("agent"))
}

pub struct PiNan {
    pub base_url: String,
    pub api: String,
    pub models: Vec<String>,
    key: String,
}
impl PiNan {
    /// The credential, for the account store only.
    pub(crate) fn key(&self) -> &str {
        &self.key
    }
}
impl fmt::Debug for PiNan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PiNan(<redacted>)")
    }
}

#[cfg(unix)]
fn private_regular(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.is_file() && !meta.file_type().is_symlink() && meta.mode() & 0o077 == 0 && meta.uid() == unsafe { libc::geteuid() }
}
#[cfg(not(unix))]
fn private_regular(_: &std::fs::Metadata) -> bool {
    false // no reviewed ACL check on this platform: fail closed
}

fn read_private_json(path: &Path) -> Result<Value, PiError> {
    use std::io::Read;
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(PiError::Missing),
        Err(_) => return Err(PiError::Unsafe),
        Ok(meta) if !private_regular(&meta) => return Err(PiError::Unsafe),
        Ok(_) => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| PiError::Unsafe)?;
    // re-check on the open handle: the path could have been swapped between the two calls
    if !file.metadata().is_ok_and(|m| private_regular(&m) && m.len() <= MAX_FILE) {
        return Err(PiError::Unsafe);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|_| PiError::Unsafe)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(PiError::Unsafe);
    }
    serde_json::from_slice(&bytes).map_err(|_| PiError::Invalid)
}

struct Provider {
    base_url: String,
    api: String,
    models: Vec<String>,
}

fn read_provider(dir: &Path) -> Result<Provider, PiError> {
    let doc = read_private_json(&dir.join("models.json"))?;
    let nan = doc.get("providers").and_then(|p| p.get(PROVIDER)).and_then(Value::as_object).ok_or(PiError::Missing)?;
    let mut models: Vec<String> = Vec::new();
    for id in nan.get("models").and_then(Value::as_array).into_iter().flatten().filter_map(|m| m.get("id").and_then(Value::as_str)) {
        if !models.iter().any(|x| x == id) && models.len() < MAX_MODELS {
            models.push(id.to_string());
        }
    }
    if models.is_empty() {
        return Err(PiError::Invalid);
    }
    let base_url = nan.get("baseUrl").and_then(Value::as_str).ok_or(PiError::Invalid)?.to_string();
    let api = nan.get("api").and_then(Value::as_str).filter(|a| APIS.contains(a)).unwrap_or("openai-completions").to_string();
    Ok(Provider { base_url, api, models })
}

/// What the page may know: does Pi define a usable `nan` provider, and how many models. Reads
/// `models.json` only (no credential file); any problem reads as «does not exist».
pub fn status(dir: &Path) -> PiStatus {
    match read_provider(dir) {
        Ok(p) => PiStatus { exists: true, models: p.models.len() },
        Err(_) => PiStatus { exists: false, models: 0 },
    }
}

/// The ONLY place a Pi credential is read. Called from the explicit import click.
pub fn read_nan(dir: &Path) -> Result<PiNan, PiError> {
    let provider = read_provider(dir)?;
    let auth = match read_private_json(&dir.join("auth.json")) {
        Err(PiError::Missing) => return Err(PiError::Invalid),
        other => other?,
    };
    let entry = auth.get(PROVIDER).and_then(Value::as_object).ok_or(PiError::Invalid)?;
    if entry.get("type").and_then(Value::as_str) != Some("api_key") {
        return Err(PiError::Invalid);
    }
    let key = entry.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).ok_or(PiError::Invalid)?;
    Ok(PiNan { base_url: provider.base_url, api: provider.api, models: provider.models, key: key.to_string() })
}

#[cfg(all(test, unix))]
#[path = "piimport_tests.rs"]
mod tests;
