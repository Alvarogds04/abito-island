//! Abito island — Electron to Rust+Tauri migration, units M1b (host/bridge)
//! + M2 (Pi transport receiver).
//!
//! M1a skeleton (X11 geometry, drag/snap, read-back probe) plus the host
//! layer ported from the Electron sources (`preload.cjs`, `core.cjs`,
//! `security.cjs`, `main.cjs`):
//! - `window.desktop.*` served by the single `desktop_action` command behind
//!   the Electron validation gate (see [`bridge`]),
//! - `desktop:state` snapshot events with Electron's exact snapshot shape
//!   (see [`desktop`]),
//! - lifecycle: single instance (second launch restores/shows/focuses the
//!   running island and the new process exits), work-area re-clamp watcher,
//!   clean quit through `RunEvent::Exit`,
//! - navigation locked to the local app page; strict CSP and a
//!   least-privilege capability live in `tauri.conf.json` /
//!   `capabilities/main.json`,
//! - M2: the Unix-domain-socket notice receiver (see [`transport`]) feeds
//!   `notices`/`connections`/`unavailable` into the snapshot, wires the
//!   `dismiss` verb, and is cleaned up on quit and on SIGINT/SIGTERM.

mod chathost;
mod modelshost;
mod nativeaudit;
mod nativewindow;
#[cfg(any(debug_assertions, feature = "probe"))]
mod probe;
mod questionhost;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use abito_island::bridge::{self, Action, BridgeError};
use abito_island::chat::ChatError;
use abito_island::chatlane::{self, Target};
use abito_island::core::{self, Core, ReleaseOutcome, TogglePlan, WindowIo};
use abito_island::desktop::{self, IslandState};
use abito_island::geometry::{self, Edge, Rect};
#[cfg(any(debug_assertions, feature = "probe"))]
use abito_island::fakebridge;
use abito_island::{approval, protocol, transport, workarea};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const COLLAPSE_RESIZE_DELAY_MS: u64 = 400; // frontend shrink anim is 340ms

/// Set once a clean quit starts (port of main.cjs `quitting`): guards the
/// close-request handler and stops the background threads.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Clean quit (main.cjs `quit()`): idempotent, cleans the transport first,
/// then leaves the normal exit path so plugins release their resources (the
/// single-instance D-Bus name included).
fn quit_clean(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    // main.cjs quit(): abort every active approval request FIRST — an
    // in-flight /execute fails at once instead of holding the lane open
    // (the card stays inert through the quitting rule).
    approval::abort_lane(&app.state::<AppState>().approval);
    close_transport(app);
    app.exit(0);
}

// --- M2 transport lifecycle (main.cjs createTransport / quit / signals) ----

/// Set by the SIGINT/SIGTERM handlers (async-signal-safe: one atomic store,
/// nothing else runs on the signal context).
static SHUTDOWN_SIGNAL: AtomicBool = AtomicBool::new(false);

extern "C" fn handle_shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN_SIGNAL.store(true, Ordering::SeqCst);
}

/// main.cjs line 393: SIGINT/SIGTERM run the clean quit instead of the
/// default terminate (which would leave a stale socket behind).
fn install_shutdown_handlers() {
    // SAFETY: the handler only performs an atomic store.
    unsafe {
        libc::signal(
            libc::SIGINT,
            handle_shutdown_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGTERM,
            handle_shutdown_signal as *const () as libc::sighandler_t,
        );
    }
}

/// Signal thread: socket cleanup first, then exit — same cleanup a normal
/// quit performs, so Ctrl-C never leaves the endpoint or dir behind.
fn spawn_shutdown_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        if !SHUTDOWN_SIGNAL.load(Ordering::SeqCst) {
            continue;
        }
        if QUITTING.swap(true, Ordering::SeqCst) {
            // A normal quit is already running: give it a moment, then leave.
            std::thread::sleep(Duration::from_millis(500));
            std::process::exit(0);
        }
        approval::abort_lane(&app.state::<AppState>().approval);
        close_transport(&app);
        // Release the single-instance name before a hard exit (probe does the
        // same), so a later launch is never mistaken for a live one.
        tauri_plugin_single_instance::destroy(&app);
        std::process::exit(0);
    });
}

/// main.cjs quit() transport half: identity-checked socket cleanup with the
/// exact legacy refusal line; nothing is ever unlinked that we did not bind.
fn close_transport(app: &AppHandle) {
    let transport = app
        .state::<AppState>()
        .transport
        .lock()
        .expect("transport lock")
        .take();
    let Some(transport) = transport else {
        return;
    };
    if let Err(error) = transport.close() {
        eprintln!("Private socket cleanup refused; inspect the local runtime directory.");
        eprintln!("transport cleanup: {error}");
    }
}

/// Legacy dev `project` (main.cjs): sha256 hex of the canonical worktree root
/// in dev builds; an installed build takes it from `ABITO_PROJECT_ROOT` only
/// (see `identity`). None when no root can be established — the transport
/// then refuses to start instead of pretending a project identity.
fn project_id_for_this_checkout() -> Option<String> {
    abito_island::identity::project_id_of_this_process()
}

/// main.cjs lines 487-497: start the optional local notice transport; on any
/// failure `unavailable` becomes true, the legacy line is printed, and
/// nothing is faked.
fn start_transport(app: &AppHandle) {
    let state = app.state::<AppState>();
    let fail = |reason: String| {
        state.unavailable.store(true, Ordering::SeqCst);
        eprintln!("Optional local notice transport unavailable; no Pi connection was made.");
        eprintln!("transport: {reason}");
    };
    if state.project.is_empty() {
        fail("canonical worktree root unavailable".into());
        return;
    }
    let runtime = match transport::resolve_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            fail(error.to_string());
            return;
        }
    };
    let notice_app = app.clone();
    let connections_app = app.clone();
    let question_app = app.clone();
    let options = transport::TransportOptions::new(runtime, state.project.clone())
        .on_notice(move |message| {
            if QUITTING.load(Ordering::SeqCst) {
                return; // main.cjs: `if (!quitting)`
            }
            let state = notice_app.state::<AppState>();
            state
                .notices
                .lock()
                .expect("notices lock")
                .accept(&message, now_ms() as u64);
            publish(&notice_app, &state);
        })
        .on_connections(move |count| {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            let state = connections_app.state::<AppState>();
            state.connections.store(count, Ordering::SeqCst);
            publish(&connections_app, &state);
        })
        .on_question_change(move || questionhost::invalidate(&question_app));
    match transport::create_transport(options) {
        Ok(transport) => {
            // Local address only; no received payloads or labels are logged.
            println!("ABITO_DESKTOP_SOCKET={}", transport.endpoint().display());
            *state.transport.lock().expect("transport lock") = Some(transport);
        }
        Err(error) => fail(error.to_string()),
    }
}

/// Last values we asked the window manager for, reported by the probe.
#[derive(Default)]
struct Requested {
    pos: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    action: String,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(any(debug_assertions, feature = "probe")), allow(dead_code))]
struct Evidence {
    svgs: usize,
    canvases: usize,
    revision: String,
}

struct AppState {
    core: Mutex<Core>,
    work_area: Mutex<Rect>,
    requested: Mutex<Requested>,
    evidence: Mutex<Option<Evidence>>,
    /// One-shot: spawn the settle-and-retry geometry pin the first time the
    /// frontend reports ready, preserving the no-user-interference guard.
    initial_pin: AtomicBool,
    /// Set on the first real pointer press: the pin loop must never fight a
    /// user drag, so it aborts once the human touches the island.
    user_touch: AtomicBool,
    /// Bumped on every plan application; a deferred collapse resize only runs
    /// if its generation is still current.
    generation: AtomicU64,
    /// M1b: the phase `preload.cjs` consumers read (single writer: apply_plan
    /// for toggles, explicit stores for hide/restore).
    phase: Mutex<IslandState>,
    /// M1b: motion override (contract 2026-10-07), persisted fail-closed.
    motion_override: AtomicBool,
    /// M1b: snapshot revision, advanced only when published content changes.
    revision: AtomicU64,
    /// M1b: last published snapshot, revision-normalized (main.cjs dedupe).
    last_published: Mutex<String>,
    /// M1b: Electron main.cjs rate gate for `desktop:action` (30/s).
    rate: Mutex<bridge::RateLimiter>,
    /// M1b: one-shot facade evidence reported by the webview for the probe.
    facade: Mutex<Option<Value>>,
    /// M2: received notices (single store behind `snapshot().notices`).
    notices: Mutex<protocol::NoticeStore>,
    /// M2: handshaked Pi connections (transport `on_connections`).
    connections: AtomicU32,
    /// M2: `unavailable` flips true ONLY when the receiver could not start
    /// (main.cjs `unavailable = true` in the transport catch).
    unavailable: AtomicBool,
    /// M2: the bound receiver — endpoint for the producer/probe, cleanup on
    /// quit/signal through the identity-checked `Transport::close`.
    transport: Mutex<Option<transport::Transport>>,
    /// M2: sha256 of the canonical worktree root (legacy dev `project`).
    project: String,
    /// M3: the approval lane itself (Electron `main.cjs` bridge globals —
    /// status, auth ladder, in-memory cookie, pinned card, busy gates).
    approval: approval::Shared,
    /// M3: publish/context/log callbacks, installed in `setup` before the
    /// bridge thread starts (they need the app handle).
    hooks: Mutex<Option<approval::SharedHooks>>,
    /// M3 probe only: the in-process fake backend THIS process started for
    /// its approval read-back. `None` in production and whenever
    /// `ABITO_BRIDGE_BASE` was already set from outside.
    #[cfg(any(debug_assertions, feature = "probe"))]
    probe_fake: Mutex<Option<Arc<fakebridge::FakeBackend>>>,
    /// U1: the island conversation (process memory only, never on disk).
    chat: chatlane::SharedLane,
    /// U1: the selected LOCAL target (U2 picker writes it; `None` = no
    /// verified local model selected → Send refuses with `profile_missing`).
    chat_target: Mutex<Option<Target>>,
    /// U1: `chat_action` rate gate (same 30/s rule, its own budget).
    chat_rate: Mutex<bridge::RateLimiter>,
    /// U1: per-turn deadlines (the probe shortens them for its fake).
    chat_deadlines: Mutex<abito_island::localmodel::Deadlines>,
    /// U1 probe only: evidence lines the webview reports for the chat step.
    chat_probe: Mutex<Vec<Value>>,
    /// U2: the verified local registry in force. Production: exactly
    /// `models::REGISTRY`. Only the probe replaces it (its fake router) —
    /// there is no IPC or env path that can add an entry.
    models_registry: Mutex<Vec<abito_island::models::Entry>>,
    /// U2: last redacted model listing and its revision.
    models_last: Mutex<Value>,
    models_revision: AtomicU64,
    /// U2: whether the last explicit selection reached the 0600 file.
    models_persisted: AtomicBool,
}

/// U2 gate before dispatch: the target must still be a registered,
/// selectable local profile at the same revision. The resource half of the
/// gate (asleep → no load, other alias → no substitute, busy → visible
/// queue, unknown → refuse, context budget) runs per turn in the
/// `chatlane` preflight right before the single request.
fn model_gate(state: &AppState, target: &Target) -> Result<(), ChatError> {
    let registry = state
        .models_registry
        .lock()
        .expect("models registry lock")
        .clone();
    let entry = abito_island::models::select(&registry, &target.profile.profile_id)?;
    if entry.revision != target.profile.revision
        || Some(target.alias.as_str()) != entry.alias
        || target.endpoint.origin() != entry.origin
    {
        return Err(ChatError::profile_missing());
    }
    Ok(())
}

/// Adapter: the pure core handlers see the real window through this.
struct TauriIo<'a>(&'a WebviewWindow);

impl TauriIo<'_> {
    fn set_size(&self, w: i32, h: i32) {
        if let Err(e) = nativewindow::set_size(self.0, w, h) {
            eprintln!("set_size({w},{h}) failed: {e}");
        }
    }
    fn set_outer_position(&self, x: i32, y: i32) {
        if let Err(e) = self.0.set_position(tauri::PhysicalPosition::new(x, y)) {
            eprintln!("set_position({x},{y}) failed: {e}");
        }
    }
}

impl core::WindowIo for TauriIo<'_> {
    fn outer_position(&self) -> (i32, i32) {
        // Prefer the X server's own answer: Tauri 2.12.1's getter reports the
        // correct X but a Y offset by a constant on this stack (see
        // workarea::x11_window_origin). Setters are accurate.
        if let Some(origin) = workarea::x11_window_origin() {
            return origin;
        }
        self.0
            .outer_position()
            .map(|p| (p.x, p.y))
            .unwrap_or_else(|e| {
                eprintln!("outer_position failed: {e}");
                (0, 0)
            })
    }
    fn size(&self) -> (i32, i32) {
        self.0
            .inner_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or_else(|e| {
                eprintln!("inner_size failed: {e}");
                (0, 0)
            })
    }
    fn scale(&self) -> f64 {
        self.0.scale_factor().unwrap_or_else(|e| {
            eprintln!("scale_factor failed: {e}");
            1.0
        })
    }
    fn set_outer_position(&self, x: i32, y: i32) {
        TauriIo::set_outer_position(self, x, y)
    }
}

fn main_window(app: &AppHandle) -> WebviewWindow {
    app.get_webview_window("main")
        .expect("main window must exist")
}

fn edge_str(edge: Edge) -> &'static str {
    match edge {
        Edge::Top => "top",
        Edge::Bottom => "bottom",
    }
}

/// Push the island phase into the webview (the frontend animates; the native
/// window is resized by [`apply_plan`]).
fn push_phase(app: &AppHandle, phase: &str, edge: Edge) {
    let win = main_window(app);
    let e = edge_str(edge);
    let _ = win.eval(format!(
        "window.__islandSetState && window.__islandSetState('{phase}','{e}');"
    ));
}

/// Tell the frontend which edge it is docked to after a snap.
fn push_edge(app: &AppHandle, edge: Edge) {
    let win = main_window(app);
    let _ = win.eval(format!(
        "window.__islandSetEdge && window.__islandSetEdge('{}');",
        edge_str(edge)
    ));
}

fn store_requested(
    state: &AppState,
    action: &str,
    pos: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
) {
    let mut req = state.requested.lock().expect("requested lock");
    if let Some(p) = pos {
        req.pos = Some(p);
    }
    if let Some(s) = size {
        req.size = Some(s);
    }
    req.action = action.to_string();
}

fn refresh_work_area(app: &AppHandle, state: &AppState) -> Rect {
    let win = main_window(app);
    let wa = workarea::current(&win);
    *state.work_area.lock().expect("work area lock") = wa.rect;
    wa.rect
}

/// Enqueue the guarded transaction, not a native resize previously authorized
/// on a worker. The barrier stays until actual physical Resized or degrades;
/// GTK/OS/WM queues still provide no causal request identifier.
fn queue_compact_request(
    app: AppHandle,
    generation: u64,
    size: (i32, i32),
    position: (i32, i32),
    delay_ms: u64,
) {
    std::thread::spawn(move || {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        let (guard_app, apply_app) = (app.clone(), app.clone());
        abito_island::questioncmd::queue_compact_apply(
            move |task| {
                let _ = app.run_on_main_thread(task);
            },
            move |operation| {
                questionhost::compact_resize_request(
                    &guard_app,
                    generation,
                    (size.0 as u32, size.1 as u32),
                    operation,
                )
            },
            move |resize| {
                // The shared helper installs a later GLib idle; GTK property
                // signals cannot reenter this admission transaction inline.
                let win = main_window(&apply_app);
                if resize {
                    TauriIo(&win).set_size(size.0, size.1);
                }
                TauriIo(&win).set_outer_position(position.0, position.1);
            },
        );
    });
}

/// Apply a toggle plan. Expand resizes immediately (the window must be big
/// before the spring grows); collapse tells the frontend to animate first and
/// resizes the native window after the 340ms shrink, guarded by generation so
/// a rapid re-toggle can never apply a stale size.
///
/// This is the SINGLE funnel for compact<->overview switches — short click,
/// facade verb, probe, restore — so the published phase can never diverge
/// from the core's `expanded` flag.
fn apply_plan(app: &AppHandle, state: &AppState, plan: TogglePlan) {
    let next = if plan.is_expand() {
        IslandState::Expanded
    } else {
        IslandState::Compact
    };
    *state.phase.lock().expect("phase lock") = next;
    let (w, h) = plan.size();
    let r = plan.rect();
    let edge = plan.edge();
    let expand = plan.is_expand();
    store_requested(
        state,
        if expand { "expand" } else { "collapse" },
        Some((r.x, r.y)),
        Some((w, h)),
    );
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let win = main_window(app);
    if expand {
        TauriIo(&win).set_size(w, h);
        TauriIo(&win).set_outer_position(r.x, r.y);
        push_phase(app, "overview", edge);
    } else {
        push_phase(app, "compact", edge);
        queue_compact_request(
            app.clone(),
            generation,
            (w, h),
            (r.x, r.y),
            COLLAPSE_RESIZE_DELAY_MS,
        );
    }
    // U1: a collapse always leaves the chat view (core resets it); tell the
    // chat surface which view is current.
    chathost::publish_chat(app);
}

// --- M1b snapshots/events ---------------------------------------------------

/// Host facts the approval lane needs (`approval::HostCtx`). Lock order:
/// this reads ONLY the phase guard and never the approval mutex, so it is
/// safe to call from the lane while it holds its own lock.
fn host_ctx(app: &AppHandle, state: &AppState) -> approval::HostCtx {
    approval::HostCtx {
        now_ms: now_ms() as i64,
        expanded: *state.phase.lock().expect("phase lock") == IslandState::Expanded,
        visible: main_window(app).is_visible().unwrap_or(true),
        quitting: QUITTING.load(Ordering::SeqCst),
    }
}

/// Current snapshot in Electron's exact shape. `anchor` is reported only
/// when the X server really answers for our window — evidence, not intent.
/// `bridgeStatus`/`card`/`request` come verbatim from the approval lane.
fn build_snapshot(app: &AppHandle, state: &AppState) -> Value {
    let phase = *state.phase.lock().expect("phase lock");
    let edge = state.core.lock().expect("core lock").edge;
    let anchor = workarea::x11_window_origin()
        .is_some()
        .then(|| edge_str(edge));
    let revision = state.revision.load(Ordering::SeqCst);
    let connections = state.connections.load(Ordering::SeqCst);
    let unavailable = state.unavailable.load(Ordering::SeqCst);
    // M2: the pruned notice queue (expiry runs on every snapshot read, the
    // same way main.cjs `notices.snapshot(Date.now())` does).
    let notices: Vec<Value> = state
        .notices
        .lock()
        .expect("notices lock")
        .snapshot(now_ms() as u64)
        .into_iter()
        .map(|notice| serde_json::to_value(notice).unwrap_or(Value::Null))
        .collect();
    let ctx = host_ctx(app, state);
    let (bridge_status, card, request) = approval::snapshot_fields(&state.approval, &ctx);
    serde_json::to_value(desktop::Snapshot::new(
        revision,
        phase,
        anchor,
        state.motion_override.load(Ordering::SeqCst),
        connections,
        unavailable,
        notices,
        bridge_status,
        card,
        request,
    ))
    .unwrap_or(Value::Null)
}

/// Publish on `desktop:state` with main.cjs `publish()` semantics: identical
/// content (revision aside) is never re-emitted and the revision advances
/// only when something actually changed. Never publishes after quit
/// (legacy `if (quitting …) return`).
fn publish(app: &AppHandle, state: &AppState) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let value = build_snapshot(app, state);
    let mut normalized = value;
    if let Value::Object(map) = &mut normalized {
        map.insert("revision".to_string(), Value::from(0));
    }
    let serialized = serde_json::to_string(&normalized).unwrap_or_default();
    let mut last = state.last_published.lock().expect("last snapshot lock");
    if *last == serialized {
        return;
    }
    let revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
    let mut emitted = normalized;
    if let Value::Object(map) = &mut emitted {
        map.insert("revision".to_string(), Value::from(revision));
    }
    *last = serialized;
    drop(last);
    if let Err(e) = app.emit("desktop:state", &emitted) {
        eprintln!("desktop:state emit failed: {e}");
    }
}

// --- M1b motion override persistence (main.cjs motion.json) -----------------

/// #304: Abito animates by default; see `desktop::motion_override_from_config`.
fn load_motion_override(app: &AppHandle) -> bool {
    let text = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("motion.json")).ok());
    abito_island::desktop::motion_override_from_config(text.as_deref())
}

fn persist_motion_override(app: &AppHandle, value: bool) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let data = serde_json::json!({ "v": 1, "override": value }).to_string();
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dir.join("motion.json"))
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(data.as_bytes()) {
                    // A read-only state root keeps the choice in memory for
                    // this launch (main.cjs persistMotionOverride).
                    eprintln!("motion override not persisted: {e}");
                }
            }
            Err(e) => eprintln!("motion override not persisted: {e}"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(dir.join("motion.json"), data);
    }
}

// --- M1b lifecycle -----------------------------------------------------------

/// Electron main.cjs `restore()` (the `second-instance` handler): land
/// compact, keep/clamp the position in the current work area, show, focus.
/// Called by the single-instance plugin in the FIRST instance; the second
/// process exits before reaching `Builder::run`.
pub(crate) fn restore(app: &AppHandle) {
    let state = app.state::<AppState>();
    questionhost::with_pending(&state, |pending| {
        if pending {
            // Preserve phase, view and geometry; a second launch is not an answer.
            let win = main_window(app);
            let _ = win.unminimize();
            let _ = win.show();
            publish(app, &state);
            return;
        }
        restore_without_question(app, &state);
    });
}

fn restore_without_question(app: &AppHandle, state: &AppState) {
    // transition(state, 'restore') -> compact when no question is pending.
    *state.phase.lock().expect("phase lock") = IslandState::Compact;
    // main.cjs restore() bumps the overlay epoch on EVERY restore (375).
    approval::bump_epoch(&state.approval);
    let area = refresh_work_area(app, state);
    let win = main_window(app);
    let io = TauriIo(&win);
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        if core.expanded {
            Some(core.toggle(&io, area)) // was left open: collapse through the funnel
        } else {
            None
        }
    };
    if let Some(plan) = plan {
        apply_plan(app, state, plan);
    } else {
        let (w, h) = geometry::scaled_size(geometry::LOGICAL_COMPACT, io.scale());
        let (x, y) = io.outer_position();
        let (cw, ch) = io.size();
        let safe = geometry::clamp_rect(Rect { x, y, w: cw, h: ch }, area);
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        queue_compact_request(app.clone(), generation, (w, h), (safe.x, safe.y), 0);
        store_requested(state, "restore", Some((safe.x, safe.y)), Some((w, h)));
    }
    let _ = win.unminimize();
    // Q1: show, never focus — the island must not take the keyboard from
    // the app the human is working in (legacy `restore()` focused it).
    let _ = win.show();
    publish(app, state);
}

/// Q1: the deliberate "Open Abito chat and type" activation (second launch
/// with `--chat`): expand, switch to the chat view, take focus, and put the
/// caret in the composer. The ONLY path that calls `set_focus`.
fn open_chat_and_type(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = dispatch_verb(app, &state, Action::Expand, None);
    chathost::switch_view(app, &state, true);
    let win = main_window(app);
    let _ = win.set_focus();
    let _ = win.eval("window.__islandFocusComposer && window.__islandFocusComposer();");
}

/// Monitor/work-area re-clamp. Electron had `display-metrics-changed` /
/// `display-added` / `display-removed`; Tauri/Tao expose no display events,
/// so the SAME work-area source (`workarea::current`) is polled once a
/// second and a CHANGED area re-clamps the window through the pure
/// `geometry::clamp_rect` port of `clampBounds`. A live drag is never
/// fought: while a press is active the release snap owns geometry.
fn spawn_workarea_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = app.state::<AppState>();
        let win = main_window(&app);
        let wa = workarea::current(&win);
        {
            let mut stored = state.work_area.lock().expect("work area lock");
            if wa.rect == *stored {
                continue;
            }
            *stored = wa.rect;
        }
        if state.core.lock().expect("core lock").press_active() {
            continue;
        }
        let io = TauriIo(&win);
        let (x, y) = io.outer_position();
        let (w, h) = io.size();
        if let Some(safe) = geometry::reclamp_on_workarea_change(Rect { x, y, w, h }, wa.rect) {
            io.set_size(safe.w, safe.h);
            io.set_outer_position(safe.x, safe.y);
            store_requested(
                &state,
                "workarea-clamp",
                Some((safe.x, safe.y)),
                Some((safe.w, safe.h)),
            );
        }
        publish(&app, &state);
    });
}

/// main.cjs `setInterval(publish, 1000)`: content-deduped, so it is silent
/// until something actually changed (it is what re-checks projected state).
fn spawn_publish_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let state = app.state::<AppState>();
        publish(&app, &state);
    });
}

/// security.cjs equivalent for the island window: top-level navigation to
/// anything but the local app page is cancelled (Tauri asks this hook for
/// every navigation of every webview; `window.open`/`target=_blank` create
/// no webview because no new-window handler is installed).
fn navigation_lock() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-lock")
        .on_navigation(|webview, url| {
            let allowed = webview.label() == "main" && bridge::page_url_allowed(url.as_str());
            if !allowed {
                eprintln!("navigation blocked from {}: {url}", webview.label());
            }
            allowed
        })
        .build()
}

// --- Commands: the webview only reports pointer events and evidence; every
// --- click-vs-drag, snap, clamp and anchor decision lives in core/geometry.

#[tauri::command]
fn drag_press(app: AppHandle, state: State<AppState>, x: f64, y: f64) {
    state.user_touch.store(true, Ordering::SeqCst);
    let win = main_window(&app);
    let io = TauriIo(&win);
    state.core.lock().expect("core lock").press(&io, (x, y));
}

#[tauri::command]
fn drag_move(app: AppHandle, state: State<AppState>, x: f64, y: f64) {
    let win = main_window(&app);
    let io = TauriIo(&win);
    let area = *state.work_area.lock().expect("work area lock");
    let moved = {
        let mut core = state.core.lock().expect("core lock");
        core.drag(&io, area, (x, y))
    };
    if let Some(pos) = moved {
        store_requested(&state, "drag", Some(pos), None);
    }
}

#[tauri::command]
fn drag_release(app: AppHandle, state: State<AppState>, x: f64, y: f64, cancelled: bool) -> String {
    let area = refresh_work_area(&app, &state);
    let win = main_window(&app);
    let io = TauriIo(&win);
    questionhost::with_pending(&state, |pending| {
        let outcome = {
            let mut core = state.core.lock().expect("core lock");
            abito_island::questioncmd::guarded_release(
                &mut core,
                &io,
                area,
                (x, y),
                cancelled,
                pending,
            )
        };
        match outcome {
            ReleaseOutcome::Toggle(plan) => {
                // The admission guard spans both planning and application.
                apply_plan(&app, &state, plan);
                publish(&app, &state);
                "toggle".to_string()
            }
            ReleaseOutcome::Snapped { rect, edge } => {
                store_requested(&state, "snap", Some((rect.x, rect.y)), None);
                push_edge(&app, edge);
                "snap".to_string()
            }
            ReleaseOutcome::Cancelled => "cancelled".to_string(),
        }
    })
}

/// The single IPC entry point behind `window.desktop.*` — Electron's
/// `ipcMain.handle('desktop:action')`. The gate order mirrors main.cjs
/// exactly: sender + payload validation FIRST, then the rate gate — an
/// invalid call never consumes rate budget.
///
/// Async since M3: `allow`/`deny` perform blocking HTTP with the legacy 5 s
/// deadline (Electron's `decide` was async there too), so those run on the
/// blocking pool — never on the webkit main thread — and answer with the
/// fresh snapshot only after the decision settled.
#[tauri::command]
async fn desktop_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let (action, index) = bridge::validate_payload(&payload)?;
    state.rate.lock().expect("rate lock").check(now_ms())?;
    match action {
        Action::Allow | Action::Deny => {
            let approval = Arc::clone(&state.approval);
            let hooks = state_hooks(&state)?;
            let decision = if action == Action::Allow {
                approval::Decision::Allow
            } else {
                approval::Decision::Deny
            };
            let handle = app.clone();
            Ok(tauri::async_runtime::spawn_blocking(move || {
                approval::decide(&approval, decision, &hooks);
                let state = handle.state::<AppState>();
                build_snapshot(&handle, &state)
            })
            .await
            .map_err(|_| BridgeError::denied("decision aborted"))?)
        }
        _ => dispatch_verb(&app, &state, action, index),
    }
}

/// The publish/context/log callbacks installed in `setup`.
fn state_hooks(state: &AppState) -> Result<approval::SharedHooks, BridgeError> {
    state
        .hooks
        .lock()
        .expect("hooks lock")
        .clone()
        .ok_or_else(|| BridgeError::denied("approval lane not started"))
}

/// Execute one validated verb with Electron main.cjs semantics. `allow`/
/// `deny`/`choose` are wired since M3: only an explicit human choice reaches
/// the lane, which re-validates card id, expiry and `payload_hash` itself
/// before any `/execute` (a notice can never approve anything).
fn dispatch_verb(
    app: &AppHandle,
    state: &AppState,
    action: Action,
    index: Option<i32>,
) -> Result<Value, BridgeError> {
    if action == Action::Close {
        return questionhost::with_pending(state, |pending| {
            let expanded = state.core.lock().expect("core lock").expanded;
            if !abito_island::questioncmd::collapse_allowed(expanded, pending) {
                return Err(questionhost::pending_error());
            }
            dispatch_action(app, state, action, index)
        });
    }
    dispatch_action(app, state, action, index)
}

fn dispatch_action(
    app: &AppHandle,
    state: &AppState,
    action: Action,
    index: Option<i32>,
) -> Result<Value, BridgeError> {
    match action {
        Action::Snapshot => Ok(build_snapshot(app, state)),
        Action::Expand | Action::Close => {
            let verb = if action == Action::Expand {
                "expand"
            } else {
                "close"
            };
            let next = {
                let mut phase = state.phase.lock().expect("phase lock");
                let next = desktop::transition(*phase, verb);
                if next == *phase {
                    None // no-op, exactly like Electron's transition()
                } else {
                    *phase = next;
                    Some(next)
                }
            };
            if let Some(next) = next {
                // main.cjs 466-467, synchronous in one step: overlayEpoch++
                // and, on expand, the pinned queue is promoted (a closed
                // overlay never keeps the previous decision authority).
                approval::bump_epoch(&state.approval);
                if next == IslandState::Expanded {
                    approval::promote_selection(&state.approval);
                }
                let area = refresh_work_area(app, state);
                let win = main_window(app);
                let io = TauriIo(&win);
                let plan = {
                    let mut core = state.core.lock().expect("core lock");
                    core.toggle(&io, area)
                };
                apply_plan(app, state, plan);
                publish(app, state);
            }
            Ok(build_snapshot(app, state))
        }
        Action::Hide => {
            let hidden = {
                let mut phase = state.phase.lock().expect("phase lock");
                let next = desktop::transition(*phase, "hide");
                let changed = next != *phase;
                *phase = next;
                changed
            };
            if hidden {
                approval::bump_epoch(&state.approval); // main.cjs 467
                let _ = main_window(app).hide();
                publish(app, state);
            }
            Ok(build_snapshot(app, state))
        }
        Action::Quit => {
            quit_clean(app);
            Ok(Value::Null) // main.cjs returns null for quit
        }
        Action::AnimateAnyway | Action::RespectSystemMotion => {
            let value = action == Action::AnimateAnyway;
            state.motion_override.store(value, Ordering::SeqCst);
            persist_motion_override(app, value);
            publish(app, state);
            Ok(build_snapshot(app, state))
        }
        Action::Dismiss => {
            // main.cjs lines 461-463: drop the FIRST notice (id + sessionId),
            // then publish. A notice is display-only: dismissing never
            // approves, decides or opens anything.
            let now = now_ms() as u64;
            let first = state
                .notices
                .lock()
                .expect("notices lock")
                .snapshot(now)
                .into_iter()
                .next();
            if let Some(notice) = first {
                state.notices.lock().expect("notices lock").dismiss(
                    &notice.id,
                    &notice.session_id,
                    now,
                );
            }
            publish(app, state);
            Ok(build_snapshot(app, state))
        }
        Action::Allow | Action::Deny => {
            // Direct host path (the probe drives this same funnel); the
            // webview path arrives through the async command above.
            let hooks = state_hooks(state)?;
            let decision = if action == Action::Allow {
                approval::Decision::Allow
            } else {
                approval::Decision::Deny
            };
            approval::decide(&state.approval, decision, &hooks);
            Ok(build_snapshot(app, state))
        }
        Action::Choose => {
            // Read-and-consume in ONE synchronous step (main.cjs 444); with
            // no producer of requests the lane has none standing, so every
            // choice is `Denied` — exactly like Electron today.
            let index =
                index.ok_or_else(|| BridgeError::denied("choose requires an integer index"))?;
            approval::choose(&state.approval, index)
                .map_err(|()| BridgeError::denied("no standing request"))?;
            publish(app, state); // legacy publishes only on success
            Ok(build_snapshot(app, state))
        }
    }
}

/// Probe-only channel: the webview reports what the facade observed (verbs,
/// typed rejections, its own label/URL) so the read-back probe can print it.
/// Not part of the preload surface and not rate limited.
#[tauri::command]
fn record_facade_evidence(state: State<AppState>, evidence: Value) {
    *state.facade.lock().expect("facade lock") = Some(evidence);
}

/// U1 probe-only channel: the webview reports what the chat surface
/// observed (DOM sizes, IPC answers). Not rate limited, stores at most 8.
#[tauri::command]
fn record_chat_evidence(state: State<AppState>, evidence: Value) {
    let mut lines = state.chat_probe.lock().expect("chat probe lock");
    if lines.len() < 8 {
        lines.push(evidence);
    }
}

/// Frontend evidence for the probe: SVG element count rendered by clay-engine
/// and canvas count (must be 0 — R6 is SVG-DOM, not Canvas/WebGL).
///
/// Side effect on first report: spawn the bounded geometry pin after page
/// load. GTK's empty-child natural fallback is handled by nativewindow;
/// this pin only reasserts the contract. It aborts as soon as the
/// user touches the island or any toggle happens (generation > 0).
#[tauri::command]
fn record_frontend_evidence(
    app: AppHandle,
    state: State<AppState>,
    svgs: usize,
    canvases: usize,
    revision: String,
) {
    *state.evidence.lock().expect("evidence lock") = Some(Evidence {
        svgs,
        canvases,
        revision,
    });
    let first = state
        .initial_pin
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    nativeaudit::sample(&app, "frontend-ready", 0, None);
    if !first {
        return;
    }
    std::thread::spawn(move || {
        // Re-pin after page load without fighting newer plans or user input.
        // Explicit GTK widget requests remove the empty-child natural fallback;
        // a grow/shrink cycle is neither required nor a sizing authority.
        let aborted = |state: &AppState| {
            state.generation.load(Ordering::SeqCst) != 0 || state.user_touch.load(Ordering::SeqCst)
        };
        for attempt in 1..=4 {
            std::thread::sleep(Duration::from_millis(600));
            let state = app.state::<AppState>();
            if aborted(&state) {
                nativeaudit::sample(&app, "pin-aborted", attempt, None);
                return;
            }
            nativeaudit::sample(&app, "pin-before", attempt, None);
            let win = main_window(&app);
            let scale = win.scale_factor().unwrap_or(1.0);
            let (w, h) = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale);
            let wa = workarea::current(&win);
            let rect = geometry::initial_position(wa.rect, w, h);
            let io = TauriIo(&win);
            if win
                .inner_size()
                .map(|s| (s.width as i32, s.height as i32))
                .unwrap_or((0, 0))
                == (w, h)
            {
                io.set_outer_position(rect.x, rect.y); // size fine: only pin position
                *state.work_area.lock().expect("work area lock") = wa.rect;
                store_requested(&state, "initial-pin", Some((rect.x, rect.y)), Some((w, h)));
                return;
            }
            io.set_size(w, h);
            nativeaudit::sample(&app, "pin-shrink-enqueued", attempt, Some((w, h)));
            io.set_outer_position(rect.x, rect.y);
            *state.work_area.lock().expect("work area lock") = wa.rect;
            store_requested(&state, "initial-pin", Some((rect.x, rect.y)), Some((w, h)));
            std::thread::sleep(Duration::from_millis(200));
            nativeaudit::sample(&app, "pin-settled", attempt, Some((w, h)));
            let settled = win
                .inner_size()
                .map(|s| (s.width as i32, s.height as i32))
                .unwrap_or((0, 0))
                == (w, h);
            if settled || aborted(&state) {
                return;
            }
        }
    });
}

/// The read-back probe exists only in debug builds or with `--features probe`;
/// a packaged release ignores `ABITO_PROBE`/`--probe` entirely.
#[cfg(not(any(debug_assertions, feature = "probe")))]
pub(crate) fn probe_requested() -> bool {
    false
}
#[cfg(any(debug_assertions, feature = "probe"))]
pub(crate) fn probe_requested() -> bool {
    let env = std::env::var("ABITO_PROBE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    env || std::env::args().any(|a| a == "--probe")
}

/// The three callbacks the approval lane needs from the host (`main.cjs`
/// publish / Date / console equivalents). `ctx` must NEVER take the
/// approval lock — the lane calls it while holding its own (it only reads
/// the phase guard and window state).
fn build_hooks(app: AppHandle) -> approval::SharedHooks {
    Arc::new(approval::Hooks {
        ctx: {
            let app = app.clone();
            Box::new(move || {
                let state = app.state::<AppState>();
                host_ctx(&app, &state)
            })
        },
        changed: {
            let app = app.clone();
            Box::new(move || {
                let state = app.state::<AppState>();
                publish(&app, &state);
            })
        },
        // legacy `mode(value)`: the auth diagnostics line is the mode name
        // and nothing else — never a value, header or credential.
        log: Box::new(|name| println!("{name}")),
    })
}

fn main() {
    // Heavy constraint (HANDOFF): GTK/Tao under Wayland cannot position a window
    // absolutely nor keep it always-on-top, so the island must run on
    // X11/XWayland. Force the GDK backend before GTK initialises, but only when
    // the launcher did not already choose one.
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    let project = project_id_for_this_checkout().unwrap_or_default();
    // M3: approval lane configuration. The credential source follows legacy
    // exactly — `<stateRoot>/bridge.json`, read ONCE per process with the
    // descriptor-safe port of `readBridgeLogin`; absent/invalid means
    // `disabled` and zero traffic. In probe mode the lane is pointed at an
    // in-process FAKE backend through the ABITO_BRIDGE_BASE override before
    // it is constructed: the probe never talks to a real backend.
    let login = transport::resolve_runtime()
        .ok()
        .and_then(|root| approval::read_bridge_login(&root));
    #[cfg(any(debug_assertions, feature = "probe"))]
    let mut probe_fake = None;
    // In probe mode the lane gets the SAME credential plumbing as
    // production: the `bridge.json` login when it exists, otherwise a
    // clearly synthetic probe-only login (the fake accepts exactly what the
    // lane sends and never logs it). The lane is then constructed with that
    // effective login, so the approval read-back exercises the real start
    // path — mint, poll, healthy — against the fake.
    #[cfg(any(debug_assertions, feature = "probe"))]
    let login = if probe_requested() && std::env::var(approval::BASE_ENV).is_err() {
        let effective = login.unwrap_or_else(|| "probe@local.test".to_string());
        let fake = fakebridge::FakeBackend::start(fakebridge::FakeConfig {
            login: effective.clone(),
            proposals: vec![serde_json::json!({
                "id": format!("proposal_{}", "a".repeat(32)),
                "payload_hash": "b".repeat(64),
                "operation": "Prueba M3: propuesta servida por el backend falso",
                "status": "pending",
                "expires_at": "2999-12-31T23:59:59Z",
                "principal": "probe",
                "payload": { "probe": true },
            })],
            ..Default::default()
        });
        // The documented test/probe override: the approval client reads this
        // env at construction, so this run mints and polls against the fake.
        std::env::set_var(approval::BASE_ENV, fake.origin());
        probe_fake = Some(fake);
        Some(effective)
    } else {
        login
    };
    let approval_lane = approval::Approval::from_environment(login);
    let state = AppState {
        core: Mutex::new(Core::new()),
        work_area: Mutex::new(Rect {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        }),
        requested: Mutex::new(Requested::default()),
        evidence: Mutex::new(None),
        initial_pin: AtomicBool::new(false),
        user_touch: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        phase: Mutex::new(IslandState::Compact),
        motion_override: AtomicBool::new(true), // #304: animate by default
        revision: AtomicU64::new(0),
        last_published: Mutex::new(String::new()),
        rate: Mutex::new(bridge::RateLimiter::new()),
        facade: Mutex::new(None),
        notices: Mutex::new(protocol::NoticeStore::new(project.clone())),
        connections: AtomicU32::new(0),
        unavailable: AtomicBool::new(false),
        transport: Mutex::new(None),
        project,
        approval: Arc::new(Mutex::new(approval_lane)),
        hooks: Mutex::new(None),
        #[cfg(any(debug_assertions, feature = "probe"))]
        probe_fake: Mutex::new(probe_fake),
        chat: chatlane::Lane::new("c-island"),
        // U2: resolved from the saved selection in `setup` (fail closed).
        chat_target: Mutex::new(None),
        chat_rate: Mutex::new(bridge::RateLimiter::new()),
        chat_deadlines: Mutex::new(chathost::default_deadlines()),
        chat_probe: Mutex::new(Vec::new()),
        models_registry: Mutex::new(abito_island::models::REGISTRY.to_vec()),
        models_last: Mutex::new(Value::Null),
        models_revision: AtomicU64::new(0),
        models_persisted: AtomicBool::new(false),
    };

    tauri::Builder::default()
        // M1b lifecycle: a second launch hands its argv to the first instance
        // (which restores/shows/focuses the island) and exits before run().
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Q1: a plain second launch restores WITHOUT stealing focus; only
            // the exact `--chat` flag is a deliberate request to type.
            match desktop::launch_intent(&argv) {
                desktop::LaunchIntent::Restore => restore(app),
                desktop::LaunchIntent::Chat => {
                    restore(app);
                    open_chat_and_type(app);
                }
            }
        }))
        .plugin(navigation_lock())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            drag_press,
            drag_move,
            drag_release,
            desktop_action,
            chathost::chat_action,
            modelshost::models_action,
            questionhost::question_action,
            record_facade_evidence,
            record_chat_evidence,
            record_frontend_evidence
        ])
        // Electron `win.webContents.on('did-finish-load', publish)`.
        .on_page_load(|webview, _payload| {
            let state = webview.state::<AppState>();
            publish(webview.app_handle(), &state);
        })
        // Electron `win.on('close', preventDefault + quit)`: closing the
        // window quits cleanly instead of tearing the app down ad hoc.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Resized(size) = event {
                    questionhost::native_resized(window.app_handle(), (size.width, size.height));
                    nativeaudit::sample(
                        window.app_handle(),
                        "resized",
                        0,
                        Some((size.width as i32, size.height as i32)),
                    );
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if QUITTING.load(Ordering::SeqCst) {
                    return; // the exit path is already closing windows
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                quit_clean(&app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let win = main_window(&handle);
            let wa = workarea::current(&win);
            let scale = win.scale_factor().unwrap_or(1.0);
            let (w, h) = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale);
            // Origin: top-centre of the work area (contract M1a).
            let rect = geometry::initial_position(wa.rect, w, h);
            let io = TauriIo(&win);
            io.set_size(w, h);
            io.set_outer_position(rect.x, rect.y);
            // Contract attribute, set explicitly as well as via the window
            // config: the read-back probe must show is_always_on_top=true and
            // under XWayland the config path alone did not guarantee it.
            if let Err(e) = win.set_always_on_top(true) {
                eprintln!("set_always_on_top(true) failed: {e}");
            }
            let state = app.state::<AppState>();
            *state.work_area.lock().expect("work area lock") = wa.rect;
            store_requested(&state, "initial", Some((rect.x, rect.y)), Some((w, h)));
            nativeaudit::sample(&handle, "setup", 0, Some((w, h)));
            // Read-only sampling stops with this process. No probe or UI actions.
            if nativeaudit::enabled() {
                let audit_handle = handle.clone();
                std::thread::spawn(move || {
                    for second in 1..=16 {
                        std::thread::sleep(Duration::from_secs(1));
                        if QUITTING.load(Ordering::SeqCst) {
                            break;
                        }
                        nativeaudit::sample(&audit_handle, "timer", second, None);
                    }
                });
            }
            // M1b: motion override fails closed from user config.
            state
                .motion_override
                .store(load_motion_override(&handle), Ordering::SeqCst);
            spawn_workarea_watcher(handle.clone());
            spawn_publish_ticker(handle.clone());
            // M2: local notice transport + SIGINT/SIGTERM socket cleanup
            // (main.cjs creates the transport after the window loads; here it
            // starts before the probe so the probe can use its endpoint).
            start_transport(&handle);
            install_shutdown_handlers();
            spawn_shutdown_watcher(handle.clone());
            // M3: approval lane — install the publish/context/log hooks,
            // then start the bridge (mode 'jar', mint, first poll, 10 s
            // cadence) exactly where main.cjs `startBridge` runs: after the
            // transport, before the first publish tick.
            // U2: the saved model selection (absent → the approved initial
            // local profile; corrupt/unknown → none, nothing substituted).
            modelshost::load_selection(&handle, &state);
            #[cfg(debug_assertions)]
            nativewindow::start_view_test(&win);
            let hooks = build_hooks(handle.clone());
            *state.hooks.lock().expect("hooks lock") = Some(hooks.clone());
            approval::spawn_bridge(Arc::clone(&state.approval), hooks);
            #[cfg(any(debug_assertions, feature = "probe"))]
            if probe_requested() {
                std::thread::spawn(move || probe::run(handle));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running abito island");
}
