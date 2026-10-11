//! P2 — the STABLE handoff of the receiver endpoint.
//!
//! The island binds a fresh `<runtime>/p-XXXXXX/s` on every start, so a local consumer (an agent
//! hook) cannot know it in advance. After the bind we publish ONE file at a path that never
//! changes — `<runtime>/endpoint.json` — and remove it on exit:
//!
//! ```json
//! {"v":1,"endpoint":"<runtime>/p-XXXXXX/s","pid":<island pid>}
//! ```
//!
//! 0600, written to a temp file then `rename`d (readers never see a half file), closed key set.
//! It is a pointer, not an authority: the consumer still connects to the socket, which checks the
//! peer uid, and [`read`] refuses a stale file (socket gone, wrong shape). Nothing here makes a
//! path, a pid or a label trusted.
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;

pub const FILE_NAME: &str = "endpoint.json";
const MAX_FILE: u64 = 4096;

/// `<runtime>/endpoint.json`.
pub fn path(runtime: &Path) -> PathBuf {
    runtime.join(FILE_NAME)
}

/// `<runtime>/p-<6 alphanumerics>/s`, absolute and normalized, exactly one level below `runtime`.
fn endpoint_shape_ok(endpoint: &Path, runtime: &Path) -> bool {
    if !endpoint.is_absolute() || endpoint.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return false;
    }
    let (Some(dir), Some(leaf)) = (endpoint.parent(), endpoint.file_name()) else { return false };
    let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) else { return false };
    let name = name.as_bytes();
    leaf.as_bytes() == b"s"
        && parent == runtime
        && endpoint.as_os_str().as_bytes().len() <= 107
        && name.len() == 8
        && name.starts_with(b"p-")
        && name[2..].iter().all(u8::is_ascii_alphanumeric)
}

fn io(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, msg.to_string())
}

/// Publish `endpoint` for local consumers. Refuses anything that is not the exact receiver socket
/// of `runtime`, a non-private `runtime`, and a symlink at the target path.
pub fn publish(runtime: &Path, endpoint: &Path) -> std::io::Result<()> {
    if !endpoint_shape_ok(endpoint, runtime) {
        return Err(io("endpoint is not <runtime>/p-XXXXXX/s"));
    }
    let socket = std::fs::symlink_metadata(endpoint)?;
    if !socket.file_type().is_socket() {
        return Err(io("endpoint is not a socket"));
    }
    let dir = std::fs::symlink_metadata(runtime)?;
    let me = uid();
    if !dir.file_type().is_dir() || dir.uid() != me || dir.permissions().mode() & 0o777 != 0o700 {
        return Err(io("runtime root must be a private (0700) directory of ours"));
    }
    let target = path(runtime);
    if let Ok(existing) = std::fs::symlink_metadata(&target) {
        if existing.file_type().is_symlink() || !existing.file_type().is_file() {
            return Err(io("refusing to replace a symlink or a non-file"));
        }
    }
    let line = format!("{}\n", json!({"v": 1, "endpoint": endpoint.to_str().ok_or_else(|| io("endpoint is not UTF-8"))?, "pid": std::process::id()}));
    let tmp = runtime.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Contents of a handoff file, parsed and shape-checked; `None` for anything that is not ours.
fn parse(runtime: &Path, text: &str) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(text).ok()?;
    let map = v.as_object()?;
    if map.len() != 3 || map.get("v") != Some(&json!(1)) {
        return None;
    }
    // the island that wrote it must still be alive: a SIGKILL leaves the file (and the socket
    // inode) behind, and a recycled path must not be believed
    let pid = map.get("pid")?.as_u64().filter(|p| *p > 0 && *p <= i32::MAX as u64)?;
    if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
        return None;
    }
    let endpoint = PathBuf::from(map.get("endpoint")?.as_str()?);
    endpoint_shape_ok(&endpoint, runtime).then_some(endpoint)
}

fn read_text(runtime: &Path) -> Option<String> {
    let target = path(runtime);
    let meta = std::fs::symlink_metadata(&target).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_FILE || meta.uid() != uid() {
        return None;
    }
    std::fs::read_to_string(&target).ok()
}

/// The endpoint a consumer should connect to, or `None`: no file, malformed, wrong shape, or the
/// socket it names no longer exists (a crashed island leaves the file behind).
pub fn read(runtime: &Path) -> Option<PathBuf> {
    let endpoint = parse(runtime, &read_text(runtime)?)?;
    std::fs::symlink_metadata(&endpoint).ok()?.file_type().is_socket().then_some(endpoint)
}

/// Remove the handoff, but ONLY when it still names `endpoint`: a newer instance may have taken
/// the file over, and a symlink or foreign file is never ours. Idempotent, never panics.
pub fn clear(runtime: &Path, endpoint: &Path) {
    if read_text(runtime).and_then(|t| parse(runtime, &t)).as_deref() == Some(endpoint) {
        let _ = std::fs::remove_file(path(runtime));
    }
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}
