//! QP.3a host only. A main-webview sender is not proof of trusted human input;
//! QP.3b must gate gestures. These questions never authorize backend proposals.
use crate::{main_window, now_ms, AppState, QUITTING};
use abito_island::bridge::{self, BridgeError};
use abito_island::questioncmd::{self, Command};
use abito_island::transport::HumanReplyError;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

fn error(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo completar la respuesta de Pi.".into(),
    }
}
fn reply_error(e: HumanReplyError) -> BridgeError {
    error(match e {
        HumanReplyError::Validation(e) => questioncmd::error_code(e),
        HumanReplyError::OutcomeUnknown => "outcome_unknown",
    })
}
pub fn question_view(state: &AppState) -> Value {
    let transport = state.transport.lock().expect("transport lock");
    match transport.as_ref() {
        Some(t) => {
            let mut v = serde_json::to_value(t.question_snapshot()).unwrap_or(Value::Null);
            v["available"] = json!(true);
            v
        }
        None => {
            json!({"available":false,"pending":null,"deliveries":[],"ready_connections":0,"notice":null,"native_transition":null})
        }
    }
}
/// Marshal invalidation to the main thread: a command can still hold the host
/// transport guard when the transport invokes its observer. No synchronous
/// reentry, no focus, expansion, text logging or browser persistence.
pub fn invalidate(app: &AppHandle) {
    let scheduler = app.clone();
    // run_on_main_thread may execute inline if already on that thread. Always
    // enqueue from another thread, never while the caller holds host guards.
    std::thread::spawn(move || {
        let handle = scheduler.clone();
        let _ = scheduler.run_on_main_thread(move || {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            let state = handle.state::<AppState>();
            let _ = handle.emit("question:state", question_view(&state));
        });
    });
}
/// Lock order: host transport → questions → core/phase. Never publish question
/// state inside this operation (desktop/chat publication is independent).
pub fn with_pending<T>(state: &AppState, operation: impl FnOnce(bool) -> T) -> T {
    let transport = state.transport.lock().expect("transport lock");
    match transport.as_ref() {
        Some(t) => t.with_question_pending(operation),
        None => operation(false),
    }
}
/// Click-only atomic matching/navigation transaction. Lock order stays host
/// transport → questions → core/phase; publication/native work follows unlock.
pub fn with_question_click<T>(state: &AppState, id: &str, operation: impl FnOnce() -> T) -> Result<T, BridgeError> {
    let transport = state.transport.lock().expect("transport lock");
    let t = transport.as_ref().ok_or_else(|| BridgeError::denied("notice is not current"))?;
    t.with_question_click(id, operation)
}
/// Run on the main thread, never from inside with_pending. The transport
/// establishes its barrier before invoking actual runtime resize work.
pub fn compact_resize_request(
    app: &AppHandle,
    generation: u64,
    expected: (u32, u32),
    operation: &mut dyn FnMut(bool),
) {
    let state = app.state::<AppState>();
    let current = || {
        // Separate guards: never retain phase while acquiring core.
        let compact =
            *state.phase.lock().expect("phase lock") == abito_island::desktop::IslandState::Compact;
        let expanded = state.core.lock().expect("core lock").expanded;
        !QUITTING.load(Ordering::SeqCst)
            && state.generation.load(Ordering::SeqCst) == generation
            && compact
            && !expanded
    };
    let observed = || {
        main_window(app)
            .inner_size()
            .ok()
            .map(|s| (s.width, s.height))
    };
    let guard = state.transport.lock().expect("transport lock");
    match guard.as_ref() {
        Some(t) => {
            t.compact_resize(generation, expected, current, observed, operation);
        }
        None => {
            if current() {
                operation(true);
            }
        } // unavailable receiver cannot admit questions
    }
}
pub fn native_resized(app: &AppHandle, size: (u32, u32)) {
    let state = app.state::<AppState>();
    let guard = state.transport.lock().expect("transport lock");
    if let Some(t) = guard.as_ref() {
        t.native_resize_observed_current(size, || {
            let generation = state.generation.load(Ordering::SeqCst);
            let core = state.core.lock().expect("core lock");
            let win = main_window(app);
            let scale = win.scale_factor().ok()?;
            if !scale.is_finite() || scale <= 0.0 {
                return None;
            }
            let area_h = state.work_area.lock().expect("work area lock").h;
            let desired = questioncmd::desired_native_size_for(core.expanded, core.chat, scale, area_h, core.chat_height());
            let actual = win.inner_size().ok()?;
            if (actual.width, actual.height) != size
                || state.generation.load(Ordering::SeqCst) != generation
            {
                return None;
            }
            // Actual event + getter + current target, NOT an OS causal ID or
            // permission to accept an arbitrary old compact observation.
            Some((generation, desired))
        });
    }
}
pub fn pending_error() -> BridgeError {
    BridgeError {
        code: "question_pending".into(),
        message: "Pi espera tu respuesta; la isla permanece abierta.".into(),
    }
}
/// Sender → closed shape/UTF-8 size → original shared chat/models rate → dispatch.
#[tauri::command]
pub async fn question_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command =
        questioncmd::parse_command(&payload).map_err(|e| error(questioncmd::error_code(e)))?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    if matches!(command, Command::View) {
        return Ok(question_view(&state));
    }
    let handle = app.clone();
    // Origin writes have a bounded deadline; never block WebKit's UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        {
            let guard = state.transport.lock().expect("transport lock");
            let t = guard.as_ref().ok_or_else(|| error("unavailable"))?;
            match command {
                Command::Budget { id, text } => {
                    return t
                        .question_text_budget(&id, &text)
                        .map(|b| serde_json::to_value(b).unwrap_or(Value::Null))
                        .map_err(|e| error(questioncmd::error_code(e)))
                }
                Command::Answer { id, index } => t.answer(&id, index),
                Command::Text { id, text } => t.answer_text(&id, text),
                Command::Decline { id } => t.decline(&id),
                Command::View => unreachable!(),
            }
            .map_err(reply_error)?;
        }
        Ok(question_view(&state)) // never return a stale view on denied mutation
    })
    .await
    .map_err(|_| error("question_aborted"))?
}
