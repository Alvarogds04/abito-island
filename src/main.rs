//! Abito island — Electron to Rust+Tauri migration, unit M1a.
//!
//! Skeleton: a transparent, undecorated, always-on-top X11 window that hosts
//! the frozen R6 clay engine, with free drag (pointer tracked in the webview),
//! edge snapping that keeps the chosen X, scale-aware work-area clamping,
//! anchored grow/shrink, and an `ABITO_PROBE=1` read-back script.

mod core;
mod geometry;
mod probe;
mod workarea;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use core::{Core, ReleaseOutcome, TogglePlan};
use geometry::{Edge, Rect};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const COLLAPSE_RESIZE_DELAY_MS: u64 = 400; // frontend shrink anim is 340ms

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

fn store_requested(
    state: &State<AppState>,
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

fn refresh_work_area(app: &AppHandle, state: &State<AppState>) -> Rect {
    let win = main_window(app);
    let wa = workarea::current(&win);
    *state.work_area.lock().expect("work area lock") = wa.rect;
    wa.rect
}

/// Apply a toggle plan. Expand resizes immediately (the window must be big
/// before the spring grows); collapse tells the frontend to animate first and
/// resizes the native window after the 340ms shrink, guarded by generation so
/// a rapid re-toggle can never apply a stale size.
fn apply_plan(app: &AppHandle, state: &State<AppState>, plan: TogglePlan) {
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
            apply_plan(&app, &state, plan);
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

/// Frontend evidence for the probe: SVG element count rendered by clay-engine
/// and canvas count (must be 0 — R6 is SVG-DOM, not Canvas/WebGL).
///
/// Side effect on first report: spawn the geometry pin. WebKitGTK inflates the
/// very first allocation (observed 304x81 instead of 304x44) and the resize
/// only sticks once the webview has settled, so the pin re-asserts the
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
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            drag_press,
            drag_move,
            drag_release,
            record_frontend_evidence
        ])
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
            if probe_requested() {
                std::thread::spawn(move || probe::run(handle));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running abito island");
}
