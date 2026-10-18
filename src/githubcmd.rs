//! #467 T11 — closed `github_action` `{action:"refresh", section:"pulse"|"activity"}`:
//! read-only GitHub data through the user's own `gh` CLI session (no token is read,
//! stored or sent by Abito). Pure half: `github.rs` (Coucou, unchanged).
//!
//! Adapted from Coucou src-tauri/src/lib.rs (`github_refresh`) and integrations.rs
//! (`github_refresh_if_stale`) @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT. Coucou
//! wakes a token poller; Abito has none, so the refresh runs `gh api graphql` once, with
//! a constant query, and keeps the parsed answer until it is stale (60 s / 300 s).
use crate::bridge::{BridgeError, RateLimiter};
use crate::github::{self, GitHubActivity, GitHubPulse};
use serde_json::{json, Value};

#[cfg(test)]
#[path = "githubcmd_tests.rs"]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Pulse,
    Activity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    NotSignedIn,
    BadAnswer,
}

impl Unavailable {
    pub fn code(self) -> &'static str {
        match self {
            Unavailable::NotInstalled => "gh_not_installed",
            Unavailable::NotSignedIn => "gh_not_signed_in",
            Unavailable::BadAnswer => "gh_bad_answer",
        }
    }
}

pub fn parse_github(payload: &Value) -> Result<Section, BridgeError> {
    let bad = || BridgeError::denied("invalid github request");
    let map = payload.as_object().ok_or_else(bad)?;
    if map.len() != 2 || map.get("action").and_then(Value::as_str) != Some("refresh") {
        return Err(bad());
    }
    match map.get("section").and_then(Value::as_str) {
        Some("pulse") => Ok(Section::Pulse),
        Some("activity") => Ok(Section::Activity),
        _ => Err(bad()),
    }
}

/// The whole argv after `gh`: a GraphQL *query* (constant, never caller text).
pub fn gh_args(section: Section) -> Vec<String> {
    let query = match section {
        Section::Pulse => github::PULSE_QUERY,
        Section::Activity => github::ACTIVITY_QUERY,
    };
    vec!["api".into(), "graphql".into(), "-f".into(), format!("query={query}")]
}

#[derive(Default)]
pub struct Cache {
    pulse: Option<GitHubPulse>,
    activity: Option<GitHubActivity>,
}

impl Cache {
    /// Serves the cache while fresh, else `fetch`es once. A failure caches nothing.
    pub fn refresh<F>(&mut self, section: Section, now_ms: u64, fetch: F) -> Result<Value, Unavailable>
    where
        F: FnOnce(Section) -> Result<Value, Unavailable>,
    {
        let (fetched_at, max_age) = match section {
            Section::Pulse => (self.pulse.as_ref().map(|p| p.fetched_at), 60),
            Section::Activity => (self.activity.as_ref().map(|a| a.fetched_at), 300),
        };
        let stale = github::is_stale(fetched_at, now_ms, max_age);
        if stale {
            let root = fetch(section)?;
            match section {
                Section::Pulse => self.pulse = Some(GitHubPulse::parse(&root, now_ms).ok_or(Unavailable::BadAnswer)?),
                Section::Activity => self.activity = Some(GitHubActivity::parse(&root, now_ms).ok_or(Unavailable::BadAnswer)?),
            }
        }
        let mut out = json!({ "available": true, "fetched": stale });
        match section {
            Section::Pulse => out["pulse"] = serde_json::to_value(&self.pulse).unwrap_or(Value::Null),
            Section::Activity => out["activity"] = serde_json::to_value(&self.activity).unwrap_or(Value::Null),
        }
        Ok(out)
    }
}

/// Sender → payload → rate → refresh. Unavailable `gh` is an honest answer, not an error.
pub fn github_command<F>(
    label: &str,
    origin: &str,
    payload: &Value,
    rate: &mut RateLimiter,
    now: u128,
    cache: &mut Cache,
    fetch: F,
) -> Result<Value, BridgeError>
where
    F: FnOnce(Section) -> Result<Value, Unavailable>,
{
    crate::bridge::sender_ok(label, origin)?;
    let section = parse_github(payload)?;
    rate.check(now)?;
    Ok(match cache.refresh(section, now as u64, fetch) {
        Ok(v) => v,
        Err(why) => json!({ "available": false, "reason": why.code() }),
    })
}

/// Runs `gh` (looked up on PATH like `files::find_on_path_in`), 20 s at most, stdin closed.
pub fn run_gh(section: Section) -> Result<Value, Unavailable> {
    use std::io::Read;
    let gh = std::env::var_os("PATH")
        .and_then(|p| crate::files::find_on_path_in("gh", &p))
        .ok_or(Unavailable::NotInstalled)?;
    let mut child = std::process::Command::new(gh)
        .args(gh_args(section))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| Unavailable::NotInstalled)?;
    let mut stdout = child.stdout.take().ok_or(Unavailable::BadAnswer)?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(2 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Unavailable::BadAnswer);
            }
        }
    };
    let bytes = reader.join().map_err(|_| Unavailable::BadAnswer)?;
    if !status.success() {
        // `gh` exits non-zero when it is not authenticated (or the call failed).
        return Err(Unavailable::NotSignedIn);
    }
    serde_json::from_slice(&bytes).map_err(|_| Unavailable::BadAnswer)
}
