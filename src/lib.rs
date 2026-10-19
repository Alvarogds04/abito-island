//! Abito island — Electron → Rust + Tauri migration.
//!
//! Unit **M2** exposes the transport-facing modules as a library so the
//! socket integration tests (`tests/`) can bind a real receiver without a
//! GUI:
//! - [`protocol`] — pure framing/validation/quota/dedupe/expiry logic
//!   (ports of `core.cjs decode`/`NoticeStore` and the `transport.cjs`
//!   stream rules), unit-tested first (RED → GREEN),
//! - [`transport`] — the Unix-domain-socket receiver itself (permissions,
//!   owner checks, quotas, connection counting, identity-checked cleanup).
//!
//! The window/bridge modules live here too (they are pure enough to test
//! headless); `main.rs` is the Tauri wiring and `probe.rs` its read-back
//! script.

pub mod agentclient;
#[cfg(target_os = "linux")]
pub mod agentconn;
#[cfg(not(target_os = "linux"))]
#[path = "agentconn_unavailable.rs"]
pub mod agentconn;
pub mod approval;
pub mod bridge;
pub mod card;
pub mod characterwin;
pub mod chat;
pub mod chatlane;
pub mod conversations;
pub mod core;
pub mod desktop;
pub mod files;
pub mod contextwin;
pub mod focushost;
pub mod github;
pub mod githubcmd;
pub mod daemonhost;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakebridge;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakemodel;
pub mod flow;
pub mod dictation_cmd;
pub mod geometry;
#[cfg(target_os = "linux")]
pub mod handoff;
#[cfg(not(target_os = "linux"))]
#[path = "handoff_unavailable.rs"]
pub mod handoff;
pub mod hotkey;
pub mod http;
pub mod identity;
pub mod localmodel;
pub mod models;
pub mod monitors;
pub mod nativedialog;
pub mod claude_plan;
pub mod codex_plan;
pub mod plan_cmd;
pub mod prefs;
pub mod protocol;
pub mod recap;
pub mod recap_cmd;
pub mod recap_spool;
pub mod secrets;
pub mod sounds;
pub mod question;
pub mod spotify;
pub mod questioncmd;
pub mod requests;
pub mod renderenv;
pub mod retry;
pub mod speech;
pub mod transport_view;
pub mod uploads;
pub mod voicecmd;
// The real receiver is Linux-only (UDS + SO_PEERCRED). Windows named pipes
// and a macOS backend remain separate human decisions with their own cfg arms.
#[cfg(target_os = "linux")]
pub mod transport;
#[cfg(not(target_os = "linux"))]
#[path = "transport_unavailable.rs"]
pub mod transport;
pub mod workarea;
