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

pub mod approval;
pub mod bridge;
pub mod card;
pub mod chat;
pub mod chatlane;
pub mod core;
pub mod desktop;
pub mod fakebridge;
pub mod fakemodel;
pub mod geometry;
pub mod http;
pub mod localmodel;
pub mod models;
pub mod protocol;
pub mod question;
pub mod questioncmd;
pub mod requests;
pub mod retry;
pub mod transport;
pub mod workarea;
