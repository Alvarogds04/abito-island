//! Abito island — Electron to Rust+Tauri migration, unit M1b (host/bridge).
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
//!   `capabilities/main.json`.

mod bridge;
mod core;
mod desktop;
mod geometry;
mod probe;
mod workarea;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use bridge::{Action, BridgeError};
use core::{Core, ReleaseOutcome, TogglePlan, WindowIo};
use desktop::IslandState;
use geometry::{Edge, Rect};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use serde_json::Value;

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

/// Clean quit (main.cjs `quit()`): idempotent, leaves the normal exit path so
/// plugins release their resources (the single-instance D-Bus name included).
fn quit_clean(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    app.exit(0);
}

/// Last values we asked the window manager for, reported by the probe.
#[derive(Default)]
struct Requested {
    pos: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    action: String,
}

#[derive(Clone, Debug)]
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
    /// frontend reports ready (WebKitGTK inflates the very first allocation).
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
}

/// Adapter: the pure core handlers see the real window through this.
struct TauriIo<'a>(&'a WebviewWindow);

impl TauriIo<'_> {
    fn set_size(&self, w: i32, h: i32) {
        if let Err(e) = self
            .0
            .set_size(tauri::PhysicalSize::new(w as u32, h as u32))
        {
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

fn store_requested(state: &AppState, action: &str, pos: Option<(i32, i32)>, size: Option<(i32, i32)>) {
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
    let generation = state
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let win = main_window(app);
    if expand {
        TauriIo(&win).set_size(w, h);
        TauriIo(&win).set_outer_position(r.x, r.y);
        push_phase(app, "overview", edge);
    } else {
        push_phase(app, "compact", edge);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(COLLAPSE_RESIZE_DELAY_MS));
            let state = app.state::<AppState>();
            if state.generation.load(Ordering::SeqCst) != generation {
                return; // a newer plan superseded this deferred resize
            }
            let win = main_window(&app);
            TauriIo(&win).set_size(w, h);
            TauriIo(&win).set_outer_position(r.x, r.y);
        });
    }
}

// --- M1b snapshots/events ---------------------------------------------------

/// Current snapshot in Electron's exact shape. `anchor` is reported only
/// when the X server really answers for our window — evidence, not intent.
fn build_snapshot(state: &AppState) -> Value {
    let phase = *state.phase.lock().expect("phase lock");
    let edge = state.core.lock().expect("core lock").edge;
    let anchor = workarea::x11_window_origin().is_some().then(|| edge_str(edge));
    let revision = state.revision.load(Ordering::SeqCst);
    serde_json::to_value(desktop::Snapshot::new(
        revision,
        phase,
        anchor,
        state.motion_override.load(Ordering::SeqCst),
    ))
    .unwrap_or(Value::Null)
}

/// Publish on `desktop:state` with main.cjs `publish()` semantics: identical
/// content (revision aside) is never re-emitted and the revision advances
/// only when something actually changed.
fn publish(app: &AppHandle, state: &AppState) {
    let value = build_snapshot(state);
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

/// Fail closed (core.cjs `rememberedMotion`): only an exact `override: true`
/// animates; absent, unreadable or corrupt config means respect accessibility.
fn load_motion_override(app: &AppHandle) -> bool {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("motion.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|v| v.get("override").and_then(Value::as_bool) == Some(true))
        .unwrap_or(false)
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
fn restore(app: &AppHandle) {
    let state = app.state::<AppState>();
    // transition(state, 'restore') -> compact, always.
    *state.phase.lock().expect("phase lock") = IslandState::Compact;
    let area = refresh_work_area(app, &state);
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
        apply_plan(app, &state, plan);
    } else {
        let (w, h) = geometry::scaled_size(geometry::LOGICAL_COMPACT, io.scale());
        let (x, y) = io.outer_position();
        let (cw, ch) = io.size();
        let safe = geometry::clamp_rect(Rect { x, y, w: cw, h: ch }, area);
        io.set_size(w, h);
        io.set_outer_position(safe.x, safe.y);
        store_requested(&state, "restore", Some((safe.x, safe.y)), Some((w, h)));
    }
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    publish(app, &state);
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
        let safe = geometry::clamp_rect(Rect { x, y, w: h.min(w), h }, wa.rect);
        if (safe.x, safe.y, safe.w, safe.h) != (x, y, w, h) {
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
fn drag_release(
    app: AppHandle,
    state: State<AppState>,
    x: f64,
    y: f64,
    cancelled: bool,
) -> String {
    let area = refresh_work_area(&app, &state);
    let win = main_window(&app);
    let io = TauriIo(&win);
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, (x, y), cancelled)
    };
    match outcome {
        ReleaseOutcome::Toggle(plan) => {
            // Short click: toggle goes through the same funnel as the facade
            // verbs, so `onState` subscribers see the phase change.
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
}

/// The single IPC entry point behind `window.desktop.*` — Electron's
/// `ipcMain.handle('desktop:action')`. The gate order mirrors main.cjs
/// exactly: sender + payload validation FIRST, then the rate gate — an
/// invalid call never consumes rate budget.
#[tauri::command]
fn desktop_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let (action, _index) = bridge::validate_payload(&payload)?;
    state.rate.lock().expect("rate lock").check(now_ms())?;
    dispatch_verb(&app, &state, action)
}

/// Execute one validated verb with Electron main.cjs semantics. Verbs whose
/// backing system is a later unit reject with a typed `not-yet-wired` error
/// instead of pretending to succeed.
fn dispatch_verb(app: &AppHandle, state: &AppState, action: Action) -> Result<Value, BridgeError> {
    match action {
        Action::Snapshot => Ok(build_snapshot(state)),
        Action::Expand | Action::Close => {
            let verb = if action == Action::Expand {
                "expand"
            } else {
                "close"
            };
            let changed = {
                let mut phase = state.phase.lock().expect("phase lock");
                let next = desktop::transition(*phase, verb);
                if next == *phase {
                    false // no-op, exactly like Electron's transition()
                } else {
                    *phase = next;
                    true
                }
            };
            if changed {
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
            Ok(build_snapshot(state))
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
                let _ = main_window(app).hide();
                publish(app, state);
            }
            Ok(build_snapshot(state))
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
            Ok(build_snapshot(state))
        }
        // --- verbs whose backing system lands in a later unit ---------------
        Action::Dismiss | Action::Allow | Action::Deny | Action::Choose => {
            let unit = match action {
                Action::Dismiss => "M2 (the local UDS notice transport)",
                Action::Allow | Action::Deny => "M3 (the approval HTTP bridge)",
                Action::Choose => {
                    "M3 (a standing proposal request; while none stands Electron answers Denied)"
                }
                _ => unreachable!("guarded by the match arm"),
            };
            Err(BridgeError::not_yet_wired(action.name(), unit))
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

/// Frontend evidence for the probe: SVG element count rendered by clay-engine
/// and canvas count (must be 0 — R6 is SVG-DOM, not Canvas/WebGL).
///
/// Side effect on first report: spawn the geometry pin. WebKitGTK inflates
/// the very first allocation (observed 304x81 instead of 304x44) and the
/// resize only sticks once the webview has settled, so the pin re-asserts the
/// contract geometry a few times after page load. It aborts as soon as the
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
    if !first {
        return;
    }
    std::thread::spawn(move || {
        // WebKitGTK's very first allocation inflates the window (304x81) and a
        // plain set_size(304,44) is refused until the widget has been grown at
        // least once (the expand/collapse cycle proves the same transition).
        // A height-only grow is visually silent: the island is top-anchored and
        // the width does not change, so nothing moves on screen.
        let bump_h = |scale: f64| geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale).1;
        let aborted = |state: &AppState| {
            state.generation.load(Ordering::SeqCst) != 0
                || state.user_touch.load(Ordering::SeqCst)
        };
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(600));
            let state = app.state::<AppState>();
            if aborted(&state) {
                return;
            }
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
            io.set_size(w, bump_h(scale)); // grow (silent) so the shrink sticks
            std::thread::sleep(Duration::from_millis(250));
            io.set_size(w, h);
            io.set_outer_position(rect.x, rect.y);
            *state.work_area.lock().expect("work area lock") = wa.rect;
            store_requested(&state, "initial-pin", Some((rect.x, rect.y)), Some((w, h)));
            std::thread::sleep(Duration::from_millis(200));
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

fn probe_requested() -> bool {
    let env = std::env::var("ABITO_PROBE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    env || std::env::args().any(|a| a == "--probe")
}

fn main() {
    // Heavy constraint (HANDOFF): GTK/Tao under Wayland cannot position a window
    // absolutely nor keep it always-on-top, so the island must run on
    // X11/XWayland. Force the GDK backend before GTK initialises, but only when
    // the launcher did not already choose one.
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

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
        motion_override: AtomicBool::new(false),
        revision: AtomicU64::new(0),
        last_published: Mutex::new(String::new()),
        rate: Mutex::new(bridge::RateLimiter::new()),
        facade: Mutex::new(None),
    };

    tauri::Builder::default()
        // M1b lifecycle: a second launch hands its argv to the first instance
        // (which restores/shows/focuses the island) and exits before run().
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore(app);
        }))
        .plugin(navigation_lock())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            drag_press,
            drag_move,
            drag_release,
            desktop_action,
            record_facade_evidence,
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
            // M1b: motion override fails closed from user config.
            state
                .motion_override
                .store(load_motion_override(&handle), Ordering::SeqCst);
            spawn_workarea_watcher(handle.clone());
            spawn_publish_ticker(handle.clone());
            if probe_requested() {
                std::thread::spawn(move || probe::run(handle));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running abito island");
}
