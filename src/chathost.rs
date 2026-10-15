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
use abito_island::conversations::SpecialistRef;
use abito_island::desktop::IslandState;
use abito_island::geometry;
use abito_island::localmodel::DEFAULT_DEADLINES;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    main_window, now_ms, publish, refresh_work_area, specialistshost, store_requested, AppState, TauriIo,
    CHAT_SETTLE_DELAY_MS, COLLAPSE_RESIZE_DELAY_MS, QUITTING,
};

fn chat_error(e: chat::ChatError) -> BridgeError {
    BridgeError {
        code: e.code,
        message: e.safe_message,
    }
}

/// The selected local target of ONE turn. U2 fills the picker's selection; #327 overrides it with
/// the active specialist's own model when that role names one, and refuses the send (instead of
/// substituting another model) when the named one is no longer selectable.
pub fn current_target(state: &AppState) -> Option<Target> {
    specialistshost::effective_target(state).ok().flatten()
}

/// `chat:state` payload: the conversation projection, the current view, the
/// chat geometry (from the ONE Rust constant) and the target's visible
/// identity (origin + alias, never a credential — there is none).
pub fn chat_view(app: &AppHandle, state: &AppState) -> Value {
    let _ = app;
    let mut v = state.chat.lock().expect("chat lane lock").view();
    v["display_name"] = json!(crate::settingshost::display_name(&state.settings));
    let chat_open = state.core.lock().expect("core lock").chat
        && *state.phase.lock().expect("phase lock") == IslandState::Expanded;
    v["view"] = json!(if chat_open { "chat" } else { "overview" });
    // #309: the column's height follows the work area, so Rust computes it from the current one
    let area = *state.work_area.lock().expect("work area lock");
    let scale = main_window(app).scale_factor().unwrap_or(1.0);
    let settings_open = state.core.lock().expect("core lock").settings;
    let (cw, ch) = if settings_open {
        geometry::settings_visible(area.w, area.h, scale)
    } else {
        geometry::chat_visible(area.h, scale)
    };
    v["chat_visible"] = json!([cw, ch]);
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
        stage,
        visible: (vw, vh),
        ..
    } = plan;
    store_requested(state, if chat { "chat" } else { "overview" }, Some((r.x, r.y)), Some((w, h)));
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let win = main_window(app);
    let push = format!(
        "window.__islandSetView && window.__islandSetView('{}',{vw},{vh});",
        if chat { "chat" } else { "overview" }
    );
    // #309: overview and column move in opposite directions per axis (672x176 <-> 432x656), so the
    // window first becomes the STAGE that holds both views, the page animates inside it, and the
    // window settles on the final rectangle once the animation is over. Opening: stage now, final
    // after the grow spring; closing: stage now, final after the 340 ms shrink (same generation
    // guard as every other deferred resize, so a newer plan always wins).
    TauriIo(&win).set_size(stage.w, stage.h);
    TauriIo(&win).set_outer_position(stage.x, stage.y);
    let _ = win.eval(push);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(if chat { CHAT_SETTLE_DELAY_MS } else { COLLAPSE_RESIZE_DELAY_MS }));
        let state = app.state::<AppState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let win = main_window(&app);
        TauriIo(&win).set_size(w, h);
        TauriIo(&win).set_outer_position(r.x, r.y);
    });
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
        if current_target(state).is_none() {
            state.chat.lock().expect("chat lane lock").availability = chatlane::Availability {
                state: "blocked",
                message: "No hay un modelo local elegido. Elegilo en «Modelo».".to_string(),
            };
            publish_chat(app);
        }
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

/// #408: give the chat column the Settings size while Ajustes is open (`open`) and take it back on close.
/// Only from the chat view; anchored to the docked edge and clamped to the work area like every view.
pub fn switch_settings(app: &AppHandle, state: &AppState, open: bool) {
    if *state.phase.lock().expect("phase lock") != IslandState::Expanded {
        return;
    }
    let area = refresh_work_area(app, state);
    let win = main_window(app);
    let io = TauriIo(&win);
    let plan = state.core.lock().expect("core lock").plan_settings(&io, area, open);
    if let Some(plan) = plan {
        apply_view(app, state, plan);
        publish_chat(app);
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
    // #327: one role snapshot supplies both model and system. Later changes affect the next turn.
    let (target, system, specialist) = specialistshost::turn_snapshot(state, chatlane::SYSTEM_PROMPT)
        .map_err(chat_error)?;
    let target = target.ok_or_else(|| chat_error(chat::ChatError::profile_missing()))?;
    let gate = crate::model_gate(state, &target);
    if let Err(e) = gate {
        return Err(chat_error(e));
    }
    let (accepted, conversation_id) = {
        let mut l = lane.lock().expect("chat lane lock");
        let accepted = l.submit(text, client_request_id, &target.profile, specialist, chatlane::history_now()).map_err(chat_error)?;
        (accepted, l.convo.id().to_owned())
    };
    publish_chat(app);
    if !accepted.duplicate {
        let app = app.clone();
        let turn = accepted.turn_id.clone();
        let deadlines = *state.chat_deadlines.lock().expect("deadlines lock");
        std::thread::spawn(move || {
            let publish_app = app.clone();
            let publish = move || publish_chat(&publish_app);
            chatlane::run_turn_scoped(&lane, &conversation_id, &turn, &target, &system, deadlines, &publish);
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
        Command::List => state.chat.lock().expect("chat lane lock").list_conversations().map_err(chat_error),
        Command::History { conversation_id, before } => state.chat.lock().expect("chat lane lock").history_page(&conversation_id, before).map_err(chat_error),
        Command::New => {
            let specialist = state.specialists.role().map(|s| SpecialistRef { id: s.id, name: s.name });
            state.chat.lock().expect("chat lane lock").new_conversation(specialist, chatlane::history_now()).map_err(chat_error)?;
            publish_chat(&app);
            Ok(chat_view(&app, &state))
        }
        Command::Restore { conversation_id } => {
            // Hold the lane across role restoration: another send cannot slip into the old context.
            let mut l = state.chat.lock().expect("chat lane lock");
            let (summary, page) = l.prepare_conversation(&conversation_id).map_err(chat_error)?;
            let role_id = summary.specialist.as_ref().map(|s| s.id.as_str());
            let missing = specialistshost::select_conversation_role(&app, &state, role_id)?;
            l.activate_conversation(summary, page);
            if missing { l.history_notice("El especialista de esta conversación ya no existe; ahora responde Abito principal."); }
            drop(l);
            publish_chat(&app);
            Ok(chat_view(&app, &state))
        }
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

/// Initialize private local history; probes are memory-only unless explicitly isolated.
pub fn start_history(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dir = if let Ok(dir) = std::env::var("ABITO_CONVERSATIONS_DATA_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if !dir.is_absolute() { state.chat.lock().expect("chat lane lock").history_failure("El directorio de historial de prueba no es válido; los mensajes no se guardarán."); return; }
        Some(dir)
    } else if crate::probe_requested() { None }
    else { app.path().app_data_dir().ok().map(|p| p.join("conversations")) };
    if let Some(dir) = dir { let _ = state.chat.lock().expect("chat lane lock").init_history(&dir); }
}

/// Default deadlines for production turns.
pub fn default_deadlines() -> abito_island::localmodel::Deadlines {
    DEFAULT_DEADLINES
}
