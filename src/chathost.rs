//! Unit U1 host wiring: the `chat_action` command, the `chat:state` event,
//! and the overview <-> chat resize of the SAME island window.
//!
//! The WebView sends only the closed `chat::Command` set (validated here:
//! sender gate, size/shape, rate) — never an endpoint, alias, key or
//! approval. Rust owns the target (U2 picker) and the single loopback
//! request per turn (`chatlane`). Nothing in this file touches the desktop
//! snapshot shape (`desktop:state` keeps its 13 keys).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use abito_island::bridge::{self, BridgeError};
use abito_island::chat::{self, Command};
use abito_island::chatlane::{self, Target};
use abito_island::core::ViewPlan;
use abito_island::desktop::IslandState;
use abito_island::geometry;
use abito_island::localmodel::DEFAULT_DEADLINES;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    main_window, now_ms, publish, refresh_work_area, store_requested, AppState, TauriIo,
    COLLAPSE_RESIZE_DELAY_MS, QUITTING,
};

fn chat_error(e: chat::ChatError) -> BridgeError {
    BridgeError {
        code: e.code,
        message: e.safe_message,
    }
}

/// The selected local target. U2 replaces the source of this value with
/// the model picker; the turn freezes a copy at submit.
pub fn current_target(state: &AppState) -> Option<Target> {
    state.chat_target.lock().expect("chat target lock").clone()
}

/// `chat:state` payload: the conversation projection, the current view, the
/// chat geometry (from the ONE Rust constant) and the target's visible
/// identity (origin + alias, never a credential — there is none).
pub fn chat_view(app: &AppHandle, state: &AppState) -> Value {
    let _ = app;
    let mut v = state.chat.lock().expect("chat lane lock").view();
    let chat_open = state.core.lock().expect("core lock").chat
        && *state.phase.lock().expect("phase lock") == IslandState::Expanded;
    v["view"] = json!(if chat_open { "chat" } else { "overview" });
    v["chat_visible"] = json!([geometry::CHAT_VISIBLE.0, geometry::CHAT_VISIBLE.1]);
    v["target"] = match current_target(state) {
        Some(t) => json!({
            "origin": t.endpoint.origin(),
            "alias": t.alias,
            "profile_id": t.profile.profile_id,
            "profile_revision": t.profile.revision,
            "max_output_tokens": t.max_output,
        }),
        None => Value::Null,
    };
    v["producer"] = json!({
        "pi": "not_connected",
        "note": "Chat con el modelo local. El productor de Pi no existe todavía en el escritorio."
    });
    v
}

pub fn publish_chat(app: &AppHandle) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let v = chat_view(app, &state);
    if let Err(e) = app.emit("chat:state", &v) {
        eprintln!("chat:state emit failed: {e}");
    }
}

/// Apply an overview <-> chat plan: growing resizes first, then the
/// frontend animates; shrinking animates first and resizes after the 340 ms
/// shrink (generation-guarded, the same rule as `apply_plan`).
pub fn apply_view(app: &AppHandle, state: &AppState, plan: ViewPlan) {
    let ViewPlan {
        chat,
        size: (w, h),
        rect: r,
        ..
    } = plan;
    store_requested(state, if chat { "chat" } else { "overview" }, Some((r.x, r.y)), Some((w, h)));
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let win = main_window(app);
    let (vw, vh) = geometry::CHAT_VISIBLE;
    let push = format!(
        "window.__islandSetView && window.__islandSetView('{}',{vw},{vh});",
        if chat { "chat" } else { "overview" }
    );
    if chat {
        TauriIo(&win).set_size(w, h);
        TauriIo(&win).set_outer_position(r.x, r.y);
        let _ = win.eval(push);
    } else {
        let _ = win.eval(push);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(COLLAPSE_RESIZE_DELAY_MS));
            let state = app.state::<AppState>();
            if state.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let win = main_window(&app);
            TauriIo(&win).set_size(w, h);
            TauriIo(&win).set_outer_position(r.x, r.y);
        });
    }
}

/// Switch the expanded island to the chat (`true`) or the overview.
pub fn switch_view(app: &AppHandle, state: &AppState, chat: bool) {
    if *state.phase.lock().expect("phase lock") != IslandState::Expanded {
        return; // the chat opens only from the overview, never from compact
    }
    let area = refresh_work_area(app, state);
    let win = main_window(app);
    let io = TauriIo(&win);
    let plan = state
        .core
        .lock()
        .expect("core lock")
        .plan_view(&io, area, chat);
    let opened = plan.as_ref().is_some_and(|p| p.chat);
    if let Some(plan) = plan {
        apply_view(app, state, plan);
    }
    publish_chat(app);
    if opened {
        // Say "unavailable" before anyone types: metadata only, no prompt.
        if let Some(target) = current_target(state) {
            let lane = Arc::clone(&state.chat);
            let app = app.clone();
            std::thread::spawn(move || {
                chatlane::check(&lane, &target);
                publish_chat(&app);
            });
        }
    }
}

/// Submit one message: validated, accepted with native ids, then ONE
/// background turn against the frozen local target.
pub fn submit(
    app: &AppHandle,
    state: &AppState,
    text: &str,
    client_request_id: &str,
) -> Result<Value, BridgeError> {
    let lane = Arc::clone(&state.chat);
    if let Some(dup) = lane.lock().expect("chat lane lock").convo.lookup(client_request_id) {
        return Ok(serde_json::to_value(dup).unwrap_or(Value::Null)); // same turn, no new job
    }
    let target = current_target(state).ok_or_else(|| chat_error(chat::ChatError::profile_missing()))?;
    let gate = crate::model_gate(state, &target);
    if let Err(e) = gate {
        return Err(chat_error(e));
    }
    let accepted = lane
        .lock()
        .expect("chat lane lock")
        .convo
        .submit(text, client_request_id, &target.profile)
        .map_err(chat_error)?;
    publish_chat(app);
    if !accepted.duplicate {
        let app = app.clone();
        let turn = accepted.turn_id.clone();
        let deadlines = *state.chat_deadlines.lock().expect("deadlines lock");
        std::thread::spawn(move || {
            let publish_app = app.clone();
            let publish = move || publish_chat(&publish_app);
            chatlane::run_turn(&lane, &turn, &target, deadlines, &publish);
        });
    }
    Ok(serde_json::to_value(accepted).unwrap_or(Value::Null))
}

/// `chat_action`: sender gate → payload shape → rate → dispatch.
#[tauri::command]
pub async fn chat_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command = chat::parse_command(&payload).map_err(chat_error)?;
    state.chat_rate.lock().expect("chat rate lock").check(now_ms())?;
    match command {
        Command::View => Ok(chat_view(&app, &state)),
        Command::Check => {
            // metadata only, off the main thread; never a prompt
            if let Some(target) = current_target(&state) {
                let lane = Arc::clone(&state.chat);
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    chatlane::check(&lane, &target);
                    publish_chat(&handle);
                })
                .await
                .map_err(|_| BridgeError::denied("check aborted"))?;
            }
            Ok(chat_view(&app, &state))
        }
        Command::Open | Command::Back => {
            switch_view(&app, &state, command == Command::Open);
            publish(&app, &state);
            Ok(chat_view(&app, &state))
        }
        Command::Submit {
            text,
            client_request_id,
        } => submit(&app, &state, &text, &client_request_id),
        Command::Cancel { turn_id } => {
            let cancelled = chatlane::cancel(&state.chat, &turn_id);
            publish_chat(&app);
            Ok(json!({ "cancelled": cancelled }))
        }
    }
}

/// Default deadlines for production turns.
pub fn default_deadlines() -> abito_island::localmodel::Deadlines {
    DEFAULT_DEADLINES
}
