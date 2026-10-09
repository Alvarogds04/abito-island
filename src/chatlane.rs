//! Unit U1 — the chat lane: one conversation, one LOCAL model, one turn at a
//! time. Glue between the pure contract ([`crate::chat`]), the loopback
//! client ([`crate::localmodel`]) and the host (publish hook).
//!
//! Per turn, in order, with no hidden step:
//! 1. `submit` (native ids, duplicate client id → same turn, running turn →
//!    `queue_full`),
//! 2. preflight: four bounded metadata GETs on the SAME pinned endpoint
//!    (`/health`, `/props`, `/slots`, `/v1/models`) → [`assess`]. Router down
//!    → `local_model_unavailable`; model asleep (a send would make the router
//!    load ~18 GB) → `resource_authorization_required`, nothing is loaded;
//!    another alias loaded → unavailable, never substituted,
//! 3. bounded prompt against the model's REAL context (visible trimming),
//! 4. exactly one streamed `POST /v1/chat/completions`; no retry, no
//!    fallback — a failure ends the turn with a safe error.
//!
//! There is no Pi chat producer on the desktop: this lane is the local-model
//! conversation only. The Pi adapter remains a marked future dependency.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::{ChatError, Conversation, Event, FinishReason, ProfileRef};
use crate::localmodel::{self, Cancel, Deadlines, Ended, Finish, LocalEndpoint, StreamItem};

/// Output cap for one island answer (bounded; the profile may lower it).
pub const ISLAND_MAX_OUTPUT_TOKENS: usize = 1024;

/// The one verified local route today (parent inventory 2026-10-08):
/// llama.cpp router on loopback, alias `Abito-gpt`. U2's picker selects
/// among verified local profiles; nothing here can name a remote one.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11002";
pub const DEFAULT_ALIAS: &str = "Abito-gpt";

/// The default local target (`local-abito-gpt`, revision 1).
pub fn default_target() -> Target {
    Target {
        endpoint: LocalEndpoint::parse(DEFAULT_ENDPOINT).expect("default endpoint is loopback"),
        alias: DEFAULT_ALIAS.to_string(),
        profile: ProfileRef {
            profile_id: "local-abito-gpt".to_string(),
            revision: 1,
            lane_id: "conversation".to_string(),
        },
        max_output: ISLAND_MAX_OUTPUT_TOKENS,
    }
}
/// Metadata preflight deadline per GET.
pub const PREFLIGHT_DEADLINE_MS: u64 = 1_500;

/// The system message: who Abito is here and, honestly, what it cannot do.
pub const SYSTEM_PROMPT: &str = "Sos Abito, el compañero de escritorio de Second Brain. \
Respondé en español rioplatense, breve y en texto plano (sin Markdown). \
Corrés en un modelo local de esta máquina. No ves la pantalla, no podés usar el mouse, \
el teclado, archivos ni herramientas, y no podés aprobar ni ejecutar nada: si te piden \
una acción, explicá que desde este chat no podés hacerla.";

/// Spanish decimal gigabytes with one decimal (`18,2 GB`).
pub fn gigabytes(bytes: u64) -> String {
    let tenths = (bytes as f64 / 1e8).round() as u64;
    format!("{},{} GB", tenths / 10, tenths % 10)
}

/// What the preflight established for one send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub context_limit: usize,
    pub busy: bool,
    pub size_bytes: Option<u64>,
}

fn model_entry<'a>(models: Option<&'a Value>, alias: &str) -> Option<&'a Value> {
    models?
        .get("data")?
        .as_array()?
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(alias))
}

/// Pure preflight decision over the four metadata answers (`None` = the
/// read failed). Unknown never means "probably fine": it refuses.
pub fn assess(
    alias: &str,
    health: Option<&Value>,
    props: Option<&Value>,
    slots: Option<&Value>,
    models: Option<&Value>,
) -> Result<Ready, ChatError> {
    if health.and_then(|h| h.get("status")).and_then(Value::as_str) != Some("ok") {
        return Err(ChatError::local_model_unavailable());
    }
    let entry = model_entry(models, alias);
    let size_bytes = entry
        .and_then(|m| m.pointer("/meta/size"))
        .and_then(Value::as_u64);
    let Some(props) = props else {
        return Err(ChatError::resource_authorization_required(
            "No se pudo leer el estado del modelo local; no se envió nada.",
        ));
    };
    if props.get("model_alias").and_then(Value::as_str) != Some(alias) {
        return Err(ChatError::local_model_unavailable());
    }
    match props.get("is_sleeping").and_then(Value::as_bool) {
        Some(false) => {}
        Some(true) => {
            let size = size_bytes
                .map(|b| format!(" (~{} en memoria)", gigabytes(b)))
                .unwrap_or_default();
            return Err(ChatError::resource_authorization_required(&format!(
                "El modelo local está dormido: enviar lo cargaría{size}. No se cargó nada; despertalo vos desde su servicio si querés usarlo."
            )));
        }
        None => {
            return Err(ChatError::resource_authorization_required(
                "No se sabe si el modelo local está cargado; no se envió nada.",
            ))
        }
    }
    let slot_list = slots.and_then(Value::as_array);
    let slot_ctx = slot_list
        .and_then(|s| s.first())
        .and_then(|s| s.get("n_ctx"))
        .and_then(Value::as_u64);
    let model_ctx = entry
        .and_then(|m| m.pointer("/meta/n_ctx"))
        .and_then(Value::as_u64);
    let Some(context_limit) = slot_ctx.or(model_ctx) else {
        return Err(ChatError::resource_authorization_required(
            "No se conoce el contexto del modelo local; no se envió nada.",
        ));
    };
    let busy = slot_list.is_some_and(|s| {
        s.iter()
            .any(|slot| slot.get("is_processing").and_then(Value::as_bool) == Some(true))
    });
    Ok(Ready {
        context_limit: context_limit as usize,
        busy,
        size_bytes,
    })
}

/// The selected local target a turn is frozen to.
#[derive(Debug, Clone)]
pub struct Target {
    pub endpoint: LocalEndpoint,
    pub alias: String,
    pub profile: ProfileRef,
    pub max_output: usize,
}

/// Read the four metadata routes from the target (bounded, no inference).
pub fn preflight(target: &Target) -> Result<Ready, ChatError> {
    let get = |path| localmodel::get_json(&target.endpoint, path, PREFLIGHT_DEADLINE_MS);
    let health = get("/health");
    if health.is_none() {
        return Err(ChatError::local_model_unavailable());
    }
    let props = get("/props");
    let slots = get("/slots");
    let models = get("/v1/models");
    assess(
        &target.alias,
        health.as_ref(),
        props.as_ref(),
        slots.as_ref(),
        models.as_ref(),
    )
}

/// What the chat may say about the local model BEFORE anyone sends:
/// `unchecked` (never read), `ready`, `busy` (a send waits in its queue),
/// `unavailable` (router down / alias gone — Send disabled, nothing else is
/// tried), `blocked` (asleep or unknown state — Send disabled, nothing is
/// loaded).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Availability {
    pub state: &'static str,
    pub message: String,
}

impl Availability {
    pub fn unchecked() -> Self {
        Availability {
            state: "unchecked",
            message: "Todavía no se comprobó el modelo local.".to_string(),
        }
    }
    pub fn can_send(&self) -> bool {
        matches!(self.state, "ready" | "busy")
    }
}

/// Pure mapping from a preflight result to what the chat shows.
pub fn availability_of(result: &Result<Ready, ChatError>) -> Availability {
    match result {
        Ok(r) if r.busy => Availability {
            state: "busy",
            message: "Modelo local listo, atendiendo otro pedido: tu mensaje esperaría en su cola."
                .to_string(),
        },
        Ok(_) => Availability {
            state: "ready",
            message: "Modelo local listo.".to_string(),
        },
        Err(e) if e.code == "local_model_unavailable" => Availability {
            state: "unavailable",
            message: e.safe_message.clone(),
        },
        Err(e) => Availability {
            state: "blocked",
            message: e.safe_message.clone(),
        },
    }
}

/// Mutable lane state behind one mutex.
#[derive(Debug)]
pub struct Lane {
    pub convo: Conversation,
    cancel: Option<(String, Arc<Cancel>)>,
    /// Last preflight shown to the human (`busy` → "en cola").
    pub queue_note: Option<String>,
    /// Last availability read (metadata only).
    pub availability: Availability,
}

pub type SharedLane = Arc<Mutex<Lane>>;

impl Lane {
    pub fn new(conversation_id: &str) -> SharedLane {
        Arc::new(Mutex::new(Lane {
            convo: Conversation::new(conversation_id),
            cancel: None,
            queue_note: None,
            availability: Availability::unchecked(),
        }))
    }

    pub fn view(&self) -> Value {
        let mut v = self.convo.view();
        v["queue_note"] = json!(self.queue_note);
        v["availability"] = json!(self.availability);
        v
    }
}

/// Read availability (metadata only) and store it. Never sends a prompt.
pub fn check(lane: &SharedLane, target: &Target) -> Availability {
    let a = availability_of(&preflight(target));
    lane.lock().expect("chat lane lock").availability = a.clone();
    a
}

/// Request cancellation of the running turn: terminal at once (later deltas
/// discarded), socket shut down best-effort. Already-consumed compute cannot
/// be reclaimed — the UI says so.
pub fn cancel(lane: &SharedLane, turn_id: &str) -> bool {
    let mut l = lane.lock().expect("chat lane lock");
    let done = l.convo.cancel(turn_id);
    if let Some((id, handle)) = &l.cancel {
        if id == turn_id {
            handle.cancel();
        }
    }
    if done {
        l.queue_note = None;
    }
    done
}

/// Run one accepted turn to its end on the CURRENT thread (callers spawn a
/// thread). `publish` is called after every visible change.
pub fn run_turn(
    lane: &SharedLane,
    turn_id: &str,
    target: &Target,
    deadlines: Deadlines,
    publish: &(dyn Fn() + Send + Sync),
) {
    let handle = Arc::new(Cancel::new());
    {
        let mut l = lane.lock().expect("chat lane lock");
        l.cancel = Some((turn_id.to_string(), Arc::clone(&handle)));
    }
    let apply = |event: Event| -> bool {
        let mut l = lane.lock().expect("chat lane lock");
        let Some(seq) = l.convo.turn(turn_id).map(|t| t.seq + 1) else {
            return false;
        };
        let truncated = matches!(
            l.convo.apply(turn_id, seq, event),
            Ok(crate::chat::Applied::Truncated)
        );
        let terminal = l
            .convo
            .turn(turn_id)
            .is_none_or(|t| t.state.is_terminal());
        if terminal {
            l.queue_note = None;
        }
        drop(l);
        publish();
        if truncated {
            handle.cancel(); // limit reached: stop reading, never re-request
        }
        !terminal
    };

    // 1. thinking: preflight + prompt processing
    if !apply(Event::Thinking) {
        return;
    }
    let checked = preflight(target);
    lane.lock().expect("chat lane lock").availability = availability_of(&checked);
    let ready = match checked {
        Ok(r) => r,
        Err(e) => {
            apply(Event::Error(e));
            return;
        }
    };
    {
        let mut l = lane.lock().expect("chat lane lock");
        l.queue_note = ready.busy.then(|| {
            "El modelo local está atendiendo otro pedido: tu mensaje espera en su cola.".to_string()
        });
    }
    publish();
    let prompt = {
        let mut l = lane.lock().expect("chat lane lock");
        l.convo.prompt_for(
            turn_id,
            SYSTEM_PROMPT,
            ready.context_limit,
            target.max_output,
        )
    };
    let prompt = match prompt {
        Ok(p) => p,
        Err(e) => {
            apply(Event::Error(e));
            return;
        }
    };
    if handle.is_cancelled() {
        return;
    }

    // 2. exactly one streamed request
    let mut on_item = |item: &StreamItem| {
        if let StreamItem::Content(text) = item {
            let mut l = lane.lock().expect("chat lane lock");
            l.queue_note = None;
            drop(l);
            apply(Event::Delta(text.clone()));
        }
    };
    let ended = localmodel::stream_chat(
        &target.endpoint,
        &target.alias,
        &prompt.messages,
        target.max_output,
        deadlines,
        &handle,
        &mut on_item,
    );
    match ended {
        Ended::Finished(Finish::Stop) => {
            apply(Event::Complete(FinishReason::Stop));
        }
        Ended::Finished(Finish::Length) => {
            apply(Event::Complete(FinishReason::Limit));
        }
        Ended::Cancelled => {
            // cancel() already made the turn terminal; a truncation cancel
            // completed it with `limit`. Nothing else to record.
            publish();
        }
        Ended::Failed(e) => {
            if e.code == "local_model_unavailable" {
                lane.lock().expect("chat lane lock").availability = availability_of(&Err(e.clone()));
            }
            apply(Event::Error(e));
        }
    }
    let mut l = lane.lock().expect("chat lane lock");
    if l.cancel.as_ref().is_some_and(|(id, _)| id == turn_id) {
        l.cancel = None;
    }
}

#[cfg(test)]
#[path = "chatlane_tests.rs"]
mod tests;
