//! #467 T11 — closed "open in apps" command: VS Code (folder / file) and the
//! configured n8n instance.
//!
//! Adapted from Coucou src-tauri/src/lib.rs (`open_in_vscode`, `open_file_in_vscode`,
//! `open_n8n`) @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT. Differences:
//! - one closed payload (`{action: vscode | vscode_file | n8n, path?}`) behind the same
//!   gate order as `focushost`/`desktop::open_web_url` (sender → payload → rate → effect);
//! - the only programs ever spawned are `code` (found on PATH by absolute directory,
//!   executable bit) and `xdg-open` for a validated folder; one argv, no shell;
//! - n8n: the URL lives in the key store (`n8n-url`, read in Rust, never returned to the
//!   page); it is validated (https, or http on loopback, no credentials) before `xdg-open`
//!   receives it as its single argument.
//!
//! Existing equivalents are NOT ported (S9): `launch_claude` (Claude Desktop),
//! `focus_host` (terminal / session / editor window) and `open_chat_url` (web URL).
use crate::bridge::{BridgeError, RateLimiter};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;

const MAX_PATH_BYTES: usize = 4096;
const ERR_PAYLOAD: &str = "invalid open request";

/// What the caller asked for, after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenRequest {
    /// `code [folder]`; no folder = just launch the editor.
    Vscode(Option<PathBuf>),
    /// `code <file>`: an existing regular file, never opened by its type.
    VscodeFile(PathBuf),
    /// The n8n instance stored in the key store (`n8n-url`).
    N8n,
}

/// How a request is carried out once `code` was (or was not) found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Spawn { program: PathBuf, arg: Option<PathBuf> },
    RevealFolder(PathBuf),
    Nothing,
}

fn checked_path(map: &serde_json::Map<String, Value>, want_dir: bool) -> Result<PathBuf, BridgeError> {
    let raw = map
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::denied(ERR_PAYLOAD))?;
    if raw.is_empty() || raw.len() > MAX_PATH_BYTES || raw.chars().any(char::is_control) {
        return Err(BridgeError::denied(ERR_PAYLOAD));
    }
    // Absolute only: `code` would read `--something` as an option, and a relative
    // path means whatever the host's cwd happens to be.
    let path = Path::new(raw);
    let ok = path.is_absolute() && if want_dir { path.is_dir() } else { path.is_file() };
    if ok { Ok(path.to_path_buf()) } else { Err(BridgeError::denied(ERR_PAYLOAD)) }
}

/// Closed schema. Unknown fields, unknown actions, relative / missing / wrong-kind paths
/// are refused.
pub fn parse_open(payload: &Value) -> Result<OpenRequest, BridgeError> {
    let map = payload.as_object().ok_or_else(|| BridgeError::denied(ERR_PAYLOAD))?;
    let action = map.get("action").and_then(Value::as_str).ok_or_else(|| BridgeError::denied(ERR_PAYLOAD))?;
    match (action, map.len()) {
        ("vscode", 1) => Ok(OpenRequest::Vscode(None)),
        ("vscode", 2) => Ok(OpenRequest::Vscode(Some(checked_path(map, true)?))),
        ("vscode_file", 2) => Ok(OpenRequest::VscodeFile(checked_path(map, false)?)),
        ("n8n", 1) => Ok(OpenRequest::N8n),
        _ => Err(BridgeError::denied(ERR_PAYLOAD)),
    }
}

/// Gate order mirrors `focushost::focus_command`: sender → payload → rate → effect. The
/// effect answers whether something opened; `Err` is a public reason.
pub fn open_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    effect: F,
) -> Result<Value, BridgeError>
where
    F: FnOnce(OpenRequest) -> Result<bool, String>,
{
    crate::bridge::sender_ok(label, origin)?;
    let request = parse_open(payload)?;
    rate.check(now)?;
    let opened = effect(request).map_err(|reason| BridgeError::denied(&reason))?;
    Ok(json!({ "opened": opened }))
}

/// The n8n URL, only when it is safe to open: https, or http on a loopback host;
/// never credentials, whitespace or control characters.
pub fn n8n_url(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 2000 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let url = tauri::Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.scheme() {
        "https" => url.host_str().is_some().then(|| url.to_string()),
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")).then(|| url.to_string()),
        _ => None,
    }
}

/// `name` on `path_var`: absolute directories only, a regular file with an executable bit.
/// `name` must be a bare file name.
pub fn find_on_path_in(name: &str, path_var: &OsStr) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        return None;
    }
    std::env::split_paths(path_var)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Pure decision: which single process (if any) carries the request out.
pub fn launch_plan(code: Option<&Path>, request: &OpenRequest) -> Launch {
    match (request, code) {
        (OpenRequest::Vscode(folder), Some(program)) => {
            Launch::Spawn { program: program.to_path_buf(), arg: folder.clone() }
        }
        (OpenRequest::VscodeFile(file), Some(program)) => {
            Launch::Spawn { program: program.to_path_buf(), arg: Some(file.clone()) }
        }
        (OpenRequest::Vscode(Some(folder)), None) => Launch::RevealFolder(folder.clone()),
        (OpenRequest::VscodeFile(file), None) => match file.parent() {
            Some(folder) if folder.is_absolute() => Launch::RevealFolder(folder.to_path_buf()),
            _ => Launch::Nothing,
        },
        _ => Launch::Nothing,
    }
}

pub fn spawn_detached(program: &Path, arg: Option<&Path>) -> bool {
    let mut cmd = std::process::Command::new(program);
    if let Some(arg) = arg {
        cmd.arg(arg);
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            // Reap it off-thread so a finished editor never lingers as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

/// Real effect for the VS Code actions. `true` only when the editor itself was launched;
/// revealing the folder is the Coucou fallback and answers `false`, as there.
pub fn open_in_editor(request: &OpenRequest) -> bool {
    let code = std::env::var_os("PATH").and_then(|p| find_on_path_in("code", &p));
    match launch_plan(code.as_deref(), request) {
        Launch::Spawn { program, arg } => {
            if spawn_detached(&program, arg.as_deref()) {
                return true;
            }
            // `code` was found but would not start: same folder fallback.
            if let Launch::RevealFolder(folder) = launch_plan(None, request) {
                reveal_folder(&folder);
            }
            false
        }
        Launch::RevealFolder(folder) => {
            reveal_folder(&folder);
            false
        }
        Launch::Nothing => false,
    }
}

/// Shows a validated folder in the file manager: fixed program, one argument.
fn reveal_folder(folder: &Path) {
    if folder.is_absolute() && folder.is_dir() {
        spawn_detached(Path::new("xdg-open"), Some(folder));
    }
}

/// Real effect for `n8n`: the stored URL, validated, handed to `xdg-open` as one argument.
/// `Ok(false)` = nothing stored or the stored value is not a safe URL.
pub fn open_n8n(store: &dyn crate::secrets::SecretStore) -> Result<bool, String> {
    let stored = store.read("n8n-url").map_err(|_| "key store unavailable".to_string())?;
    let Some(url) = stored.as_deref().and_then(n8n_url) else { return Ok(false) };
    Ok(spawn_detached(Path::new("xdg-open"), Some(Path::new(&url))))
}
