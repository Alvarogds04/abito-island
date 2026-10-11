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
pub mod chat;
pub mod chatlane;
pub mod core;
pub mod desktop;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakebridge;
#[cfg(any(debug_assertions, feature = "probe"))]
pub mod fakemodel;
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
pub mod prefs;
pub mod protocol;
pub mod question;
pub mod questioncmd;
pub mod requests;
pub mod retry;
pub mod transport_view;
// The real receiver is Linux-only (UDS + SO_PEERCRED). Windows named pipes
// and a macOS backend remain separate human decisions with their own cfg arms.
#[cfg(target_os = "linux")]
pub mod transport;
#[cfg(not(target_os = "linux"))]
#[path = "transport_unavailable.rs"]
pub mod transport;
pub mod workarea;
