//! Unix-domain-socket receiver for the Pi → desktop notice transport — unit
//! M2.
//!
//! Port of `transport.cjs` (read-only legacy source) plus the receiver wiring
//! of `main.cjs`:
//! - same endpoint naming: `<runtime>/p-XXXXXX/s` (six alphanumerics from
//!   `mkdtemp`), same `ABITO_DESKTOP_SOCKET=…` line on stdout,
//! - same permissions and owner rules: runtime + generated dir 0700, socket
//!   0600, no symlink anywhere in the chain, world-writable parents refused,
//! - same quotas: [`protocol::CONNECTIONS`] clients, per-connection frame
//!   rate, handshake/idle deadlines, batch cap (pure half in [`protocol`]),
//! - owner check on the wire: the connecting peer's uid must equal ours
//!   (SO_PEERCRED — the Tauri counterpart of the legacy file-uid checks),
//! - stale/foreign paths are never removed: cleanup verifies dir and socket
//!   inode identity (dev/ino + is-socket) before unlinking, exactly like
//!   `transport.cjs close()`,
//! - the installed Preview's reserved roots (`$XDG_RUNTIME_DIR/abito-desktop`
//!   and `…-preview`) are refused outright — detection is read-only and this
//!   receiver never touches a socket it did not create.
//!
//! Env overrides:
//! - `ABITO_SOCKET_DIR` — transport runtime root for tests/probe (absolute,
//!   normalized, never a reserved Preview root).
//!
//! Legacy note: `transport.cjs` kept a private `NoticeStore` as a pre-filter
//! before `onNotice`. Its `accept()` is a deterministic function of the frame
//! sequence, and `main.cjs` re-accepted every event in its own store anyway,
//! so the single store at the snapshot boundary (app state) reproduces the
//! observable behaviour — same dedupe, same queue, same decisions.

use std::collections::HashMap;
use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::protocol::{self, Message};
use crate::question::{self, Inbound};
use serde::Serialize;

const WRITE_TIMEOUT: Duration = Duration::from_millis(500);

/// Local host diagnostic, NOT a new wire message or a capability promise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionOutcome {
    CapabilityNotImplementedYet,
}

/// QP.2 slice 1 retains only one static reason, never question/answer text,
/// scope or tokens. Lifecycle and host answer APIs arrive in the next slice.
#[derive(Clone, Default, Serialize)]
pub struct QuestionSnapshot {
    pub notice: Option<QuestionOutcome>,
}

fn write_line(writer: &Mutex<UnixStream>, line: &[u8]) -> std::io::Result<()> {
    let mut writer = writer.lock().expect("origin writer lock");
    writer.set_write_timeout(Some(WRITE_TIMEOUT))?;
    writer.write_all(line)
}

/// Override env: transport runtime root (tests/probe).
pub const SOCKET_DIR_ENV: &str = "ABITO_SOCKET_DIR";

/// Runtime leaf names reserved by the packaged identities (packaged.cjs
/// `IDENTITIES`): the installed Preview owns `abito-desktop`, the technical
/// preview owns `abito-desktop-preview`.
pub const RESERVED_RUNTIME_NAMES: [&str; 2] = ["abito-desktop", "abito-desktop-preview"];

/// Errors, one per legacy `throw` string in transport.cjs where one exists.
#[derive(Debug)]
pub enum TransportError {
    /// `'Linux identity required'` — no OS uid (cannot happen on Linux).
    LinuxIdentityRequired,
    /// `'Unsafe directory chain'` — a parent is a symlink, foreign-owned or
    /// world-writable.
    UnsafeDirectoryChain,
    /// `'Private directory required'` — not exactly 0700 and ours.
    PrivateDirectoryRequired,
    /// `'Unexpected endpoint'` — path shape/ownership rules of verifyEndpoint.
    UnexpectedEndpoint,
    /// `'Unsafe socket'` — not an owned 0600 socket file.
    UnsafeSocket,
    /// `'Cleanup identity changed'` — the generated dir inode changed; do
    /// not remove anything.
    CleanupIdentityChanged,
    /// `'Cleanup socket changed'` — the endpoint is no longer the socket we
    /// bound; do not remove it.
    CleanupSocketChanged,
    /// `'Unix endpoint path too long'` — sockaddr_un holds 108 bytes.
    PathTooLong,
    /// Refused: path resolves into a reserved Preview runtime root.
    ReservedPreviewRoot,
    /// Refused: `ABITO_SOCKET_DIR` is not an absolute normalized path.
    InvalidOverride,
    /// No runtime root could be determined (no manifest dir).
    NoRuntimeRoot,
    Io(std::io::Error),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::LinuxIdentityRequired => write!(f, "Linux identity required"),
            TransportError::UnsafeDirectoryChain => write!(f, "Unsafe directory chain"),
            TransportError::PrivateDirectoryRequired => write!(f, "Private directory required"),
            TransportError::UnexpectedEndpoint => write!(f, "Unexpected endpoint"),
            TransportError::UnsafeSocket => write!(f, "Unsafe socket"),
            TransportError::CleanupIdentityChanged => write!(f, "Cleanup identity changed"),
            TransportError::CleanupSocketChanged => write!(f, "Cleanup socket changed"),
            TransportError::PathTooLong => write!(f, "Unix endpoint path too long"),
            TransportError::ReservedPreviewRoot => {
                write!(f, "Refusing reserved Preview runtime root")
            }
            TransportError::InvalidOverride => write!(f, "Unexpected endpoint"),
            TransportError::NoRuntimeRoot => write!(f, "No runtime directory"),
            TransportError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(error: std::io::Error) -> Self {
        TransportError::Io(error)
    }
}

/// Receiver options — the legacy `createTransport` argument list.
pub struct TransportOptions {
    pub runtime: PathBuf,
    pub project: String,
    pub handshake_ms: u64,
    pub idle_ms: u64,
    pub on_notice: Box<dyn Fn(Message) + Send + Sync>,
    pub on_connections: Box<dyn Fn(u32) + Send + Sync>,
    /// Invalidation only; callbacks run after all transport locks are dropped.
    pub on_question_change: Box<dyn Fn() + Send + Sync>,
}

impl TransportOptions {
    pub fn new(runtime: impl Into<PathBuf>, project: impl Into<String>) -> Self {
        TransportOptions {
            runtime: runtime.into(),
            project: project.into(),
            handshake_ms: protocol::HANDSHAKE_MS,
            idle_ms: protocol::IDLE_MS,
            on_notice: Box::new(|_| {}),
            on_connections: Box::new(|_| {}),
            on_question_change: Box::new(|| {}),
        }
    }

    pub fn handshake_ms(mut self, milliseconds: u64) -> Self {
        self.handshake_ms = milliseconds;
        self
    }

    pub fn idle_ms(mut self, milliseconds: u64) -> Self {
        self.idle_ms = milliseconds;
        self
    }

    pub fn on_notice(mut self, callback: impl Fn(Message) + Send + Sync + 'static) -> Self {
        self.on_notice = Box::new(callback);
        self
    }

    pub fn on_connections(mut self, callback: impl Fn(u32) + Send + Sync + 'static) -> Self {
        self.on_connections = Box::new(callback);
        self
    }

    pub fn on_question_change(mut self, callback: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_question_change = Box::new(callback);
        self
    }
}

// --- path / runtime policy (fs-free, unit-tested) ---------------------------

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}

/// Absolute AND normalized in the JS `path.normalize` sense: no `//`, no
/// `.`, no `..` segments, no trailing slash (packaged.cjs/adapter.cjs
/// reject anything else before any filesystem work).
fn is_absolute_normalized(text: &str) -> bool {
    if !text.starts_with('/') {
        return false;
    }
    text.split('/')
        .skip(1)
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// `p-[a-zA-Z0-9]{6}` — the exact generated directory name shape
/// (transport.cjs line 48 / packaged.cjs endpoint rule).
fn is_generated_dir_name(name: &str) -> bool {
    match name.strip_prefix("p-") {
        Some(rest) => rest.len() == 6 && rest.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        None => false,
    }
}

/// Reserved-root check (packaged.cjs `IDENTITIES`): true when `path` IS or
/// LIES UNDER `/run/user/<uid>/abito-desktop` or `…/abito-desktop-preview`.
/// Those belong to the installed Preview — never touch, unlink or connect.
pub fn runtime_allowed(path: &Path, xdg_runtime_dir: Option<&str>) -> bool {
    let base = match xdg_runtime_dir {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(format!("/run/user/{}", uid())),
    };
    !RESERVED_RUNTIME_NAMES.iter().any(|name| {
        let root = base.join(name);
        path == root || path.starts_with(&root)
    })
}

/// Resolve the runtime root: `ABITO_SOCKET_DIR` override (absolute,
/// normalized, never reserved) or the default `<crate>/.runtime`.
pub fn resolve_runtime_from(
    override_dir: Option<&str>,
    default: &Path,
    xdg_runtime_dir: Option<&str>,
) -> Result<PathBuf, TransportError> {
    let path = match override_dir {
        Some(text) => {
            if !is_absolute_normalized(text) {
                return Err(TransportError::InvalidOverride);
            }
            PathBuf::from(text)
        }
        None => default.to_path_buf(),
    };
    if !runtime_allowed(&path, xdg_runtime_dir) {
        return Err(TransportError::ReservedPreviewRoot);
    }
    Ok(path)
}

/// Default runtime root: `.runtime` next to this crate (the dev layout the
/// legacy app used: `apps/desktop/.runtime`).
pub fn default_runtime() -> Result<PathBuf, TransportError> {
    let manifest =
        option_env!("CARGO_MANIFEST_DIR").ok_or(TransportError::NoRuntimeRoot)?;
    Ok(Path::new(manifest).join(".runtime"))
}

/// Runtime root for this process (`ABITO_SOCKET_DIR` or the default).
pub fn resolve_runtime() -> Result<PathBuf, TransportError> {
    let override_dir = std::env::var(SOCKET_DIR_ENV).ok();
    let default = default_runtime()?;
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    resolve_runtime_from(override_dir.as_deref(), &default, xdg.as_deref())
}

// --- filesystem rules (transport.cjs lines 11-44) ---------------------------

/// Walk every component from `/` down: directory, not symlink, owned by root
/// or us, never world-writable (`stat.mode & 0o002`).
pub fn directory_chain(target: &Path) -> Result<(), TransportError> {
    let owner = uid();
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(TransportError::Io)?
            .join(target)
    };
    let text = resolved.to_string_lossy().into_owned();
    let mut current = PathBuf::from("/");
    for segment in text.split('/').filter(|part| !part.is_empty()) {
        current.push(segment);
        let metadata = std::fs::symlink_metadata(&current).map_err(TransportError::Io)?;
        let file_type = metadata.file_type();
        if !file_type.is_dir() // lstat: a symlink is never a directory
            || file_type.is_symlink()
            || (metadata.uid() != 0 && metadata.uid() != owner)
            || (metadata.mode() & 0o002) != 0
        {
            return Err(TransportError::UnsafeDirectoryChain);
        }
    }
    Ok(())
}

/// `directory_chain` + exact `0700` + ours; returns the lstat metadata.
pub fn private_directory(target: &Path) -> Result<std::fs::Metadata, TransportError> {
    directory_chain(target)?;
    let metadata = std::fs::symlink_metadata(target).map_err(TransportError::Io)?;
    if metadata.uid() != uid() || (metadata.mode() & 0o7777) != 0o700 {
        return Err(TransportError::PrivateDirectoryRequired);
    }
    Ok(metadata)
}

/// Prepare the runtime root (chain check, mkdir 0700, private check).
pub fn prepare_runtime(runtime: &Path) -> Result<PathBuf, TransportError> {
    let parent = runtime.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    directory_chain(parent)?;
    match std::fs::DirBuilder::new().mode(0o700).create(runtime) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(TransportError::Io(error)),
    }
    private_directory(runtime)?;
    Ok(runtime.to_path_buf())
}

/// `verifyEndpoint`: exact `<runtime>/p-XXXXXX/s` shape, both dirs private,
/// endpoint an owned 0600 socket and not a symlink.
pub fn verify_endpoint(endpoint: &Path, runtime: &Path) -> Result<(), TransportError> {
    let endpoint_text = endpoint.to_str().ok_or(TransportError::UnexpectedEndpoint)?;
    let runtime_text = runtime.to_str().ok_or(TransportError::UnexpectedEndpoint)?;
    if !endpoint.is_absolute()
        || !is_absolute_normalized(endpoint_text)
        || !runtime.is_absolute()
        || !is_absolute_normalized(runtime_text)
    {
        return Err(TransportError::UnexpectedEndpoint);
    }
    let parent = endpoint.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    let grandparent = parent.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    if grandparent != Path::new(runtime_text) {
        return Err(TransportError::UnexpectedEndpoint);
    }
    if endpoint.file_name().map(|name| name == "s") != Some(true) {
        return Err(TransportError::UnexpectedEndpoint);
    }
    let generated = parent
        .file_name()
        .map(|name| is_generated_dir_name(&name.to_string_lossy()))
        .unwrap_or(false);
    if !generated {
        return Err(TransportError::UnexpectedEndpoint);
    }
    private_directory(runtime)?;
    private_directory(parent)?;
    let metadata = std::fs::symlink_metadata(endpoint).map_err(TransportError::Io)?;
    let file_type = metadata.file_type();
    if !file_type.is_socket()
        || file_type.is_symlink()
        || metadata.uid() != uid()
        || (metadata.mode() & 0o7777) != 0o600
    {
        return Err(TransportError::UnsafeSocket);
    }
    Ok(())
}

// --- detection (read-only) ---------------------------------------------------

/// Read-only report of one runtime root: socket files under generated
/// `p-XXXXXX` dirs. Never connects, never unlinks, never follows symlinks.
#[derive(Debug, Clone)]
pub struct PreviewScan {
    pub root: String,
    pub sockets: Vec<String>,
}

/// List socket files directly under `root` (presence only — a stale socket
/// and a live one look identical without connecting, which we never do).
pub fn detect_sockets(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().into_owned();
        if !is_generated_dir_name(&name) {
            continue;
        }
        // lstat only: a symlinked p- dir is never followed.
        let Ok(directory) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !directory.file_type().is_dir() || directory.file_type().is_symlink() {
            continue;
        }
        let endpoint = entry.path().join("s");
        let Ok(socket) = std::fs::symlink_metadata(&endpoint) else {
            continue;
        };
        if socket.file_type().is_socket() && !socket.file_type().is_symlink() {
            found.push(endpoint);
        }
    }
    found.sort();
    found
}

/// Read-only scan of the two reserved Preview roots (report in the probe).
pub fn preview_scan() -> Vec<PreviewScan> {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .unwrap_or_else(|_| format!("/run/user/{}", uid()));
    RESERVED_RUNTIME_NAMES
        .iter()
        .map(|name| {
            let root = format!("{base}/{name}");
            PreviewScan {
                root: root.clone(),
                sockets: detect_sockets(Path::new(&root))
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect(),
                // detection reports presence only: live-vs-stale is not
                // guessed, because guessing would mean connecting — never.
            }
        })
        .collect()
}

// --- the receiver ------------------------------------------------------------

struct Client {
    identified: bool,
    stream: Arc<UnixStream>,
}

struct Inner {
    endpoint: PathBuf,
    runtime: PathBuf,
    directory: PathBuf,
    directory_dev: u64,
    directory_ino: u64,
    /// (dev, ino) of the socket we bound — cleanup refuses any other.
    socket_id: Option<(u64, u64)>,
    running: AtomicBool,
    closed: AtomicBool,
    next_id: AtomicU64,
    clients: Mutex<HashMap<u64, Client>>,
    listener: Mutex<Option<std::thread::JoinHandle<()>>>,
    handlers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    project: String,
    handshake_ms: u64,
    idle_ms: u64,
    /// Legacy `transport.cjs` kept its own `NoticeStore` as the gate for
    /// `onNotice`: only an accepted `settled` reaches the app (heartbeats,
    /// dedupe and the queue are filtered here first, exactly as before).
    store: Mutex<protocol::NoticeStore>,
    on_notice: Box<dyn Fn(Message) + Send + Sync>,
    on_connections: Box<dyn Fn(u32) + Send + Sync>,
    questions: Mutex<QuestionSnapshot>,
    on_question_change: Box<dyn Fn() + Send + Sync>,
}

impl Inner {
    fn question_changed(&self) {
        // Observer panics cannot poison transport state or prevent teardown.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.on_question_change)()));
    }
    /// `transport.cjs report()`: clients that completed the handshake.
    fn report(&self) {
        let identified = self
            .clients
            .lock()
            .expect("clients lock")
            .values()
            .filter(|client| client.identified)
            .count() as u32;
        (self.on_connections)(identified);
    }
}

/// A bound receiver. `close()` (or dropping it) performs the identity-checked
/// cleanup; it is idempotent.
pub struct Transport {
    inner: Arc<Inner>,
}

impl Transport {
    /// The `ABITO_DESKTOP_SOCKET=…` path the producer connects to.
    pub fn endpoint(&self) -> &Path {
        &self.inner.endpoint
    }

    pub fn runtime(&self) -> &Path {
        &self.inner.runtime
    }

    /// Read the local negotiation diagnostic without exposing wire authority.
    pub fn question_snapshot(&self) -> QuestionSnapshot {
        self.inner.questions.lock().expect("questions lock").clone()
    }

    /// Legacy `close()`: stop accepting, destroy clients, verify dir + socket
    /// inode identity, unlink only our own socket, rmdir only our own (empty)
    /// dir. Idempotent; foreign paths are never removed.
    pub fn close(&self) -> Result<(), TransportError> {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.running.store(false, Ordering::SeqCst);
        // 1. stop accepting before sweeping clients, so no client can be
        //    inserted after the sweep (legacy: destroy clients, then close).
        if let Some(handle) = self
            .inner
            .listener
            .lock()
            .expect("listener lock")
            .take()
        {
            join_other_thread(handle);
        }
        let streams: Vec<Arc<UnixStream>> = self
            .inner
            .clients
            .lock()
            .expect("clients lock")
            .values()
            .map(|client| client.stream.clone())
            .collect();
        for stream in streams {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        let handlers: Vec<std::thread::JoinHandle<()>> =
            std::mem::take(&mut *self.inner.handlers.lock().expect("handlers lock"));
        for handle in handlers {
            join_other_thread(handle);
        }
        cleanup(
            &self.inner.directory,
            self.inner.directory_dev,
            self.inner.directory_ino,
            &self.inner.endpoint,
            self.inner.socket_id,
        )
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn join_other_thread(handle: std::thread::JoinHandle<()>) {
    // A host callback can close/drop the receiver on its own read/expiry
    // thread. Detach only that current handle; shutdown/running=false ensures
    // it finishes on return. Joining ourselves would panic or deadlock.
    if handle.thread().id() != std::thread::current().id() {
        let _ = handle.join();
    }
}

/// Identity-checked cleanup (transport.cjs lines 91-106): only the exact dir
/// and socket this process created may disappear, and the dir must be empty
/// (a foreign file makes rmdir fail — it is kept, never forced).
fn cleanup(
    directory: &Path,
    directory_dev: u64,
    directory_ino: u64,
    endpoint: &Path,
    socket_id: Option<(u64, u64)>,
) -> Result<(), TransportError> {
    let metadata = std::fs::symlink_metadata(directory).map_err(|_| {
        TransportError::CleanupIdentityChanged
    })?;
    if metadata.file_type().is_symlink()
        || metadata.dev() != directory_dev
        || metadata.ino() != directory_ino
    {
        return Err(TransportError::CleanupIdentityChanged);
    }
    if let Some((socket_dev, socket_ino)) = socket_id {
        if let Ok(socket) = std::fs::symlink_metadata(endpoint) {
            if socket.dev() != socket_dev
                || socket.ino() != socket_ino
                || !socket.file_type().is_socket()
            {
                return Err(TransportError::CleanupSocketChanged);
            }
            std::fs::remove_file(endpoint).map_err(TransportError::Io)?;
        }
    }
    std::fs::remove_dir(directory).map_err(TransportError::Io)?;
    Ok(())
}

fn fail_with(
    error: TransportError,
    directory: &Path,
    directory_dev: u64,
    directory_ino: u64,
    endpoint: &Path,
    socket_id: Option<(u64, u64)>,
) -> TransportError {
    // legacy createTransport: `catch { await close(); throw error }` — the
    // original error is what the caller sees.
    if let Err(cleanup_error) = cleanup(directory, directory_dev, directory_ino, endpoint, socket_id) {
        eprintln!("transport startup cleanup refused: {cleanup_error}");
    }
    error
}

/// Node `fs.mkdtempSync(path.join(runtime, 'p-'))`: six alphanumerics after
/// `p-`, directory mode 0700, retry on collision.
fn mkdtemp(runtime: &Path) -> Result<PathBuf, TransportError> {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
        ^ (u64::from(std::process::id()) << 32);
    for _ in 0..1000 {
        let mut name = String::with_capacity(8);
        name.push_str("p-");
        for _ in 0..6 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            name.push(CHARS[(seed >> 33) as usize % CHARS.len()] as char);
        }
        let candidate = runtime.join(&name);
        match std::fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(TransportError::Io(error)),
        }
    }
    Err(TransportError::Io(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "mkdtemp: no free directory slot",
    )))
}

/// SO_PEERCRED: the peer's uid (None only if the kernel refuses the call —
/// then the peer is not admitted: fail closed on the owner check).
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut libc::ucred as *mut libc::c_void,
            &mut length,
        )
    };
    (result == 0).then_some(credentials.uid)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    now_millis() as u64
}

/// Bind a fresh `<runtime>/p-XXXXXX/s`, serve clients on threads, report
/// notices and identified-connection counts through the callbacks.
pub fn create_transport(options: TransportOptions) -> Result<Transport, TransportError> {
    let TransportOptions {
        runtime,
        project,
        handshake_ms,
        idle_ms,
        on_notice,
        on_connections,
        on_question_change,
    } = options;

    prepare_runtime(&runtime)?;
    let directory = mkdtemp(&runtime)?;
    let directory_stat = private_directory(&directory)?;
    let (directory_dev, directory_ino) = (directory_stat.dev(), directory_stat.ino());
    let endpoint = directory.join("s");
    let mut socket_id: Option<(u64, u64)> = None;

    // Linux sockaddr_un has a 108-byte field, including the terminating NUL
    // (transport.cjs line 112) — checked after mkdtemp, like the legacy try.
    if endpoint.as_os_str().as_bytes().len() > 107 {
        return Err(fail_with(
            TransportError::PathTooLong,
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }
    let listener = match UnixListener::bind(&endpoint) {
        Ok(listener) => listener,
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    };
    if let Err(error) =
        std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))
    {
        return Err(fail_with(
            TransportError::Io(error),
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }
    // Record the socket identity immediately: every later exit goes through
    // the identity-checked unlink and can never remove a foreign inode.
    match std::fs::symlink_metadata(&endpoint) {
        Ok(metadata) => socket_id = Some((metadata.dev(), metadata.ino())),
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    }
    if let Err(error) = verify_endpoint(&endpoint, &runtime) {
        return Err(fail_with(
            error,
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }

    let inner = Arc::new(Inner {
        endpoint: endpoint.clone(),
        runtime: runtime.clone(),
        directory: directory.clone(),
        directory_dev,
        directory_ino,
        socket_id,
        running: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        clients: Mutex::new(HashMap::new()),
        listener: Mutex::new(None),
        handlers: Mutex::new(Vec::new()),
        project: project.clone(),
        handshake_ms,
        idle_ms,
        store: Mutex::new(protocol::NoticeStore::new(project)),
        on_notice,
        on_connections,
        on_question_change,
        questions: Mutex::new(QuestionSnapshot::default()),
    });

    let accept_inner = inner.clone();
    let spawned = std::thread::Builder::new()
        .name("abito-accept".into())
        .spawn(move || accept_loop(accept_inner, listener));
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    };
    *inner.listener.lock().expect("listener lock") = Some(handle);
    Ok(Transport { inner })
}

fn accept_loop(inner: Arc<Inner>, listener: UnixListener) {
    let _ = listener.set_nonblocking(true);
    while inner.running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                // Owner check on the wire: same-uid peer only (SO_PEERCRED).
                // The 0600 socket already limits the filesystem side; this is
                // the transport-level counterpart the task asks for.
                if peer_uid(&stream) != Some(uid()) {
                    drop(stream);
                    continue;
                }
                let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
                let prepared = {
                    let mut clients = inner.clients.lock().expect("clients lock");
                    if clients.len() >= protocol::CONNECTIONS {
                        // legacy line 56: `socket.destroy()` — never counted.
                        None
                    } else {
                        let _ = stream.set_nonblocking(false);
                        let shared = Arc::new(stream);
                        clients.insert(
                            id,
                            Client {
                                identified: false,
                                stream: shared.clone(),
                            },
                        );
                        Some(shared)
                    }
                };
                let Some(stream) = prepared else {
                    continue;
                };
                let thread_inner = inner.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("abito-client-{id}"))
                    .spawn(move || handle_connection(thread_inner, id, stream));
                match spawned {
                    Ok(handle) => {
                        let mut handlers = inner.handlers.lock().expect("handlers lock");
                        handlers.retain(|handle| !handle.is_finished());
                        handlers.push(handle);
                    }
                    Err(_) => {
                        inner.clients.lock().expect("clients lock").remove(&id);
                        inner.report();
                    }
                }
            }
            Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return,
        }
    }
}

/// Transport-local framing; the legacy protocol module stays byte-for-byte
/// unchanged. Identification allows question negotiation in this buffer;
/// this slice does not advertise subscription and never widens legacy decode.
#[derive(Default)]
struct QuestionFramer { pending: Vec<u8> }
impl QuestionFramer {
    fn push(&mut self, chunk: &[u8], identified: bool) -> Result<protocol::Framed, ()> {
        // After v1 identification, allow a full-size questions_hello as well.
        // This is framing permission, NOT subscription or admission authority.
        let cap = if identified { question::FRAME_BYTES } else { protocol::FRAME_BYTES };
        if self.pending.len() + chunk.len() > cap * protocol::BATCH_FACTOR { return Err(()); }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        let mut legacy_bytes = 0;
        for (end, &byte) in self.pending.iter().enumerate() {
            if byte == b'\n' {
                let frame = &self.pending[start..end];
                // Classification only affects the tighter legacy batch bound.
                // Both real decoders still enforce their original full schema,
                // UTF-8, per-type byte bound and connection/opt-in authority.
                let qp = serde_json::from_slice::<serde_json::Value>(frame).ok()
                    .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| matches!(t,
                        "questions_hello" | "question" | "question_cancel" |
                        "question_resolved" | "question_answer_rejected"))).unwrap_or(false);
                if !qp { legacy_bytes += end + 1 - start; }
                if legacy_bytes > protocol::FRAME_BYTES * protocol::BATCH_FACTOR { return Err(()); }
                frames.push(frame.to_vec()); start = end + 1;
            }
        }
        self.pending.drain(..start);
        let fatal = (self.pending.len() > cap).then_some(protocol::FramingError::OversizedTail);
        Ok(protocol::Framed { frames, fatal })
    }
}

fn reject_question_negotiation(inner: &Inner, stream: &UnixStream, inbound: Inbound) {
    if matches!(inbound, Inbound::Hello) {
        // A validated opt-in is recognized, but lifecycle support is knowingly
        // absent in this slice. Never send questions_ready or invent a wire
        // rejection schema. The stable producer reports unsupported_receiver
        // when this scoped socket closes before capability readiness.
        inner.questions.lock().expect("questions lock").notice =
            Some(QuestionOutcome::CapabilityNotImplementedYet);
        let _ = stream.shutdown(std::net::Shutdown::Both);
        // No question/socket-map/writer lock is held during the observer.
        inner.question_changed();
    }
}

fn handle_connection(inner: Arc<Inner>, id: u64, stream: Arc<UnixStream>) {
    let writer = match stream.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(_) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            inner.clients.lock().expect("clients lock").remove(&id); inner.report(); return;
        }
    };
    let mut framer = QuestionFramer::default();
    let mut identity: Option<protocol::Identity> = None;
    let mut quota = protocol::FrameQuota::new(now_millis());
    let handshake_deadline = Instant::now() + Duration::from_millis(inner.handshake_ms);
    // Only a complete, valid message renews the lease (legacy `active()`):
    // partial bytes or invalid frames never move this.
    let mut last_valid: Option<Instant> = None;
    let mut buffer = [0u8; question::FRAME_BYTES * protocol::BATCH_FACTOR];

    'outer: loop {
        let deadline = match (&identity, last_valid) {
            (None, _) => handshake_deadline,
            (Some(_), Some(valid)) => valid + Duration::from_millis(inner.idle_ms),
            // Unreachable: identity is only set right after a valid frame.
            (Some(_), None) => handshake_deadline,
        };
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = (deadline - now).max(Duration::from_millis(1));
        if stream.set_read_timeout(Some(remaining)).is_err() {
            break;
        }
        let mut reader = &*stream; // Read is implemented for &UnixStream
        match reader.read(&mut buffer) {
            Ok(0) => break, // peer closed
            Ok(count) => {
                let framed = match framer.push(&buffer[..count], identity.is_some()) {
                    Ok(framed) => framed,
                    Err(_) => break, // batch cap (line 66): destroy
                };
                let mut rejected = false;
                for frame in &framed.frames {
                    // A previous frame's observer may close/drop the receiver.
                    if !inner.running.load(Ordering::SeqCst) { rejected = true; break; }
                    // rate gate BEFORE decode (transport.cjs line 74-75)
                    if quota.check(now_millis()).is_err() {
                        rejected = true;
                        break;
                    }
                    match protocol::decode(frame, &inner.project, identity.as_ref(), now_ms()) {
                        Ok(message) => {
                            last_valid = Some(Instant::now());
                            if identity.is_none() {
                                identity = Some(protocol::Identity {
                                    project: message.project.clone(),
                                    session_id: message.session_id.clone(),
                                    at: message.at,
                                });
                                if write_line(&writer, protocol::READY_LINE).is_err() {
                                    rejected = true;
                                    break;
                                }
                                {
                                    let mut clients =
                                        inner.clients.lock().expect("clients lock");
                                    if let Some(client) = clients.get_mut(&id) {
                                        client.identified = true;
                                    }
                                }
                                inner.report();
                            } else {
                                // `transport.cjs` line 83: the store gates the
                                // callback — heartbeats, dedupe, queue bounds
                                // and the boundary re-validation all run here.
                                let accepted = {
                                    let mut store =
                                        inner.store.lock().expect("transport notice store");
                                    store.accept(&message, now_ms())
                                };
                                if accepted {
                                    (inner.on_notice)(message);
                                }
                            }
                        }
                        Err(_) => {
                            let inbound = identity.as_ref().and_then(|bound| question::decode(frame, bound, now_ms()).ok());
                            if let Some(inbound) = inbound {
                                reject_question_negotiation(&inner, &stream, inbound);
                            }
                            rejected = true;
                            break; // unsupported negotiation/unsubscribed frame: fail closed
                        }
                    }
                }
                if rejected {
                    break 'outer;
                }
                if framed.fatal.is_some() {
                    break; // oversized tail (line 86): destroy
                }
            }
            Err(ref error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut =>
            {
                continue; // deadline re-checked at the top of the loop
            }
            Err(_) => break,
        }
    }

    let _ = stream.shutdown(std::net::Shutdown::Both);
    // Keep the explicit local capability reason through teardown. The legacy
    // connection callback still reports disconnect; no pending state exists.
    inner.clients.lock().expect("clients lock").remove(&id);
    inner.report();
}

// --- tests (fs-free policy; the socket behaviour is integration-tested) ------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_framing_preserves_legacy_batch_after_identification() {
        let legacy = b"{\"type\":\"heartbeat\"}\n";
        let chunk = legacy.repeat(4096 / legacy.len() + 1);
        assert!(QuestionFramer::default().push(&chunk, true).is_err());
        let qp = b"{\"type\":\"question\"}\n";
        let mut chunk = qp.repeat(32768 / qp.len());
        chunk.resize(32768, b' ');
        assert!(QuestionFramer::default().push(&chunk, true).is_ok());
        assert!(QuestionFramer::default().push(&vec![b'x';32769], true).is_err());
        assert!(QuestionFramer::default().push(&vec![b'x';513], false).unwrap().fatal.is_some());
    }

    #[test]
    fn reserved_preview_roots_are_never_allowed() {
        let xdg = Some("/run/user/1000");
        assert!(!runtime_allowed(Path::new("/run/user/1000/abito-desktop"), xdg));
        assert!(!runtime_allowed(
            Path::new("/run/user/1000/abito-desktop/p-abc123/s"),
            xdg
        ));
        assert!(!runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-preview"),
            xdg
        ));
        // sibling names are NOT reserved (component-wise prefix match)
        assert!(runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-other"),
            xdg
        ));
        assert!(runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-tauri"),
            xdg
        ));
        assert!(runtime_allowed(
            Path::new(
                "/home/alvaro/Apps/sb-second-brain/worktrees/abito-tauri/apps/desktop-tauri/.runtime"
            ),
            xdg
        ));
    }

    #[test]
    fn override_must_be_absolute_and_normalized() {
        let default = Path::new("/home/alvaro/.runtime");
        // relative or unnormalized overrides fail closed
        for bad in [
            "relative/dir",
            "/has//double",
            "/has/./dot",
            "/has/../up",
            "/trailing/",
        ] {
            let error =
                resolve_runtime_from(Some(bad), default, Some("/run/user/1000")).expect_err(bad);
            assert!(
                matches!(error, TransportError::InvalidOverride),
                "{bad}: {error:?}"
            );
        }
        // an absolute normalized override inside a reserved root is refused
        let error = resolve_runtime_from(
            Some("/run/user/1000/abito-desktop"),
            default,
            Some("/run/user/1000"),
        )
        .expect_err("reserved");
        assert!(
            matches!(error, TransportError::ReservedPreviewRoot),
            "{error:?}"
        );
        // ours resolves, default resolves
        assert_eq!(
            resolve_runtime_from(
                Some("/home/alvaro/x/.runtime-probe"),
                default,
                Some("/run/user/1000")
            )
            .expect("override"),
            PathBuf::from("/home/alvaro/x/.runtime-probe")
        );
        assert_eq!(
            resolve_runtime_from(None, default, Some("/run/user/1000")).expect("default"),
            default
        );
    }

    #[test]
    fn default_runtime_is_the_crate_side_runtime_never_a_preview_root() {
        let default = default_runtime().expect("manifest dir is set by cargo");
        assert!(default.ends_with(".runtime"));
        assert!(default.is_absolute());
        assert!(
            runtime_allowed(&default, None),
            "our own default can never be a reserved Preview root"
        );
        // generated dir names follow the legacy `p-XXXXXX` rule
        assert!(is_generated_dir_name("p-0ajNZR"));
        assert!(is_generated_dir_name("p-ABC123"));
        assert!(!is_generated_dir_name("p-abc12"));
        assert!(!is_generated_dir_name("p-abc1234"));
        assert!(!is_generated_dir_name("p-abc!23"));
        assert!(!is_generated_dir_name("other"));
        // absolute+normalized parity with path.normalize
        assert!(is_absolute_normalized("/a/b/c"));
        assert!(!is_absolute_normalized("a/b"));
        assert!(!is_absolute_normalized("/a//b"));
        assert!(!is_absolute_normalized("/a/./b"));
        assert!(!is_absolute_normalized("/a/../b"));
        assert!(!is_absolute_normalized("/a/b/"));
    }
}
