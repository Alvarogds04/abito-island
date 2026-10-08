//! `ABITO_PROBE=1` (or `--probe`) read-back script for unit M1a.
//!
//! The probe drives the SAME core handlers the pointer commands use — press,
//! drag, release/snap, toggle — programmatically. It is NOT a real pointer:
//! every line printed here says so. After each step it waits for the window
//! manager to apply the change, then prints a JSON line with the ACTUAL
//! getters (outer_position, inner_size, scale_factor, is_always_on_top,
//! is_decorated, work area) next to the values we REQUESTED, plus frontend
//! evidence (SVG element count rendered by clay-engine, zero canvas).
//! Exits only this process.

use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::core::{screen_at, ReleaseOutcome, WindowIo};
use crate::geometry;
use crate::{apply_plan, main_window, refresh_work_area, store_requested, AppState, TauriIo};

const NO_POINTER: &str =
    "none — the probe drives the same core handlers programmatically; no real pointer events are used";

fn emit(value: &serde_json::Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Wait until the WM reports the requested inner size, bounded.
fn wait_for_size(app: &AppHandle, want: (i32, i32), timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let win = main_window(app);
        let got = win
            .inner_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or((0, 0));
        if got == want {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

fn readback(app: &AppHandle, step: &str) {
    let win = main_window(app);
    let state = app.state::<AppState>();
    let wa = crate::workarea::current(&win);
    let pos = win.outer_position().ok().map(|p| (p.x, p.y));
    let size = win.inner_size().ok().map(|s| (s.width as i32, s.height as i32));
    let scale = win.scale_factor().ok();
    let always_on_top = win.is_always_on_top().ok();
    let decorated = win.is_decorated().ok();
    let (rpos, rsize, raction) = {
        let req = state.requested.lock().expect("requested lock");
        (req.pos, req.size, req.action.clone())
    };
    // Raw X11 ground truth for our own window (read-only): disambiguates the
    // Tauri getters from what the WM actually applied.
    let x11win = crate::workarea::x11_find_window_by_title("Abito");
    let x11json = x11win.as_ref().map(|w| {
        json!({
            "id": format!("0x{:x}", w.id),
            "geometry": [w.x, w.y, w.w, w.h],
            "border": w.border,
            "gtk_frame_extents": w.frame_extents,
            "net_wm_state_above": w.wm_state_above,
            "wm_class": w.wm_class,
        })
    });
    emit(&json!({
        "step": step,
        "pointer_input": NO_POINTER,
        "actual": {
            "outer_position": pos.map(|p| [p.0, p.1]),
            "inner_size": size.map(|s| [s.0, s.1]),
            "scale_factor": scale,
            "is_always_on_top": always_on_top,
            "is_decorated": decorated,
            "work_area": [wa.rect.x, wa.rect.y, wa.rect.w, wa.rect.h],
            "work_area_source": wa.source,
            "work_area_x11_raw": wa.x11.map(|r| [r.x, r.y, r.w, r.h]),
            "work_area_monitor_raw": wa.monitor.map(|r| [r.x, r.y, r.w, r.h]),
            "x11_window": x11json,
        },
        "requested": {
            "position": rpos.map(|p| [p.0, p.1]),
            "size": rsize.map(|s| [s.0, s.1]),
            "action": raction,
        },
        "match": {
            "position": pos.is_some() && pos == rpos,
            "size": size.is_some() && size == rsize,
        },
        // X-server truth: what mutter actually applied for our request.
        "match_x11": {
            "position": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.x, w.y)) == rpos)
            }),
            "size": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.w, w.h)) == rsize)
            }),
        },
    }));
}

/// Move the pointer (as a screen point) from its current position to `target`
/// in 10 simulated steps, going through `Core::drag` each time — exactly the
/// handler the webview's `drag_move` command calls.
fn simulated_drag(app: &AppHandle, area: geometry::Rect, target: (f64, f64)) {
    let state = app.state::<AppState>();
    let win = main_window(app);
    let io = TauriIo(&win);
    let scale = io.scale();
    for i in 1..=10 {
        // The window follows the pointer, so the pointer's screen point is
        // outer origin + grab offset; interpolate toward the target from there
        // and convert back to a client coordinate for the shared handler.
        let (ox, oy) = io.outer_position();
        let start = screen_at(&io, (50.0, 20.0));
        let t = i as f64 / 10.0;
        let screen = (
            start.0 + (target.0 - start.0) * t,
            start.1 + (target.1 - start.1) * t,
        );
        let client = ((screen.0 - ox as f64) / scale, (screen.1 - oy as f64) / scale);
        let moved = {
            let mut core = state.core.lock().expect("core lock");
            core.drag(&io, area, client)
        };
        if let Some(pos) = moved {
            store_requested(&state, "drag", Some(pos), None);
        }
        sleep(Duration::from_millis(40));
    }
}

pub fn run(app: AppHandle) {
    emit(&json!({
        "probe": "abito M1a geometry/state read-back",
        "pointer_input": NO_POINTER,
        "sequence": ["start", "simulated_drag_near_bottom", "release_snap_bottom", "expand", "collapse", "drag_to_top_snap", "frontend_evidence"],
        "gdk_backend": std::env::var("GDK_BACKEND").unwrap_or_else(|_| "unset".into()),
    }));

    let state = app.state::<AppState>();

    // Wait for the webview's evidence command (clay-engine rendered, no canvas).
    let mut evidence = None;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(e) = state.evidence.lock().expect("evidence lock").clone() {
            evidence = Some(e);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    sleep(Duration::from_millis(100));

    // 1. start: wait for the initial geometry to settle first — WebKitGTK
    //    inflates the very first allocation and the app re-pins 304x44 right
    //    after page load (same "wait for the WM to apply" discipline as every
    //    later step), then read the honest getters.
    let scale0 = main_window(&app).scale_factor().unwrap_or(1.0);
    let compact = geometry::scaled_size(geometry::LOGICAL_COMPACT, scale0);
    let overview = geometry::scaled_size(geometry::LOGICAL_OVERVIEW, scale0);
    let settled = wait_for_size(&app, compact, Duration::from_secs(6));
    if !settled {
        emit(&json!({"step": "start", "warning": "compact size did not settle within 6s"}));
    }
    sleep(Duration::from_millis(200));
    readback(&app, "start");

    // 2. simulated drag to a point near the bottom of the work area.
    let area = refresh_work_area(&app, &state);
    let win = main_window(&app);
    let io = TauriIo(&win);
    let press_client = (50.0, 20.0);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.bottom() as f64 - 24.0,
    );
    simulated_drag(&app, area, target);
    sleep(Duration::from_millis(200)); // WM applies the last move
    readback(&app, "simulated_drag_near_bottom");

    // 3. release: the core decides snap (drag) — must NOT toggle.
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    match &outcome {
        ReleaseOutcome::Snapped { rect, edge } => {
            store_requested(
                &state,
                &format!("snap_{:?}", edge).to_lowercase(),
                Some((rect.x, rect.y)),
                None,
            );
        }
        other => emit(&json!({"step": "release_snap_bottom", "unexpected": format!("{other:?}") })),
    }
    sleep(Duration::from_millis(300));
    readback(&app, "release_snap_bottom");

    // 4. expand: docked at the bottom -> must grow upward (bottom anchored).
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "expand");
    if !applied {
        emit(&json!({"step": "expand", "warning": "window did not reach overview size within 3s"}));
    }

    // 5. collapse: frontend animates first, native resize follows (~400ms).
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "collapse");
    if !applied {
        emit(&json!({"step": "collapse", "warning": "window did not return to compact size within 3s"}));
    }

    // 6. drag to the top and release -> snaps to the top edge keeping X.
    let area = refresh_work_area(&app, &state);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.y as f64 + 12.0,
    );
    simulated_drag(&app, area, target);
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    match &outcome {
        ReleaseOutcome::Snapped { rect, edge } => {
            store_requested(
                &state,
                &format!("snap_{:?}", edge).to_lowercase(),
                Some((rect.x, rect.y)),
                None,
            );
        }
        other => emit(&json!({"step": "drag_to_top_snap", "unexpected": format!("{other:?}") })),
    }
    sleep(Duration::from_millis(300));
    readback(&app, "drag_to_top_snap");

    // 7. frontend evidence from the webview command.
    emit(&json!({
        "step": "frontend_evidence",
        "pointer_input": "produced by the webview itself via the record_frontend_evidence command",
        "svg_elements_rendered_by_clay_engine": evidence.as_ref().map(|e| e.svgs),
        "canvas_elements": evidence.as_ref().map(|e| e.canvases),
        "clay_revision": evidence.as_ref().map(|e| e.revision.as_str()),
        "received": evidence.is_some(),
    }));

    std::process::exit(0); // exits only this app
}
